use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct ConfigSummary {
    /// Nombre del archivo (lo que se pasa en `config_name` al POST /api/jobs).
    pub name: String,
    pub path: String,
    /// Nombre legible declarado dentro del JSON (`EtlConfig.name`). Si no se
    /// puede leer, queda igual a `name` (el filename) como fallback.
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct RunJobReq {
    pub config_name: String,
    /// Nombre del usuario que lanza el job (login simple sin password).
    /// Se persiste en la tabla `runs` para auditoría.
    #[serde(default)]
    pub user: Option<String>,
    /// Si true, persiste el dataset resultante de cada step en la DB de runs.
    /// Aumenta tamaño en disco; pensado para sesiones de debug.
    #[serde(default)]
    pub debug: bool,
}

#[derive(Debug, Serialize)]
pub struct RunJobResp {
    pub job_id: String,
}

#[derive(Debug, Serialize)]
pub struct JobSummary {
    pub job_id: String,
    pub config_name: String,
    pub config_display_name: Option<String>,
    pub user: Option<String>,
    pub status: crate::orchestrator::state::JobStatus,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    pub job_pct: f32,
}
