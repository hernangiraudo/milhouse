use super::context::{OpenedConnection, StepContext};
use anyhow::{anyhow, Context, Result};
use polars::prelude::*;
use std::sync::Arc;

pub async fn run(ctx: &StepContext, query: &str, connection: Option<&str>) -> Result<DataFrame> {
    let opened = ctx.connections.get_any(connection).await?;
    let q = query.to_string();
    match &*opened {
        OpenedConnection::Duckdb(conn) => duckdb_query(conn.clone(), q).await,
        OpenedConnection::Odbc(conn) => {
            let conn = conn.clone();
            tokio::task::spawn_blocking(move || odbc_query_to_df(conn, &q)).await?
        }
        OpenedConnection::SqlServer(conn) => sql_server_query(conn.clone(), q).await,
        OpenedConnection::Mysql(pool) => mysql_query(pool.clone(), q).await,
    }
}

async fn duckdb_query(
    conn: Arc<tokio::sync::Mutex<duckdb::Connection>>,
    q: String,
) -> Result<DataFrame> {
    tokio::task::spawn_blocking(move || -> Result<DataFrame> {
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
    })
    .await?
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
async fn sql_server_query(
    client: Arc<tokio::sync::Mutex<super::context::SqlServerClient>>,
    sql: String,
) -> Result<DataFrame> {
    use futures::TryStreamExt;
    use tiberius::ColumnData;

    let mut col_names: Vec<String> = Vec::new();
    let mut cols: Vec<Vec<ColumnData<'static>>> = Vec::new();
    {
        let mut guard = client.lock().await;
        let mut stream = guard
            .simple_query(sql.clone())
            .await
            .map_err(|e| anyhow!("SQL Server query: {e}"))?;

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
                    ColumnData::DateTime(_)
                    | ColumnData::SmallDateTime(_)
                    | ColumnData::Time(_)
                    | ColumnData::Date(_)
                    | ColumnData::DateTime2(_)
                    | ColumnData::DateTimeOffset(_) => {
                        let _ = (NaiveDate::default(), NaiveDateTime::default(), NaiveTime::default());
                        // tiberius con feature `chrono` permite extraer; usamos Debug por simplicidad.
                        Some(format!("{c:?}"))
                    }
                    other => Some(format!("{other:?}")),
                })
                .collect();
            Series::new(name.into(), &v)
        }
    }
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
