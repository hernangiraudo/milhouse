use crate::config::{Connection, ConnectionKind, ConnectionsFile};
use anyhow::{anyhow, Context, Result};
use duckdb::Connection as DuckConn;
use polars::frame::DataFrame;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

pub type TableStore = Arc<RwLock<HashMap<String, Arc<DataFrame>>>>;

/// Pool de conexiones declaradas en `connections.json`. Abre cada conexión
/// la primera vez que se usa y la deja cacheada por nombre.
pub struct ConnectionPool {
    file: ConnectionsFile,
    cache: Mutex<HashMap<String, Arc<Mutex<DuckConn>>>>,
}

impl ConnectionPool {
    pub fn new(file: ConnectionsFile) -> Self {
        Self {
            file,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn file(&self) -> &ConnectionsFile {
        &self.file
    }

    pub fn default_name(&self) -> Option<&str> {
        self.file.default.as_deref()
    }

    /// Devuelve la conexión DuckDB para el nombre dado (o la default si es None).
    /// Devuelve error si la conexión no existe o si su tipo no es DuckDB.
    pub async fn get_duckdb(&self, name: Option<&str>) -> Result<Arc<Mutex<DuckConn>>> {
        let conn_def = self
            .file
            .resolve(name)
            .map_err(|e| anyhow!("{e}"))?
            .clone();
        let key = conn_def.name.clone();
        let mut cache = self.cache.lock().await;
        if let Some(existing) = cache.get(&key) {
            return Ok(existing.clone());
        }
        let opened = open_duckdb_connection(&conn_def)?;
        let arc = Arc::new(Mutex::new(opened));
        cache.insert(key, arc.clone());
        Ok(arc)
    }
}

fn open_duckdb_connection(conn: &Connection) -> Result<DuckConn> {
    match &conn.kind {
        ConnectionKind::Duckdb { path } => DuckConn::open(path)
            .with_context(|| format!("opening duckdb file at {path} (connection `{}`)", conn.name)),
        ConnectionKind::DuckdbMemory => DuckConn::open_in_memory()
            .with_context(|| format!("opening duckdb in-memory (connection `{}`)", conn.name)),
        ConnectionKind::Postgres { .. } => Err(anyhow!(
            "connection `{}`: Postgres connections are declared but not implemented yet in this MVP",
            conn.name
        )),
        ConnectionKind::Sqlite { .. } => Err(anyhow!(
            "connection `{}`: SQLite connections are declared but not implemented yet in this MVP",
            conn.name
        )),
        ConnectionKind::SqlServer { .. } => Err(anyhow!(
            "connection `{}`: SQL Server connections are declared but not implemented yet in this MVP",
            conn.name
        )),
    }
}

pub struct StepContext {
    pub tables: TableStore,
    pub connections: Arc<ConnectionPool>,
    pub cancel: CancellationToken,
}

impl StepContext {
    pub async fn get_table(&self, name: &str) -> Result<Arc<DataFrame>> {
        let guard = self.tables.read().await;
        guard
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow!("table `{}` not found in store", name))
    }

    pub async fn insert_table(&self, name: String, df: DataFrame) {
        let mut guard = self.tables.write().await;
        guard.insert(name, Arc::new(df));
    }

    /// Atajo: conexión DuckDB default (usada por export y similares).
    pub async fn default_duckdb(&self) -> Result<Arc<Mutex<DuckConn>>> {
        self.connections.get_duckdb(None).await
    }
}
