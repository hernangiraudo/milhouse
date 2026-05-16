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
    input: &str,
    engine: ProceduralEngine,
    script: Option<&str>,
    fn_name: Option<&str>,
    params: &serde_json::Value,
    state_init: &serde_json::Value,
    reporter: ProgressReporter,
) -> Result<DataFrame> {
    let df = ctx.get_table(input).await?;
    let total = df.height();
    let cancel = ctx.cancel.clone();
    let script = script.map(|s| s.to_string());
    let fn_name = fn_name.map(|s| s.to_string());
    let params = params.clone();
    let state_init = state_init.clone();

    // Snapshot de los parámetros del proyecto para que el script los
    // exponga como `params.NombreDelParametro` (rhai) o ctx.params_resolved
    // (rust). Específico de cada job: si cambian en runtime, la corrida
    // ya está corriendo con el snapshot inicial.
    let specs: Vec<crate::config::ParamSpec> =
        ctx.params.specs.values().cloned().collect();
    let params_resolved = Arc::new(ResolvedParamsForScripts::new(
        &specs,
        &ctx.params.values,
    ));

    tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        let mut proc_ctx = ProcCtx {
            cancel,
            reporter,
            total_rows: total,
            params_resolved,
        };
        match engine {
            ProceduralEngine::Rhai => {
                let script = script.ok_or_else(|| anyhow!("missing script for rhai engine"))?;
                rhai_runner::run(df.as_ref(), &script, &state_init, &mut proc_ctx)
            }
            ProceduralEngine::Rust => {
                let fn_name = fn_name.ok_or_else(|| anyhow!("missing fn_name for rust engine"))?;
                let registry = rust_registry::global();
                let f = registry
                    .get(fn_name.as_str())
                    .ok_or_else(|| anyhow!("rust procedural fn `{fn_name}` not registered"))?;
                f.process(df.as_ref(), &params, &mut proc_ctx)
            }
        }
    })
    .await?
}
