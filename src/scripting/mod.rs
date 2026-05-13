pub mod rhai_runner;
pub mod rust_registry;

use crate::orchestrator::progress::ProgressReporter;
use anyhow::Result;
use polars::frame::DataFrame;
use tokio_util::sync::CancellationToken;

pub struct ProcCtx {
    pub cancel: CancellationToken,
    pub reporter: ProgressReporter,
    pub total_rows: usize,
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
        self.reporter.log(line.into(), "info");
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
