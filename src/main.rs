use axum::routing::{delete, get, post};
use axum::Router;
use dashmap::DashMap;
use milhouse::api::{public as api_public, routes, ws, AppState};
use milhouse::config::{ConnectionsFile, UsersFile};
use milhouse::engine::ConnectionPool;
use milhouse::runs::RunStore;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Carga variables de entorno desde `.env` en el cwd, si existe.
    // Las vars que ya estén seteadas en el entorno real NO se pisan —
    // dotenvy::dotenv() solo agrega las que falten. Pensado para que el
    // operador pueda dejar `ANTHROPIC_API_KEY=...` y otros secretos en
    // un archivo local que no se commitea (`.env` está en .gitignore;
    // ver `.env.example` para la lista de vars soportadas).
    let dotenv_loaded = dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,milhouse=debug".into()),
        )
        .init();

    if let Some(path) = &dotenv_loaded {
        tracing::info!("loaded env vars from {}", path.display());
    } else {
        tracing::debug!("no .env file found in cwd; using process env only");
    }

    let bind = std::env::var("MILHOUSE_BIND").unwrap_or_else(|_| "0.0.0.0:8090".into());
    let configs_dir = std::env::var("MILHOUSE_CONFIGS_DIR").unwrap_or_else(|_| "configs".into());
    let connections_path = std::env::var("MILHOUSE_CONNECTIONS_PATH")
        .unwrap_or_else(|_| "configs/connections.json".into());
    let users_path =
        std::env::var("MILHOUSE_USERS_PATH").unwrap_or_else(|_| "configs/users.json".into());
    let global_params_path = std::env::var("MILHOUSE_GLOBAL_PARAMS_PATH")
        .unwrap_or_else(|_| "configs/parameters.json".into());
    let global_constants_path = std::env::var("MILHOUSE_GLOBAL_CONSTANTS_PATH")
        .unwrap_or_else(|_| "configs/constants.json".into());

    let connections = load_connections_or_warn(&connections_path);
    let users = load_users_or_warn(&users_path);
    let global_params = milhouse::config::GlobalParamsFile::load_or_empty(
        std::path::Path::new(&global_params_path),
    );
    tracing::info!(
        "loaded {} global parameter(s) and {} preset(s) from {}",
        global_params.parameters.len(),
        global_params.presets.len(),
        global_params_path
    );
    let global_constants = milhouse::config::GlobalConstantsFile::load_or_empty(
        std::path::Path::new(&global_constants_path),
    );
    tracing::info!(
        "loaded {} global constant(s) ({} group/s) from {}",
        global_constants.constants.len(),
        global_constants.groups.len(),
        global_constants_path
    );

    // Pool compartido del servidor (los jobs harán su propio pool actualizado
    // a partir de connections; pero compartimos uno solo para acceso de
    // lectura desde la API de revisión).
    let pool = Arc::new(ConnectionPool::new(connections.clone()));
    let run_store_opt: Option<Arc<RunStore>> = match RunStore::open(&pool).await {
        Ok(opt) => opt.map(Arc::new),
        Err(e) => {
            tracing::warn!("could not initialize runs DB at startup: {e:#}");
            None
        }
    };

    let state = AppState {
        jobs: Arc::new(DashMap::new()),
        configs_dir,
        connections_path: connections_path.clone(),
        connections: Arc::new(RwLock::new(connections)),
        users_path: users_path.clone(),
        users: Arc::new(RwLock::new(users)),
        pool,
        run_store: Arc::new(RwLock::new(run_store_opt)),
        global_params: Arc::new(RwLock::new(global_params)),
        global_params_path: global_params_path.clone(),
        global_constants: Arc::new(RwLock::new(global_constants)),
        global_constants_path: global_constants_path.clone(),
    };

    // Worker que dispara schedules cada minuto (puede correr siempre; chequea
    // el run_store en cada tick).
    milhouse::runs::worker::spawn(state.clone());

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(routes::health))
        .route(
            "/api/configs",
            get(routes::list_configs).post(routes::create_config),
        )
        .route("/api/configs/slug", get(routes::slugify_endpoint))
        .route(
            "/api/configs/:name",
            get(routes::get_config)
                .put(routes::update_config)
                .delete(routes::delete_config),
        )
        .route(
            "/api/connections",
            get(routes::list_connections).post(routes::create_connection),
        )
        .route(
            "/api/connections/reload",
            post(routes::reload_connections),
        )
        .route(
            "/api/connections/:name",
            axum::routing::put(routes::update_connection)
                .delete(routes::delete_connection),
        )
        .route(
            "/api/connections/:name/test",
            post(routes::test_connection_endpoint),
        )
        .route(
            "/api/connections/:name/duplicate",
            post(routes::duplicate_connection),
        )
        .route(
            "/api/connections/:name/tables",
            get(routes::list_tables_endpoint),
        )
        .route(
            "/api/connections/:name/tables/:table/columns",
            get(routes::list_columns_endpoint),
        )
        // API pública de proyectos expuestos
        .route(
            "/api/public/projects/:slug/run",
            post(api_public::run_project),
        )
        .route(
            "/api/public/jobs/:id",
            get(api_public::get_job_status),
        )
        .route("/api/sql/check", post(routes::check_sql_endpoint))
        .route(
            "/api/parameters/parse-excel",
            post(routes::parse_excel_for_param),
        )
        .route(
            "/api/parameters/excel-preview",
            post(routes::excel_preview),
        )
        .route(
            "/api/parameters/excel-import",
            post(routes::excel_import),
        )
        .route(
            "/api/parameters",
            get(routes::get_global_params).put(routes::put_global_params),
        )
        .route(
            "/api/constants",
            get(routes::get_global_constants).put(routes::put_global_constants),
        )
        .route("/api/ai/available", get(routes::ai_available))
        .route("/api/ai/build-step", post(routes::ai_build_step))
        .route("/api/ai/review-sql", post(routes::ai_review_sql))
        .route(
            "/api/registry/procedural",
            get(routes::list_registry_procedural),
        )
        .route(
            "/api/users",
            get(routes::list_users).post(routes::create_user),
        )
        .route("/api/users/:name", delete(routes::delete_user))
        .route("/api/users/reload", post(routes::reload_users))
        .route("/api/jobs", get(routes::list_jobs).post(routes::create_job))
        .route("/api/jobs/:id", get(routes::get_job))
        .route("/api/jobs/:id/cancel", post(routes::cancel_job))
        .route("/api/jobs/:id/drain", post(routes::drain_job))
        .route(
            "/api/jobs/:id/cancel-step/:step_id",
            post(routes::cancel_step),
        )
        .route("/api/jobs/:id/ws", get(ws::ws_handler))
        // Histórico desde la DB de runs
        .route("/api/runs", get(routes::list_run_history))
        .route("/api/runs/health", get(routes::runs_health))
        .route("/api/runs/:id", delete(routes::delete_run))
        .route("/api/runs/:id/steps", get(routes::list_run_steps))
        .route(
            "/api/runs/:id/steps/:uid/logs",
            get(routes::list_run_logs),
        )
        .route("/api/runs/:id/datasets", get(routes::list_run_datasets))
        .route(
            "/api/runs/:id/datasets/:uid/preview",
            get(routes::dataset_preview),
        )
        .route(
            "/api/runs/:id/datasets/:uid/export",
            get(routes::export_dataset),
        )
        .route("/api/runs/:id/bundle", get(routes::export_run_bundle))
        .route(
            "/api/configs/:name/preload",
            get(routes::preload_status)
                .post(routes::import_preload)
                .delete(routes::delete_preload),
        )
        // Roadmap
        .route(
            "/api/roadmap",
            get(routes::list_roadmap).post(routes::create_roadmap_item),
        )
        .route(
            "/api/roadmap/:id",
            axum::routing::patch(routes::update_roadmap_item)
                .delete(routes::delete_roadmap_item),
        )
        .route(
            "/api/roadmap/:id/comments",
            get(routes::list_roadmap_comments).post(routes::add_roadmap_comment),
        )
        // SQL Monitor
        .route("/api/sql-monitor/:connection", get(routes::sql_monitor_list))
        .route(
            "/api/sql-monitor/:connection/kill/:session_id",
            post(routes::sql_monitor_kill),
        )
        // Casos
        .route(
            "/api/cases",
            get(routes::list_cases).post(routes::create_case),
        )
        .route("/api/cases/:id", get(routes::get_case))
        .route("/api/cases/:id/close", post(routes::close_case))
        .route(
            "/api/cases/:id/comments",
            post(routes::add_comment),
        )
        .route(
            "/api/cases/:id/datasets",
            post(routes::attach_dataset),
        )
        // Schedules
        .route(
            "/api/schedules",
            get(routes::list_schedules).post(routes::create_schedule),
        )
        .route(
            "/api/schedules/:id",
            delete(routes::delete_schedule).patch(routes::patch_schedule),
        )
        .with_state(state)
        .layer(cors);

    tracing::info!("milhouse listening on http://{bind}");
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn load_connections_or_warn(path: &str) -> ConnectionsFile {
    let p = PathBuf::from(path);
    match std::fs::read_to_string(&p) {
        Ok(text) => match ConnectionsFile::from_json_str(&text) {
            Ok(file) => {
                tracing::info!(
                    "loaded {} connection(s) from {} (default: {:?})",
                    file.connections.len(),
                    p.display(),
                    file.default
                );
                file
            }
            Err(e) => {
                tracing::error!(
                    "failed to parse {}: {e}. Starting with empty connections.",
                    p.display()
                );
                ConnectionsFile {
                    default: None,
                    connections: Vec::new(),
                }
            }
        },
        Err(_) => {
            tracing::warn!(
                "connections file {} not found; starting with empty connections",
                p.display()
            );
            ConnectionsFile {
                default: None,
                connections: Vec::new(),
            }
        }
    }
}

fn load_users_or_warn(path: &str) -> UsersFile {
    let p = PathBuf::from(path);
    match std::fs::read_to_string(&p) {
        Ok(text) => match UsersFile::from_json_str(&text) {
            Ok(f) => {
                tracing::info!("loaded {} user(s) from {}", f.users.len(), p.display());
                f
            }
            Err(e) => {
                tracing::error!("failed to parse {}: {e}", p.display());
                UsersFile::empty()
            }
        },
        Err(_) => {
            tracing::warn!("users file {} not found; starting empty", p.display());
            UsersFile::empty()
        }
    }
}
