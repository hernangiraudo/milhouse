use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionsFile {
    #[serde(default)]
    pub default: Option<String>,
    pub connections: Vec<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(flatten)]
    pub kind: ConnectionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionKind {
    /// DuckDB persistente en disco.
    Duckdb { path: String },
    /// DuckDB en memoria (efímero, se pierde al cerrar el proceso).
    DuckdbMemory,
    /// Postgres (placeholder, no implementado en este MVP).
    Postgres {
        host: String,
        #[serde(default = "default_pg_port")]
        port: u16,
        user: String,
        #[serde(default)]
        password: Option<String>,
        database: String,
    },
    /// SQLite (placeholder, no implementado en este MVP).
    Sqlite { path: String },
    /// SQL Server (placeholder, no implementado en este MVP).
    SqlServer {
        host: String,
        #[serde(default = "default_mssql_port")]
        port: u16,
        user: String,
        #[serde(default)]
        password: Option<String>,
        database: String,
    },
}

fn default_pg_port() -> u16 {
    5432
}
fn default_mssql_port() -> u16 {
    1433
}

impl ConnectionKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            ConnectionKind::Duckdb { .. } => "duckdb",
            ConnectionKind::DuckdbMemory => "duckdb_memory",
            ConnectionKind::Postgres { .. } => "postgres",
            ConnectionKind::Sqlite { .. } => "sqlite",
            ConnectionKind::SqlServer { .. } => "sql_server",
        }
    }
    /// Si esta conexión está realmente soportada por el ejecutor actual.
    pub fn is_implemented(&self) -> bool {
        matches!(
            self,
            ConnectionKind::Duckdb { .. } | ConnectionKind::DuckdbMemory
        )
    }
}

#[derive(Debug, Error)]
pub enum ConnectionsError {
    #[error("invalid JSON in connections file: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("duplicated connection name: {0}")]
    Duplicated(String),
    #[error("default `{0}` does not match any connection")]
    UnknownDefault(String),
    #[error("connection `{0}` is not defined")]
    Unknown(String),
}

impl ConnectionsFile {
    pub fn from_json_str(s: &str) -> Result<Self, ConnectionsError> {
        let f: Self = serde_json::from_str(s)?;
        f.validate()?;
        Ok(f)
    }

    pub fn validate(&self) -> Result<(), ConnectionsError> {
        let mut seen = std::collections::HashSet::new();
        for c in &self.connections {
            if !seen.insert(c.name.as_str()) {
                return Err(ConnectionsError::Duplicated(c.name.clone()));
            }
        }
        if let Some(d) = &self.default {
            if !seen.contains(d.as_str()) {
                return Err(ConnectionsError::UnknownDefault(d.clone()));
            }
        }
        Ok(())
    }

    pub fn lookup_map(&self) -> HashMap<String, Connection> {
        self.connections
            .iter()
            .map(|c| (c.name.clone(), c.clone()))
            .collect()
    }

    pub fn resolve(&self, name: Option<&str>) -> Result<&Connection, ConnectionsError> {
        let target = name
            .map(String::from)
            .or_else(|| self.default.clone())
            .ok_or_else(|| {
                ConnectionsError::Unknown("(no connection specified, no default)".into())
            })?;
        self.connections
            .iter()
            .find(|c| c.name == target)
            .ok_or(ConnectionsError::Unknown(target))
    }
}
