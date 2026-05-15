//! Introspección de schemas de una conexión: listar tablas y columnas.
//!
//! Cada motor expone las tablas vía una query a su information_schema
//! (o equivalente). Para ODBC usamos los catalog calls del driver.

use super::context::{ConnectionPool, OpenedConnection};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct TableInfo {
    pub schema: Option<String>,
    pub name: String,
    pub kind: String, // "table" | "view"
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: Option<bool>,
    #[serde(default)]
    pub is_primary_key: bool,
}

pub async fn list_tables(pool: &ConnectionPool, conn_name: &str) -> Result<Vec<TableInfo>> {
    let opened = pool.get_any(Some(conn_name)).await?;
    match &*opened {
        OpenedConnection::Duckdb(c) => duckdb_tables(c.clone()).await,
        OpenedConnection::SqlServer(c) => mssql_tables(c.clone()).await,
        OpenedConnection::Mysql(p) => mysql_tables(p.clone()).await,
        OpenedConnection::Odbc(c) => odbc_tables(c.clone()).await,
    }
}

pub async fn list_columns(
    pool: &ConnectionPool,
    conn_name: &str,
    table: &str,
    schema: Option<&str>,
) -> Result<Vec<ColumnInfo>> {
    let opened = pool.get_any(Some(conn_name)).await?;
    let schema = schema.map(String::from);
    let table = table.to_string();
    match &*opened {
        OpenedConnection::Duckdb(c) => duckdb_columns(c.clone(), table).await,
        OpenedConnection::SqlServer(c) => mssql_columns(c.clone(), schema, table).await,
        OpenedConnection::Mysql(p) => mysql_columns(p.clone(), table).await,
        OpenedConnection::Odbc(c) => odbc_columns(c.clone(), schema, table).await,
    }
}

// -----------------------------------------------------------------------
// DuckDB
// -----------------------------------------------------------------------
async fn duckdb_tables(
    conn: Arc<tokio::sync::Mutex<duckdb::Connection>>,
) -> Result<Vec<TableInfo>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<TableInfo>> {
        let guard = conn.blocking_lock();
        let mut stmt = guard.prepare(
            "SELECT table_schema, table_name, table_type
             FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY table_schema, table_name",
        )?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            let schema: String = r.get(0)?;
            let name: String = r.get(1)?;
            let table_type: String = r.get(2)?;
            let kind = if table_type.to_uppercase().contains("VIEW") {
                "view"
            } else {
                "table"
            }
            .to_string();
            out.push(TableInfo {
                schema: Some(schema),
                name,
                kind,
            });
        }
        Ok(out)
    })
    .await?
}

async fn duckdb_columns(
    conn: Arc<tokio::sync::Mutex<duckdb::Connection>>,
    table: String,
) -> Result<Vec<ColumnInfo>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ColumnInfo>> {
        let guard = conn.blocking_lock();
        // Soporta nombre simple o "schema.tabla".
        let (schema, tbl): (Option<&str>, &str) = match table.split_once('.') {
            Some((s, t)) => (Some(s), t),
            None => (None, table.as_str()),
        };
        let sql = match schema {
            Some(_) => "SELECT column_name, data_type, is_nullable
                        FROM information_schema.columns
                        WHERE table_schema = ? AND table_name = ?
                        ORDER BY ordinal_position",
            None => "SELECT column_name, data_type, is_nullable
                     FROM information_schema.columns
                     WHERE table_name = ?
                     ORDER BY ordinal_position",
        };
        let mut stmt = guard.prepare(sql)?;
        let mut rows = if let Some(s) = schema {
            stmt.query(duckdb::params![s, tbl])?
        } else {
            stmt.query(duckdb::params![tbl])?
        };
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            let name: String = r.get(0)?;
            let dtype: String = r.get(1)?;
            let nullable: String = r.get(2)?;
            out.push(ColumnInfo {
                name,
                data_type: dtype,
                nullable: Some(nullable.eq_ignore_ascii_case("YES")),
                is_primary_key: false,
            });
        }
        // DuckDB expone PKs via duckdb_constraints (tabla virtual) que da el
        // array de columnas de cada constraint. Si por algún motivo falla,
        // fallback a PRAGMA table_info (donde la columna `pk` indica posición
        // en la PK, 0 = no es PK).
        let pk_cols: std::collections::HashSet<String> = (|| -> Result<_> {
            let sql = match schema {
                Some(_) => "SELECT unnest(constraint_column_names) AS col
                            FROM duckdb_constraints()
                            WHERE constraint_type = 'PRIMARY KEY'
                              AND schema_name = ? AND table_name = ?",
                None => "SELECT unnest(constraint_column_names) AS col
                         FROM duckdb_constraints()
                         WHERE constraint_type = 'PRIMARY KEY'
                           AND table_name = ?",
            };
            let mut stmt = guard.prepare(sql)?;
            let mut rows = if let Some(s) = schema {
                stmt.query(duckdb::params![s, tbl])?
            } else {
                stmt.query(duckdb::params![tbl])?
            };
            let mut set = std::collections::HashSet::new();
            while let Some(r) = rows.next()? {
                let col_name: String = r.get(0)?;
                set.insert(col_name);
            }
            Ok(set)
        })()
        .or_else(|_e: anyhow::Error| -> Result<_> {
            // Fallback: PRAGMA table_info
            let pragma_sql = match schema {
                Some(s) => format!(
                    "PRAGMA table_info('{}.{}')",
                    s.replace('\'', "''"),
                    tbl.replace('\'', "''")
                ),
                None => format!("PRAGMA table_info('{}')", tbl.replace('\'', "''")),
            };
            let mut stmt = guard.prepare(&pragma_sql)?;
            let mut rows = stmt.query([])?;
            let mut set = std::collections::HashSet::new();
            while let Some(r) = rows.next()? {
                let col_name: String = r.get(1)?;
                let pk_flag: bool = r.get(5).unwrap_or(false);
                if pk_flag {
                    set.insert(col_name);
                }
            }
            Ok(set)
        })
        .unwrap_or_default();
        for c in &mut out {
            if pk_cols.contains(&c.name) {
                c.is_primary_key = true;
            }
        }
        Ok(out)
    })
    .await?
}

// -----------------------------------------------------------------------
// SQL Server
// -----------------------------------------------------------------------
async fn mssql_tables(
    client: Arc<tokio::sync::Mutex<super::context::SqlServerClient>>,
) -> Result<Vec<TableInfo>> {
    use futures::TryStreamExt;
    use tiberius::QueryItem;
    let mut guard = client.lock().await;
    let mut stream = guard
        .simple_query(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
             FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
        )
        .await
        .map_err(|e| anyhow!("SQL Server tables: {e}"))?;
    let mut out = Vec::new();
    while let Some(item) = stream.try_next().await.map_err(|e| anyhow!("{e}"))? {
        if let QueryItem::Row(row) = item {
            let schema: Option<&str> = row.try_get(0).ok().flatten();
            let name: Option<&str> = row.try_get(1).ok().flatten();
            let ttype: Option<&str> = row.try_get(2).ok().flatten();
            if let Some(name) = name {
                out.push(TableInfo {
                    schema: schema.map(String::from),
                    name: name.to_string(),
                    kind: if ttype == Some("VIEW") { "view" } else { "table" }.into(),
                });
            }
        }
    }
    Ok(out)
}

async fn mssql_columns(
    client: Arc<tokio::sync::Mutex<super::context::SqlServerClient>>,
    schema: Option<String>,
    table: String,
) -> Result<Vec<ColumnInfo>> {
    use futures::TryStreamExt;
    use tiberius::QueryItem;
    let mut guard = client.lock().await;
    let sql = match schema.as_deref() {
        Some(s) => format!(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}'
             ORDER BY ORDINAL_POSITION",
            sql_lit(s),
            sql_lit(&table)
        ),
        None => format!(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_NAME = '{}'
             ORDER BY ORDINAL_POSITION",
            sql_lit(&table)
        ),
    };
    let mut out = Vec::new();
    {
        let mut stream = guard
            .simple_query(sql)
            .await
            .map_err(|e| anyhow!("SQL Server columns: {e}"))?;
        while let Some(item) = stream.try_next().await.map_err(|e| anyhow!("{e}"))? {
            if let QueryItem::Row(row) = item {
                let name: Option<&str> = row.try_get(0).ok().flatten();
                let dtype: Option<&str> = row.try_get(1).ok().flatten();
                let nullable: Option<&str> = row.try_get(2).ok().flatten();
                if let Some(name) = name {
                    out.push(ColumnInfo {
                        name: name.to_string(),
                        data_type: dtype.unwrap_or("").to_string(),
                        nullable: nullable.map(|s| s.eq_ignore_ascii_case("YES")),
                        is_primary_key: false,
                    });
                }
            }
        }
    }
    // PKs via INFORMATION_SCHEMA.KEY_COLUMN_USAGE + TABLE_CONSTRAINTS
    let pk_sql = match schema.as_deref() {
        Some(s) => format!(
            "SELECT kcu.COLUMN_NAME
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
               ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
              AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
               AND kcu.TABLE_SCHEMA = '{}' AND kcu.TABLE_NAME = '{}'",
            sql_lit(s),
            sql_lit(&table)
        ),
        None => format!(
            "SELECT kcu.COLUMN_NAME
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
               ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
              AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
               AND kcu.TABLE_NAME = '{}'",
            sql_lit(&table)
        ),
    };
    let mut pk_set = std::collections::HashSet::new();
    {
        let mut pk_stream = guard
            .simple_query(pk_sql)
            .await
            .map_err(|e| anyhow!("SQL Server PK lookup: {e}"))?;
        while let Some(item) = pk_stream.try_next().await.map_err(|e| anyhow!("{e}"))? {
            if let QueryItem::Row(row) = item {
                if let Some(n) = row.try_get::<&str, _>(0).ok().flatten() {
                    pk_set.insert(n.to_string());
                }
            }
        }
    }
    for c in &mut out {
        if pk_set.contains(&c.name) {
            c.is_primary_key = true;
        }
    }
    Ok(out)
}

fn sql_lit(s: &str) -> String {
    s.replace('\'', "''")
}

// -----------------------------------------------------------------------
// MySQL
// -----------------------------------------------------------------------
async fn mysql_tables(pool: Arc<mysql_async::Pool>) -> Result<Vec<TableInfo>> {
    use mysql_async::prelude::Queryable;
    let mut c = pool.get_conn().await.map_err(|e| anyhow!("{e}"))?;
    let rows: Vec<(String, String, String)> = c
        .query(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
             FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
             ORDER BY TABLE_NAME",
        )
        .await
        .map_err(|e| anyhow!("MySQL tables: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(schema, name, ttype)| TableInfo {
            schema: Some(schema),
            name,
            kind: if ttype.contains("VIEW") {
                "view".into()
            } else {
                "table".into()
            },
        })
        .collect())
}

async fn mysql_columns(pool: Arc<mysql_async::Pool>, table: String) -> Result<Vec<ColumnInfo>> {
    use mysql_async::prelude::Queryable;
    let mut c = pool.get_conn().await.map_err(|e| anyhow!("{e}"))?;
    // COLUMN_KEY = 'PRI' marca columnas que forman parte de la PK.
    let rows: Vec<(String, String, String, String)> = c
        .exec(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             ORDER BY ORDINAL_POSITION",
            (table,),
        )
        .await
        .map_err(|e| anyhow!("MySQL columns: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(name, dtype, nullable, key)| ColumnInfo {
            name,
            data_type: dtype,
            nullable: Some(nullable.eq_ignore_ascii_case("YES")),
            is_primary_key: key.eq_ignore_ascii_case("PRI"),
        })
        .collect())
}

// -----------------------------------------------------------------------
// ODBC
// -----------------------------------------------------------------------
async fn odbc_tables(
    conn: Arc<tokio::sync::Mutex<odbc_api::Connection<'static>>>,
) -> Result<Vec<TableInfo>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<TableInfo>> {
        // Para ODBC, intentamos primero la query estándar de information_schema
        // (la mayoría de los drivers la soportan).
        let guard = conn.blocking_lock();
        let mut stmt = guard
            .prepare(
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
                 FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_TYPE IN ('BASE TABLE', 'TABLE', 'VIEW')
                 ORDER BY TABLE_SCHEMA, TABLE_NAME",
            )
            .map_err(|e| anyhow!("ODBC prepare INFORMATION_SCHEMA.TABLES: {e}"))?;
        use odbc_api::{buffers::{BufferDesc, ColumnarAnyBuffer}, Cursor, ResultSetMetadata};
        let _ = ResultSetMetadata::num_result_cols(&mut stmt)
            .map_err(|e| anyhow!("ODBC num_result_cols: {e}"))?;
        let descs = vec![
            BufferDesc::Text { max_str_len: 256 },
            BufferDesc::Text { max_str_len: 256 },
            BufferDesc::Text { max_str_len: 64 },
        ];
        let buffer = ColumnarAnyBuffer::from_descs(512, descs);
        let cursor = stmt
            .execute(())
            .map_err(|e| anyhow!("ODBC execute INFORMATION_SCHEMA.TABLES: {e}"))?
            .ok_or_else(|| anyhow!("ODBC: no cursor"))?;
        let mut bc = cursor.bind_buffer(buffer).map_err(|e| anyhow!("{e}"))?;
        let mut out = Vec::new();
        while let Some(batch) = bc.fetch().map_err(|e| anyhow!("{e}"))? {
            let n = batch.num_rows();
            let s_view = batch.column(0).as_text_view().ok_or_else(|| anyhow!("col0 not text"))?;
            let n_view = batch.column(1).as_text_view().ok_or_else(|| anyhow!("col1 not text"))?;
            let t_view = batch.column(2).as_text_view().ok_or_else(|| anyhow!("col2 not text"))?;
            for row in 0..n {
                let schema = s_view.get(row).map(|b| String::from_utf8_lossy(b).into_owned());
                let name = n_view.get(row).map(|b| String::from_utf8_lossy(b).into_owned());
                let ttype = t_view.get(row).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
                if let Some(name) = name {
                    out.push(TableInfo {
                        schema,
                        name,
                        kind: if ttype.contains("VIEW") { "view".into() } else { "table".into() },
                    });
                }
            }
        }
        Ok(out)
    })
    .await?
}

async fn odbc_columns(
    conn: Arc<tokio::sync::Mutex<odbc_api::Connection<'static>>>,
    schema: Option<String>,
    table: String,
) -> Result<Vec<ColumnInfo>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ColumnInfo>> {
        let guard = conn.blocking_lock();
        let sql = match schema.as_deref() {
            Some(s) => format!(
                "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}' ORDER BY ORDINAL_POSITION",
                s.replace('\'', "''"),
                table.replace('\'', "''")
            ),
            None => format!(
                "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_NAME = '{}' ORDER BY ORDINAL_POSITION",
                table.replace('\'', "''")
            ),
        };
        let mut stmt = guard.prepare(&sql).map_err(|e| anyhow!("{e}"))?;
        use odbc_api::{buffers::{BufferDesc, ColumnarAnyBuffer}, Cursor, ResultSetMetadata};
        let _ = ResultSetMetadata::num_result_cols(&mut stmt).map_err(|e| anyhow!("{e}"))?;
        let descs = vec![
            BufferDesc::Text { max_str_len: 256 },
            BufferDesc::Text { max_str_len: 64 },
            BufferDesc::Text { max_str_len: 8 },
        ];
        let buffer = ColumnarAnyBuffer::from_descs(512, descs);
        let cursor = stmt
            .execute(())
            .map_err(|e| anyhow!("{e}"))?
            .ok_or_else(|| anyhow!("no cursor"))?;
        let mut bc = cursor.bind_buffer(buffer).map_err(|e| anyhow!("{e}"))?;
        let mut out = Vec::new();
        while let Some(batch) = bc.fetch().map_err(|e| anyhow!("{e}"))? {
            let n = batch.num_rows();
            let n_view = batch.column(0).as_text_view().ok_or_else(|| anyhow!("col0"))?;
            let d_view = batch.column(1).as_text_view().ok_or_else(|| anyhow!("col1"))?;
            let null_view = batch.column(2).as_text_view().ok_or_else(|| anyhow!("col2"))?;
            for row in 0..n {
                let name = n_view.get(row).map(|b| String::from_utf8_lossy(b).into_owned());
                let dtype = d_view.get(row).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
                let nullable = null_view.get(row).map(|b| String::from_utf8_lossy(b).into_owned());
                if let Some(name) = name {
                    out.push(ColumnInfo {
                        name,
                        data_type: dtype,
                        nullable: nullable.map(|s| s.eq_ignore_ascii_case("YES")),
                        is_primary_key: false,
                    });
                }
            }
        }
        // PKs via INFORMATION_SCHEMA.KEY_COLUMN_USAGE + TABLE_CONSTRAINTS.
        // Si el driver no la soporta, simplemente se ignoran y se quedan
        // todas como is_primary_key=false.
        let pk_sql = match schema.as_deref() {
            Some(s) => format!(
                "SELECT kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                 JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                   ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
                 WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                   AND kcu.TABLE_SCHEMA = '{}' AND kcu.TABLE_NAME = '{}'",
                s.replace('\'', "''"),
                table.replace('\'', "''")
            ),
            None => format!(
                "SELECT kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                 JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                   ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                 WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                   AND kcu.TABLE_NAME = '{}'",
                table.replace('\'', "''")
            ),
        };
        let pk_set: std::collections::HashSet<String> = (|| -> Result<_> {
            let mut stmt = guard.prepare(&pk_sql).map_err(|e| anyhow!("{e}"))?;
            let _ = ResultSetMetadata::num_result_cols(&mut stmt).map_err(|e| anyhow!("{e}"))?;
            let descs = vec![BufferDesc::Text { max_str_len: 256 }];
            let buffer = ColumnarAnyBuffer::from_descs(256, descs);
            let cursor = stmt
                .execute(())
                .map_err(|e| anyhow!("{e}"))?
                .ok_or_else(|| anyhow!("no cursor"))?;
            let mut bc = cursor.bind_buffer(buffer).map_err(|e| anyhow!("{e}"))?;
            let mut set = std::collections::HashSet::new();
            while let Some(batch) = bc.fetch().map_err(|e| anyhow!("{e}"))? {
                let n = batch.num_rows();
                let v = batch
                    .column(0)
                    .as_text_view()
                    .ok_or_else(|| anyhow!("col0"))?;
                for r in 0..n {
                    if let Some(b) = v.get(r) {
                        set.insert(String::from_utf8_lossy(b).into_owned());
                    }
                }
            }
            Ok(set)
        })()
        .unwrap_or_default();
        for c in &mut out {
            if pk_set.contains(&c.name) {
                c.is_primary_key = true;
            }
        }
        Ok(out)
    })
    .await?
}
