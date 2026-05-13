use super::dag::Dag;
use super::progress::{ProgressEvent, ProgressReporter, StepUpdate, StepUpdateMsg};
use super::state::{
    ColumnMeta, GroupMetaDto, JobState, JobStatus, LogLine, StepInfo, StepRuntimeState,
    TableSample,
};
use crate::config::{ConnectionsFile, EtlConfig, Step};
use crate::engine::{execute_step, ConnectionPool, StepContext, TableStore};
use anyhow::Result;
use chrono::Utc;
use polars::prelude::*;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct JobHandle {
    pub job_id: String,
    pub cancel: CancellationToken,
    pub state: Arc<RwLock<JobState>>,
    pub broadcaster: broadcast::Sender<ProgressEvent>,
}

impl JobHandle {
    pub fn subscribe(&self) -> broadcast::Receiver<ProgressEvent> {
        self.broadcaster.subscribe()
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
    pub async fn snapshot(&self) -> JobState {
        self.state.read().await.clone()
    }
}

pub async fn run_job(
    job_id: String,
    config_name: String,
    user: Option<String>,
    debug: bool,
    cfg: EtlConfig,
    connections: ConnectionsFile,
) -> Result<JobHandle> {
    if let Some(path) = &cfg.duckdb_path {
        tracing::warn!(
            "config `{}` declares `duckdb_path = {}` which is deprecated; use connections.json instead",
            config_name,
            path
        );
    }
    // Estado inicial
    let now = Utc::now();
    let mut steps_map = HashMap::new();
    let mut step_order = Vec::new();
    for s in &cfg.steps {
        step_order.push(s.id.clone());
        let spec = serde_json::to_value(s).unwrap_or(serde_json::Value::Null);
        let step_uid = s
            .step_uid
            .expect("step_uid must be assigned before run_job (call ensure_step_uids)");
        steps_map.insert(
            s.id.clone(),
            StepInfo {
                step_uid,
                id: s.id.clone(),
                kind: s.kind_str().to_string(),
                depends_on: s.depends_on.clone(),
                output_table: s.output_table().map(|s| s.to_string()),
                group: s.group.clone(),
                state: StepRuntimeState::Pending,
                logs: Vec::new(),
                sample: None,
                spec,
            },
        );
    }

    // Lista de grupos: primero los explícitamente declarados (orden del config),
    // luego cualquier grupo referenciado por un step que no esté declarado.
    let mut groups: Vec<GroupMetaDto> = cfg
        .groups
        .iter()
        .map(|g| GroupMetaDto {
            name: g.name.clone(),
            description: g.description.clone(),
            color: g.color.clone(),
        })
        .collect();
    {
        let known: std::collections::HashSet<&str> =
            groups.iter().map(|g| g.name.as_str()).collect();
        let mut inferred: Vec<String> = Vec::new();
        let mut seen_inferred: std::collections::HashSet<String> = std::collections::HashSet::new();
        for s in &cfg.steps {
            if let Some(g) = &s.group {
                if !known.contains(g.as_str()) && seen_inferred.insert(g.clone()) {
                    inferred.push(g.clone());
                }
            }
        }
        for g in inferred {
            groups.push(GroupMetaDto {
                name: g,
                description: None,
                color: None,
            });
        }
    }
    let job_state = JobState {
        job_id: job_id.clone(),
        config_name: config_name.clone(),
        user: user.clone(),
        debug,
        started_at: now,
        finished_at: None,
        status: JobStatus::Running,
        steps: steps_map,
        step_order,
        groups,
        eta_seconds: None,
        job_pct: 0.0,
    };
    let state = Arc::new(RwLock::new(job_state));
    let (broadcaster, _) = broadcast::channel::<ProgressEvent>(1024);
    let cancel = CancellationToken::new();

    let handle = JobHandle {
        job_id: job_id.clone(),
        cancel: cancel.clone(),
        state: state.clone(),
        broadcaster: broadcaster.clone(),
    };

    // Pool de conexiones declarado en el archivo de conexiones.
    let pool = Arc::new(ConnectionPool::new(connections));

    // RunStore opcional: si la conexión `runs` no está declarada, seguimos
    // sin persistencia (con warning).
    let run_store = match crate::runs::RunStore::open(&pool).await {
        Ok(opt) => opt.map(Arc::new),
        Err(e) => {
            tracing::warn!("could not initialize runs DB: {e:#}; history disabled");
            None
        }
    };
    if let Some(store) = &run_store {
        if let Err(e) = store
            .insert_run(
                &job_id,
                &config_name,
                user.as_deref(),
                debug,
                now,
                cfg.steps.len(),
            )
            .await
        {
            tracing::warn!("could not persist run header: {e}");
        }
    }

    let tables: TableStore = Arc::new(RwLock::new(HashMap::new()));

    // Pre-broadcast del JobStarted
    let _ = broadcaster.send(ProgressEvent::JobStarted {
        job_id: job_id.clone(),
        total_steps: cfg.steps.len(),
    });

    // Lanzar supervisor + scheduler
    let cfg_arc = Arc::new(cfg);
    tokio::spawn(supervisor_and_scheduler(
        cfg_arc,
        tables,
        pool,
        state,
        broadcaster,
        cancel,
        run_store,
        job_id.clone(),
        debug,
    ));

    Ok(handle)
}

#[allow(clippy::too_many_arguments)]
async fn supervisor_and_scheduler(
    cfg: Arc<EtlConfig>,
    tables: TableStore,
    connections: Arc<ConnectionPool>,
    state: Arc<RwLock<JobState>>,
    broadcaster: broadcast::Sender<ProgressEvent>,
    cancel: CancellationToken,
    run_store: Option<Arc<crate::runs::RunStore>>,
    job_id_owned: String,
    debug: bool,
) {
    let job_started = Instant::now();
    let dag = match Dag::build(&cfg.steps) {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("dag build failed: {e}");
            mark_job_finished(&state, JobStatus::Failed, &broadcaster, job_started.elapsed().as_millis()).await;
            return;
        }
    };

    let step_by_id: HashMap<String, Step> =
        cfg.steps.iter().map(|s| (s.id.clone(), s.clone())).collect();

    let (tx, mut rx) = mpsc::channel::<StepUpdateMsg>(1024);

    // ready queue
    let mut in_degree = dag.in_degree.clone();
    let mut ready: Vec<String> = in_degree
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(k, _)| k.clone())
        .collect();
    ready.sort();

    let mut running_count: usize = 0;
    let mut done_or_terminal: HashSet<String> = HashSet::new();
    let mut step_started_at: HashMap<String, Instant> = HashMap::new();
    let timings = load_timings();

    // Marcar ready
    for sid in &ready {
        set_step_state(&state, sid, StepRuntimeState::Ready, &broadcaster).await;
    }

    // Lanzar todos los ready iniciales
    let mut to_launch = std::mem::take(&mut ready);

    loop {
        // Si el job fue cancelado, marcar pendientes/ready como Cancelled
        if cancel.is_cancelled() {
            let pending_ids: Vec<String> = {
                let s = state.read().await;
                s.step_order
                    .iter()
                    .filter(|id| {
                        let st = s.steps.get(*id).unwrap();
                        matches!(st.state, StepRuntimeState::Pending | StepRuntimeState::Ready)
                    })
                    .cloned()
                    .collect()
            };
            for id in &pending_ids {
                set_step_state(&state, id, StepRuntimeState::Cancelled, &broadcaster).await;
                done_or_terminal.insert(id.clone());
            }
            to_launch.clear();
        }

        for sid in to_launch.drain(..) {
            let step = step_by_id.get(&sid).cloned().unwrap();
            let reporter = ProgressReporter::new(sid.clone(), tx.clone());
            let ctx = StepContext {
                tables: tables.clone(),
                connections: connections.clone(),
                cancel: cancel.clone(),
            };
            running_count += 1;
            step_started_at.insert(sid.clone(), Instant::now());
            tokio::spawn(run_one_step(step, ctx, reporter, tables.clone()));
        }

        // Si no hay nada corriendo y nada por lanzar, terminamos
        if running_count == 0 && to_launch.is_empty() {
            break;
        }

        // Procesar updates
        let Some(msg) = rx.recv().await else { break };
        let step_id_at_msg = msg.step_id.clone();
        match msg.update {
            StepUpdate::Started => {
                set_step_state(
                    &state,
                    &msg.step_id,
                    StepRuntimeState::Running {
                        started_at: Utc::now(),
                        progress: 0.0,
                        rows_done: None,
                        rows_total: None,
                    },
                    &broadcaster,
                )
                .await;
            }
            StepUpdate::Progress {
                pct,
                rows_done,
                rows_total,
            } => {
                {
                    let mut s = state.write().await;
                    if let Some(info) = s.steps.get_mut(&msg.step_id) {
                        if let StepRuntimeState::Running {
                            started_at,
                            progress,
                            rows_done: rd,
                            rows_total: rt,
                        } = &mut info.state
                        {
                            *progress = pct;
                            *rd = rows_done;
                            *rt = rows_total;
                            let _ = (started_at,);
                        }
                    }
                }
                let _ = broadcaster.send(ProgressEvent::StepProgress {
                    step_id: msg.step_id.clone(),
                    pct,
                    rows_done,
                    rows_total,
                });
                recompute_eta(&state, &broadcaster, &timings, &step_started_at).await;
            }
            StepUpdate::Log { line, level } => {
                {
                    let mut s = state.write().await;
                    if let Some(info) = s.steps.get_mut(&msg.step_id) {
                        info.logs.push(LogLine {
                            at: Utc::now(),
                            level: level.clone(),
                            line: line.clone(),
                        });
                    }
                }
                let _ = broadcaster.send(ProgressEvent::StepLog {
                    step_id: msg.step_id.clone(),
                    line,
                    level,
                });
            }
            StepUpdate::Completed { row_count, sample } => {
                let started_at = step_started_at
                    .get(&msg.step_id)
                    .copied()
                    .unwrap_or_else(Instant::now);
                let duration_ms = started_at.elapsed().as_millis();
                let started_chrono = {
                    let s = state.read().await;
                    if let StepRuntimeState::Running { started_at, .. } =
                        s.steps.get(&msg.step_id).unwrap().state
                    {
                        started_at
                    } else {
                        Utc::now()
                    }
                };
                {
                    let mut s = state.write().await;
                    if let Some(info) = s.steps.get_mut(&msg.step_id) {
                        info.state = StepRuntimeState::Done {
                            started_at: started_chrono,
                            finished_at: Utc::now(),
                            duration_ms,
                            row_count,
                        };
                        info.sample = sample.clone();
                    }
                }
                let _ = broadcaster.send(ProgressEvent::StepCompleted {
                    step_id: msg.step_id.clone(),
                    row_count,
                    duration_ms,
                    sample,
                });
                done_or_terminal.insert(msg.step_id.clone());
                running_count = running_count.saturating_sub(1);

                // Encolar sucesores listos
                let succs = dag.successors.get(&msg.step_id).cloned().unwrap_or_default();
                for next in succs {
                    if let Some(d) = in_degree.get_mut(&next) {
                        *d = d.saturating_sub(1);
                        if *d == 0 && !done_or_terminal.contains(&next) {
                            set_step_state(&state, &next, StepRuntimeState::Ready, &broadcaster)
                                .await;
                            to_launch.push(next);
                        }
                    }
                }
                save_timing(&msg.step_id, &cfg, duration_ms);
                recompute_eta(&state, &broadcaster, &timings, &step_started_at).await;
            }
            StepUpdate::Failed { error } => {
                {
                    let mut s = state.write().await;
                    if let Some(info) = s.steps.get_mut(&msg.step_id) {
                        info.state = StepRuntimeState::Failed {
                            started_at: None,
                            finished_at: Utc::now(),
                            error: error.clone(),
                        };
                    }
                }
                let _ = broadcaster.send(ProgressEvent::StepStateChanged {
                    step_id: msg.step_id.clone(),
                    state: StepRuntimeState::Failed {
                        started_at: None,
                        finished_at: Utc::now(),
                        error: error.clone(),
                    },
                });
                done_or_terminal.insert(msg.step_id.clone());
                running_count = running_count.saturating_sub(1);
                // Marcar descendientes como Skipped
                let descendants = collect_descendants(&dag.successors, &msg.step_id);
                for d in descendants {
                    if !done_or_terminal.contains(&d) {
                        set_step_state(
                            &state,
                            &d,
                            StepRuntimeState::Skipped {
                                reason: format!("upstream `{}` failed", msg.step_id),
                            },
                            &broadcaster,
                        )
                        .await;
                        done_or_terminal.insert(d);
                    }
                }
                recompute_eta(&state, &broadcaster, &timings, &step_started_at).await;
            }
            StepUpdate::Cancelled => {
                set_step_state(&state, &msg.step_id, StepRuntimeState::Cancelled, &broadcaster)
                    .await;
                done_or_terminal.insert(msg.step_id.clone());
                running_count = running_count.saturating_sub(1);
            }
        }

        // Persistencia: si el step quedó en estado terminal, escribir su row
        // en step_runs + logs en step_logs (+ dataset si debug).
        if let Some(store) = &run_store {
            let info_snap = {
                let s = state.read().await;
                s.steps.get(&step_id_at_msg).cloned()
            };
            if let Some(info) = info_snap {
                if info.state.is_terminal() {
                    let st = store.clone();
                    let job_id = job_id_owned.clone();
                    let logs_to_persist = info.logs.clone();
                    let step_uid = info.step_uid;
                    let step_id_s = info.id.clone();
                    let kind = info.kind.clone();
                    let group = info.group.clone();
                    let state_clone = info.state.clone();

                    if let Err(e) = st
                        .upsert_step_run(
                            &job_id,
                            step_uid,
                            &step_id_s,
                            &kind,
                            group.as_deref(),
                            &state_clone,
                        )
                        .await
                    {
                        tracing::warn!("persist step_run failed for {step_id_s}: {e}");
                    }
                    if !logs_to_persist.is_empty() {
                        if let Err(e) = st.append_logs(&job_id, step_uid, logs_to_persist).await {
                            tracing::warn!("persist logs failed for {step_id_s}: {e}");
                        }
                    }
                    if debug && matches!(info.state, StepRuntimeState::Done { .. }) {
                        if let Some(table_name) = info.output_table.as_deref() {
                            let maybe_df = {
                                let t = tables.read().await;
                                t.get(table_name).cloned()
                            };
                            if let Some(df) = maybe_df {
                                if let Err(e) =
                                    st.persist_dataset(&job_id, step_uid, df.as_ref()).await
                                {
                                    tracing::warn!(
                                        "persist dataset failed for {step_id_s}: {e}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Determinar status final
    let final_status = {
        let s = state.read().await;
        if s.steps.values().any(|i| matches!(i.state, StepRuntimeState::Failed { .. })) {
            JobStatus::Failed
        } else if s.steps.values().any(|i| matches!(i.state, StepRuntimeState::Cancelled)) {
            JobStatus::Cancelled
        } else {
            JobStatus::Ok
        }
    };
    let total_ms = job_started.elapsed().as_millis();
    mark_job_finished(&state, final_status, &broadcaster, total_ms).await;
    if let Some(store) = &run_store {
        if let Err(e) = store
            .finish_run(&job_id_owned, final_status, Utc::now(), total_ms)
            .await
        {
            tracing::warn!("persist run finish failed: {e}");
        }
    }
}

async fn set_step_state(
    state: &Arc<RwLock<JobState>>,
    step_id: &str,
    new_state: StepRuntimeState,
    broadcaster: &broadcast::Sender<ProgressEvent>,
) {
    {
        let mut s = state.write().await;
        if let Some(info) = s.steps.get_mut(step_id) {
            info.state = new_state.clone();
        }
    }
    let _ = broadcaster.send(ProgressEvent::StepStateChanged {
        step_id: step_id.to_string(),
        state: new_state,
    });
}

async fn mark_job_finished(
    state: &Arc<RwLock<JobState>>,
    status: JobStatus,
    broadcaster: &broadcast::Sender<ProgressEvent>,
    duration_ms: u128,
) {
    {
        let mut s = state.write().await;
        s.status = status;
        s.finished_at = Some(Utc::now());
        s.job_pct = 1.0;
        s.eta_seconds = Some(0);
    }
    let _ = broadcaster.send(ProgressEvent::JobFinished {
        status,
        duration_ms,
    });
}

async fn run_one_step(
    step: Step,
    ctx: StepContext,
    reporter: ProgressReporter,
    tables: TableStore,
) {
    reporter.started();
    if ctx.cancel.is_cancelled() {
        reporter.cancelled();
        return;
    }
    let reporter_clone = reporter.clone();
    let res = execute_step(&step, &ctx, reporter_clone).await;
    match res {
        Ok(outcome) => {
            let row_count = outcome.row_count;
            let sample = if let Some(df) = &outcome.dataframe {
                Some(make_sample(df))
            } else {
                None
            };
            if let (Some(name), Some(df)) = (outcome.output_table, outcome.dataframe) {
                let mut guard = tables.write().await;
                guard.insert(name, Arc::new(df));
            }
            reporter.completed(row_count, sample);
        }
        Err(e) => {
            if ctx.cancel.is_cancelled() {
                reporter.cancelled();
            } else {
                reporter.failed(format!("{e:#}"));
            }
        }
    }
}

fn make_sample(df: &DataFrame) -> TableSample {
    const N: usize = 50;
    let sampled = df.head(Some(N));
    let cols: Vec<ColumnMeta> = sampled
        .schema()
        .iter()
        .map(|(name, dtype)| ColumnMeta {
            name: name.to_string(),
            dtype: format!("{dtype}"),
        })
        .collect();
    let height = sampled.height();
    let width = sampled.width();
    let series = sampled.get_columns();
    let mut rows: Vec<Vec<JsonValue>> = Vec::with_capacity(height);
    for i in 0..height {
        let mut row: Vec<JsonValue> = Vec::with_capacity(width);
        for c in series {
            row.push(any_value_to_json(c.get(i).ok()));
        }
        rows.push(row);
    }
    TableSample {
        columns: cols,
        rows,
        total_rows: df.height(),
        sampled_rows: height,
    }
}

fn any_value_to_json(v: Option<AnyValue>) -> JsonValue {
    match v {
        None | Some(AnyValue::Null) => JsonValue::Null,
        Some(AnyValue::Boolean(b)) => JsonValue::Bool(b),
        Some(AnyValue::Int8(i)) => JsonValue::from(i),
        Some(AnyValue::Int16(i)) => JsonValue::from(i),
        Some(AnyValue::Int32(i)) => JsonValue::from(i),
        Some(AnyValue::Int64(i)) => JsonValue::from(i),
        Some(AnyValue::UInt8(i)) => JsonValue::from(i),
        Some(AnyValue::UInt16(i)) => JsonValue::from(i),
        Some(AnyValue::UInt32(i)) => JsonValue::from(i),
        Some(AnyValue::UInt64(i)) => JsonValue::from(i),
        Some(AnyValue::Float32(f)) => serde_json::Number::from_f64(f as f64)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Some(AnyValue::Float64(f)) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Some(AnyValue::String(s)) => JsonValue::String(s.to_string()),
        Some(AnyValue::StringOwned(s)) => JsonValue::String(s.to_string()),
        Some(other) => JsonValue::String(other.to_string()),
    }
}

fn collect_descendants(succ: &HashMap<String, Vec<String>>, root: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack: Vec<String> = succ.get(root).cloned().unwrap_or_default();
    while let Some(n) = stack.pop() {
        if !out.contains(&n) {
            if let Some(ch) = succ.get(&n) {
                for c in ch {
                    stack.push(c.clone());
                }
            }
            out.push(n);
        }
    }
    out
}

// ----- Timings históricos (mediana por kind) -----

#[derive(Default, Clone)]
struct Timings {
    per_kind: HashMap<String, Vec<u128>>,
}

impl Timings {
    fn median(&self, kind: &str) -> Option<u128> {
        let v = self.per_kind.get(kind)?;
        if v.is_empty() {
            return None;
        }
        let mut x = v.clone();
        x.sort_unstable();
        Some(x[x.len() / 2])
    }
}

fn timings_path() -> &'static str {
    "data/timings.json"
}

fn load_timings() -> Timings {
    let path = timings_path();
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<HashMap<String, Vec<u128>>>(&s)
            .map(|per_kind| Timings { per_kind })
            .unwrap_or_default(),
        Err(_) => Timings::default(),
    }
}

fn save_timing(step_id: &str, cfg: &EtlConfig, duration_ms: u128) {
    let kind = match cfg.steps.iter().find(|s| s.id == step_id) {
        Some(s) => s.kind_str().to_string(),
        None => return,
    };
    let path = timings_path();
    let mut current: HashMap<String, Vec<u128>> = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let v = current.entry(kind).or_default();
    v.push(duration_ms);
    if v.len() > 20 {
        let drop = v.len() - 20;
        v.drain(0..drop);
    }
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(&current).unwrap_or_default());
}

async fn recompute_eta(
    state: &Arc<RwLock<JobState>>,
    broadcaster: &broadcast::Sender<ProgressEvent>,
    timings: &Timings,
    started_at: &HashMap<String, Instant>,
) {
    let (job_pct, eta_seconds, done, total) = {
        let s = state.read().await;
        let total = s.step_order.len();
        let mut done = 0usize;
        let mut remaining_ms: u128 = 0;
        for id in &s.step_order {
            let info = s.steps.get(id).unwrap();
            let median = timings.median(&info.kind).unwrap_or(1500);
            match &info.state {
                StepRuntimeState::Done { duration_ms, .. } => {
                    done += 1;
                    let _ = duration_ms;
                }
                StepRuntimeState::Cancelled | StepRuntimeState::Skipped { .. } => {
                    done += 1;
                }
                StepRuntimeState::Failed { .. } => {
                    done += 1;
                }
                StepRuntimeState::Running { progress, .. } => {
                    let elapsed = started_at
                        .get(id)
                        .map(|i| i.elapsed().as_millis())
                        .unwrap_or(0);
                    let remaining = if *progress > 0.01 {
                        ((elapsed as f32) * (1.0 - *progress) / *progress) as u128
                    } else {
                        median.saturating_sub(elapsed)
                    };
                    remaining_ms = remaining_ms.saturating_add(remaining);
                }
                _ => {
                    remaining_ms = remaining_ms.saturating_add(median);
                }
            }
        }
        let pct = if total == 0 {
            1.0
        } else {
            (done as f32) / (total as f32)
        };
        let eta_s = if remaining_ms == 0 {
            None
        } else {
            Some((remaining_ms / 1000) as u64)
        };
        (pct, eta_s, done, total)
    };
    {
        let mut s = state.write().await;
        s.job_pct = job_pct;
        s.eta_seconds = eta_seconds;
    }
    let _ = broadcaster.send(ProgressEvent::JobEta {
        job_pct,
        eta_seconds,
        steps_done: done,
        steps_total: total,
    });
}
