//! Worker que cada minuto evalúa los schedules persistidos y dispara los
//! jobs que correspondan en el momento.
//!
//! Estrategia de decisión:
//! - At {days, time}: dispara cuando el minuto actual coincide con `time` y el
//!   día de la semana está en `days`, y nunca disparó hoy.
//! - Window {days, from, to, every_minutes}: dispara cuando el minuto actual
//!   está alineado a `every_minutes` (relativo a `from`) dentro de la ventana
//!   [from, to] de un día válido, y no disparó en este minuto.
//! - Cron: aplicamos una versión mínima de matching (5 campos: m h dom mes dow)
//!   suficiente para los casos comunes.
//!
//! La deduplicación se hace con `last_fired_at`: nunca disparamos dos veces
//! en el mismo minuto del calendario (truncado a minuto).

use super::{RunStore, ScheduleRow, ScheduleSpec};
use crate::api::AppState;
use chrono::{DateTime, Datelike, NaiveTime, Timelike, Utc};
use std::sync::Arc;
use std::time::Duration;

pub fn spawn(state: AppState) {
    tokio::spawn(async move { run_loop(state).await });
}

async fn run_loop(state: AppState) {
    // Pequeño jitter inicial para no chocar con startup.
    tokio::time::sleep(Duration::from_secs(5)).await;
    loop {
        if let Some(store) = state.run_store.read().await.clone() {
            if let Err(e) = tick(&state, &store).await {
                tracing::warn!("scheduler tick error: {e:#}");
            }
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

async fn tick(state: &AppState, store: &Arc<RunStore>) -> anyhow::Result<()> {
    let now = Utc::now();
    let schedules = store.all_schedules().await?;
    for sch in schedules {
        if !sch.enabled {
            continue;
        }
        let spec: ScheduleSpec = match serde_json::from_str(&sch.spec_json) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("schedule #{}: invalid spec_json: {e}", sch.id);
                continue;
            }
        };
        if !should_fire(&spec, now, sch.last_fired_at) {
            continue;
        }
        if let Err(e) = fire(state, &sch, now).await {
            tracing::warn!("schedule #{} fire failed: {e:#}", sch.id);
        } else {
            // Marcamos como disparado al minuto truncado.
            let truncated = now
                .with_second(0)
                .and_then(|t| t.with_nanosecond(0))
                .unwrap_or(now);
            if let Err(e) = store.mark_schedule_fired(sch.id, truncated).await {
                tracing::warn!("schedule #{} mark_fired error: {e:#}", sch.id);
            }
        }
    }
    Ok(())
}

/// Evalúa si un schedule debe dispararse "ahora" considerando `last_fired_at`.
fn should_fire(
    spec: &ScheduleSpec,
    now: DateTime<Utc>,
    last_fired: Option<DateTime<Utc>>,
) -> bool {
    // Trunco "ahora" al minuto: el worker corre cada 60s, los schedules son
    // por minuto.
    let now_min = match now.with_second(0).and_then(|t| t.with_nanosecond(0)) {
        Some(n) => n,
        None => return false,
    };
    if let Some(prev) = last_fired {
        let prev_min = prev
            .with_second(0)
            .and_then(|t| t.with_nanosecond(0))
            .unwrap_or(prev);
        if prev_min == now_min {
            return false; // no disparar dos veces el mismo minuto
        }
    }

    match spec {
        ScheduleSpec::At { days, time } => {
            let dow = weekday_num(now);
            if !days_match(days, dow) {
                return false;
            }
            let want = match parse_hhmm(time) {
                Some(t) => t,
                None => return false,
            };
            now.hour() == want.hour() && now.minute() == want.minute()
        }
        ScheduleSpec::Window {
            days,
            from,
            to,
            every_minutes,
        } => {
            let dow = weekday_num(now);
            if !days_match(days, dow) {
                return false;
            }
            let f = match parse_hhmm(from) {
                Some(t) => t,
                None => return false,
            };
            let t = match parse_hhmm(to) {
                Some(t) => t,
                None => return false,
            };
            let curr = NaiveTime::from_hms_opt(now.hour(), now.minute(), 0).unwrap();
            if curr < f || curr > t {
                return false;
            }
            if *every_minutes == 0 {
                return false;
            }
            let from_minutes = (f.hour() * 60 + f.minute()) as i32;
            let now_minutes = (curr.hour() * 60 + curr.minute()) as i32;
            let diff = now_minutes - from_minutes;
            diff >= 0 && diff % (*every_minutes as i32) == 0
        }
        ScheduleSpec::Cron { expr } => cron_match(expr, now),
    }
}

fn weekday_num(dt: DateTime<Utc>) -> u32 {
    // chrono: Mon=0..Sun=6 (num_days_from_monday). Para cron y nuestro modelo
    // usamos 0=domingo..6=sábado.
    let m = dt.weekday().num_days_from_monday();
    match m {
        0 => 1, // monday
        1 => 2,
        2 => 3,
        3 => 4,
        4 => 5, // friday
        5 => 6, // saturday
        6 => 0, // sunday
        _ => 0,
    }
}

fn days_match(days: &[u32], dow: u32) -> bool {
    days.iter().any(|d| *d == dow)
}

fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let s = s.trim();
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    NaiveTime::from_hms_opt(h, m, 0)
}

/// Cron mínimo: 5 campos `minute hour day-of-month month day-of-week`.
/// Soporta: `*`, listas `a,b,c`, rangos `a-b`, `*/n`.
fn cron_match(expr: &str, now: DateTime<Utc>) -> bool {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    let mins_ok = cron_field_match(parts[0], now.minute() as i64, 0, 59);
    let hours_ok = cron_field_match(parts[1], now.hour() as i64, 0, 23);
    let dom_ok = cron_field_match(parts[2], now.day() as i64, 1, 31);
    let mon_ok = cron_field_match(parts[3], now.month() as i64, 1, 12);
    let dow_n = weekday_num(now) as i64; // 0=Sun..6=Sat (cron convention)
    let dow_ok = cron_field_match(parts[4], dow_n, 0, 6);
    mins_ok && hours_ok && dom_ok && mon_ok && dow_ok
}

fn cron_field_match(field: &str, value: i64, min: i64, max: i64) -> bool {
    // Soporta múltiples elementos separados por `,`.
    for part in field.split(',') {
        if cron_single_match(part, value, min, max) {
            return true;
        }
    }
    false
}

fn cron_single_match(part: &str, value: i64, min: i64, max: i64) -> bool {
    // Steps `*/n` o `a-b/n`.
    let (range_part, step) = if let Some((r, s)) = part.split_once('/') {
        let n: i64 = match s.parse() {
            Ok(n) if n > 0 => n,
            _ => return false,
        };
        (r, n)
    } else {
        (part, 1)
    };

    let (start, end) = if range_part == "*" {
        (min, max)
    } else if let Some((a, b)) = range_part.split_once('-') {
        let a: i64 = match a.parse() {
            Ok(v) => v,
            _ => return false,
        };
        let b: i64 = match b.parse() {
            Ok(v) => v,
            _ => return false,
        };
        (a, b)
    } else {
        let v: i64 = match range_part.parse() {
            Ok(v) => v,
            _ => return false,
        };
        (v, v)
    };

    if value < start || value > end {
        return false;
    }
    (value - start) % step == 0
}

/// Dispara el job correspondiente a un schedule.
async fn fire(
    state: &AppState,
    sch: &ScheduleRow,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    use crate::config::EtlConfig;
    use crate::orchestrator::run_job;
    use std::path::Path;
    let path = Path::new(&state.configs_dir).join(&sch.config_name);
    let text = std::fs::read_to_string(&path)?;
    let mut cfg = EtlConfig::from_json_str(&text)?;
    if cfg.ensure_step_uids() {
        let new_text = serde_json::to_string_pretty(&cfg)?;
        let _ = std::fs::write(&path, new_text);
    }
    let job_id = uuid::Uuid::new_v4().to_string();
    let user_label = format!("scheduler#{}", sch.id);
    let run_store = state.run_store.read().await.clone();
    let handle = run_job(
        job_id.clone(),
        sch.config_name.clone(),
        Some(user_label),
        false,
        cfg,
        state.pool.clone(),
        run_store,
    )
    .await?;
    state.jobs.insert(job_id.clone(), handle);
    tracing::info!(
        "scheduler #{} ('{}') fired job {} at {}",
        sch.id,
        sch.name,
        job_id,
        now.to_rfc3339()
    );
    Ok(())
}
