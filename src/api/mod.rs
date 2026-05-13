pub mod dto;
pub mod routes;
pub mod ws;

use crate::config::ConnectionsFile;
use crate::orchestrator::JobHandle;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub jobs: Arc<DashMap<String, JobHandle>>,
    pub configs_dir: String,
    pub connections_path: String,
    pub connections: Arc<RwLock<ConnectionsFile>>,
}
