use super::context::StepContext;
use crate::config::SortBy;
use anyhow::Result;
use polars::prelude::*;

pub async fn run(ctx: &StepContext, input: &str, by: &[SortBy]) -> Result<DataFrame> {
    let df = ctx.get_table(input).await?;
    let by = by.to_vec();
    let res = tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        let cols: Vec<String> = by.iter().map(|s| s.column.clone()).collect();
        let descending: Vec<bool> = by.iter().map(|s| s.desc).collect();
        let opts = SortMultipleOptions::new()
            .with_order_descending_multi(descending)
            .with_nulls_last(true);
        Ok(df.as_ref().clone().sort(cols, opts)?)
    })
    .await??;
    Ok(res)
}
