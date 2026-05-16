pub mod dto;
pub mod public;
pub mod routes;
pub mod ws;

use crate::config::{ConnectionsFile, GlobalConstantsFile, GlobalParamsFile, UsersFile};
use crate::engine::ConnectionPool;
use crate::orchestrator::JobHandle;
use crate::runs::RunStore;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub jobs: Arc<DashMap<String, JobHandle>>,
    pub configs_dir: String,
    pub connections_path: String,
    pub connections: Arc<RwLock<ConnectionsFile>>,
    pub users_path: String,
    pub users: Arc<RwLock<UsersFile>>,
    /// Pool de conexiones compartido (incluye la conexión `runs`).
    pub pool: Arc<ConnectionPool>,
    /// Acceso de lectura al histórico de runs. None si la conexión `runs`
    /// no está declarada en connections.json.
    pub run_store: Arc<RwLock<Option<Arc<RunStore>>>>,
    /// Parámetros y respuestas globales (compartidos entre proyectos).
    pub global_params: Arc<RwLock<GlobalParamsFile>>,
    pub global_params_path: String,
    /// Constantes globales (códigos canónicos compartidos entre proyectos).
    pub global_constants: Arc<RwLock<GlobalConstantsFile>>,
    pub global_constants_path: String,
}
