use super::context::{OpenedConnection, StepContext};
use crate::orchestrator::progress::ProgressReporter;
use anyhow::{anyhow, Context, Result};
use polars::prelude::*;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub async fn run(
    ctx: &StepContext,
    query: &str,
    connection: Option<&str>,
    keep_time_columns: &[String],
    reporter: ProgressReporter,
) -> Result<DataFrame> {
    let opened = ctx.connections.get_any(connection).await?;
    let q = query.to_string();
    let cancel = ctx.cancel.clone();
    // Log "enviado": timestamp + conexión + texto del SQL. El timestamp lo
    // adjunta el supervisor cuando recibe el StepLog (la pestaña Logs lo
    // muestra como `HH:MM:SS [info]`).
    reporter.log(format!(
        "→ enviando SQL a `{}`\n{}",
        connection.unwrap_or("(default)"),
        truncate_for_log(&q, 4000)
    ));
    let df = match &*opened {
        OpenedConnection::Duckdb(conn) => duckdb_query(conn.clone(), q, cancel).await?,
        OpenedConnection::Odbc(conn) => {
            let conn = conn.clone();
            let q2 = q.clone();
            let work = tokio::task::spawn_blocking(move || odbc_query_to_df(conn, &q2));
            select_with_cancel(work, cancel, "ODBC query").await?
        }
        OpenedConnection::SqlServer(pool) => {
            sql_server_query_cancellable(
                pool.clone(),
                q,
                cancel,
                connection.unwrap_or("(default)").to_string(),
                reporter.clone(),
            )
            .await?
        }
        OpenedConnection::Mysql(pool) => mysql_query_cancellable(pool.clone(), q, cancel).await?,
    };
    Ok(normalize_temporal_columns(df, keep_time_columns))
}

/// Por default todas las columnas Datetime se truncan a Date. Las columnas
/// listadas en `keep_time_columns` se preservan como Datetime con hora.
/// Match case-insensitive contra el nombre de columna.
fn normalize_temporal_columns(mut df: DataFrame, keep_time: &[String]) -> DataFrame {
    let keep: std::collections::HashSet<String> =
        keep_time.iter().map(|s| s.to_lowercase()).collect();
    let names: Vec<String> = df
        .schema()
        .iter()
        .map(|(n, _)| n.to_string())
        .collect();
    for name in names {
        let is_datetime = matches!(
            df.column(&name).map(|c| c.dtype().clone()),
            Ok(DataType::Datetime(_, _))
        );
        if is_datetime && !keep.contains(&name.to_lowercase()) {
            if let Ok(col) = df.column(&name) {
                if let Ok(casted) = col.cast(&DataType::Date) {
                    let _ = df.with_column(casted);
                }
            }
        }
    }
    df
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}\n…(truncado a {max} caracteres)")
    }
}

/// Helper: corre un JoinHandle con cancelación. Si el cancel se activa antes
/// que el handle termine, abortamos el spawn_blocking y devolvemos error.
/// El work del lado del servidor podría seguir corriendo (no lo podemos
/// interrumpir desde acá), pero al menos liberamos al scheduler para
/// reportar Cancelled.
async fn select_with_cancel<T>(
    mut work: tokio::task::JoinHandle<Result<T>>,
    cancel: CancellationToken,
    label: &str,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            work.abort();
            let _ = (&mut work).await; // drenamos
            Err(anyhow!("{label} cancelado por el usuario"))
        }
        res = &mut work => res.map_err(|e| anyhow!("{label} join: {e}"))?,
    }
}

async fn duckdb_query(
    conn: Arc<tokio::sync::Mutex<duckdb::Connection>>,
    q: String,
    cancel: CancellationToken,
) -> Result<DataFrame> {
    // Tomamos el InterruptHandle ANTES de bloquear, así el watcher puede
    // llamarlo sin necesidad de tomar el lock (el handle es thread-safe).
    let interrupt_handle = {
        let guard = conn.lock().await;
        guard.interrupt_handle()
    };
    let watcher_cancel = cancel.clone();
    let watcher = tokio::spawn(async move {
        watcher_cancel.cancelled().await;
        interrupt_handle.interrupt();
    });

    let work = tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        let guard = conn.blocking_lock();
        let mut stmt = guard.prepare(&q).context("preparing duckdb query")?;
        let chunks: Vec<DataFrame> = stmt.query_polars([])?.collect();
        if chunks.is_empty() {
            return Err(anyhow!("query returned no chunks: `{q}`"));
        }
        let mut iter = chunks.into_iter();
        let mut acc = iter.next().unwrap();
        for next in iter {
            acc.vstack_mut(&next)?;
        }
        acc.rechunk_mut();
        Ok(acc)
    });
    let res = select_with_cancel(work, cancel, "DuckDB query").await;
    watcher.abort();
    res
}

// =====================================================================
// ODBC (todas las columnas como texto)
// =====================================================================
fn odbc_query_to_df(
    conn: Arc<tokio::sync::Mutex<odbc_api::Connection<'static>>>,
    sql: &str,
) -> Result<DataFrame> {
    use odbc_api::buffers::{BufferDesc, ColumnarAnyBuffer};
    use odbc_api::{Cursor, ResultSetMetadata};
    let guard = conn.blocking_lock();
    let mut prepared = guard.prepare(sql).map_err(|e| anyhow!("ODBC prepare: {e}"))?;
    let num_cols: i16 = prepared
        .num_result_cols()
        .map_err(|e| anyhow!("ODBC num_result_cols: {e}"))?;
    if num_cols <= 0 {
        return Err(anyhow!("ODBC query returned no columns: `{sql}`"));
    }
    let names_iter = prepared
        .column_names()
        .map_err(|e| anyhow!("ODBC column_names: {e}"))?;
    let mut col_names: Vec<String> = Vec::with_capacity(num_cols as usize);
    for n in names_iter {
        col_names.push(n.map_err(|e| anyhow!("ODBC column_name: {e}"))?);
    }
    let descs: Vec<BufferDesc> = (0..num_cols)
        .map(|_| BufferDesc::Text { max_str_len: 4096 })
        .collect();
    let buffer = ColumnarAnyBuffer::from_descs(1024, descs);
    let cursor = prepared
        .execute(())
        .map_err(|e| anyhow!("ODBC execute: {e}"))?
        .ok_or_else(|| anyhow!("ODBC execute returned no cursor"))?;
    let mut block_cursor = cursor
        .bind_buffer(buffer)
        .map_err(|e| anyhow!("ODBC bind_buffer: {e}"))?;

    let mut columns: Vec<Vec<Option<String>>> = vec![Vec::new(); num_cols as usize];
    while let Some(batch) = block_cursor
        .fetch()
        .map_err(|e| anyhow!("ODBC fetch: {e}"))?
    {
        let n = batch.num_rows();
        for col_idx in 0..num_cols as usize {
            let view = batch
                .column(col_idx)
                .as_text_view()
                .ok_or_else(|| anyhow!("ODBC column {col_idx} is not text"))?;
            for row in 0..n {
                let v = view.get(row).map(|b| String::from_utf8_lossy(b).into_owned());
                columns[col_idx].push(v);
            }
        }
    }

    let mut series: Vec<Column> = Vec::with_capacity(num_cols as usize);
    for (i, name) in col_names.iter().enumerate() {
        let s = Series::new(name.as_str().into(), &columns[i]);
        series.push(s.into());
    }
    Ok(DataFrame::new(series)?)
}

// =====================================================================
// SQL Server (tiberius) — mapeo tipado
// =====================================================================
async fn sql_server_query_cancellable(
    pool: Arc<super::context::SqlServerPool>,
    sql: String,
    cancel: CancellationToken,
    connection_name: String,
    reporter: ProgressReporter,
) -> Result<DataFrame> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow!("SQL Server query cancelado por el usuario (la consulta sigue en el servidor)")),
        res = sql_server_query(pool, sql, connection_name, reporter) => res,
    }
}

async fn sql_server_query(
    pool: Arc<super::context::SqlServerPool>,
    sql: String,
    connection_name: String,
    reporter: ProgressReporter,
) -> Result<DataFrame> {
    use futures::TryStreamExt;
    use tiberius::ColumnData;

    let with_sql_ctx = |e: String| -> String {
        let preview: String = sql.chars().take(800).collect();
        let dots = if sql.len() > 800 { " …(truncado)" } else { "" };
        format!("{e}\n--- SQL enviado al servidor ---\n{preview}{dots}")
    };

    let mut col_names: Vec<String> = Vec::new();
    let mut cols: Vec<Vec<ColumnData<'static>>> = Vec::new();
    {
        let mut lease = pool.acquire().await?;
        // Capturamos @@SPID en el mismo cliente ANTES de ejecutar la query
        // del usuario. Mismo cliente físico = misma sesión SQL Server,
        // por lo que el SID que devuelve identifica exactamente la sesión
        // que va a procesar la query siguiente. Notificamos al supervisor
        // así la UI lo muestra y el cancel-step puede mandar KILL.
        {
            let client = lease.client_mut();
            if let Ok(mut spid_stream) = client.simple_query("SELECT @@SPID").await {
                use futures::TryStreamExt;
                use tiberius::QueryItem;
                while let Ok(Some(item)) = spid_stream.try_next().await {
                    if let QueryItem::Row(row) = item {
                        if let Some(cell) = row.into_iter().next() {
                            let sid: Option<i32> = match cell {
                                ColumnData::I16(Some(v)) => Some(v as i32),
                                ColumnData::I32(Some(v)) => Some(v),
                                ColumnData::I64(Some(v)) => Some(v as i32),
                                _ => None,
                            };
                            if let Some(s) = sid {
                                reporter.sql_session(connection_name.clone(), s);
                            }
                        }
                    }
                }
            }
        }
        let client = lease.client_mut();
        let mut stream = client
            .simple_query(sql.clone())
            .await
            .map_err(|e| anyhow!("{}", with_sql_ctx(format!("SQL Server query: {e}"))))?;

        let mut col_initialized = false;
        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|e| anyhow!("SQL Server next: {e}"))?
        {
            use tiberius::QueryItem;
            match item {
                QueryItem::Metadata(meta) => {
                    if !col_initialized {
                        for c in meta.columns() {
                            col_names.push(c.name().to_string());
                        }
                        cols = vec![Vec::new(); col_names.len()];
                        col_initialized = true;
                    }
                }
                QueryItem::Row(row) => {
                    for (i, cell) in row.into_iter().enumerate() {
                        if i < cols.len() {
                            cols[i].push(cell);
                        }
                    }
                }
            }
        }
        // stream y guard se dropean al cerrar el bloque
    }
    let mut series: Vec<Column> = Vec::with_capacity(cols.len());
    for (i, name) in col_names.iter().enumerate() {
        series.push(tiberius_column_to_series(name, &cols[i]).into());
    }
    Ok(DataFrame::new(series)?)
}

fn tiberius_column_to_series(name: &str, vals: &[tiberius::ColumnData<'static>]) -> Series {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
    use tiberius::ColumnData;
    use tiberius::FromSql;
    // Decidir el dtype inspeccionando el primer valor no-Null.
    let sample = vals.iter().find(|v| !matches!(v, ColumnData::U8(None) | ColumnData::I16(None) | ColumnData::I32(None) | ColumnData::I64(None) | ColumnData::F32(None) | ColumnData::F64(None) | ColumnData::Bit(None) | ColumnData::String(None) | ColumnData::Guid(None) | ColumnData::Binary(None)));
    let kind = match sample {
        Some(ColumnData::Bit(_)) => "bool",
        Some(ColumnData::U8(_)) => "i64",
        Some(ColumnData::I16(_)) => "i64",
        Some(ColumnData::I32(_)) => "i64",
        Some(ColumnData::I64(_)) => "i64",
        Some(ColumnData::F32(_)) => "f64",
        Some(ColumnData::F64(_)) => "f64",
        Some(ColumnData::String(_)) | Some(ColumnData::Guid(_)) => "str",
        Some(ColumnData::Date(_)) => "date",
        Some(ColumnData::DateTime(_))
        | Some(ColumnData::SmallDateTime(_))
        | Some(ColumnData::DateTime2(_)) => "datetime",
        Some(ColumnData::DateTimeOffset(_)) => "datetime",
        Some(ColumnData::Time(_)) => "time",
        _ => "str",
    };

    match kind {
        "bool" => {
            let v: Vec<Option<bool>> = vals
                .iter()
                .map(|c| match c {
                    ColumnData::Bit(b) => *b,
                    _ => None,
                })
                .collect();
            Series::new(name.into(), &v)
        }
        "i64" => {
            let v: Vec<Option<i64>> = vals
                .iter()
                .map(|c| match c {
                    ColumnData::U8(x) => x.map(|n| n as i64),
                    ColumnData::I16(x) => x.map(|n| n as i64),
                    ColumnData::I32(x) => x.map(|n| n as i64),
                    ColumnData::I64(x) => *x,
                    _ => None,
                })
                .collect();
            Series::new(name.into(), &v)
        }
        "f64" => {
            let v: Vec<Option<f64>> = vals
                .iter()
                .map(|c| match c {
                    ColumnData::F32(x) => x.map(|n| n as f64),
                    ColumnData::F64(x) => *x,
                    ColumnData::I16(x) => x.map(|n| n as f64),
                    ColumnData::I32(x) => x.map(|n| n as f64),
                    ColumnData::I64(x) => x.map(|n| n as f64),
                    _ => None,
                })
                .collect();
            Series::new(name.into(), &v)
        }
        "date" => {
            // NaiveDate vía FromSql (feature `chrono` activa en Cargo).
            let v: Vec<Option<i32>> = vals
                .iter()
                .map(|c| {
                    let opt: Option<NaiveDate> = NaiveDate::from_sql(c).ok().flatten();
                    opt.map(|d| {
                        d.signed_duration_since(epoch_date()).num_days() as i32
                    })
                })
                .collect();
            let series = Series::new(name.into(), &v);
            series
                .cast(&DataType::Date)
                .unwrap_or_else(|_| Series::new(name.into(), &v))
        }
        "datetime" => {
            let v: Vec<Option<i64>> = vals
                .iter()
                .map(|c| {
                    // DateTimeOffset → DateTime<Utc>, el resto → NaiveDateTime.
                    if matches!(c, ColumnData::DateTimeOffset(_)) {
                        let opt: Option<chrono::DateTime<chrono::Utc>> =
                            <chrono::DateTime<chrono::Utc> as FromSql>::from_sql(c)
                                .ok()
                                .flatten();
                        opt.map(|dt| dt.naive_utc().and_utc().timestamp_micros())
                    } else {
                        let opt: Option<NaiveDateTime> =
                            NaiveDateTime::from_sql(c).ok().flatten();
                        opt.map(|dt| dt.and_utc().timestamp_micros())
                    }
                })
                .collect();
            let series = Series::new(name.into(), &v);
            series
                .cast(&DataType::Datetime(TimeUnit::Microseconds, None))
                .unwrap_or_else(|_| Series::new(name.into(), &v))
        }
        "time" => {
            // Polars Time es nanos desde medianoche; lo dejamos como string.
            let v: Vec<Option<String>> = vals
                .iter()
                .map(|c| {
                    let opt: Option<NaiveTime> =
                        NaiveTime::from_sql(c).ok().flatten();
                    opt.map(|t| t.format("%H:%M:%S").to_string())
                })
                .collect();
            Series::new(name.into(), &v)
        }
        _ => {
            let v: Vec<Option<String>> = vals
                .iter()
                .map(|c| match c {
                    ColumnData::String(Some(s)) => Some(s.to_string()),
                    ColumnData::String(None) => None,
                    ColumnData::Guid(Some(g)) => Some(g.to_string()),
                    ColumnData::Guid(None) => None,
                    ColumnData::Binary(Some(b)) => Some(hex::encode_minimal(b)),
                    ColumnData::Binary(None) => None,
                    ColumnData::Numeric(Some(n)) => Some(n.to_string()),
                    ColumnData::Numeric(None) => None,
                    other => Some(format!("{other:?}")),
                })
                .collect();
            Series::new(name.into(), &v)
        }
    }
}

#[inline]
fn epoch_date() -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()
}

// shim minimal de hex sin sumar crate (usado solo para BINARY → texto).
mod hex {
    pub fn encode_minimal(bytes: &[u8]) -> String {
        const HEX: &[u8] = b"0123456789abcdef";
        let mut s = String::with_capacity(bytes.len() * 2);
        for &b in bytes {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0xf) as usize] as char);
        }
        s
    }
}

// =====================================================================
// MySQL (mysql_async) — mapeo tipado
// =====================================================================
async fn mysql_query_cancellable(
    pool: Arc<mysql_async::Pool>,
    sql: String,
    cancel: CancellationToken,
) -> Result<DataFrame> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(anyhow!("MySQL query cancelado por el usuario (la consulta sigue en el servidor)")),
        res = mysql_query(pool, sql) => res,
    }
}

async fn mysql_query(pool: Arc<mysql_async::Pool>, sql: String) -> Result<DataFrame> {
    use mysql_async::prelude::Queryable;
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| anyhow!("MySQL get_conn: {e}"))?;
    let mut result = conn
        .query_iter(sql)
        .await
        .map_err(|e| anyhow!("MySQL query: {e}"))?;
    // Tomar columnas del result set.
    let cols_meta: Vec<(String, mysql_async::consts::ColumnType)> = match result.columns() {
        Some(arc_cols) => arc_cols
            .iter()
            .map(|c| (c.name_str().to_string(), c.column_type()))
            .collect(),
        None => Vec::new(),
    };
    let col_names: Vec<String> = cols_meta.iter().map(|(n, _)| n.clone()).collect();
    let col_types: Vec<mysql_async::consts::ColumnType> =
        cols_meta.iter().map(|(_, t)| *t).collect();

    let rows: Vec<mysql_async::Row> = result
        .collect()
        .await
        .map_err(|e| anyhow!("MySQL collect rows: {e}"))?;

    let mut series: Vec<Column> = Vec::with_capacity(col_names.len());
    for (i, name) in col_names.iter().enumerate() {
        series.push(mysql_column_to_series(name, &rows, i, col_types[i]).into());
    }
    Ok(DataFrame::new(series)?)
}

fn mysql_column_to_series(
    name: &str,
    rows: &[mysql_async::Row],
    idx: usize,
    col_type: mysql_async::consts::ColumnType,
) -> Series {
    use mysql_async::consts::ColumnType as CT;
    use mysql_async::Value;
    match col_type {
        CT::MYSQL_TYPE_TINY
        | CT::MYSQL_TYPE_SHORT
        | CT::MYSQL_TYPE_INT24
        | CT::MYSQL_TYPE_LONG
        | CT::MYSQL_TYPE_LONGLONG => {
            let v: Vec<Option<i64>> = rows
                .iter()
                .map(|r| match r.as_ref(idx) {
                    Some(Value::Int(n)) => Some(*n),
                    Some(Value::UInt(n)) => Some(*n as i64),
                    Some(Value::NULL) | None => None,
                    other => other.and_then(value_to_i64),
                })
                .collect();
            Series::new(name.into(), &v)
        }
        CT::MYSQL_TYPE_FLOAT
        | CT::MYSQL_TYPE_DOUBLE
        | CT::MYSQL_TYPE_DECIMAL
        | CT::MYSQL_TYPE_NEWDECIMAL => {
            let v: Vec<Option<f64>> = rows
                .iter()
                .map(|r| match r.as_ref(idx) {
                    Some(Value::Float(n)) => Some(*n as f64),
                    Some(Value::Double(n)) => Some(*n),
                    Some(Value::Int(n)) => Some(*n as f64),
                    Some(Value::UInt(n)) => Some(*n as f64),
                    Some(Value::Bytes(b)) => std::str::from_utf8(b).ok().and_then(|s| s.parse().ok()),
                    Some(Value::NULL) | None => None,
                    _ => None,
                })
                .collect();
            Series::new(name.into(), &v)
        }
        _ => {
            // Cubre VARCHAR, BLOB, DATE, DATETIME, TIME, JSON, etc. como string.
            let v: Vec<Option<String>> = rows
                .iter()
                .map(|r| match r.as_ref(idx) {
                    Some(Value::NULL) | None => None,
                    Some(Value::Bytes(b)) => Some(String::from_utf8_lossy(b).into_owned()),
                    Some(other) => Some(format!("{other:?}")),
                })
                .collect();
            Series::new(name.into(), &v)
        }
    }
}

fn value_to_i64(v: &mysql_async::Value) -> Option<i64> {
    use mysql_async::Value;
    match v {
        Value::Int(n) => Some(*n),
        Value::UInt(n) => Some(*n as i64),
        Value::Bytes(b) => std::str::from_utf8(b).ok().and_then(|s| s.parse().ok()),
        _ => None,
    }
}
