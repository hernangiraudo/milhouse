use axum::routing::{get, post};
use axum::Router;
use dashmap::DashMap;
use milhouse::api::{routes, ws, AppState};
use milhouse::config::ConnectionsFile;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,milhouse=debug".into()),
        )
        .init();

    let bind = std::env::var("MILHOUSE_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let configs_dir = std::env::var("MILHOUSE_CONFIGS_DIR").unwrap_or_else(|_| "configs".into());
    let connections_path = std::env::var("MILHOUSE_CONNECTIONS_PATH")
        .unwrap_or_else(|_| "configs/connections.json".into());

    // Cargar conexiones al inicio. Si el archivo no existe, arrancamos con una
    // lista vacía y registramos un warning: el usuario podrá crearla y recargar
    // con POST /api/connections/reload.
    let connections = load_connections_or_warn(&connections_path);

    let state = AppState {
        jobs: Arc::new(DashMap::new()),
        configs_dir,
        connections_path: connections_path.clone(),
        connections: Arc::new(RwLock::new(connections)),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/configs", get(routes::list_configs))
        .route("/api/configs/:name", get(routes::get_config))
        .route("/api/connections", get(routes::list_connections))
        .route(
            "/api/connections/reload",
            post(routes::reload_connections),
        )
        .route("/api/jobs", get(routes::list_jobs).post(routes::create_job))
        .route("/api/jobs/:id", get(routes::get_job))
        .route("/api/jobs/:id/cancel", post(routes::cancel_job))
        .route("/api/jobs/:id/ws", get(ws::ws_handler))
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
