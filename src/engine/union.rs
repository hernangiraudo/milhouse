//! Paso union: apila N datasets en vertical.
//!
//! Si los datasets tienen esquemas distintos:
//! - el resultado expone la **unión** de columnas;
//! - las columnas que faltan en algún input se completan con `null`
//!   respetando el dtype "ganador" para esa columna.

use super::context::StepContext;
use anyhow::{anyhow, Result};
use polars::prelude::*;
use std::collections::BTreeMap;

pub async fn run(ctx: &StepContext, inputs: &[String]) -> Result<DataFrame> {
    if inputs.is_empty() {
        return Err(anyhow!("union: la lista de inputs está vacía"));
    }
    // Traer todos los DataFrames (Arc<DataFrame> compartido).
    let mut frames: Vec<std::sync::Arc<DataFrame>> = Vec::with_capacity(inputs.len());
    for name in inputs {
        let df = ctx.get_table(name).await?;
        frames.push(df);
    }

    let inputs_owned: Vec<String> = inputs.to_vec();

    tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        // Unión ordenada de columnas: preservamos el orden de primera aparición.
        let mut col_order: Vec<String> = Vec::new();
        let mut dtypes: BTreeMap<String, DataType> = BTreeMap::new();
        for df in &frames {
            for s in df.get_columns() {
                let name = s.name().to_string();
                let dt = s.dtype().clone();
                dtypes
                    .entry(name.clone())
                    .and_modify(|e| {
                        // Si conflictan, promovemos a String como denominador
                        // común conservador (evita errores de vstack).
                        if *e != dt {
                            *e = DataType::String;
                        }
                    })
                    .or_insert(dt);
                if !col_order.contains(&name) {
                    col_order.push(name);
                }
            }
        }

        // Normalizamos cada DataFrame al esquema unión.
        let mut normalized: Vec<DataFrame> = Vec::with_capacity(frames.len());
        for (idx, df) in frames.iter().enumerate() {
            let df_owned: DataFrame = df.as_ref().clone();
            let height = df_owned.height();
            // Indexar las columnas actuales.
            let mut existing: std::collections::HashMap<String, Column> =
                std::collections::HashMap::new();
            for c in df_owned.get_columns() {
                existing.insert(c.name().to_string(), c.clone());
            }
            // Armar la lista de columnas en el orden unión.
            let mut cols: Vec<Column> = Vec::with_capacity(col_order.len());
            for name in &col_order {
                let target_dtype = dtypes.get(name).cloned().unwrap_or(DataType::Null);
                if let Some(orig) = existing.remove(name) {
                    // Si el dtype del frame coincide con el target, se usa
                    // tal cual. Sino, intentamos cast.
                    if orig.dtype() == &target_dtype {
                        cols.push(orig);
                    } else {
                        let s = orig.as_materialized_series().clone();
                        let casted = s.cast(&target_dtype).map_err(|e| {
                            anyhow!(
                                "union: no se pudo castear `{}` de {} (input #{}) a {}: {e}",
                                name,
                                orig.dtype(),
                                idx + 1,
                                target_dtype
                            )
                        })?;
                        cols.push(casted.into_column());
                    }
                } else {
                    // Columna ausente → vector de nulls con el dtype target.
                    let pl_name = polars::prelude::PlSmallStr::from_string(name.clone());
                    let s = Series::full_null(pl_name, height, &target_dtype);
                    cols.push(s.into_column());
                }
            }
            let frame = DataFrame::new(cols).map_err(|e| {
                anyhow!("union: error construyendo frame normalizado #{}: {e}", idx + 1)
            })?;
            normalized.push(frame);
        }

        // vstack todos los frames normalizados.
        let mut iter = normalized.into_iter();
        let mut acc = iter.next().expect("al menos un input verificado arriba");
        for next in iter {
            acc.vstack_mut(&next).map_err(|e| {
                anyhow!(
                    "union: vstack falló mezclando {} datasets: {e}",
                    inputs_owned.len()
                )
            })?;
        }
        acc.rechunk_mut();
        Ok(acc)
    })
    .await?
}
