pub mod rhai_runner;
pub mod rust_registry;

use crate::config::{ParamSpec, ParamValue};
use crate::orchestrator::progress::ProgressReporter;
use anyhow::Result;
use polars::frame::DataFrame;
use std::collections::HashMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct ProcCtx {
    pub cancel: CancellationToken,
    pub reporter: ProgressReporter,
    pub total_rows: usize,
    /// Valores y specs de parámetros del proyecto. Expuestos a los scripts
    /// rhai como `params` (con coerción a tipos nativos según el kind),
    /// y disponibles para las fns rust nativas via `ctx.params_resolved`.
    pub params_resolved: Arc<ResolvedParamsForScripts>,
}

/// Vista de `ResolvedParams` reducida a lo que los scripts necesitan: el
/// valor resuelto + el kind para saber cómo coercionarlo (a número/bool/
/// lista) cuando se exponga al engine de scripting.
#[derive(Debug, Default, Clone)]
pub struct ResolvedParamsForScripts {
    pub specs: HashMap<String, ParamSpec>,
    pub values: HashMap<String, ParamValue>,
}

impl ResolvedParamsForScripts {
    pub fn new(
        specs: &[ParamSpec],
        values: &HashMap<String, ParamValue>,
    ) -> Self {
        Self {
            specs: specs
                .iter()
                .map(|s| (s.name.clone(), s.clone()))
                .collect(),
            values: values.clone(),
        }
    }
}

impl ProcCtx {
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
    pub fn report_progress(&self, processed: usize) {
        let pct = if self.total_rows == 0 {
            1.0
        } else {
            (processed as f32) / (self.total_rows as f32)
        };
        self.reporter
            .report_progress(pct.min(1.0), Some(processed), Some(self.total_rows));
    }
    pub fn log(&self, line: impl Into<String>) {
        self.reporter.log(line.into());
    }
}

pub trait ProceduralFn: Send + Sync {
    fn process(
        &self,
        df: &DataFrame,
        params: &serde_json::Value,
        ctx: &mut ProcCtx,
    ) -> Result<DataFrame>;
}
