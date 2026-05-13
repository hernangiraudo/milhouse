use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct ConfigSummary {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct RunJobReq {
    pub config_name: String,
}

#[derive(Debug, Serialize)]
pub struct RunJobResp {
    pub job_id: String,
}

#[derive(Debug, Serialize)]
pub struct JobSummary {
    pub job_id: String,
    pub config_name: String,
    pub status: crate::orchestrator::state::JobStatus,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    pub job_pct: f32,
}
