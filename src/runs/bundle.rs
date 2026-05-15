//! Bundles de datasets: export e import.
//!
//! El bundle es un zip con:
//!   - `manifest.json`     metadatos: job_id, config_name, exported_at, lista
//!                          de datasets con `step_id`, `step_uid`, `output_table`,
//!                          `row_count`.
//!   - `datasets/<step_id>.parquet`  uno por step con dataset.
//!
//! Al importar (`preload`), los archivos se extraen a
//! `data/preloaded/<config_name>/` y al lanzar un job con
//! `preload=true`, antes del scheduler los parquet se cargan al `TableStore`
//! usando como key el `output_table` declarado por el step. Los steps cuyas
//! tablas quedan preloadeadas se marcan automáticamente como `Skipped` con
//! razón "precargado".

use crate::runs::{DatasetMeta, RunStore};
use anyhow::{anyhow, Result};
use polars::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Serialize, Deserialize)]
pub struct BundleManifest {
    pub job_id: String,
    pub config_name: Option<String>,
    pub config_display_name: Option<String>,
    pub exported_at: String,
    pub datasets: Vec<BundleDatasetEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BundleDatasetEntry {
    pub step_id: String,
    pub step_uid: u32,
    pub name: String,
    pub level: String,
    pub row_count: i64,
    /// Path relativo dentro del zip.
    pub file: String,
}

/// Construye un zip in-memory con todos los datasets de un job.
pub async fn build_bundle(
    store: Arc<RunStore>,
    job_id: &str,
    config_name: Option<&str>,
    config_display_name: Option<&str>,
) -> Result<Vec<u8>> {
    let metas: Vec<DatasetMeta> = store.list_run_dataset_meta(job_id).await?;
    if metas.is_empty() {
        return Err(anyhow!(
            "el run {} no tiene datasets persistidos (corrió con debug=false?)",
            job_id
        ));
    }

    let mut parquets: Vec<(String, Vec<u8>, &DatasetMeta)> = Vec::with_capacity(metas.len());
    for meta in &metas {
        let mut df = store.dataset_full_df(job_id, meta.step_uid).await?;
        let mut buf: Vec<u8> = Vec::new();
        // Escritura sincrónica (datasets típicamente caben en memoria).
        ParquetWriter::new(&mut buf)
            .with_compression(ParquetCompression::Snappy)
            .finish(&mut df)?;
        let file = format!("datasets/{}__{}.parquet", meta.step_uid, sanitize(&meta.step_id));
        parquets.push((file, buf, meta));
    }

    let manifest = BundleManifest {
        job_id: job_id.to_string(),
        config_name: config_name.map(String::from),
        config_display_name: config_display_name.map(String::from),
        exported_at: chrono::Utc::now().to_rfc3339(),
        datasets: parquets
            .iter()
            .map(|(file, _, m)| BundleDatasetEntry {
                step_id: m.step_id.clone(),
                step_uid: m.step_uid,
                name: m.name.clone(),
                level: m.level.clone(),
                row_count: m.row_count,
                file: file.clone(),
            })
            .collect(),
    };

    let mut zip_buf: Vec<u8> = Vec::new();
    {
        let cursor = Cursor::new(&mut zip_buf);
        let mut zw = ::zip::ZipWriter::new(cursor);
        let opts: ::zip::write::SimpleFileOptions = ::zip::write::SimpleFileOptions::default()
            .compression_method(::zip::CompressionMethod::Deflated);

        zw.start_file("manifest.json", opts)?;
        let manifest_text = serde_json::to_string_pretty(&manifest)?;
        zw.write_all(manifest_text.as_bytes())?;

        for (file, buf, _) in &parquets {
            zw.start_file(file.as_str(), opts)?;
            zw.write_all(buf)?;
        }
        zw.finish()?;
    }
    Ok(zip_buf)
}

/// Extrae el zip a `data/preloaded/<config_name>/`.
/// Sobreescribe si ya existía. Retorna el manifest y la ruta destino.
pub fn import_bundle(
    zip_bytes: &[u8],
    config_name: &str,
) -> Result<(BundleManifest, PathBuf)> {
    let target_dir = Path::new("data").join("preloaded").join(safe_dir(config_name));
    if target_dir.exists() {
        std::fs::remove_dir_all(&target_dir).ok();
    }
    std::fs::create_dir_all(&target_dir)?;

    let reader = Cursor::new(zip_bytes);
    let mut archive = ::zip::ZipArchive::new(reader)?;
    let mut manifest: Option<BundleManifest> = None;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        // Por seguridad: no permitir paths absolutos ni "..".
        if name.contains("..") || name.starts_with('/') || name.contains(":\\") {
            return Err(anyhow!("entrada inválida en el zip: {name}"));
        }
        let out_path = target_dir.join(&name);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf)?;
        if name == "manifest.json" {
            manifest = Some(serde_json::from_slice(&buf)?);
        }
        std::fs::write(&out_path, &buf)?;
    }
    let manifest = manifest
        .ok_or_else(|| anyhow!("el bundle no contiene manifest.json"))?;
    Ok((manifest, target_dir))
}

/// Carga los parquet preloadeados a un HashMap (output_table → DataFrame)
/// listo para insertar en el TableStore. Mapea por `step_id`, leyendo la
/// definición del config para obtener el `output_table` real.
pub fn load_preloaded_tables(
    config_name: &str,
    steps_by_id: &HashMap<String, String>, // step_id → output_table
) -> Result<HashMap<String, DataFrame>> {
    let dir = Path::new("data").join("preloaded").join(safe_dir(config_name));
    if !dir.exists() {
        return Ok(HashMap::new());
    }
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(HashMap::new());
    }
    let manifest_text = std::fs::read_to_string(&manifest_path)?;
    let manifest: BundleManifest = serde_json::from_str(&manifest_text)?;
    let mut out = HashMap::new();
    for ds in &manifest.datasets {
        let Some(output_table) = steps_by_id.get(&ds.step_id) else {
            // El config actual ya no tiene ese step. Lo ignoramos.
            continue;
        };
        let p = dir.join(&ds.file);
        let f = std::fs::File::open(&p)?;
        let df = ParquetReader::new(f).finish()?;
        out.insert(output_table.clone(), df);
    }
    Ok(out)
}

/// True si hay un manifest precargado para este config.
pub fn has_preload(config_name: &str) -> bool {
    Path::new("data")
        .join("preloaded")
        .join(safe_dir(config_name))
        .join("manifest.json")
        .exists()
}

/// Lista los step_id que vienen precargados (vacío si no hay manifest).
pub fn preloaded_step_ids(config_name: &str) -> Vec<String> {
    let dir = Path::new("data").join("preloaded").join(safe_dir(config_name));
    let mp = dir.join("manifest.json");
    let Ok(text) = std::fs::read_to_string(&mp) else {
        return Vec::new();
    };
    let m: BundleManifest = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    m.datasets.into_iter().map(|d| d.step_id).collect()
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}
fn safe_dir(s: &str) -> String {
    sanitize(&s.trim_end_matches(".json").to_string())
}
