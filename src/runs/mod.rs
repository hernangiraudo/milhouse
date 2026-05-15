//! DB de runs: persistencia de jobs, steps, logs y datasets debug.
//!
//! La conexión se obtiene del `ConnectionPool` por nombre (por defecto `runs`),
//! lo que permite que el operador la reubique a otro path o motor cambiando
//! `connections.json`.

pub mod worker;
pub mod bundle;

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
    job_id              VARCHAR PRIMARY KEY,
    config_name         VARCHAR NOT NULL,
    config_display_name VARCHAR,
    user_name           VARCHAR,
    debug               BOOLEAN NOT NULL DEFAULT FALSE,
    status              VARCHAR NOT NULL,
    started_at          TIMESTAMP NOT NULL,
    finished_at         TIMESTAMP,
    duration_ms         BIGINT,
    total_steps         INTEGER NOT NULL DEFAULT 0
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
    name             VARCHAR NOT NULL,
    level            VARCHAR NOT NULL DEFAULT 'info',
    table_name       VARCHAR NOT NULL,
    row_count        BIGINT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    created_at       TIMESTAMP NOT NULL,
    PRIMARY KEY (job_id, step_uid)
);

CREATE INDEX IF NOT EXISTS idx_step_runs_job ON step_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_step_logs_job_step ON step_logs(job_id, step_uid);

CREATE SEQUENCE IF NOT EXISTS case_id_seq START 1;
CREATE TABLE IF NOT EXISTS cases (
    id            BIGINT PRIMARY KEY DEFAULT nextval('case_id_seq'),
    title         VARCHAR NOT NULL,
    description   VARCHAR,
    severity      VARCHAR NOT NULL DEFAULT 'medium',
    assignee      VARCHAR,
    creator       VARCHAR,
    status        VARCHAR NOT NULL DEFAULT 'open',
    created_at    TIMESTAMP NOT NULL,
    closed_at     TIMESTAMP,
    closed_by     VARCHAR
);

CREATE TABLE IF NOT EXISTS case_datasets (
    case_id       BIGINT NOT NULL,
    job_id        VARCHAR NOT NULL,
    step_uid      INTEGER NOT NULL,
    added_at      TIMESTAMP NOT NULL,
    added_by      VARCHAR,
    PRIMARY KEY (case_id, job_id, step_uid)
);

CREATE SEQUENCE IF NOT EXISTS case_comment_id_seq START 1;
CREATE TABLE IF NOT EXISTS case_comments (
    id            BIGINT PRIMARY KEY DEFAULT nextval('case_comment_id_seq'),
    case_id       BIGINT NOT NULL,
    author        VARCHAR,
    body          VARCHAR NOT NULL,
    created_at    TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_comments_case ON case_comments(case_id);
CREATE INDEX IF NOT EXISTS idx_case_datasets_job ON case_datasets(job_id, step_uid);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

CREATE SEQUENCE IF NOT EXISTS schedule_id_seq START 1;
CREATE TABLE IF NOT EXISTS schedules (
    id              BIGINT PRIMARY KEY DEFAULT nextval('schedule_id_seq'),
    name            VARCHAR NOT NULL,
    config_name     VARCHAR NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    -- spec_json contiene la definición del schedule serializada como JSON.
    -- Tres formas posibles:
    --   { "kind":"at", "days":[1,2,3], "time":"09:00" }
    --   { "kind":"window", "days":[1..5], "from":"08:00", "to":"23:00", "every_minutes":5 }
    --   { "kind":"cron", "expr":"0 9 * * 1-5" }
    spec_json       VARCHAR NOT NULL,
    created_by      VARCHAR,
    created_at      TIMESTAMP NOT NULL,
    last_fired_at   TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
"#;

/// Nombre lógico de la conexión usada para la DB de runs. Definida en
/// `connections.json`. Si no existe, el RunStore se desactiva silenciosamente.
pub const RUNS_CONNECTION: &str = "runs";

pub struct RunStore {
    conn: Arc<Mutex<Connection>>,
}

/// Filas devueltas como JSON crudo (Vec<columns> + Vec<Vec<Value>>) para
/// que el front las consuma sin DTOs específicos.
#[derive(serde::Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

impl RunStore {
    /// Ejecuta una query de solo lectura y devuelve filas como JSON.
    pub async fn query(&self, sql: String) -> anyhow::Result<QueryResult> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<QueryResult> {
            let guard = conn.blocking_lock();
            let mut stmt = guard.prepare(&sql)?;
            let mut rows_iter = stmt.query([])?;
            // Recolectamos primero las filas; los nombres de columna los
            // tomamos al primer row si lo hay, o del statement luego.
            let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
            let mut col_count = 0usize;
            let mut columns: Vec<String> = Vec::new();
            while let Some(row) = rows_iter.next()? {
                if columns.is_empty() {
                    let stmt_ref = row.as_ref();
                    col_count = stmt_ref.column_count();
                    columns = (0..col_count)
                        .map(|i| stmt_ref.column_name(i).map(|s| s.to_string()).unwrap_or_default())
                        .collect();
                }
                let mut r: Vec<serde_json::Value> = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let v: duckdb::types::Value = row.get(i)?;
                    r.push(duck_value_to_json(v));
                }
                rows.push(r);
            }
            // Si no hubo filas, intentamos extraer los nombres del statement.
            if columns.is_empty() {
                drop(rows_iter);
                col_count = stmt.column_count();
                columns = (0..col_count)
                    .map(|i| stmt.column_name(i).map(|s| s.to_string()).unwrap_or_default())
                    .collect();
            }
            Ok(QueryResult { columns, rows })
        })
        .await?
    }
}

fn duck_value_to_json(v: duckdb::types::Value) -> serde_json::Value {
    use chrono::{DateTime, TimeZone, Utc};
    use duckdb::types::Value as V;
    use serde_json::Value as J;
    match v {
        V::Null => J::Null,
        V::Boolean(b) => J::Bool(b),
        V::TinyInt(i) => J::from(i),
        V::SmallInt(i) => J::from(i),
        V::Int(i) => J::from(i),
        V::BigInt(i) => J::from(i),
        V::HugeInt(i) => J::from(i.to_string()),
        V::UTinyInt(i) => J::from(i),
        V::USmallInt(i) => J::from(i),
        V::UInt(i) => J::from(i),
        V::UBigInt(i) => J::from(i),
        V::Float(f) => serde_json::Number::from_f64(f as f64).map(J::Number).unwrap_or(J::Null),
        V::Double(f) => serde_json::Number::from_f64(f).map(J::Number).unwrap_or(J::Null),
        V::Text(s) => J::String(s),
        V::Timestamp(unit, micros) => {
            // micros suele venir en microsegundos desde epoch.
            let secs = match unit {
                duckdb::types::TimeUnit::Second => micros,
                duckdb::types::TimeUnit::Millisecond => micros / 1_000,
                duckdb::types::TimeUnit::Microsecond => micros / 1_000_000,
                duckdb::types::TimeUnit::Nanosecond => micros / 1_000_000_000,
            };
            let nanos = match unit {
                duckdb::types::TimeUnit::Second => 0,
                duckdb::types::TimeUnit::Millisecond => ((micros % 1_000) * 1_000_000) as u32,
                duckdb::types::TimeUnit::Microsecond => ((micros % 1_000_000) * 1_000) as u32,
                duckdb::types::TimeUnit::Nanosecond => (micros % 1_000_000_000) as u32,
            };
            match Utc.timestamp_opt(secs, nanos).single() {
                Some(dt) => J::String(dt.to_rfc3339()),
                None => J::String(format!("{micros:?}")),
            }
        }
        V::Date32(days) => {
            let dt = DateTime::from_timestamp((days as i64) * 86400, 0);
            match dt {
                Some(d) => J::String(d.format("%Y-%m-%d").to_string()),
                None => J::Null,
            }
        }
        other => J::String(format!("{other:?}")),
    }
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

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_run(
        &self,
        job_id: &str,
        config_name: &str,
        config_display_name: Option<&str>,
        user: Option<&str>,
        debug: bool,
        started_at: DateTime<Utc>,
        total_steps: usize,
    ) -> Result<()> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        let config_name = config_name.to_string();
        let config_display_name = config_display_name.map(|s| s.to_string());
        let user = user.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            // Si ya existe, lo dejamos pasar (reutilización en re-ejecución
            // parcial); el caller será responsable de actualizarlo a 'running'.
            let exists: i64 = guard
                .query_row(
                    "SELECT COUNT(*) FROM runs WHERE job_id = ?",
                    params![job_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if exists > 0 {
                guard.execute(
                    "UPDATE runs SET status = 'running', finished_at = NULL, duration_ms = NULL WHERE job_id = ?",
                    params![job_id],
                )?;
                return Ok(());
            }
            guard.execute(
                "INSERT INTO runs (job_id, config_name, config_display_name, user_name, debug, status, started_at, total_steps)
                 VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
                params![
                    job_id,
                    config_name,
                    config_display_name,
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

    /// Limpia las filas de logs/datasets de los pasos que se van a re-ejecutar,
    /// para que la corrida nueva sobreescriba la anterior sin acumular ruido.
    pub async fn clear_steps_for_rerun(
        &self,
        job_id: &str,
        step_uids: Vec<u32>,
    ) -> Result<()> {
        if step_uids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            for uid in &step_uids {
                guard.execute(
                    "DELETE FROM step_logs WHERE job_id = ? AND step_uid = ?",
                    params![job_id, *uid as i64],
                )?;
                // Borrar tabla física del dataset si existe + entrada en step_datasets.
                let tn: Option<String> = guard
                    .query_row(
                        "SELECT table_name FROM step_datasets WHERE job_id = ? AND step_uid = ?",
                        params![job_id, *uid as i64],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(table) = tn {
                    let _ = guard.execute_batch(&format!("DROP TABLE IF EXISTS \"{table}\";"));
                }
                guard.execute(
                    "DELETE FROM step_datasets WHERE job_id = ? AND step_uid = ?",
                    params![job_id, *uid as i64],
                )?;
            }
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
        name: &str,
        level: &str,
        df: &DataFrame,
    ) -> Result<()> {
        // El nombre real de la tabla en la DB se mantiene determinístico:
        // `log_<job_short>_<step_uid>`. El `name` es solo etiqueta de UI.
        let table_name = format!(
            "log_{}_{}",
            job_id.replace('-', "").chars().take(12).collect::<String>(),
            step_uid
        );
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        let name = name.to_string();
        let level = level.to_string();
        let df = df.clone();
        let row_count = df.height();
        let approx_bytes = approx_bytes(&df);

        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            create_table_from_df(&guard, &table_name, &df)?;
            insert_df_rows(&guard, &table_name, &df)?;

            guard.execute(
                "DELETE FROM step_datasets WHERE job_id = ? AND step_uid = ?",
                params![job_id, step_uid as i64],
            )?;
            guard.execute(
                "INSERT INTO step_datasets (job_id, step_uid, name, level, table_name, row_count, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    job_id,
                    step_uid as i64,
                    name,
                    level,
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

    /// Devuelve un preview de un dataset persistido + metadata.
    pub async fn dataset_preview(
        &self,
        job_id: &str,
        step_uid: u32,
        limit: usize,
    ) -> Result<DatasetPreview> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        let limit = limit.max(1).min(10_000);
        tokio::task::spawn_blocking(move || -> Result<DatasetPreview> {
            let guard = conn.blocking_lock();
            // Buscar metadata
            let mut stmt = guard.prepare(
                "SELECT table_name, name, level, row_count, size_bytes, created_at
                 FROM step_datasets WHERE job_id = ? AND step_uid = ?",
            )?;
            let mut rows = stmt.query(params![job_id, step_uid as i64])?;
            let row = rows
                .next()?
                .ok_or_else(|| anyhow::anyhow!("dataset not found"))?;
            let table_name: String = row.get(0)?;
            let name: String = row.get(1)?;
            let level: String = row.get(2)?;
            let row_count: i64 = row.get(3)?;
            let size_bytes: i64 = row.get(4)?;
            drop(rows);
            drop(stmt);
            // Preview
            let sql = format!("SELECT * FROM \"{table_name}\" LIMIT {limit}");
            let mut stmt2 = guard.prepare(&sql)?;
            let mut rows2 = stmt2.query([])?;
            let mut data_rows: Vec<Vec<serde_json::Value>> = Vec::new();
            let mut col_count = 0usize;
            let mut columns: Vec<String> = Vec::new();
            while let Some(row) = rows2.next()? {
                if columns.is_empty() {
                    let stmt_ref = row.as_ref();
                    col_count = stmt_ref.column_count();
                    columns = (0..col_count)
                        .map(|i| stmt_ref.column_name(i).map(|s| s.to_string()).unwrap_or_default())
                        .collect();
                }
                let mut r: Vec<serde_json::Value> = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let v: duckdb::types::Value = row.get(i)?;
                    r.push(duck_value_to_json(v));
                }
                data_rows.push(r);
            }
            if columns.is_empty() {
                drop(rows2);
                col_count = stmt2.column_count();
                columns = (0..col_count)
                    .map(|i| stmt2.column_name(i).map(|s| s.to_string()).unwrap_or_default())
                    .collect();
            }
            Ok(DatasetPreview {
                name,
                level,
                table_name,
                row_count: row_count as u64,
                size_bytes: size_bytes as u64,
                columns,
                rows: data_rows,
            })
        })
        .await?
    }

    // -----------------------------------------------------------------
    // Casos
    // -----------------------------------------------------------------

    /// Crea un caso y lo devuelve con su id asignado.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_case(
        &self,
        title: String,
        description: Option<String>,
        severity: String,
        assignee: Option<String>,
        creator: Option<String>,
    ) -> Result<i64> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<i64> {
            let guard = conn.blocking_lock();
            guard.execute(
                "INSERT INTO cases (title, description, severity, assignee, creator, status, created_at)
                 VALUES (?, ?, ?, ?, ?, 'open', ?)",
                params![
                    title,
                    description,
                    severity,
                    assignee,
                    creator,
                    Utc::now().naive_utc().to_string()
                ],
            )?;
            let id: i64 = guard
                .query_row("SELECT currval('case_id_seq')", [], |r| r.get(0))?;
            Ok(id)
        })
        .await?
    }

    pub async fn close_case(&self, id: i64, by: Option<String>) -> Result<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            guard.execute(
                "UPDATE cases SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?",
                params![Utc::now().naive_utc().to_string(), by, id],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn add_comment(
        &self,
        case_id: i64,
        author: Option<String>,
        body: String,
    ) -> Result<i64> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<i64> {
            let guard = conn.blocking_lock();
            guard.execute(
                "INSERT INTO case_comments (case_id, author, body, created_at) VALUES (?, ?, ?, ?)",
                params![
                    case_id,
                    author,
                    body,
                    Utc::now().naive_utc().to_string()
                ],
            )?;
            let id: i64 = guard
                .query_row("SELECT currval('case_comment_id_seq')", [], |r| r.get(0))?;
            Ok(id)
        })
        .await?
    }

    pub async fn attach_dataset(
        &self,
        case_id: i64,
        job_id: String,
        step_uid: u32,
        added_by: Option<String>,
    ) -> Result<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            // Validar existencia del dataset.
            let exists: i64 = guard.query_row(
                "SELECT COUNT(*) FROM step_datasets WHERE job_id = ? AND step_uid = ?",
                params![job_id, step_uid as i64],
                |r| r.get(0),
            )?;
            if exists == 0 {
                return Err(anyhow::anyhow!(
                    "dataset {job_id}/{step_uid} not found in step_datasets"
                ));
            }
            // Insert idempotente.
            guard.execute(
                "DELETE FROM case_datasets WHERE case_id = ? AND job_id = ? AND step_uid = ?",
                params![case_id, job_id, step_uid as i64],
            )?;
            guard.execute(
                "INSERT INTO case_datasets (case_id, job_id, step_uid, added_at, added_by)
                 VALUES (?, ?, ?, ?, ?)",
                params![
                    case_id,
                    job_id,
                    step_uid as i64,
                    Utc::now().naive_utc().to_string(),
                    added_by
                ],
            )?;
            Ok(())
        })
        .await?
    }

    /// Devuelve los `id` de casos OPEN que tienen al menos un dataset de
    /// este job adjunto. Lista vacía => seguro borrar.
    pub async fn open_cases_for_run(&self, job_id: &str) -> Result<Vec<i64>> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<i64>> {
            let guard = conn.blocking_lock();
            let mut stmt = guard.prepare(
                "SELECT DISTINCT cd.case_id
                 FROM case_datasets cd
                 JOIN cases c ON c.id = cd.case_id
                 WHERE cd.job_id = ? AND c.status = 'open'
                 ORDER BY cd.case_id",
            )?;
            let mut rows = stmt.query(params![job_id])?;
            let mut out: Vec<i64> = Vec::new();
            while let Some(r) = rows.next()? {
                out.push(r.get(0)?);
            }
            Ok(out)
        })
        .await?
    }

    /// Devuelve el DataFrame completo del dataset (utilizado para export).
    pub async fn dataset_full_df(&self, job_id: &str, step_uid: u32) -> Result<DataFrame> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<DataFrame> {
            let guard = conn.blocking_lock();
            let table: String = guard.query_row(
                "SELECT table_name FROM step_datasets WHERE job_id = ? AND step_uid = ?",
                params![job_id, step_uid as i64],
                |r| r.get(0),
            )?;
            let sql = format!("SELECT * FROM \"{table}\"");
            let mut stmt = guard.prepare(&sql)?;
            let chunks: Vec<DataFrame> = stmt.query_polars([])?.collect();
            if chunks.is_empty() {
                return Err(anyhow::anyhow!("dataset table is empty"));
            }
            let mut iter = chunks.into_iter();
            let mut acc = iter.next().unwrap();
            for next in iter {
                acc.vstack_mut(&next)?;
            }
            acc.rechunk_mut();
            Ok(acc)
        })
        .await?
    }

    /// Lista metadatos básicos de cada step_dataset de un run (para bundles).
    pub async fn list_run_dataset_meta(
        &self,
        job_id: &str,
    ) -> Result<Vec<DatasetMeta>> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<DatasetMeta>> {
            let guard = conn.blocking_lock();
            let mut stmt = guard.prepare(
                "SELECT sd.step_uid, sd.name, sd.level, sd.table_name, sd.row_count, sr.step_id
                 FROM step_datasets sd
                 LEFT JOIN step_runs sr ON sr.job_id = sd.job_id AND sr.step_uid = sd.step_uid
                 WHERE sd.job_id = ?
                 ORDER BY sd.step_uid",
            )?;
            let mut rows = stmt.query(params![job_id])?;
            let mut out = Vec::new();
            while let Some(r) = rows.next()? {
                out.push(DatasetMeta {
                    step_uid: r.get::<_, i64>(0)? as u32,
                    name: r.get(1)?,
                    level: r.get(2)?,
                    table_name: r.get(3)?,
                    row_count: r.get::<_, i64>(4).unwrap_or(0),
                    step_id: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                });
            }
            Ok(out)
        })
        .await?
    }

    // -----------------------------------------------------------------
    // Schedules
    // -----------------------------------------------------------------

    pub async fn create_schedule(
        &self,
        name: String,
        config_name: String,
        spec_json: String,
        created_by: Option<String>,
        enabled: bool,
    ) -> Result<i64> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<i64> {
            let guard = conn.blocking_lock();
            guard.execute(
                "INSERT INTO schedules (name, config_name, enabled, spec_json, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    name,
                    config_name,
                    enabled,
                    spec_json,
                    created_by,
                    Utc::now().naive_utc().to_string()
                ],
            )?;
            let id: i64 =
                guard.query_row("SELECT currval('schedule_id_seq')", [], |r| r.get(0))?;
            Ok(id)
        })
        .await?
    }

    pub async fn delete_schedule(&self, id: i64) -> Result<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            guard.execute("DELETE FROM schedules WHERE id = ?", params![id])?;
            Ok(())
        })
        .await?
    }

    pub async fn set_schedule_enabled(&self, id: i64, enabled: bool) -> Result<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            guard.execute(
                "UPDATE schedules SET enabled = ? WHERE id = ?",
                params![enabled, id],
            )?;
            Ok(())
        })
        .await?
    }

    pub async fn mark_schedule_fired(&self, id: i64, at: DateTime<Utc>) -> Result<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            guard.execute(
                "UPDATE schedules SET last_fired_at = ? WHERE id = ?",
                params![at.naive_utc().to_string(), id],
            )?;
            Ok(())
        })
        .await?
    }

    /// Devuelve todos los schedules para que el worker decida quién dispara.
    pub async fn all_schedules(&self) -> Result<Vec<ScheduleRow>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<ScheduleRow>> {
            let guard = conn.blocking_lock();
            let mut stmt = guard.prepare(
                "SELECT id, name, config_name, enabled, spec_json, created_by, created_at, last_fired_at
                 FROM schedules",
            )?;
            let mut rows = stmt.query([])?;
            let mut out = Vec::new();
            while let Some(r) = rows.next()? {
                let last_str: Option<String> = r.get(7).ok();
                let last_fired_at = last_str.and_then(|s| {
                    chrono::NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%.f")
                        .ok()
                        .map(|n| n.and_utc())
                });
                out.push(ScheduleRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    config_name: r.get(2)?,
                    enabled: r.get(3)?,
                    spec_json: r.get(4)?,
                    created_by: r.get(5).ok(),
                    created_at: r.get(6).ok(),
                    last_fired_at,
                });
            }
            Ok(out)
        })
        .await?
    }

    /// Elimina el historial de un job: filas en runs/step_runs/step_logs/
    /// step_datasets y las tablas físicas `log_*` de sus datasets.
    pub async fn delete_run(&self, job_id: &str) -> Result<()> {
        let conn = self.conn.clone();
        let job_id = job_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = conn.blocking_lock();
            // Recolectar tablas físicas a dropear
            let mut tables: Vec<String> = Vec::new();
            {
                let mut stmt = guard.prepare(
                    "SELECT table_name FROM step_datasets WHERE job_id = ?",
                )?;
                let mut rows = stmt.query(params![job_id])?;
                while let Some(row) = rows.next()? {
                    let t: String = row.get(0)?;
                    tables.push(t);
                }
            }
            for t in tables {
                let _ = guard.execute(&format!("DROP TABLE IF EXISTS \"{t}\""), []);
            }
            guard.execute("DELETE FROM step_logs WHERE job_id = ?", params![job_id])?;
            guard.execute(
                "DELETE FROM step_datasets WHERE job_id = ?",
                params![job_id],
            )?;
            guard.execute("DELETE FROM step_runs WHERE job_id = ?", params![job_id])?;
            guard.execute("DELETE FROM runs WHERE job_id = ?", params![job_id])?;
            Ok(())
        })
        .await?
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScheduleRow {
    pub id: i64,
    pub name: String,
    pub config_name: String,
    pub enabled: bool,
    pub spec_json: String,
    pub created_by: Option<String>,
    pub created_at: Option<String>,
    pub last_fired_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduleSpec {
    /// Dispara en días específicos a la hora indicada (HH:MM 24h).
    /// days: 0=domingo, 1=lunes ... 6=sábado
    At {
        days: Vec<u32>,
        time: String,
    },
    /// Ventana: en `days`, desde `from` hasta `to` cada `every_minutes`.
    Window {
        days: Vec<u32>,
        from: String,
        to: String,
        every_minutes: u32,
    },
    /// Expresión cron raw (campos: minuto hora dom mes dow). Para usuarios power.
    Cron {
        expr: String,
    },
}

#[derive(serde::Serialize)]
pub struct DatasetPreview {
    pub name: String,
    pub level: String,
    pub table_name: String,
    pub row_count: u64,
    pub size_bytes: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DatasetMeta {
    pub step_uid: u32,
    pub step_id: String,
    pub name: String,
    pub level: String,
    pub table_name: String,
    pub row_count: i64,
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
