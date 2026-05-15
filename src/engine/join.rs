use super::context::StepContext;
use crate::config::JoinHow;
use anyhow::Result;
use polars::prelude::*;

pub async fn run(
    ctx: &StepContext,
    left: &str,
    right: &str,
    left_on: &[String],
    right_on: &[String],
    how: JoinHow,
) -> Result<DataFrame> {
    let lhs = ctx.get_table(left).await?;
    let rhs = ctx.get_table(right).await?;

    let left_on: Vec<String> = left_on.to_vec();
    let right_on: Vec<String> = right_on.to_vec();

    let res = tokio::task::spawn_blocking(move || -> Result<DataFrame> {
        let join_type = match how {
            JoinHow::Inner => JoinType::Inner,
            JoinHow::Left => JoinType::Left,
            JoinHow::Right => JoinType::Right,
            JoinHow::Full => JoinType::Full,
        };
        let l_expr: Vec<Expr> = left_on.iter().map(|c| col(c.as_str())).collect();
        let r_expr: Vec<Expr> = right_on.iter().map(|c| col(c.as_str())).collect();

        let out = lhs
            .as_ref()
            .clone()
            .lazy()
            .join(
                rhs.as_ref().clone().lazy(),
                l_expr,
                r_expr,
                JoinArgs::new(join_type),
            )
            .collect()?;
        Ok(out)
    })
    .await??;

    Ok(res)
}
