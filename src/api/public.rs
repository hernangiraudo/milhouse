//! Endpoints públicos para exponer proyectos vía REST.
//!
//! Cada config puede declarar `api.exposed = true` y opcionalmente un
//! `api.token`. Si lo hace, los siguientes endpoints quedan disponibles:
//!
//! - `POST /api/public/projects/:slug/run`  → dispara una ejecución.
//!   Body: `{ "parameters": { ... } }` (opcional, si el proyecto declara
//!   parámetros y `accept_parameters` es true).
//!   Responde inmediatamente con `{ "ok": true, "job_id": "..." }`.
//!
//! - `GET /api/public/jobs/:id`  → consulta estado.
//!   Si está corriendo: `{ status: "running", progress: {done, total, pct} }`.
//!   Si terminó ok: `{ status: "ok", progress: ..., result: { datasets: [...] } }`.
//!   Si falló: `{ status: "failed", progress: ..., error: "..." }`.
//!
//! Auth: si el config declara `api.token`, los requests deben incluirlo en
//! `X-API-Token: <token>` (o `Authorization: Bearer <token>`). Si no, queda
//! público (depende del operador poner un proxy delante).

use crate::api::AppState;
use crate::config::{ApiConfig, EtlConfig, ParamValue};
use crate::orchestrator::state::{JobStatus, StepRuntimeState};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Default, Deserialize)]
pub struct RunPublicReq {
    /// Mapa nombre → valor. Mismo formato que el endpoint interno.
    #[serde(default)]
    pub parameters: HashMap<String, ParamValue>,
    /// Si true, persiste datasets debug en la DB de runs (necesario para
    /// devolver `result.datasets`). Default: true.
    #[serde(default = "default_true")]
    pub debug: bool,
}

fn default_true() -> bool {
    true
}

/// POST /api/public/projects/:slug/run
pub async fn run_project(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    body: Option<Json<RunPublicReq>>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (mut cfg, config_name) = load_exposed_config(&state, &slug)?;
    enforce_token(&cfg.api, &headers)?;

    let req = body.map(|Json(b)| b).unwrap_or_default();
    let mut parameters = if cfg.api.accept_parameters {
        req.parameters
    } else {
        HashMap::new()
    };

    // Merge selectivo: sólo los globales que el proyecto declaró en
    // `selected_global_params`. Local pisa global. Mismo criterio que el
    // endpoint interno `/api/jobs`.
    {
        let globals = state.global_params.read().await.clone();
        let selected: std::collections::HashSet<String> = cfg
            .selected_global_params
            .iter()
            .cloned()
            .collect();
        let local_names: std::collections::HashSet<String> = cfg
            .parameters
            .iter()
            .map(|p| p.name.clone())
            .collect();
        for g in &globals.parameters {
            if !selected.contains(&g.name) {
                continue;
            }
            if !local_names.contains(&g.name) {
                cfg.parameters.push(g.clone());
            }
        }
    }

    // Cadena de fallbacks: request > run_defaults del proyecto >
    // ParamSpec.default. Mismo orden que en `/api/jobs`.
    for (name, value) in &cfg.run_defaults {
        parameters
            .entry(name.clone())
            .or_insert_with(|| value.clone());
    }
    for p in &cfg.parameters {
        if let Some(def) = &p.default {
            parameters
                .entry(p.name.clone())
                .or_insert_with(|| def.clone());
        }
    }

    // Validar que cualquier :param referenciado tenga valor (mismo check
    // que /api/jobs).
    {
        let mut missing: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();
        for s in &cfg.steps {
            let texts: Vec<&str> = match &s.spec {
                crate::config::StepSpec::SqlQuery { query, .. }
                | crate::config::StepSpec::SqlExec { query, .. } => vec![query.as_str()],
                crate::config::StepSpec::FilterAndSubset { filter, .. } => {
                    filter.as_deref().into_iter().collect()
                }
                _ => continue,
            };
            for t in texts {
                for name in crate::api::routes::scan_param_refs(t) {
                    if !parameters.contains_key(&name) {
                        missing.insert(name);
                    }
                }
            }
        }
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "parámetros faltantes: {}",
                    missing
                        .into_iter()
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
    }

    // Validar conexión definida en todos los pasos SQL.
    {
        let mut missing: Vec<String> = Vec::new();
        for s in &cfg.steps {
            let conn = match &s.spec {
                crate::config::StepSpec::SqlQuery { connection, .. }
                | crate::config::StepSpec::SqlExec { connection, .. } => connection.as_deref(),
                _ => continue,
            };
            if conn.map(|c| c.trim().is_empty()).unwrap_or(true) {
                missing.push(s.id.clone());
            }
        }
        if !missing.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "los siguientes pasos SQL no tienen conexión asignada: {}",
                    missing.join(", ")
                ),
            ));
        }
    }

    let job_id = Uuid::new_v4().to_string();
    let run_store = state.run_store.read().await.clone();
    let constants = state.global_constants.read().await.constants.clone();
    let options = crate::orchestrator::scheduler::JobOptions {
        target_steps: None,
        stop_on_failure: true,
        use_preload: false,
        params: parameters,
        constants,
        run_name: None,
    };
    let handle = crate::orchestrator::run_job(
        job_id.clone(),
        config_name,
        Some(format!("api/{slug}")),
        req.debug,
        cfg,
        state.pool.clone(),
        run_store,
        options,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    state.jobs.insert(job_id.clone(), handle);

    Ok(Json(json!({
        "ok": true,
        "job_id": job_id,
        "status": "accepted",
        "poll_url": format!("/api/public/jobs/{job_id}"),
    })))
}

/// GET /api/public/jobs/:id
pub async fn get_job_status(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Buscar el handle en memoria primero.
    let snap = if let Some(entry) = state.jobs.get(&job_id) {
        Some(entry.value().snapshot().await)
    } else {
        None
    };

    let Some(snap) = snap else {
        // Si no está en memoria, buscar en la DB de runs (histórico).
        return historic_status(&state, &job_id, &headers).await;
    };

    // Obtener el config del proyecto para resolver auth + export_datasets.
    let cfg = load_config_by_name(&state, &snap.config_name).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("no se pudo cargar el config del job: {e}"),
        )
    })?;
    enforce_token(&cfg.api, &headers)?;

    let total = snap.step_order.len();
    let done = snap
        .steps
        .values()
        .filter(|s| {
            matches!(
                s.state,
                StepRuntimeState::Done { .. }
                    | StepRuntimeState::Skipped { .. }
                    | StepRuntimeState::Failed { .. }
                    | StepRuntimeState::Cancelled
            )
        })
        .count();
    let pct = if total == 0 {
        1.0
    } else {
        done as f32 / total as f32
    };

    match snap.status {
        JobStatus::Running => Ok(Json(json!({
            "status": "running",
            "progress": { "done": done, "total": total, "pct": pct },
        }))),
        JobStatus::Cancelled => Ok(Json(json!({
            "status": "cancelled",
            "progress": { "done": done, "total": total, "pct": pct },
        }))),
        JobStatus::Failed => {
            let error = snap
                .steps
                .values()
                .find_map(|s| match &s.state {
                    StepRuntimeState::Failed { error, .. } => Some(error.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| "unknown".to_string());
            Ok(Json(json!({
                "status": "failed",
                "progress": { "done": done, "total": total, "pct": pct },
                "error": error,
            })))
        }
        JobStatus::Ok => {
            let result = build_result(&state, &job_id, &cfg).await?;
            Ok(Json(json!({
                "status": "ok",
                "progress": { "done": done, "total": total, "pct": pct },
                "result": result,
            })))
        }
    }
}

async fn historic_status(
    state: &AppState,
    job_id: &str,
    headers: &HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store_opt = state.run_store.read().await.clone();
    let Some(store) = store_opt else {
        return Err((StatusCode::NOT_FOUND, "job no encontrado".to_string()));
    };
    let escaped = job_id.replace('\'', "''");
    let rs = store
        .query(format!(
            "SELECT config_name, status, total_steps FROM runs WHERE job_id = '{escaped}'"
        ))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    let row = rs
        .rows
        .first()
        .ok_or((StatusCode::NOT_FOUND, "job no encontrado".to_string()))?;
    let cfg_name = row
        .first()
        .and_then(|v| v.as_str())
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "config_name".into()))?
        .to_string();
    let status_str = row
        .get(1)
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let total_steps = row.get(2).and_then(|v| v.as_i64()).unwrap_or(0) as usize;

    let cfg = load_config_by_name(state, &cfg_name).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("no se pudo cargar config: {e}"),
        )
    })?;
    enforce_token(&cfg.api, headers)?;

    // Contar step_runs OK + Skipped + Failed + Cancelled como "done".
    let done_rs = store
        .query(format!(
            "SELECT COUNT(*) FROM step_runs WHERE job_id = '{escaped}'"
        ))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    let done = done_rs
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as usize;
    let pct = if total_steps == 0 {
        1.0
    } else {
        done as f32 / total_steps as f32
    };

    match status_str.as_str() {
        "ok" => {
            let result = build_result(state, job_id, &cfg).await?;
            Ok(Json(json!({
                "status": "ok",
                "progress": { "done": done, "total": total_steps, "pct": pct },
                "result": result,
            })))
        }
        "running" => Ok(Json(json!({
            "status": "running",
            "progress": { "done": done, "total": total_steps, "pct": pct },
        }))),
        other => Ok(Json(json!({
            "status": other,
            "progress": { "done": done, "total": total_steps, "pct": pct },
        }))),
    }
}

async fn build_result(
    state: &AppState,
    job_id: &str,
    cfg: &EtlConfig,
) -> Result<Value, (StatusCode, String)> {
    if cfg.api.export_datasets.is_empty() {
        return Ok(json!({ "datasets": [] }));
    }
    let store_opt = state.run_store.read().await.clone();
    let Some(store) = store_opt else {
        return Ok(json!({
            "datasets": [],
            "note": "run_store no configurado — no se persistieron datasets",
        }));
    };
    let metas = store
        .list_run_dataset_meta(job_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    let wanted: std::collections::HashSet<String> =
        cfg.api.export_datasets.iter().cloned().collect();

    let mut out: Vec<Value> = Vec::new();
    for m in metas {
        // Match por step_id o por dataset name.
        if !(wanted.contains(&m.step_id) || wanted.contains(&m.name)) {
            continue;
        }
        // Preview con límite alto (10k rows). El operador que necesite más,
        // que use el bundle del job.
        match store.dataset_preview(job_id, m.step_uid, 10_000).await {
            Ok(prev) => out.push(json!({
                "step_id": m.step_id,
                "name": m.name,
                "row_count": m.row_count,
                "returned_rows": prev.rows.len(),
                "columns": prev.columns,
                "rows": prev.rows,
            })),
            Err(e) => out.push(json!({
                "step_id": m.step_id,
                "name": m.name,
                "error": format!("{e:#}"),
            })),
        }
    }
    Ok(json!({ "datasets": out }))
}

// =====================================================================
// Helpers
// =====================================================================

/// Carga un proyecto por slug (= filename del config sin `.json`).
/// Devuelve error si no existe o si no está expuesto.
fn load_exposed_config(
    state: &AppState,
    slug: &str,
) -> Result<(EtlConfig, String), (StatusCode, String)> {
    let filename = if slug.ends_with(".json") {
        slug.to_string()
    } else {
        format!("{slug}.json")
    };
    let path = std::path::Path::new(&state.configs_dir).join(&filename);
    let text = std::fs::read_to_string(&path)
        .map_err(|_| (StatusCode::NOT_FOUND, format!("proyecto `{slug}` no encontrado")))?;
    let cfg = EtlConfig::from_json_str(&text).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("config inválido: {e}"),
        )
    })?;
    if !cfg.api.exposed {
        return Err((
            StatusCode::FORBIDDEN,
            format!("el proyecto `{slug}` no está expuesto como API"),
        ));
    }
    Ok((cfg, filename))
}

fn load_config_by_name(state: &AppState, name: &str) -> anyhow::Result<EtlConfig> {
    let path = std::path::Path::new(&state.configs_dir).join(name);
    let text = std::fs::read_to_string(&path)?;
    Ok(EtlConfig::from_json_str(&text)?)
}

/// Si el config declara `api.token`, exige que venga en el header. Si no,
/// permite el acceso (el operador es responsable de proteger la red).
fn enforce_token(api: &ApiConfig, headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
    let Some(expected) = &api.token else {
        return Ok(());
    };
    let provided = headers
        .get("x-api-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| {
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.to_string())
        });
    match provided {
        Some(p) if p == *expected => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            "token inválido o ausente (`X-API-Token` o `Authorization: Bearer ...`)".into(),
        )),
    }
}
