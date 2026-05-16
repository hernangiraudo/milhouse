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
    let cancel = ctx.cancel.clone();

    // Watcher: si llega cancel, interrumpe la conexión DuckDB para que la
    // sentencia en curso falle con "interrupted".
    let interrupt_handle = {
        let guard = conn.lock().await;
        guard.interrupt_handle()
    };
    let watcher_cancel = cancel.clone();
    let watcher = tokio::spawn(async move {
        watcher_cancel.cancelled().await;
        interrupt_handle.interrupt();
    });

    let mut work = tokio::task::spawn_blocking(move || -> Result<usize> {
        let guard = conn.blocking_lock();
        let stmts: Vec<&str> = q
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let total = stmts.len().max(1);
        let mut total_affected: usize = 0;
        for (i, stmt) in stmts.iter().enumerate() {
            let preview_short = preview(stmt);
            // Log "enviado": numera la sentencia, muestra el SQL completo
            // (truncado a 4000 chars). El timestamp lo agrega el supervisor.
            reporter.log(format!(
                "→ [{}/{}] enviando SQL\n{}",
                i + 1,
                total,
                truncate_for_log(stmt, 4000)
            ));
            let n = guard
                .execute(stmt, [])
                .with_context(|| format!("executing statement #{}: {preview_short}", i + 1))?;
            total_affected = total_affected.saturating_add(n);
            let pct = (i + 1) as f32 / total as f32;
            reporter.report_progress(pct, Some(i + 1), Some(total));
        }
        Ok(total_affected)
    });
    let res = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            work.abort();
            let _ = (&mut work).await;
            Err(anyhow::anyhow!("SQL exec cancelado por el usuario"))
        }
        r = &mut work => r.map_err(|e| anyhow::anyhow!("SQL exec join: {e}"))?,
    };
    watcher.abort();
    res
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}\n…(truncado a {max} caracteres)")
    }
}

fn preview(s: &str) -> String {
    let one_line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.len() > 100 {
        format!("{}…", &one_line[..99])
    } else {
        one_line
    }
}
