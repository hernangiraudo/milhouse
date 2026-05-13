use super::context::StepContext;
use crate::config::{ExportFormat, ExportTarget};
use anyhow::{Context, Result};
use polars::prelude::*;
use std::fs::File;
use std::path::PathBuf;

pub async fn run(ctx: &StepContext, input: &str, target: &ExportTarget) -> Result<usize> {
    let df = ctx.get_table(input).await?;
    let target = target.clone();
    // El export a DuckDB usa la conexión default. Si querés otra, agregamos
    // `connection: "..."` al target en el futuro.
    let duckdb = match &target {
        ExportTarget::Duckdb { .. } => Some(ctx.default_duckdb().await?),
        _ => None,
    };

    let rows = tokio::task::spawn_blocking(move || -> Result<usize> {
        let mut owned = df.as_ref().clone();
        let rows = owned.height();
        match target {
            ExportTarget::File { format, path } => {
                let path = PathBuf::from(&path);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let file = File::create(&path)
                    .with_context(|| format!("creating export file {}", path.display()))?;
                match format {
                    ExportFormat::Csv => {
                        CsvWriter::new(file).finish(&mut owned)?;
                    }
                    ExportFormat::Parquet => {
                        ParquetWriter::new(file).finish(&mut owned)?;
                    }
                    ExportFormat::Json => {
                        JsonWriter::new(file)
                            .with_json_format(JsonFormat::Json)
                            .finish(&mut owned)?;
                    }
                }
            }
            ExportTarget::Duckdb { table, replace } => {
                let duckdb = duckdb
                    .as_ref()
                    .expect("export to duckdb requires a duckdb connection (bug)");
                let guard = duckdb.blocking_lock();
                if replace {
                    guard
                        .execute_batch(&format!("DROP TABLE IF EXISTS \"{table}\";"))
                        .context("dropping target duckdb table")?;
                }
                // Crear tabla a partir del schema del DataFrame.
                let cols: Vec<String> = owned
                    .schema()
                    .iter()
                    .map(|(name, dtype)| {
                        let sql_type = polars_to_duckdb_type(dtype);
                        format!("\"{name}\" {sql_type}")
                    })
                    .collect();
                let create_sql =
                    format!("CREATE TABLE IF NOT EXISTS \"{table}\" ({});", cols.join(", "));
                guard.execute_batch(&create_sql)?;

                let mut appender = guard.appender(&table)?;
                let n = owned.height();
                let col_count = owned.width();
                let columns = owned.get_columns().to_vec();
                for i in 0..n {
                    let row_vals: Vec<duckdb::types::Value> = (0..col_count)
                        .map(|c| any_value_to_duckdb(columns[c].get(i).ok()))
                        .collect();
                    appender.append_row(duckdb::appender_params_from_iter(row_vals))?;
                }
            }
        }
        Ok(rows)
    })
    .await??;

    Ok(rows)
}

fn polars_to_duckdb_type(dtype: &DataType) -> &'static str {
    match dtype {
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
    }
}

fn any_value_to_duckdb(v: Option<AnyValue>) -> duckdb::types::Value {
    use duckdb::types::Value as V;
    match v {
        None | Some(AnyValue::Null) => V::Null,
        Some(AnyValue::Boolean(b)) => V::Boolean(b),
        Some(AnyValue::Int8(i)) => V::TinyInt(i),
        Some(AnyValue::Int16(i)) => V::SmallInt(i),
        Some(AnyValue::Int32(i)) => V::Int(i),
        Some(AnyValue::Int64(i)) => V::BigInt(i),
        Some(AnyValue::UInt8(i)) => V::UTinyInt(i),
        Some(AnyValue::UInt16(i)) => V::USmallInt(i),
        Some(AnyValue::UInt32(i)) => V::UInt(i),
        Some(AnyValue::UInt64(i)) => V::UBigInt(i),
        Some(AnyValue::Float32(f)) => V::Float(f),
        Some(AnyValue::Float64(f)) => V::Double(f),
        Some(AnyValue::String(s)) => V::Text(s.to_string()),
        Some(AnyValue::StringOwned(s)) => V::Text(s.to_string()),
        Some(other) => V::Text(other.to_string()),
    }
}
