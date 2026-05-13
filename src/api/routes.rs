use super::{dto::*, AppState};
use crate::config::{ConnectionsFile, EtlConfig};
use crate::orchestrator::run_job;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};
use std::fs;
use uuid::Uuid;

pub async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

pub async fn list_configs(State(state): State<AppState>) -> impl IntoResponse {
    let mut out = Vec::new();
    let dir = std::path::Path::new(&state.configs_dir);
    // Archivos en este directorio que NO son configs ETL (no aparecen en el
    // dropdown de jobs a ejecutar). Por nombre, exacto.
    const NON_ETL: &[&str] = &["connections.json"];
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let name = p
                .file_name()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_string();
            if NON_ETL.contains(&name.as_str()) {
                continue;
            }
            out.push(ConfigSummary {
                name,
                path: p.to_string_lossy().to_string(),
            });
        }
    }
    Json(out)
}

pub async fn get_config(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = std::path::Path::new(&state.configs_dir).join(&name);
    let text = fs::read_to_string(&path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("{e}")))?;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid JSON: {e}")))?;
    Ok(Json(v))
}

pub async fn create_job(
    State(state): State<AppState>,
    Json(req): Json<RunJobReq>,
) -> Result<Json<RunJobResp>, (StatusCode, String)> {
    let path = std::path::Path::new(&state.configs_dir).join(&req.config_name);
    let text = fs::read_to_string(&path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("config not found: {e}")))?;
    let mut cfg = EtlConfig::from_json_str(&text)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid config: {e}")))?;
    // Asignar step_uids faltantes y persistir el cambio en disco.
    if cfg.ensure_step_uids() {
        let new_text = serde_json::to_string_pretty(&cfg).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("re-serializing config: {e}"),
            )
        })?;
        if let Err(e) = fs::write(&path, new_text) {
            tracing::warn!(
                "could not persist newly assigned step_uids back to {}: {e}",
                path.display()
            );
        } else {
            tracing::info!("assigned missing step_uids and saved {}", path.display());
        }
    }
    let connections = state.connections.read().await.clone();
    let job_id = Uuid::new_v4().to_string();
    let handle = run_job(
        job_id.clone(),
        req.config_name.clone(),
        req.user.clone(),
        req.debug,
        cfg,
        connections,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    state.jobs.insert(job_id.clone(), handle);
    Ok(Json(RunJobResp { job_id }))
}

pub async fn list_connections(State(state): State<AppState>) -> impl IntoResponse {
    let file = state.connections.read().await.clone();
    // Devolvemos un descriptor amigable (sin secretos como password).
    let summaries: Vec<Value> = file
        .connections
        .iter()
        .map(|c| {
            let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
            // Eliminar credenciales sensibles si las hay.
            if let Some(obj) = v.as_object_mut() {
                obj.remove("password");
            }
            json!({
                "name": c.name,
                "type": c.kind.type_name(),
                "implemented": c.kind.is_implemented(),
                "description": c.description.clone(),
                "spec": v,
                "is_default": file.default.as_deref() == Some(c.name.as_str()),
            })
        })
        .collect();
    Json(json!({ "default": file.default, "connections": summaries }))
}

pub async fn reload_connections(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let text = fs::read_to_string(&state.connections_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot read connections file: {e}"),
        )
    })?;
    let parsed = ConnectionsFile::from_json_str(&text)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid connections: {e}")))?;
    let count = parsed.connections.len();
    *state.connections.write().await = parsed;
    Ok(Json(json!({ "status": "ok", "connections": count })))
}

pub async fn list_jobs(State(state): State<AppState>) -> impl IntoResponse {
    let mut out: Vec<JobSummary> = Vec::new();
    for entry in state.jobs.iter() {
        let snap = entry.value().snapshot().await;
        out.push(JobSummary {
            job_id: snap.job_id.clone(),
            config_name: snap.config_name.clone(),
            user: snap.user.clone(),
            status: snap.status,
            started_at: snap.started_at,
            finished_at: snap.finished_at,
            job_pct: snap.job_pct,
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out.truncate(20);
    Json(out)
}

pub async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let handle = state
        .jobs
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "job not found".to_string()))?;
    let snap = handle.snapshot().await;
    Ok(Json(serde_json::to_value(snap).unwrap()))
}

pub async fn cancel_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let handle = state
        .jobs
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "job not found".to_string()))?;
    handle.cancel();
    Ok(StatusCode::NO_CONTENT)
}
