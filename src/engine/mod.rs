pub mod context;
pub mod dyn_dates;
pub mod export;
pub mod filter_subset;
pub mod introspect;
pub mod join;
pub mod lookup;
pub mod params;
pub mod procedural;
pub mod sort;
pub mod sql_exec;
pub mod sql_query;
pub mod transform;
pub mod union;

use crate::config::{Step, StepSpec};
use crate::orchestrator::progress::ProgressReporter;
use anyhow::Result;
use polars::frame::DataFrame;

pub use context::{
    test_connection, ConnectionPool, OpenedConnection, StepContext, TableStore,
};

pub async fn execute_step(step: &Step, ctx: &StepContext, reporter: ProgressReporter) -> Result<StepOutcome> {
    let outcome = match &step.spec {
        StepSpec::SqlQuery {
            query,
            connection,
            output_table,
            keep_time_columns,
        } => {
            let q = {
                let guard = ctx.params.read().await;
                params::substitute(query, &guard)?
            };
            let df = sql_query::run(
                ctx,
                &q,
                connection.as_deref(),
                keep_time_columns,
                reporter.clone(),
            )
            .await?;
            StepOutcome::table(output_table.clone(), df)
        }
        StepSpec::SqlExec { query, connection } => {
            let q = {
                let guard = ctx.params.read().await;
                params::substitute(query, &guard)?
            };
            let rows = sql_exec::run(ctx, &q, connection.as_deref(), reporter.clone()).await?;
            StepOutcome::exec_done(rows)
        }
        StepSpec::Join {
            left,
            right,
            left_on,
            right_on,
            how,
            output_table,
        } => {
            let df = join::run(ctx, left, right, left_on, right_on, *how).await?;
            StepOutcome::table(output_table.clone(), df)
        }
        StepSpec::Lookup {
            input,
            master,
            key,
            master_key,
            select,
            output_table,
        } => {
            let df = lookup::run(ctx, input, master, key, master_key, select).await?;
            let name = output_table.clone().unwrap_or_else(|| input.clone());
            StepOutcome::table(name, df)
        }
        StepSpec::Transform {
            input,
            operations,
            output_table,
        } => {
            let df = transform::run(ctx, input, operations).await?;
            let name = output_table.clone().unwrap_or_else(|| input.clone());
            StepOutcome::table(name, df)
        }
        StepSpec::FilterAndSubset {
            input,
            filter,
            select,
            output_table,
        } => {
            let substituted = match filter {
                Some(f) => {
                    let guard = ctx.params.read().await;
                    Some(params::substitute(f, &guard)?)
                }
                None => None,
            };
            let df = filter_subset::run(ctx, input, substituted.as_deref(), select).await?;
            let name = output_table.clone().unwrap_or_else(|| input.clone());
            StepOutcome::table(name, df)
        }
        StepSpec::Sort {
            input,
            by,
            output_table,
        } => {
            let df = sort::run(ctx, input, by).await?;
            StepOutcome::table(output_table.clone(), df)
        }
        StepSpec::Export { input, target } => {
            let rows = export::run(ctx, input, target).await?;
            StepOutcome::exported(rows)
        }
        StepSpec::Union {
            inputs,
            output_table,
        } => {
            let df = union::run(ctx, inputs).await?;
            StepOutcome::table(output_table.clone(), df)
        }
        StepSpec::Procedural {
            input,
            engine,
            script,
            fn_name,
            params,
            state_init,
            output_table,
        } => {
            let df = procedural::run(
                ctx,
                input.as_deref(),
                *engine,
                script.as_deref(),
                fn_name.as_deref(),
                params,
                state_init,
                reporter,
            )
            .await?;
            match (output_table.as_deref(), input.as_deref()) {
                (Some(o), _) => StepOutcome::table(o.to_string(), df),
                (None, Some(i)) => StepOutcome::table(i.to_string(), df),
                // Sin tabla destino: el step solo tuvo efectos sobre params.
                (None, None) => StepOutcome::params_only(df.height()),
            }
        }
    };
    Ok(outcome)
}

pub struct StepOutcome {
    pub output_table: Option<String>,
    pub dataframe: Option<DataFrame>,
    pub row_count: usize,
}

impl StepOutcome {
    fn table(name: String, df: DataFrame) -> Self {
        let row_count = df.height();
        Self {
            output_table: Some(name),
            dataframe: Some(df),
            row_count,
        }
    }
    fn exported(rows: usize) -> Self {
        Self {
            output_table: None,
            dataframe: None,
            row_count: rows,
        }
    }
    fn exec_done(rows_affected: usize) -> Self {
        Self {
            output_table: None,
            dataframe: None,
            row_count: rows_affected,
        }
    }
    /// Procedural sin tabla input ni output_table: solo efectos sobre params.
    fn params_only(rows: usize) -> Self {
        Self {
            output_table: None,
            dataframe: None,
            row_count: rows,
        }
    }
}
