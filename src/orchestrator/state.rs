use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StepRuntimeState {
    Pending,
    Ready,
    Running {
        started_at: DateTime<Utc>,
        progress: f32,
        rows_done: Option<usize>,
        rows_total: Option<usize>,
    },
    Done {
        started_at: DateTime<Utc>,
        finished_at: DateTime<Utc>,
        duration_ms: u128,
        row_count: usize,
    },
    Failed {
        started_at: Option<DateTime<Utc>>,
        finished_at: DateTime<Utc>,
        error: String,
    },
    Cancelled,
    Skipped {
        reason: String,
    },
}

impl StepRuntimeState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Done { .. } | Self::Failed { .. } | Self::Cancelled | Self::Skipped { .. }
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepInfo {
    /// Identidad estable de máquina (asignada al cargar el config).
    pub step_uid: u32,
    pub id: String,
    pub kind: String,
    pub depends_on: Vec<String>,
    pub output_table: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    pub state: StepRuntimeState,
    #[serde(default)]
    pub logs: Vec<LogLine>,
    #[serde(default)]
    pub sample: Option<TableSample>,
    /// JSON crudo de la definición del step (tal como aparece en el config),
    /// para que el front pueda mostrar una descripción detallada.
    #[serde(default)]
    pub spec: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub at: DateTime<Utc>,
    pub level: String,
    pub line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSample {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    pub sampled_rows: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub dtype: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobState {
    pub job_id: String,
    pub config_name: String,
    /// Nombre legible del config (campo `name` dentro del JSON).
    #[serde(default)]
    pub config_display_name: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub debug: bool,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub status: JobStatus,
    pub steps: HashMap<String, StepInfo>,
    pub step_order: Vec<String>,
    /// Metadata de grupos declarados en el config (orden preservado).
    #[serde(default)]
    pub groups: Vec<GroupMetaDto>,
    pub eta_seconds: Option<u64>,
    pub job_pct: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMetaDto {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub parent_group: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Running,
    Ok,
    Failed,
    Cancelled,
}
