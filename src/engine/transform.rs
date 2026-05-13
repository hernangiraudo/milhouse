use super::context::StepContext;
use crate::config::TransformOp;
use anyhow::{anyhow, Result};
use polars::prelude::*;

pub async fn run(
    ctx: &StepContext,
    input: &str,
    operations: &[TransformOp],
) -> Result<DataFrame> {
    let df = ctx.get_table(input).await?;
    let ops = operations.to_vec();

    let res = tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        let mut lf = df.as_ref().clone().lazy();
        for op in &ops {
            lf = apply_op(lf, op)?;
        }
        Ok(lf.collect()?)
    })
    .await??;

    Ok(res)
}

fn apply_op(lf: LazyFrame, op: &TransformOp) -> Result<LazyFrame> {
    Ok(match op {
        TransformOp::ToDate { column, format, alias } => {
            let opts = StrptimeOptions {
                format: format.clone().map(Into::into),
                strict: false,
                exact: true,
                cache: true,
            };
            let expr = col(column.as_str())
                .cast(DataType::String)
                .str()
                .to_date(opts);
            let expr = if let Some(a) = alias {
                expr.alias(a.as_str())
            } else {
                expr.alias(column.as_str())
            };
            lf.with_column(expr)
        }
        TransformOp::Cast { column, to, alias } => {
            let dtype = parse_dtype(to)?;
            let expr = col(column.as_str()).cast(dtype);
            let expr = if let Some(a) = alias {
                expr.alias(a.as_str())
            } else {
                expr.alias(column.as_str())
            };
            lf.with_column(expr)
        }
        TransformOp::Uppercase { column, alias } => {
            let expr = col(column.as_str()).str().to_uppercase();
            let expr = if let Some(a) = alias {
                expr.alias(a.as_str())
            } else {
                expr.alias(column.as_str())
            };
            lf.with_column(expr)
        }
        TransformOp::Lowercase { column, alias } => {
            let expr = col(column.as_str()).str().to_lowercase();
            let expr = if let Some(a) = alias {
                expr.alias(a.as_str())
            } else {
                expr.alias(column.as_str())
            };
            lf.with_column(expr)
        }
        TransformOp::Rename { column, to } => {
            lf.rename([column.as_str()], [to.as_str()], true)
        }
        TransformOp::AddConstant { column, value } => {
            let expr = lit_from_json(value)?.alias(column.as_str());
            lf.with_column(expr)
        }
    })
}

fn parse_dtype(s: &str) -> Result<DataType> {
    Ok(match s.to_ascii_lowercase().as_str() {
        "i32" | "int32" => DataType::Int32,
        "i64" | "int64" | "int" => DataType::Int64,
        "u32" | "uint32" => DataType::UInt32,
        "u64" | "uint64" => DataType::UInt64,
        "f32" | "float32" => DataType::Float32,
        "f64" | "float64" | "float" => DataType::Float64,
        "bool" | "boolean" => DataType::Boolean,
        "str" | "string" => DataType::String,
        "date" => DataType::Date,
        other => return Err(anyhow!("unsupported dtype: {other}")),
    })
}

fn lit_from_json(v: &serde_json::Value) -> Result<Expr> {
    Ok(match v {
        serde_json::Value::Null => lit(NULL),
        serde_json::Value::Bool(b) => lit(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                lit(i)
            } else if let Some(f) = n.as_f64() {
                lit(f)
            } else {
                return Err(anyhow!("unsupported number literal"));
            }
        }
        serde_json::Value::String(s) => lit(s.as_str()),
        _ => return Err(anyhow!("unsupported literal type for add_constant")),
    })
}
