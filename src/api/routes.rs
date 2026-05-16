use super::{dto::*, AppState};
use crate::config::{ConnectionsFile, EtlConfig, UserDef, UsersFile};
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
    // Archivos en este directorio que NO son configs ETL.
    const NON_ETL: &[&str] = &["connections.json", "users.json"];
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
            // Leer el JSON para obtener el `name` interno como display_name.
            // Lo hacemos de forma defensiva: si falla, usamos el filename.
            let display_name = fs::read_to_string(&p)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| {
                    v.get("name").and_then(|x| x.as_str()).map(|s| s.to_string())
                })
                .unwrap_or_else(|| name.clone());
            out.push(ConfigSummary {
                name,
                path: p.to_string_lossy().to_string(),
                display_name,
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

/// Convierte un nombre amigable a un nombre de archivo seguro
/// (ascii minúscula, espacios → _, sin caracteres raros).
fn slugify_filename(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == '_' || ch == '-' || ch == '.' {
            out.push(ch);
        } else if ch.is_whitespace() || ch == '/' || ch == '\\' {
            out.push('_');
        }
    }
    out
}

const FORBIDDEN_NAMES: &[&str] = &["connections.json", "users.json"];

fn config_path_for(state: &AppState, name: &str) -> std::path::PathBuf {
    std::path::Path::new(&state.configs_dir).join(name)
}

fn validate_filename(name: &str) -> Result<(), (StatusCode, String)> {
    if name.is_empty() || !name.ends_with(".json") {
        return Err((
            StatusCode::BAD_REQUEST,
            "El nombre del archivo debe terminar en .json".into(),
        ));
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Nombre inválido (sin paths)".into(),
        ));
    }
    if FORBIDDEN_NAMES.contains(&name) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("`{name}` es un archivo reservado del sistema"),
        ));
    }
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct UpsertProjectReq {
    /// Para create: nombre del archivo .json. Para edit (PUT): si se manda y
    /// difiere del path, renombra el archivo.
    #[serde(default)]
    pub filename: Option<String>,
    /// Contenido completo del proyecto. Se valida que parsee como EtlConfig.
    pub config: serde_json::Value,
}

/// POST /api/configs - crear proyecto.
pub async fn create_config(
    State(state): State<AppState>,
    Json(req): Json<UpsertProjectReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let filename = req
        .filename
        .clone()
        .ok_or((StatusCode::BAD_REQUEST, "falta filename".into()))?;
    validate_filename(&filename)?;
    let path = config_path_for(&state, &filename);
    if path.exists() {
        return Err((
            StatusCode::CONFLICT,
            format!("`{filename}` ya existe"),
        ));
    }
    // Validar parseo + asignar step_uids.
    let text = serde_json::to_string_pretty(&req.config).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("config no serializable: {e}"),
        )
    })?;
    let mut cfg = EtlConfig::from_json_str(&text)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("config inválido: {e}")))?;
    cfg.ensure_step_uids();
    let out_text = serde_json::to_string_pretty(&cfg).unwrap();
    fs::write(&path, out_text).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write: {e}"),
        )
    })?;
    Ok(Json(json!({ "status": "ok", "filename": filename })))
}

/// PUT /api/configs/:name - reemplaza el contenido. Si `filename` viene en el
/// body y difiere de `name`, renombra el archivo.
pub async fn update_config(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<UpsertProjectReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    validate_filename(&name)?;
    let old_path = config_path_for(&state, &name);
    if !old_path.exists() {
        return Err((StatusCode::NOT_FOUND, format!("`{name}` no existe")));
    }
    let target_name = req.filename.unwrap_or_else(|| name.clone());
    validate_filename(&target_name)?;
    let new_path = config_path_for(&state, &target_name);
    if target_name != name && new_path.exists() {
        return Err((
            StatusCode::CONFLICT,
            format!("`{target_name}` ya existe"),
        ));
    }
    let text = serde_json::to_string_pretty(&req.config).map_err(|e| {
        (StatusCode::BAD_REQUEST, format!("no serializable: {e}"))
    })?;
    let mut cfg = EtlConfig::from_json_str(&text)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("config inválido: {e}")))?;
    cfg.ensure_step_uids();
    let out_text = serde_json::to_string_pretty(&cfg).unwrap();
    fs::write(&new_path, out_text).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("write: {e}"))
    })?;
    if target_name != name {
        let _ = fs::remove_file(&old_path);
    }
    Ok(Json(json!({ "status": "ok", "filename": target_name })))
}

/// DELETE /api/configs/:name - borra el JSON del proyecto.
pub async fn delete_config(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_filename(&name)?;
    let path = config_path_for(&state, &name);
    if !path.exists() {
        return Err((StatusCode::NOT_FOUND, format!("`{name}` no existe")));
    }
    fs::remove_file(&path).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("delete: {e}"))
    })?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/configs/slug?from=Mi+Proyecto → { filename: "mi_proyecto.json" }
/// Útil para sugerir un filename al crear desde la UI sin que el usuario lo tipee.
#[derive(serde::Deserialize)]
pub struct SlugifyQuery {
    pub from: String,
}
pub async fn slugify_endpoint(
    axum::extract::Query(q): axum::extract::Query<SlugifyQuery>,
) -> Json<Value> {
    let s = slugify_filename(&q.from);
    let s = if s.is_empty() { "proyecto".to_string() } else { s };
    Json(json!({ "filename": format!("{s}.json") }))
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
    let job_id = req
        .existing_job_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let run_store = state.run_store.read().await.clone();
    // Si reusamos un job_id existente con subset, limpiamos los step_uids del
    // subset para que la re-ejecución sobreescriba logs/datasets de esos pasos
    // sin tocar los demás.
    if req.existing_job_id.is_some() {
        if let Some(targets) = &req.target_steps {
            if let Some(store) = &run_store {
                let target_uids: Vec<u32> = cfg
                    .steps
                    .iter()
                    .filter(|s| targets.contains(&s.id))
                    .filter_map(|s| s.step_uid)
                    .collect();
                if let Err(e) =
                    store.clear_steps_for_rerun(&job_id, target_uids).await
                {
                    tracing::warn!("clear_steps_for_rerun failed: {e:#}");
                }
            }
        }
    }
    // Si el job_id ya está en memoria (corrida anterior aún registrada), lo
    // sacamos para reemplazarlo con el nuevo handle.
    state.jobs.remove(&job_id);
    let options = crate::orchestrator::scheduler::JobOptions {
        target_steps: req
            .target_steps
            .as_ref()
            .map(|v| v.iter().cloned().collect()),
        stop_on_failure: req.stop_on_failure,
        use_preload: req.use_preload,
    };
    let handle = run_job(
        job_id.clone(),
        req.config_name.clone(),
        req.user.clone(),
        req.debug,
        cfg,
        state.pool.clone(),
        run_store,
        options,
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

pub async fn list_users(State(state): State<AppState>) -> impl IntoResponse {
    let file = state.users.read().await.clone();
    Json(file)
}

pub async fn create_user(
    State(state): State<AppState>,
    Json(u): Json<UserDef>,
) -> Result<Json<UserDef>, (StatusCode, String)> {
    let mut guard = state.users.write().await;
    guard
        .add(u.clone())
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e}")))?;
    let txt = serde_json::to_string_pretty(&*guard).unwrap();
    fs::write(&state.users_path, txt).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(u))
}

pub async fn delete_user(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let mut guard = state.users.write().await;
    guard
        .remove(&name)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("{e}")))?;
    let txt = serde_json::to_string_pretty(&*guard).unwrap();
    fs::write(&state.users_path, txt).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reload_users(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let text = fs::read_to_string(&state.users_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?;
    let parsed = UsersFile::from_json_str(&text)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid users: {e}")))?;
    let n = parsed.users.len();
    *state.users.write().await = parsed;
    Ok(Json(json!({ "status": "ok", "users": n })))
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
    *state.connections.write().await = parsed.clone();
    state.pool.replace_file(parsed).await;
    Ok(Json(json!({ "status": "ok", "connections": count })))
}

// ---------------------------------------------------------------------
// Connections CRUD + test
// ---------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CreateConnectionReq {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Connection spec con flatten: { "type": "duckdb", "path": "..." }, etc.
    pub spec: serde_json::Value,
    #[serde(default)]
    pub make_default: bool,
}

async fn persist_connections(
    state: &AppState,
    file: &ConnectionsFile,
) -> Result<(), (StatusCode, String)> {
    file.validate()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e}")))?;
    let txt = serde_json::to_string_pretty(file).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("serialize: {e}"),
        )
    })?;
    fs::write(&state.connections_path, txt).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write connections file: {e}"),
        )
    })?;
    Ok(())
}

fn parse_connection_payload(
    name: &str,
    description: Option<String>,
    spec: &serde_json::Value,
) -> Result<crate::config::Connection, (StatusCode, String)> {
    // Reconstruimos el JSON completo para que serde respete el flatten:
    // { "name", "description", ...spec }.
    let mut merged = match spec {
        serde_json::Value::Object(_) => spec.clone(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "spec must be an object".into(),
            ));
        }
    };
    if let serde_json::Value::Object(map) = &mut merged {
        map.insert("name".into(), serde_json::Value::String(name.to_string()));
        if let Some(d) = description {
            map.insert("description".into(), serde_json::Value::String(d));
        }
    }
    serde_json::from_value::<crate::config::Connection>(merged).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("invalid connection spec: {e}"),
        )
    })
}

pub async fn create_connection(
    State(state): State<AppState>,
    Json(req): Json<CreateConnectionReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let new_conn = parse_connection_payload(&req.name, req.description, &req.spec)?;
    let mut file = state.connections.read().await.clone();
    file.add(new_conn).map_err(|e| (StatusCode::BAD_REQUEST, format!("{e}")))?;
    if req.make_default {
        file.default = Some(req.name.clone());
    }
    persist_connections(&state, &file).await?;
    state.pool.replace_file(file.clone()).await;
    *state.connections.write().await = file;
    Ok(Json(json!({ "status": "ok", "name": req.name })))
}

#[derive(serde::Deserialize)]
pub struct UpdateConnectionReq {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub spec: serde_json::Value,
    #[serde(default)]
    pub make_default: bool,
}

pub async fn update_connection(
    State(state): State<AppState>,
    Path(current_name): Path<String>,
    Json(req): Json<UpdateConnectionReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Si el body NO trae explícitamente el campo `password` (en los kinds
    // que lo aceptan), conservamos la password de la conexión existente.
    // Esto soporta la convención del front: "input vacío en modo edit =
    // mantener la actual".
    let mut spec_value = req.spec.clone();
    let body_has_password = matches!(&spec_value, serde_json::Value::Object(m) if m.contains_key("password"));
    if !body_has_password {
        let existing = state.connections.read().await.clone();
        if let Some(prev) = existing.connections.iter().find(|c| c.name == current_name) {
            let prev_pwd = match &prev.kind {
                crate::config::ConnectionKind::Postgres { password, .. }
                | crate::config::ConnectionKind::SqlServer { password, .. }
                | crate::config::ConnectionKind::Mysql { password, .. } => password.clone(),
                _ => None,
            };
            if let (Some(pwd), serde_json::Value::Object(m)) = (prev_pwd, &mut spec_value) {
                m.insert("password".into(), serde_json::Value::String(pwd));
            }
        }
    }
    let new_conn = parse_connection_payload(&req.name, req.description, &spec_value)?;
    let mut file = state.connections.read().await.clone();
    file.update(&current_name, new_conn)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e}")))?;
    if req.make_default {
        file.default = Some(req.name.clone());
    }
    persist_connections(&state, &file).await?;
    state.pool.replace_file(file.clone()).await;
    *state.connections.write().await = file;
    Ok(Json(json!({ "status": "ok", "name": req.name })))
}

pub async fn delete_connection(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let mut file = state.connections.read().await.clone();
    file.remove(&name)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("{e}")))?;
    persist_connections(&state, &file).await?;
    state.pool.replace_file(file.clone()).await;
    *state.connections.write().await = file;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct TestConnectionReq {
    /// Si se pasa, prueba esa conexión (no persistida). Si no, se prueba
    /// la conexión con `name = path-param`.
    #[serde(default)]
    pub spec: Option<serde_json::Value>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

// ----- Registry de funciones Rust procedural -----

pub async fn list_registry_procedural(
    State(_state): State<AppState>,
) -> Json<Value> {
    let names = crate::scripting::rust_registry::global().names();
    Json(json!({ "functions": names }))
}

// ----- Milhouse-AI -----

pub async fn ai_build_step(
    State(_state): State<AppState>,
    Json(req): Json<crate::ai::BuildStepReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    match crate::ai::build_step(req).await {
        Ok(r) => Ok(Json(serde_json::to_value(r).unwrap())),
        Err(e) => Err((StatusCode::BAD_REQUEST, format!("{e:#}"))),
    }
}

pub async fn ai_review_sql(
    State(_state): State<AppState>,
    Json(req): Json<crate::ai::ReviewSqlReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    match crate::ai::review_sql(req).await {
        Ok(r) => Ok(Json(serde_json::to_value(r).unwrap())),
        Err(e) => Err((StatusCode::BAD_REQUEST, format!("{e:#}"))),
    }
}

pub async fn ai_available(State(_state): State<AppState>) -> Json<Value> {
    let configured = std::env::var("ANTHROPIC_API_KEY").is_ok();
    Json(json!({ "available": configured }))
}

// ----- Introspection -----

pub async fn list_tables_endpoint(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let tables = crate::engine::introspect::list_tables(&state.pool, &name)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(tables).unwrap()))
}

#[derive(serde::Deserialize)]
pub struct ColumnsQuery {
    #[serde(default)]
    pub schema: Option<String>,
}

pub async fn list_columns_endpoint(
    State(state): State<AppState>,
    Path((name, table)): Path<(String, String)>,
    axum::extract::Query(q): axum::extract::Query<ColumnsQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let cols = crate::engine::introspect::list_columns(
        &state.pool,
        &name,
        &table,
        q.schema.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(cols).unwrap()))
}

pub async fn test_connection_endpoint(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<TestConnectionReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Si vino spec en el body, usamos esa (probar antes de guardar).
    // Si no, buscamos por nombre en el AppState.
    let conn: crate::config::Connection = match req.spec {
        Some(spec) => parse_connection_payload(
            req.name.as_deref().unwrap_or(&name),
            req.description,
            &spec,
        )?,
        None => {
            let file = state.connections.read().await.clone();
            file.connections
                .into_iter()
                .find(|c| c.name == name)
                .ok_or_else(|| {
                    (
                        StatusCode::NOT_FOUND,
                        format!("connection `{name}` not found"),
                    )
                })?
        }
    };
    match crate::engine::test_connection(&conn).await {
        Ok(r) => Ok(Json(serde_json::to_value(r).unwrap())),
        Err(e) => Ok(Json(json!({
            "ok": false,
            "error": format!("{e:#}")
        }))),
    }
}

#[derive(serde::Deserialize)]
pub struct CheckSqlReq {
    pub sql: String,
    #[serde(default)]
    pub connection: Option<String>,
}

/// POST /api/sql/check — prepara la sentencia contra la conexión indicada
/// (sin ejecutarla) y devuelve si pasó el parse + bind. Para motores que no
/// soportan prepare "barato", devuelve `supported=false` y no falla.
pub async fn check_sql_endpoint(
    State(state): State<AppState>,
    Json(req): Json<CheckSqlReq>,
) -> Json<Value> {
    let sql_trimmed = req.sql.trim().to_string();
    if sql_trimmed.is_empty() {
        return Json(json!({ "ok": false, "error": "SQL vacío" }));
    }
    let opened = match state.pool.get_any(req.connection.as_deref()).await {
        Ok(o) => o,
        Err(e) => {
            return Json(json!({
                "ok": false,
                "error": format!("conexión: {e:#}"),
            }))
        }
    };
    match &*opened {
        crate::engine::OpenedConnection::Duckdb(conn) => {
            let conn = conn.clone();
            // Corremos el prepare en thread blocking con timeout. Si la
            // conexión está bloqueada por otra operación, cortamos sin colgar
            // el server.
            let prepare_future = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let guard = conn.blocking_lock();
                guard.prepare(&sql_trimmed).map(|_| ()).map_err(|e| format!("{e}"))
            });
            let res = tokio::time::timeout(std::time::Duration::from_secs(4), prepare_future).await;
            match res {
                Ok(Ok(Ok(()))) => Json(json!({ "ok": true, "supported": true })),
                Ok(Ok(Err(e))) => {
                    if e.contains("device or resource busy")
                        || e.contains("resource busy")
                    {
                        Json(json!({
                            "ok": true,
                            "supported": false,
                            "note": "la conexión está ocupada — no se pudo chequear sintaxis ahora",
                        }))
                    } else {
                        Json(json!({ "ok": false, "error": e, "supported": true }))
                    }
                }
                Ok(Err(e)) => Json(json!({ "ok": false, "error": format!("task: {e}") })),
                Err(_) => Json(json!({
                    "ok": true,
                    "supported": false,
                    "note": "timeout: la conexión no respondió en 4s (probablemente ocupada con otra operación)",
                })),
            }
        }
        _ => Json(json!({
            "ok": true,
            "supported": false,
            "note": "el chequeo de sintaxis solo está disponible para conexiones DuckDB",
        })),
    }
}

pub async fn list_jobs(State(state): State<AppState>) -> impl IntoResponse {
    let mut out: Vec<JobSummary> = Vec::new();
    for entry in state.jobs.iter() {
        let snap = entry.value().snapshot().await;
        out.push(JobSummary {
            job_id: snap.job_id.clone(),
            config_name: snap.config_name.clone(),
            config_display_name: snap.config_display_name.clone(),
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

// ---------------------------------------------------------------------
// Revisión de runs (histórico desde la DB de runs)
// ---------------------------------------------------------------------

async fn run_store_or_503(
    state: &AppState,
) -> Result<std::sync::Arc<crate::runs::RunStore>, (StatusCode, String)> {
    let guard = state.run_store.read().await;
    guard
        .clone()
        .ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "runs DB not configured (declare connection `runs` in connections.json)".into(),
        ))
}

pub async fn list_run_history(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let res = store
        .query(
            "SELECT job_id, config_name, config_display_name, user_name, debug, status, started_at, finished_at, duration_ms, total_steps FROM runs ORDER BY started_at DESC LIMIT 100".into(),
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(res).unwrap()))
}

pub async fn list_run_steps(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let escaped = id.replace('\'', "''");
    let sql = format!(
        "SELECT step_uid, step_id, kind, group_name, status, started_at, finished_at, duration_ms, row_count, error
         FROM step_runs WHERE job_id = '{escaped}' ORDER BY started_at NULLS LAST, step_uid"
    );
    let res = store
        .query(sql)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(res).unwrap()))
}

pub async fn list_run_logs(
    State(state): State<AppState>,
    Path((id, uid)): Path<(String, u32)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let escaped = id.replace('\'', "''");
    let sql = format!(
        "SELECT ts, level, line FROM step_logs WHERE job_id = '{escaped}' AND step_uid = {uid} ORDER BY ts"
    );
    let res = store
        .query(sql)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(res).unwrap()))
}

pub async fn list_run_datasets(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let escaped = id.replace('\'', "''");
    let sql = format!(
        "SELECT step_uid, name, level, table_name, row_count, size_bytes, created_at FROM step_datasets WHERE job_id = '{escaped}' ORDER BY step_uid"
    );
    let res = store
        .query(sql)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(res).unwrap()))
}

#[derive(serde::Deserialize)]
pub struct PreviewQuery {
    #[serde(default = "default_preview_limit")]
    pub limit: usize,
}
fn default_preview_limit() -> usize {
    100
}

pub async fn dataset_preview(
    State(state): State<AppState>,
    Path((id, uid)): Path<(String, u32)>,
    axum::extract::Query(q): axum::extract::Query<PreviewQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let res = store
        .dataset_preview(&id, uid, q.limit)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(res).unwrap()))
}

pub async fn delete_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    // Validar: si el run tiene datasets asociados a casos abiertos, bloquear.
    let open_cases = store
        .open_cases_for_run(&id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    if !open_cases.is_empty() {
        return Err((
            StatusCode::CONFLICT,
            serde_json::to_string(&json!({
                "error": "open_cases_block_delete",
                "message": "El run tiene datasets adjuntos a casos abiertos. Cerralos antes de eliminar.",
                "open_cases": open_cases,
            }))
            .unwrap(),
        ));
    }
    store
        .delete_run(&id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    state.jobs.remove(&id);
    Ok(Json(json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CreateCaseReq {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_severity")]
    pub severity: String,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    /// Datasets a adjuntar al crear (atajo: `attach: [{job_id, step_uid}]`).
    #[serde(default)]
    pub attach: Vec<AttachRef>,
}
#[derive(serde::Deserialize)]
pub struct AttachRef {
    pub job_id: String,
    pub step_uid: u32,
}
fn default_severity() -> String {
    "medium".into()
}

pub async fn list_cases(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let res = store
        .query(
            "SELECT c.id, c.title, c.severity, c.assignee, c.creator, c.status, c.created_at, c.closed_at, c.closed_by,
                    (SELECT COUNT(*) FROM case_comments cm WHERE cm.case_id = c.id) AS comments_count,
                    (SELECT COUNT(*) FROM case_datasets cd WHERE cd.case_id = c.id) AS datasets_count
             FROM cases c ORDER BY c.created_at DESC".into(),
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(res).unwrap()))
}

pub async fn get_case(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let header = store
        .query(format!(
            "SELECT id, title, description, severity, assignee, creator, status, created_at, closed_at, closed_by
             FROM cases WHERE id = {id}"
        ))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    if header.rows.is_empty() {
        return Err((StatusCode::NOT_FOUND, "case not found".into()));
    }
    let comments = store
        .query(format!(
            "SELECT id, author, body, created_at FROM case_comments WHERE case_id = {id} ORDER BY created_at"
        ))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    let datasets = store
        .query(format!(
            "SELECT cd.job_id, cd.step_uid, cd.added_at, cd.added_by,
                    sd.name AS dataset_name, sd.level, sd.row_count, sd.size_bytes,
                    r.config_display_name, r.config_name
             FROM case_datasets cd
             LEFT JOIN step_datasets sd ON sd.job_id = cd.job_id AND sd.step_uid = cd.step_uid
             LEFT JOIN runs r ON r.job_id = cd.job_id
             WHERE cd.case_id = {id}
             ORDER BY cd.added_at"
        ))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(json!({
        "header": header,
        "comments": comments,
        "datasets": datasets,
    })))
}

pub async fn create_case(
    State(state): State<AppState>,
    Json(req): Json<CreateCaseReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let id = store
        .create_case(
            req.title.trim().to_string(),
            req.description,
            req.severity,
            req.assignee,
            req.creator.clone(),
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    for a in req.attach {
        store
            .attach_dataset(id, a.job_id, a.step_uid, req.creator.clone())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    }
    Ok(Json(json!({ "id": id })))
}

pub async fn close_case(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let by = body.get("user").and_then(|v| v.as_str()).map(String::from);
    store
        .close_case(id, by)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct AddCommentReq {
    pub body: String,
    #[serde(default)]
    pub author: Option<String>,
}
pub async fn add_comment(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<AddCommentReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if req.body.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty comment body".into()));
    }
    let store = run_store_or_503(&state).await?;
    let cid = store
        .add_comment(id, req.author, req.body)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(json!({ "id": cid })))
}

#[derive(serde::Deserialize)]
pub struct AttachReq {
    pub job_id: String,
    pub step_uid: u32,
    #[serde(default)]
    pub added_by: Option<String>,
}
// ---------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CreateScheduleReq {
    pub name: String,
    pub config_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub spec: serde_json::Value,
    #[serde(default)]
    pub created_by: Option<String>,
}
fn default_true() -> bool {
    true
}

pub async fn list_schedules(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let schedules = store
        .all_schedules()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    // Devolvemos también el spec ya parseado para la UI.
    let out: Vec<Value> = schedules
        .into_iter()
        .map(|s| {
            let spec: Value =
                serde_json::from_str(&s.spec_json).unwrap_or(Value::Null);
            json!({
                "id": s.id,
                "name": s.name,
                "config_name": s.config_name,
                "enabled": s.enabled,
                "spec": spec,
                "created_by": s.created_by,
                "created_at": s.created_at,
                "last_fired_at": s.last_fired_at,
            })
        })
        .collect();
    Ok(Json(json!({ "schedules": out })))
}

pub async fn create_schedule(
    State(state): State<AppState>,
    Json(req): Json<CreateScheduleReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    // Validar el spec: debe ser un ScheduleSpec parseable.
    let parsed: Result<crate::runs::ScheduleSpec, _> =
        serde_json::from_value(req.spec.clone());
    if let Err(e) = parsed {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("invalid schedule spec: {e}"),
        ));
    }
    // Validar config_name existe.
    let cfg_path = std::path::Path::new(&state.configs_dir).join(&req.config_name);
    if !cfg_path.exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("config '{}' not found", req.config_name),
        ));
    }
    let spec_json = serde_json::to_string(&req.spec).unwrap();
    let id = store
        .create_schedule(
            req.name,
            req.config_name,
            spec_json,
            req.created_by,
            req.enabled,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(json!({ "id": id })))
}

#[derive(serde::Deserialize)]
pub struct PatchScheduleReq {
    pub enabled: bool,
}
pub async fn patch_schedule(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<PatchScheduleReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    store
        .set_schedule_enabled(id, req.enabled)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_schedule(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    store
        .delete_schedule(id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn attach_dataset(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<AttachReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    store
        .attach_dataset(id, req.job_id, req.step_uid, req.added_by)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------
// Export de datasets
// ---------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct ExportQuery {
    #[serde(default = "default_export_format")]
    pub format: String,
}
fn default_export_format() -> String {
    "csv".into()
}

pub async fn export_dataset(
    State(state): State<AppState>,
    Path((id, uid)): Path<(String, u32)>,
    axum::extract::Query(q): axum::extract::Query<ExportQuery>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    use axum::http::header;
    let store = run_store_or_503(&state).await?;
    let mut df = store
        .dataset_full_df(&id, uid)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    // Nombre del archivo: usa name del dataset.
    let meta = store
        .query(format!(
            "SELECT name FROM step_datasets WHERE job_id = '{}' AND step_uid = {uid}",
            id.replace('\'', "''")
        ))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    let ds_name = meta
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|v| v.as_str())
        .unwrap_or("dataset")
        .to_string();
    let safe_name = ds_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect::<String>();
    let format = q.format.to_ascii_lowercase();
    match format.as_str() {
        "csv" => {
            use polars::prelude::{CsvWriter, SerWriter};
            let mut buf: Vec<u8> = Vec::new();
            CsvWriter::new(&mut buf)
                .finish(&mut df)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?;
            Ok(axum::response::Response::builder()
                .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
                .header(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{safe_name}.csv\""),
                )
                .body(axum::body::Body::from(buf))
                .unwrap())
        }
        "xlsx" | "excel" => {
            let bytes = df_to_xlsx(&df)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
            Ok(axum::response::Response::builder()
                .header(
                    header::CONTENT_TYPE,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
                .header(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{safe_name}.xlsx\""),
                )
                .body(axum::body::Body::from(bytes))
                .unwrap())
        }
        other => Err((
            StatusCode::BAD_REQUEST,
            format!("unsupported format: {other}; use csv or xlsx"),
        )),
    }
}

fn df_to_xlsx(df: &polars::prelude::DataFrame) -> anyhow::Result<Vec<u8>> {
    use polars::prelude::AnyValue;
    use rust_xlsxwriter::Workbook;
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    let cols = df.get_columns();
    for (col_idx, c) in cols.iter().enumerate() {
        ws.write_string(0, col_idx as u16, c.name().as_str())?;
    }
    let n = df.height();
    for i in 0..n {
        for (col_idx, c) in cols.iter().enumerate() {
            let v = c.get(i).ok();
            let row = (i + 1) as u32;
            let col = col_idx as u16;
            match v {
                None | Some(AnyValue::Null) => {}
                Some(AnyValue::Boolean(b)) => {
                    ws.write_boolean(row, col, b)?;
                }
                Some(AnyValue::Int8(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::Int16(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::Int32(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::Int64(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::UInt8(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::UInt16(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::UInt32(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::UInt64(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::Float32(x)) => {
                    ws.write_number(row, col, x as f64)?;
                }
                Some(AnyValue::Float64(x)) => {
                    ws.write_number(row, col, x)?;
                }
                Some(AnyValue::String(s)) => {
                    ws.write_string(row, col, s)?;
                }
                Some(AnyValue::StringOwned(s)) => {
                    ws.write_string(row, col, s.as_str())?;
                }
                Some(other) => {
                    ws.write_string(row, col, &other.to_string())?;
                }
            }
        }
    }
    let bytes = wb.save_to_buffer()?;
    Ok(bytes)
}

// =====================================================================
// Bundles de datasets (export / import / preload status)
// =====================================================================

/// GET /api/runs/:id/bundle  → application/zip
/// Devuelve un .zip con todos los datasets persistidos del run.
pub async fn export_run_bundle(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    use axum::http::header;
    let store = run_store_or_503(&state).await?;
    // Buscar el config_name del run para meterlo en el manifest.
    let meta = store
        .query(format!(
            "SELECT config_name, config_display_name FROM runs WHERE job_id = '{}'",
            id.replace('\'', "''")
        ))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    let (cfg_name, cfg_display) = match meta.rows.first() {
        Some(r) => {
            let c = r.first().and_then(|v| v.as_str()).map(String::from);
            let d = r.get(1).and_then(|v| v.as_str()).map(String::from);
            (c, d)
        }
        None => (None, None),
    };
    let zip = crate::runs::bundle::build_bundle(
        store.clone(),
        &id,
        cfg_name.as_deref(),
        cfg_display.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    let filename = format!(
        "milhouse_bundle_{}_{}.zip",
        cfg_name.as_deref().unwrap_or("run"),
        &id.replace('-', "")[..8.min(id.len())]
    );
    Ok(axum::response::Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(axum::body::Body::from(zip))
        .unwrap())
}

/// POST /api/configs/:name/preload  (body: application/zip)
/// Importa un bundle como precarga para ese config.
pub async fn import_preload(
    State(_state): State<AppState>,
    Path(name): Path<String>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (manifest, target) = crate::runs::bundle::import_bundle(&body, &name)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid bundle: {e:#}")))?;
    Ok(Json(json!({
        "status": "ok",
        "manifest": manifest,
        "target_dir": target.display().to_string(),
    })))
}

/// DELETE /api/configs/:name/preload  → quita el preload guardado.
pub async fn delete_preload(
    Path(name): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let dir = std::path::Path::new("data")
        .join("preloaded")
        .join(sanitize_for_path(&name));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?;
    }
    Ok(Json(json!({ "status": "ok" })))
}

/// GET /api/configs/:name/preload  → estado del preload.
pub async fn preload_status(Path(name): Path<String>) -> Json<Value> {
    let has = crate::runs::bundle::has_preload(&name);
    let steps = crate::runs::bundle::preloaded_step_ids(&name);
    Json(json!({ "has_preload": has, "preloaded_step_ids": steps }))
}

fn sanitize_for_path(s: &str) -> String {
    s.trim_end_matches(".json")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

// =====================================================================
// Roadmap (pedidos de mejora)
// =====================================================================

#[derive(serde::Deserialize)]
pub struct CreateRoadmapReq {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_roadmap_severity")]
    pub severity: String,
    #[serde(default)]
    pub created_by: Option<String>,
}
fn default_roadmap_severity() -> String {
    "normal".into()
}

pub async fn list_roadmap(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let r = store
        .query(
            "SELECT i.id, i.title, i.description, i.severity, i.status,
                    i.created_by, i.created_at, i.updated_at,
                    (SELECT COUNT(*) FROM roadmap_comments c WHERE c.item_id = i.id) AS comments_count
             FROM roadmap_items i ORDER BY i.created_at DESC"
                .into(),
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(r).unwrap()))
}

pub async fn create_roadmap_item(
    State(state): State<AppState>,
    Json(req): Json<CreateRoadmapReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let id = store
        .create_roadmap_item(req.title, req.description, req.severity, req.created_by)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(json!({ "id": id })))
}

#[derive(serde::Deserialize, Default)]
pub struct UpdateRoadmapReq {
    #[serde(default)]
    pub title: Option<String>,
    /// `Some(None)` borra la descripción; `Some(Some(s))` la cambia; `None` no toca.
    #[serde(default, deserialize_with = "deserialize_optional_optional_string")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

fn deserialize_optional_optional_string<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let v = serde_json::Value::deserialize(deserializer)?;
    match v {
        serde_json::Value::Null => Ok(Some(None)),
        serde_json::Value::String(s) => Ok(Some(Some(s))),
        _ => Err(serde::de::Error::custom(
            "description debe ser string o null",
        )),
    }
}

pub async fn update_roadmap_item(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateRoadmapReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    store
        .update_roadmap_item(id, req.title, req.description, req.severity, req.status)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_roadmap_item(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    store
        .delete_roadmap_item(id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct AddRoadmapCommentReq {
    pub body: String,
    #[serde(default)]
    pub author: Option<String>,
}

pub async fn list_roadmap_comments(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let r = store
        .list_roadmap_comments(id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(r).unwrap()))
}

pub async fn add_roadmap_comment(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<AddRoadmapCommentReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let store = run_store_or_503(&state).await?;
    let cid = store
        .add_roadmap_comment(id, req.author, req.body)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(json!({ "id": cid })))
}
