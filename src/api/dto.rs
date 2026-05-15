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
    /// Conjunto de step ids a ejecutar. Si está vacío o ausente, se ejecuta el
    /// proyecto completo. Los pasos fuera del subset quedan en estado
    /// `Skipped { reason: "fuera del subset" }`. Los antecesores requeridos
    /// se ejecutan automáticamente si no están en el subset y no tienen
    /// dataset cacheado (lo dejamos a cargo de quien arme el subset; el
    /// scheduler solo respeta `target_steps`).
    #[serde(default)]
    pub target_steps: Option<Vec<String>>,
    /// Si true, ante el primer step en estado Failed, cancela el job entero
    /// (no espera a otras ramas independientes). Default: false (compat).
    #[serde(default)]
    pub stop_on_failure: bool,
    /// Si true, antes del scheduler se cargan los datasets precargados
    /// (vía bundle importado) al TableStore.
    #[serde(default)]
    pub use_preload: bool,
    /// Si está presente, la corrida reusa este `job_id` en lugar de generar
    /// uno nuevo. Útil para "re-ejecutar un paso" en modo Diseño: se mantiene
    /// el id histórico y sólo se sobreescriben los pasos del subset.
    #[serde(default)]
    pub existing_job_id: Option<String>,
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
