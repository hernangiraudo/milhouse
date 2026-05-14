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
    /// SQL Server via cliente TDS nativo (`tiberius`). Recomendado por
    /// performance vs ODBC.
    SqlServer {
        host: String,
        #[serde(default = "default_mssql_port")]
        port: u16,
        user: String,
        #[serde(default)]
        password: Option<String>,
        database: String,
        /// Encriptación TLS: "off" | "on" | "required". Default "on".
        #[serde(default = "default_encrypt")]
        encrypt: String,
        /// Acepta cualquier certificado (útil contra instancias con certs
        /// self-signed). Default false.
        #[serde(default)]
        trust_server_certificate: bool,
    },
    /// MySQL / MariaDB via cliente nativo (`mysql_async`).
    Mysql {
        host: String,
        #[serde(default = "default_mysql_port")]
        port: u16,
        user: String,
        #[serde(default)]
        password: Option<String>,
        database: String,
        #[serde(default)]
        ssl: bool,
    },
    /// ODBC: connection string libre del driver instalado. Fallback para
    /// motores sin cliente nativo (Oracle, DB2, etc.).
    Odbc {
        connection_string: String,
    },
}

fn default_pg_port() -> u16 {
    5432
}
fn default_mssql_port() -> u16 {
    1433
}
fn default_mysql_port() -> u16 {
    3306
}
fn default_encrypt() -> String {
    "on".into()
}

impl ConnectionKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            ConnectionKind::Duckdb { .. } => "duckdb",
            ConnectionKind::DuckdbMemory => "duckdb_memory",
            ConnectionKind::Postgres { .. } => "postgres",
            ConnectionKind::Sqlite { .. } => "sqlite",
            ConnectionKind::SqlServer { .. } => "sql_server",
            ConnectionKind::Mysql { .. } => "mysql",
            ConnectionKind::Odbc { .. } => "odbc",
        }
    }
    /// Si esta conexión está realmente soportada por el ejecutor actual.
    pub fn is_implemented(&self) -> bool {
        matches!(
            self,
            ConnectionKind::Duckdb { .. }
                | ConnectionKind::DuckdbMemory
                | ConnectionKind::SqlServer { .. }
                | ConnectionKind::Mysql { .. }
                | ConnectionKind::Odbc { .. }
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
    #[error("connection name cannot be empty")]
    EmptyName,
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

    /// Agrega una conexión nueva. Falla si el nombre ya existe.
    pub fn add(&mut self, c: Connection) -> Result<(), ConnectionsError> {
        let name = c.name.trim().to_string();
        if name.is_empty() {
            return Err(ConnectionsError::EmptyName);
        }
        if self.connections.iter().any(|x| x.name == name) {
            return Err(ConnectionsError::Duplicated(name));
        }
        self.connections.push(Connection { name, ..c });
        Ok(())
    }

    /// Reemplaza una conexión existente. El `current_name` se busca; el
    /// `new` puede tener nuevo nombre, pero si cambia no debe colisionar.
    pub fn update(
        &mut self,
        current_name: &str,
        new: Connection,
    ) -> Result<(), ConnectionsError> {
        let new_name = new.name.trim().to_string();
        if new_name.is_empty() {
            return Err(ConnectionsError::EmptyName);
        }
        let idx = self
            .connections
            .iter()
            .position(|c| c.name == current_name)
            .ok_or_else(|| ConnectionsError::Unknown(current_name.to_string()))?;
        if new_name != current_name
            && self.connections.iter().any(|c| c.name == new_name)
        {
            return Err(ConnectionsError::Duplicated(new_name));
        }
        // Si era la default y cambia de nombre, actualizar la referencia.
        if self.default.as_deref() == Some(current_name) {
            self.default = Some(new_name.clone());
        }
        self.connections[idx] = Connection { name: new_name, ..new };
        Ok(())
    }

    pub fn remove(&mut self, name: &str) -> Result<(), ConnectionsError> {
        let before = self.connections.len();
        self.connections.retain(|c| c.name != name);
        if self.connections.len() == before {
            return Err(ConnectionsError::Unknown(name.to_string()));
        }
        if self.default.as_deref() == Some(name) {
            self.default = None;
        }
        Ok(())
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
