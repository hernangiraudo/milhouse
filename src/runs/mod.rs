//! DB de runs: persistencia de jobs, steps, logs y datasets debug.
//!
//! La conexión se obtiene del `ConnectionPool` por nombre (por defecto `runs`),
//! lo que permite que el operador la reubique a otro path o motor cambiando
//! `connections.json`.

use crate::engine::ConnectionPool;
use crate::orchestrator::state::{JobStatus, LogLine, StepRuntimeState};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use duckdb::{params, Connection};
use polars::frame::DataFrame;
use std::sync::Arc;
use tokio::sync::Mutex;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS runs (
    job_id           VARCHAR PRIMARY KEY,
    config_name      VARCHAR NOT NULL,
    user_name        VARCHAR,
    debug            BOOLEAN NOT NULL DEFAULT FALSE,
    status           VARCHAR NOT NULL,
    started_at       TIMESTAMP NOT NULL,
    finished_at      TIMESTAMP,
    duration_ms      BIGINT,
    total_steps      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS step_runs (
    job_id           VARCHAR NOT NULL,
    step_uid         INTEGER NOT NULL,
    step_id          VARCHAR NOT NULL,
    kind             VARCHAR NOT NULL,
    group_name       VARCHAR,
    status           VARCHAR NOT NULL,
    started_at       TIMESTAMP,
    finished_at      TIMESTAMP,
    duration_ms      BIGINT,
    row_count        BIGINT,
    error            VARCHAR,
    PRIMARY KEY (job_id, step_uid)
);

CREATE TABLE IF NOT EXISTS step_logs (
    job_id           VARCHAR NOT NULL,
    step_uid         INTEGER NOT NULL,
    ts               TIMESTAMP NOT NULL,
    level            VARCHAR NOT NULL,
    line             VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS step_datasets (
    job_id           VARCHAR NOT NULL,
    step_uid         INTEGER NOT NULL,
    table_name       VARCHAR NOT NULL,
    row_count        BIGINT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    created_at       TIMESTAMP NOT NULL,
    PRIMARY KEY (job_id, step_uid)
);

CREATE INDEX IF NOT EXISTS idx_step_runs_job ON step_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_step_logs_job_step ON step_logs(job_id, step_uid);
"#;

/// Nombre lógico de la conexión usada para la DB de runs. Definida en
/// `connections.json`. Si no existe, el RunStore se desactiva silenciosamente.
pub const RUNS_CONNECTION: &str = "runs";

pub struct RunStore {
    conn: Arc<Mutex<Connection>>,
}

impl RunStore {
    /// Inicializa el store: pide la conexión `runs` al pool y aplica el schema.
    /// Si la conexión no está declarada, devuelve `Ok(None)` y el resto del
    /// sistema sigue funcionando sin persistencia de runs (con un warning).
    pub async fn open(pool: &ConnectionPool) -> Result<Option<Self>> {
        match pool.get_duckdb(Some(RUNS_CONNECTION)).await {
            Ok(conn) => {
                {
                    let guard = conn.lock().await;
                    guard
                        .execute_batch(SCHEMA_SQL)
                        .context("initializing runs schema")?;
                }
                Ok(Some(Self { conn }))
            }
            Err(e) => {
                tracing::warn!(
                    "runs DB not configured ({e}); job/step history will not be persisted"
                );
                Ok(None)
            }
        }
    }

    pub async fn insert_run(
        &self,
        job_id: &str,
        config_name: &str,
        user: Option<&str>,
        debug: bool,
        started_at: DateTime<Utc>,
        total_steps: usize,
    ) -> Result<()> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        let config_name = config_name.to_string();
        let user = user.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            guard.execute(
                "INSERT INTO runs (job_id, config_name, user_name, debug, status, started_at, total_steps)
                 VALUES (?, ?, ?, ?, 'running', ?, ?)",
                params![
                    job_id,
                    config_name,
                    user,
                    debug,
                    started_at.naive_utc().to_string(),
                    total_steps as i64
                ],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn finish_run(
        &self,
        job_id: &str,
        status: JobStatus,
        finished_at: DateTime<Utc>,
        duration_ms: u128,
    ) -> Result<()> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        let status_str = format!("{status:?}").to_lowercase();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            guard.execute(
                "UPDATE runs SET status = ?, finished_at = ?, duration_ms = ? WHERE job_id = ?",
                params![
                    status_str,
                    finished_at.naive_utc().to_string(),
                    duration_ms as i64,
                    job_id
                ],
            )?;
            Ok(())
        })
        .await?
    }

    /// Inserta o actualiza el row de un step. Se llama cuando el step termina
    /// (done/failed/cancelled/skipped).
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_step_run(
        &self,
        job_id: &str,
        step_uid: u32,
        step_id: &str,
        kind: &str,
        group: Option<&str>,
        state: &StepRuntimeState,
    ) -> Result<()> {
        let (status, started_at, finished_at, duration_ms, row_count, error) =
            extract_step_fields(state);
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        let step_id = step_id.to_string();
        let kind = kind.to_string();
        let group = group.map(|s| s.to_string());
        let status = status.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            // upsert manual (DuckDB no soporta ON CONFLICT en todas las versiones).
            guard.execute(
                "DELETE FROM step_runs WHERE job_id = ? AND step_uid = ?",
                params![job_id, step_uid as i64],
            )?;
            guard.execute(
                "INSERT INTO step_runs (job_id, step_uid, step_id, kind, group_name, status, started_at, finished_at, duration_ms, row_count, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    job_id,
                    step_uid as i64,
                    step_id,
                    kind,
                    group,
                    status,
                    started_at.map(|t: DateTime<Utc>| t.naive_utc().to_string()),
                    finished_at.map(|t: DateTime<Utc>| t.naive_utc().to_string()),
                    duration_ms.map(|d| d as i64),
                    row_count.map(|n| n as i64),
                    error
                ],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn append_logs(
        &self,
        job_id: &str,
        step_uid: u32,
        logs: Vec<LogLine>,
    ) -> Result<()> {
        if logs.is_empty() {
            return Ok(());
        }
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            let mut app = guard.appender("step_logs")?;
            for l in &logs {
                app.append_row(params![
                    job_id,
                    step_uid as i64,
                    l.at.naive_utc().to_string(),
                    l.level,
                    l.line
                ])?;
            }
            Ok(())
        })
        .await?
    }

    /// Persiste el DataFrame resultante de un step en una tabla nombrada y
    /// registra la entrada en `step_datasets`.
    pub async fn persist_dataset(
        &self,
        job_id: &str,
        step_uid: u32,
        df: &DataFrame,
    ) -> Result<()> {
        let table_name = format!(
            "ds_{}_{}",
            job_id.replace('-', "").chars().take(12).collect::<String>(),
            step_uid
        );
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        let df = df.clone();
        let row_count = df.height();
        let approx_bytes = approx_bytes(&df);

        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            // Crear tabla con CREATE TABLE AS SELECT * FROM df (insert by rows;
            // para MVP no usamos Arrow zero-copy, hacemos appender por row).
            create_table_from_df(&guard, &table_name, &df)?;
            insert_df_rows(&guard, &table_name, &df)?;

            guard.execute(
                "DELETE FROM step_datasets WHERE job_id = ? AND step_uid = ?",
                params![job_id, step_uid as i64],
            )?;
            guard.execute(
                "INSERT INTO step_datasets (job_id, step_uid, table_name, row_count, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    job_id,
                    step_uid as i64,
                    table_name,
                    row_count as i64,
                    approx_bytes as i64,
                    Utc::now().naive_utc().to_string()
                ],
            )?;
            Ok(())
        })
        .await?
    }
}

fn extract_step_fields(
    state: &StepRuntimeState,
) -> (
    &'static str,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Option<u128>,
    Option<usize>,
    Option<String>,
) {
    match state {
        StepRuntimeState::Pending => ("pending", None, None, None, None, None),
        StepRuntimeState::Ready => ("ready", None, None, None, None, None),
        StepRuntimeState::Running { started_at, .. } => {
            ("running", Some(*started_at), None, None, None, None)
        }
        StepRuntimeState::Done {
            started_at,
            finished_at,
            duration_ms,
            row_count,
        } => (
            "done",
            Some(*started_at),
            Some(*finished_at),
            Some(*duration_ms),
            Some(*row_count),
            None,
        ),
        StepRuntimeState::Failed {
            started_at,
            finished_at,
            error,
        } => (
            "failed",
            *started_at,
            Some(*finished_at),
            None,
            None,
            Some(error.clone()),
        ),
        StepRuntimeState::Cancelled => ("cancelled", None, None, None, None, None),
        StepRuntimeState::Skipped { reason } => {
            ("skipped", None, None, None, None, Some(reason.clone()))
        }
    }
}

fn approx_bytes(df: &DataFrame) -> usize {
    use polars::prelude::DataType;
    let rows = df.height();
    let mut total = 0usize;
    for c in df.get_columns() {
        let per: usize = match c.dtype() {
            DataType::Boolean => 1,
            DataType::Int8 | DataType::UInt8 => 1,
            DataType::Int16 | DataType::UInt16 => 2,
            DataType::Int32 | DataType::UInt32 | DataType::Float32 | DataType::Date => 4,
            DataType::Int64
            | DataType::UInt64
            | DataType::Float64
            | DataType::Datetime(_, _) => 8,
            DataType::String => 24, // estimación: punteros + promedio ~16 bytes/string
            _ => 16,
        };
        total = total.saturating_add(per.saturating_mul(rows));
    }
    total
}

fn create_table_from_df(conn: &Connection, table: &str, df: &DataFrame) -> Result<()> {
    use polars::prelude::DataType;
    let cols: Vec<String> = df
        .schema()
        .iter()
        .map(|(name, dtype)| {
            let sql_type = match dtype {
                DataType::Boolean => "BOOLEAN",
                DataType::Int8 | DataType::Int16 | DataType::Int32 => "INTEGER",
                DataType::Int64 => "BIGINT",
                DataType::UInt8 | DataType::UInt16 | DataType::UInt32 => "UINTEGER",
                DataType::UInt64 => "UBIGINT",
                DataType::Float32 => "REAL",
                DataType::Float64 => "DOUBLE",
                DataType::Date => "DATE",
                DataType::Datetime(_, _) => "TIMESTAMP",
                _ => "VARCHAR",
            };
            format!("\"{name}\" {sql_type}")
        })
        .collect();
    let sql = format!(
        "CREATE OR REPLACE TABLE \"{table}\" ({});",
        cols.join(", ")
    );
    conn.execute_batch(&sql)?;
    Ok(())
}

fn insert_df_rows(conn: &Connection, table: &str, df: &DataFrame) -> Result<()> {
    use polars::prelude::AnyValue;
    let mut app = conn.appender(table)?;
    let cols = df.get_columns();
    let n = df.height();
    let width = df.width();
    for i in 0..n {
        let row_vals: Vec<duckdb::types::Value> = (0..width)
            .map(|c| match cols[c].get(i).ok() {
                None | Some(AnyValue::Null) => duckdb::types::Value::Null,
                Some(AnyValue::Boolean(b)) => duckdb::types::Value::Boolean(b),
                Some(AnyValue::Int8(v)) => duckdb::types::Value::TinyInt(v),
                Some(AnyValue::Int16(v)) => duckdb::types::Value::SmallInt(v),
                Some(AnyValue::Int32(v)) => duckdb::types::Value::Int(v),
                Some(AnyValue::Int64(v)) => duckdb::types::Value::BigInt(v),
                Some(AnyValue::UInt8(v)) => duckdb::types::Value::UTinyInt(v),
                Some(AnyValue::UInt16(v)) => duckdb::types::Value::USmallInt(v),
                Some(AnyValue::UInt32(v)) => duckdb::types::Value::UInt(v),
                Some(AnyValue::UInt64(v)) => duckdb::types::Value::UBigInt(v),
                Some(AnyValue::Float32(v)) => duckdb::types::Value::Float(v),
                Some(AnyValue::Float64(v)) => duckdb::types::Value::Double(v),
                Some(AnyValue::String(s)) => duckdb::types::Value::Text(s.to_string()),
                Some(AnyValue::StringOwned(s)) => duckdb::types::Value::Text(s.to_string()),
                Some(other) => duckdb::types::Value::Text(other.to_string()),
            })
            .collect();
        app.append_row(duckdb::appender_params_from_iter(row_vals))?;
    }
    Ok(())
}
