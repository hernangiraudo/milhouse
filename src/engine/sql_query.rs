use super::context::StepContext;
use anyhow::{anyhow, Context, Result};
use polars::prelude::*;

pub async fn run(ctx: &StepContext, query: &str, connection: Option<&str>) -> Result<DataFrame> {
    let conn = ctx.connections.get_duckdb(connection).await?;
    let q = query.to_string();
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
