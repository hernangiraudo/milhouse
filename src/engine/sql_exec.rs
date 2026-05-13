use super::context::StepContext;
use crate::orchestrator::progress::ProgressReporter;
use anyhow::{Context, Result};

/// Ejecuta SQL "side-effect" en la conexión: DDL/DML, múltiples sentencias
/// separadas por `;`. No trae resultados al store de tablas de Milhouse.
///
/// Devuelve el número total de filas afectadas por sentencias que reportan
/// `rows_affected` (INSERT/UPDATE/DELETE). Las DDL devuelven 0 y eso es OK.
pub async fn run(
    ctx: &StepContext,
    query: &str,
    connection: Option<&str>,
    reporter: ProgressReporter,
) -> Result<usize> {
    let conn = ctx.connections.get_duckdb(connection).await?;
    let q = query.to_string();
    let reporter = reporter.clone();

    tokio::task::spawn_blocking(move || -> Result<usize> {
        let guard = conn.blocking_lock();
        // Dividimos por `;` para poder reportar progreso y rows_affected por
        // sentencia. DuckDB también acepta múltiples sentencias en un solo
        // execute_batch, pero ahí perderíamos granularidad.
        let stmts: Vec<&str> = q
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let total = stmts.len().max(1);
        let mut total_affected: usize = 0;
        for (i, stmt) in stmts.iter().enumerate() {
            let preview = preview(stmt);
            reporter.log(format!("[{}/{}] {}", i + 1, total, preview), "info");
            let n = guard
                .execute(stmt, [])
                .with_context(|| format!("executing statement #{}: {preview}", i + 1))?;
            total_affected = total_affected.saturating_add(n);
            // progreso simple por sentencias completadas
            let pct = (i + 1) as f32 / total as f32;
            reporter.report_progress(pct, Some(i + 1), Some(total));
        }
        Ok(total_affected)
    })
    .await?
}

fn preview(s: &str) -> String {
    let one_line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.len() > 100 {
        format!("{}…", &one_line[..99])
    } else {
        one_line
    }
}
