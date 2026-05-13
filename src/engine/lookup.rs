use super::context::StepContext;
use crate::config::LookupSelect;
use anyhow::Result;
use polars::prelude::*;

pub async fn run(
    ctx: &StepContext,
    input: &str,
    master: &str,
    key: &str,
    master_key: &str,
    select: &[LookupSelect],
) -> Result<DataFrame> {
    let lhs = ctx.get_table(input).await?;
    let rhs = ctx.get_table(master).await?;

    let key = key.to_string();
    let master_key = master_key.to_string();
    let select = select.to_vec();

    let res = tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        // Project the master to only the lookup key + selected columns (renamed)
        let mut rhs_lazy = rhs.as_ref().clone().lazy();
        if !select.is_empty() {
            let mut cols: Vec<Expr> = vec![col(master_key.as_str())];
            for s in &select {
                let alias = s.alias.clone().unwrap_or_else(|| s.from.clone());
                cols.push(col(s.from.as_str()).alias(alias.as_str()));
            }
            rhs_lazy = rhs_lazy.select(cols);
        }
        let out = lhs
            .as_ref()
            .clone()
            .lazy()
            .join(
                rhs_lazy,
                [col(key.as_str())],
                [col(master_key.as_str())],
                JoinArgs::new(JoinType::Left),
            )
            .collect()?;
        Ok(out)
    })
    .await??;

    Ok(res)
}
