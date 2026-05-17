use super::context::StepContext;
use crate::config::ProceduralEngine;
use crate::orchestrator::progress::ProgressReporter;
use crate::scripting::{rhai_runner, rust_registry, ProcCtx, ResolvedParamsForScripts};
use anyhow::{anyhow, Result};
use polars::frame::DataFrame;
use std::sync::Arc;

#[allow(clippy::too_many_arguments)]
pub async fn run(
    ctx: &StepContext,
    input: Option<&str>,
    engine: ProceduralEngine,
    script: Option<&str>,
    fn_name: Option<&str>,
    params: &serde_json::Value,
    state_init: &serde_json::Value,
    reporter: ProgressReporter,
) -> Result<DataFrame> {
    // Si no hay tabla input, arrancamos con un DataFrame vacío. Útil para
    // pasos que solo manipulan params (preparar SQL dinámicos, etc).
    let df: Arc<DataFrame> = match input {
        Some(name) => ctx.get_table(name).await?,
        None => Arc::new(DataFrame::empty()),
    };
    let total = df.height();
    let cancel = ctx.cancel.clone();
    let script = script.map(|s| s.to_string());
    let fn_name = fn_name.map(|s| s.to_string());
    let params = params.clone();
    let state_init = state_init.clone();

    // Snapshot read-only de los parámetros del proyecto para que el script
    // los exponga como `params.NombreDelParametro` (rhai) o
    // ctx.params_resolved (rust). El lock se libera antes del
    // spawn_blocking para no bloquear otros pasos.
    let (specs_vec, values_snapshot) = {
        let guard = ctx.params.read().await;
        let specs: Vec<crate::config::ParamSpec> = guard.specs.values().cloned().collect();
        (specs, guard.values.clone())
    };
    let params_resolved = Arc::new(ResolvedParamsForScripts::new(
        &specs_vec,
        &values_snapshot,
    ));

    let rhai_engine_used = matches!(engine, ProceduralEngine::Rhai);
    let result = tokio::task::spawn_blocking(move || -> Result<ProceduralOutcome> {
        let mut proc_ctx = ProcCtx {
            cancel,
            reporter,
            total_rows: total,
            params_resolved,
        };
        match engine {
            ProceduralEngine::Rhai => {
                let script = script.ok_or_else(|| anyhow!("missing script for rhai engine"))?;
                let res = rhai_runner::run(df.as_ref(), &script, &state_init, &mut proc_ctx)?;
                Ok(ProceduralOutcome {
                    df: res.df,
                    param_mutations: res.param_mutations,
                })
            }
            ProceduralEngine::Rust => {
                let fn_name = fn_name.ok_or_else(|| anyhow!("missing fn_name for rust engine"))?;
                let registry = rust_registry::global();
                let f = registry
                    .get(fn_name.as_str())
                    .ok_or_else(|| anyhow!("rust procedural fn `{fn_name}` not registered"))?;
                let df_out = f.process(df.as_ref(), &params, &mut proc_ctx)?;
                Ok(ProceduralOutcome {
                    df: df_out,
                    param_mutations: Vec::new(),
                })
            }
        }
    })
    .await??;

    // Si el script mutó params, escribimos los nuevos valores al
    // StepContext. Los pasos siguientes (SQL u otros procedurales) van a
    // sustituir `:Nombre` con el nuevo valor.
    if rhai_engine_used && !result.param_mutations.is_empty() {
        let mut guard = ctx.params.write().await;
        for (name, value) in result.param_mutations {
            guard.values.insert(name, value);
        }
    }

    Ok(result.df)
}

struct ProceduralOutcome {
    df: DataFrame,
    param_mutations: Vec<(String, crate::config::ParamValue)>,
}
