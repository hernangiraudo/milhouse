use super::dag::Dag;
use super::progress::{ProgressEvent, ProgressReporter, StepUpdate, StepUpdateMsg};
use super::state::{
    ColumnMeta, GroupMetaDto, JobState, JobStatus, LogLine, StepInfo, StepRuntimeState,
    TableSample,
};
use crate::config::{EtlConfig, Step};
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
    /// Solicitudes de cancelación granular. El supervisor las lee y
    /// actúa entre iteraciones del loop principal.
    pub control: Arc<RwLock<JobControl>>,
}

/// Estado de cancelaciones parciales. El frontend marca `drain=true` para
/// frenar los pendientes/ready pero dejar terminar los Running. Cada
/// `cancel_step_ids` se procesa una vez y se vacía.
#[derive(Debug)]
pub struct JobControl {
    /// Cuando es true, cualquier paso que estaba esperando slot o ready
    /// se marca Cancelled y no se lanzan más nuevos. Los Running terminan
    /// naturalmente y el job finaliza.
    pub drain: bool,
    /// Step ids a cancelar individualmente. Solo aplica a Pending/Ready
    /// (el Running se respeta — habría que matar la query desde el motor,
    /// pendiente de otra tanda).
    pub cancel_step_ids: HashSet<String>,
    /// Notify para que el supervisor despierte ante una nueva señal
    /// aunque no haya mensajes en el mpsc principal.
    pub notify: Arc<tokio::sync::Notify>,
}

impl Default for JobControl {
    fn default() -> Self {
        Self {
            drain: false,
            cancel_step_ids: HashSet::new(),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }
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
    pub async fn request_drain(&self) {
        let notify = {
            let mut c = self.control.write().await;
            c.drain = true;
            c.notify.clone()
        };
        notify.notify_one();
    }
    pub async fn request_cancel_step(&self, step_id: String) {
        let notify = {
            let mut c = self.control.write().await;
            c.cancel_step_ids.insert(step_id);
            c.notify.clone()
        };
        notify.notify_one();
    }
}

#[derive(Default, Clone, Debug)]
pub struct JobOptions {
    /// Subset de step ids a ejecutar. None ⇒ todos.
    pub target_steps: Option<HashSet<String>>,
    /// Si true, ante el primer fallo, cancela el job entero.
    pub stop_on_failure: bool,
    /// Si true, antes del scheduler se cargan los datasets preloadeados al
    /// TableStore desde `data/preloaded/<config_name>/`. Los steps cuyas
    /// output_table quedan precargadas se marcan automáticamente como
    /// Skipped.
    pub use_preload: bool,
    /// Valores resueltos de parámetros para esta ejecución (`:nombre` → valor).
    pub params: std::collections::HashMap<String, crate::config::ParamValue>,
    /// Constantes globales para sustitución `:Grupo.Nombre`. Se pasan por
    /// valor para que la ejecución sea reproducible aunque el archivo
    /// cambie en runtime.
    pub constants: Vec<crate::config::ConstantSpec>,
    /// Etiqueta opcional para identificar esta corrida.
    pub run_name: Option<String>,
}

pub async fn run_job(
    job_id: String,
    config_name: String,
    user: Option<String>,
    debug: bool,
    cfg: EtlConfig,
    pool: Arc<ConnectionPool>,
    run_store: Option<Arc<crate::runs::RunStore>>,
    options: JobOptions,
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
                sql_session: None,
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
            parent_group: g.parent_group.clone(),
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
                parent_group: None,
            });
        }
    }
    let job_state = JobState {
        job_id: job_id.clone(),
        config_name: config_name.clone(),
        config_display_name: Some(cfg.name.clone()),
        run_name: options.run_name.clone(),
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
    let control: Arc<RwLock<JobControl>> = Arc::new(RwLock::new(JobControl::default()));

    let handle = JobHandle {
        job_id: job_id.clone(),
        cancel: cancel.clone(),
        state: state.clone(),
        broadcaster: broadcaster.clone(),
        control: control.clone(),
    };

    // El pool y run_store vienen del AppState (compartidos). Esto evita que
    // múltiples conexiones DuckDB compitan por el mismo archivo .duckdb.
    if let Some(store) = &run_store {
        if let Err(e) = store
            .insert_run(
                &job_id,
                &config_name,
                Some(cfg.name.as_str()),
                user.as_deref(),
                debug,
                now,
                cfg.steps.len(),
                options.run_name.as_deref(),
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
        control,
        run_store,
        job_id.clone(),
        debug,
        options,
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
    control: Arc<RwLock<JobControl>>,
    run_store: Option<Arc<crate::runs::RunStore>>,
    job_id_owned: String,
    debug: bool,
    options: JobOptions,
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

    // Construir ResolvedParams una vez por job: specs del config + valores
    // del request + constantes globales. Compartido entre todos los
    // StepContext via Arc.
    let resolved_params = Arc::new(
        crate::engine::params::ResolvedParams::new(&cfg.parameters, options.params.clone())
            .with_constants(&options.constants),
    );

    let (tx, mut rx) = mpsc::channel::<StepUpdateMsg>(1024);

    // ready queue
    let mut in_degree = dag.in_degree.clone();
    let mut running_count: usize = 0;
    let mut done_or_terminal: HashSet<String> = HashSet::new();
    let mut step_started_at: HashMap<String, Instant> = HashMap::new();
    let timings = load_timings();

    // Preload: cargar parquet preloadeados al TableStore y marcar esos
    // steps como Skipped { precargado }.
    let config_name_for_preload = {
        let s = state.read().await;
        s.config_name.clone()
    };
    if options.use_preload {
        let steps_by_id: HashMap<String, String> = cfg
            .steps
            .iter()
            .filter_map(|s| s.output_table().map(|ot| (s.id.clone(), ot.to_string())))
            .collect();
        match crate::runs::bundle::load_preloaded_tables(&config_name_for_preload, &steps_by_id) {
            Ok(loaded) => {
                if !loaded.is_empty() {
                    let mut guard = tables.write().await;
                    for (k, v) in &loaded {
                        guard.insert(k.clone(), Arc::new(v.clone()));
                    }
                    drop(guard);
                    // Marcar como Done los steps cuyo output_table fue precargado:
                    // - emitir StepCompleted con sample → la UI lo ve como
                    //   un paso normal con datos.
                    // - persistir el dataset en la DB de runs si debug=true,
                    //   así el panel "Datos de salida" puede abrirlo.
                    // - decrementar in-degree de sucesores.
                    let now_chrono = Utc::now();
                    for s in &cfg.steps {
                        let Some(ot) = s.output_table() else { continue };
                        let Some(df_arc) = loaded.get(ot) else { continue };
                        let row_count = df_arc.height();
                        let sample = make_sample(df_arc);

                        let done_state = StepRuntimeState::Done {
                            started_at: now_chrono,
                            finished_at: now_chrono,
                            duration_ms: 0,
                            row_count,
                        };

                        // Estado Done + sample + log informativo.
                        {
                            let mut st = state.write().await;
                            if let Some(info) = st.steps.get_mut(&s.id) {
                                info.state = done_state.clone();
                                info.sample = Some(sample.clone());
                                info.logs.push(LogLine {
                                    at: now_chrono,
                                    level: "info".to_string(),
                                    line: format!(
                                        "precargado desde bundle ({} filas) — no se ejecuta",
                                        row_count
                                    ),
                                });
                            }
                        }
                        let _ = broadcaster.send(ProgressEvent::StepStateChanged {
                            step_id: s.id.clone(),
                            state: done_state.clone(),
                        });
                        let _ = broadcaster.send(ProgressEvent::StepCompleted {
                            step_id: s.id.clone(),
                            row_count,
                            duration_ms: 0,
                            sample: Some(sample),
                        });

                        // Persistencia en la DB de runs para que el step
                        // aparezca en Revisión y el dataset sea abrible
                        // desde el panel "Datos de salida".
                        if let Some(store) = run_store.as_ref() {
                            if let Some(uid) = s.step_uid {
                                if let Err(e) = store
                                    .upsert_step_run(
                                        &job_id_owned,
                                        uid,
                                        &s.id,
                                        s.kind_str(),
                                        s.group.as_deref(),
                                        &done_state,
                                    )
                                    .await
                                {
                                    tracing::warn!(
                                        "preload: upsert_step_run failed for {}: {e:#}",
                                        s.id
                                    );
                                }
                                let log_line = LogLine {
                                    at: now_chrono,
                                    level: "info".to_string(),
                                    line: format!(
                                        "precargado desde bundle ({} filas) — no se ejecuta",
                                        row_count
                                    ),
                                };
                                if let Err(e) = store
                                    .append_logs(&job_id_owned, uid, vec![log_line])
                                    .await
                                {
                                    tracing::warn!(
                                        "preload: append_logs failed for {}: {e:#}",
                                        s.id
                                    );
                                }
                                if debug {
                                    let dataset_name = s
                                        .dataset_name
                                        .clone()
                                        .unwrap_or_else(|| s.id.clone());
                                    let level = s.log_level.as_str();
                                    if let Err(e) = store
                                        .persist_dataset(
                                            &job_id_owned,
                                            uid,
                                            &dataset_name,
                                            level,
                                            df_arc,
                                        )
                                        .await
                                    {
                                        tracing::warn!(
                                            "preload: persist_dataset failed for {}: {e:#}",
                                            s.id
                                        );
                                    }
                                }
                            }
                        }

                        done_or_terminal.insert(s.id.clone());
                        let succs =
                            dag.successors.get(&s.id).cloned().unwrap_or_default();
                        for next in succs {
                            if let Some(d) = in_degree.get_mut(&next) {
                                *d = d.saturating_sub(1);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!("preload failed: {e:#}");
            }
        }
    }

    // Si hay subset, marcar como Skipped TODO lo que no está en él y
    // decrementar in-degree de sus sucesores para que el grafo restante
    // pueda avanzar.
    if let Some(targets) = options.target_steps.as_ref() {
        let all_ids: Vec<String> = cfg.steps.iter().map(|s| s.id.clone()).collect();
        for sid in &all_ids {
            if !targets.contains(sid) {
                set_step_state(
                    &state,
                    sid,
                    StepRuntimeState::Skipped {
                        reason: "fuera del subset solicitado".to_string(),
                    },
                    &broadcaster,
                )
                .await;
                done_or_terminal.insert(sid.clone());
                // Decrementar in_degree de sucesores (como si hubiera terminado).
                let succs = dag.successors.get(sid).cloned().unwrap_or_default();
                for next in succs {
                    if let Some(d) = in_degree.get_mut(&next) {
                        *d = d.saturating_sub(1);
                    }
                }
            }
        }
    }

    let mut ready: Vec<String> = in_degree
        .iter()
        .filter(|(id, &d)| d == 0 && !done_or_terminal.contains(*id))
        .map(|(k, _)| k.clone())
        .collect();
    ready.sort();

    // Marcar ready
    for sid in &ready {
        set_step_state(&state, sid, StepRuntimeState::Ready, &broadcaster).await;
    }

    // Cola de pasos listos para lanzarse. Se vacía respetando el cap de
    // paralelismo. Si un step queda en la cola sin slot, su estado sigue
    // siendo Ready y el front lo muestra como "esperando slot".
    let mut to_launch = std::mem::take(&mut ready);
    // None ⇒ sin cap (lanza todo lo ready). Algunos valores típicos:
    // 1 (serial), 4, 8.
    let max_parallel: Option<usize> = cfg.settings.max_parallel_steps;

    loop {
        // Procesar señales de control granular (drain + cancel-step-N).
        // El drain es equivalente a "cancelar todo lo pendiente pero dejar
        // terminar los Running"; cancel_step solo afecta Pending/Ready.
        let (drain, cancel_ids) = {
            let mut c = control.write().await;
            let cs: Vec<String> = c.cancel_step_ids.drain().collect();
            (c.drain, cs)
        };
        if drain {
            // Marcar todos los Pending/Ready como Cancelled. No tocamos
            // Running — los dejamos terminar.
            let to_cancel: Vec<String> = {
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
            for id in &to_cancel {
                set_step_state(&state, id, StepRuntimeState::Cancelled, &broadcaster).await;
                done_or_terminal.insert(id.clone());
            }
            to_launch.clear();
        }
        for sid in cancel_ids {
            // Leemos el estado + sql_session bajo lock corto.
            let (st, session) = {
                let s = state.read().await;
                let info = s.steps.get(&sid);
                (
                    info.map(|i| i.state.clone()),
                    info.and_then(|i| i.sql_session.clone()),
                )
            };
            let is_pending = matches!(
                st,
                Some(StepRuntimeState::Pending) | Some(StepRuntimeState::Ready)
            );
            let is_running = matches!(st, Some(StepRuntimeState::Running { .. }));

            // Caso Running con sesión SQL Server conocida: lanzamos KILL
            // <sid> via cliente paralelo del pool. El cliente que está
            // corriendo la query se libera cuando el motor detecta el
            // error y vuelve. El KILL no necesita bloquear el supervisor.
            if is_running {
                if let Some(sess) = session.clone() {
                    let pool = connections.clone();
                    let sid_clone = sid.clone();
                    tokio::spawn(async move {
                        if let Err(e) = kill_sql_server_session(
                            pool,
                            &sess.connection,
                            sess.sid,
                        )
                        .await
                        {
                            tracing::warn!(
                                "KILL falló para step {sid_clone} (SPID {}): {e:#}",
                                sess.sid
                            );
                        } else {
                            tracing::info!(
                                "KILL enviado para step {sid_clone} (SPID {})",
                                sess.sid
                            );
                        }
                    });
                }
            }

            // Tanto en Pending/Ready como en Running con KILL despachado:
            // marcamos Cancelled inmediatamente y marcamos los
            // descendientes como Skipped por dependencia rota. El task
            // del step Running terminará en Err (queries killed) y eso
            // genera un StepUpdate::Failed que el match de abajo procesa
            // — pero como el step ya está terminal, set_step_state no
            // hará daño (sobrescribe sólo a quien no esté terminal).
            if is_pending || is_running {
                set_step_state(&state, &sid, StepRuntimeState::Cancelled, &broadcaster).await;
                done_or_terminal.insert(sid.clone());
                if is_running {
                    running_count = running_count.saturating_sub(1);
                }
                to_launch.retain(|x| x != &sid);
                let descendants = collect_descendants(&dag.successors, &sid);
                for d in descendants {
                    if !done_or_terminal.contains(&d) {
                        set_step_state(
                            &state,
                            &d,
                            StepRuntimeState::Skipped {
                                reason: format!("dependencia cancelada: {sid}"),
                            },
                            &broadcaster,
                        )
                        .await;
                        done_or_terminal.insert(d.clone());
                        to_launch.retain(|x| x != &d);
                    }
                }
            }
        }

        // Si el job fue cancelado, marcar pendientes/ready como Cancelled.
        // También marcamos los Running visualmente como Cancelled —
        // sus tasks pueden seguir corriendo un toque (libera el cliente
        // SQL pero la query del lado del servidor sigue), pero la UI
        // ya refleja el estado correcto y no se quedan en "Ejecutando"
        // hasta que el TCP timeout expire.
        if cancel.is_cancelled() {
            let to_cancel: Vec<String> = {
                let s = state.read().await;
                s.step_order
                    .iter()
                    .filter(|id| {
                        let st = s.steps.get(*id).unwrap();
                        matches!(
                            st.state,
                            StepRuntimeState::Pending
                                | StepRuntimeState::Ready
                                | StepRuntimeState::Running { .. }
                        )
                    })
                    .cloned()
                    .collect()
            };
            let was_running: std::collections::HashSet<String> = {
                let s = state.read().await;
                s.step_order
                    .iter()
                    .filter(|id| {
                        let st = s.steps.get(*id).unwrap();
                        matches!(st.state, StepRuntimeState::Running { .. })
                    })
                    .cloned()
                    .collect()
            };
            for id in &to_cancel {
                set_step_state(&state, id, StepRuntimeState::Cancelled, &broadcaster).await;
                done_or_terminal.insert(id.clone());
            }
            // Los Running ya se marcaron Cancelled — descontamos del
            // contador para que el loop pueda terminar aunque sus tasks
            // sigan corriendo un toque en background (TCP en cierre).
            running_count = running_count.saturating_sub(was_running.len());
            to_launch.clear();
        }

        // Lanzar de la cola respetando el cap de paralelismo. Si max es
        // None, lanza todo. Si max es Some(N), lanza solo lo que cabe;
        // el resto queda en to_launch esperando que termine alguno.
        let mut launched_now = 0usize;
        let mut keep_waiting: Vec<String> = Vec::new();
        for sid in to_launch.drain(..) {
            if let Some(max) = max_parallel {
                if running_count >= max {
                    keep_waiting.push(sid);
                    continue;
                }
            }
            let step = step_by_id.get(&sid).cloned().unwrap();
            let reporter = ProgressReporter::new(
                sid.clone(),
                step.log_level.as_str().to_string(),
                tx.clone(),
            );
            let ctx = StepContext {
                tables: tables.clone(),
                connections: connections.clone(),
                cancel: cancel.clone(),
                params: resolved_params.clone(),
            };
            running_count += 1;
            launched_now += 1;
            step_started_at.insert(sid.clone(), Instant::now());
            tokio::spawn(run_one_step(step, ctx, reporter, tables.clone()));
        }
        to_launch = keep_waiting;
        let _ = launched_now; // por si queremos métricas más adelante

        // Si no hay nada corriendo y nada por lanzar, terminamos
        if running_count == 0 && to_launch.is_empty() {
            break;
        }

        // Procesar updates: o llega un mensaje de un step (start/progress/
        // log/completed/failed) o el frontend nos despierta con una señal
        // de control (drain / cancel-step / cancel global).
        let control_notify = { control.read().await.notify.clone() };
        let msg = tokio::select! {
            biased;
            _ = control_notify.notified() => {
                // No es un mensaje de step — volvemos al tope del loop para
                // procesar las señales nuevas de control.
                continue;
            }
            _ = cancel.cancelled() => {
                // El cancel global llegó. La iteración siguiente ya lo
                // detecta arriba y marca pendientes/ready como Cancelled.
                continue;
            }
            recv = rx.recv() => match recv {
                Some(m) => m,
                None => break,
            }
        };
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
                // Si ya quedó terminal (cancel previo), descartamos el
                // Completed que llega tarde.
                let already_terminal = {
                    let s = state.read().await;
                    s.steps
                        .get(&msg.step_id)
                        .map(|i| i.state.is_terminal())
                        .unwrap_or(false)
                };
                if already_terminal {
                    done_or_terminal.insert(msg.step_id.clone());
                    continue;
                }
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
                        info.sql_session = None;
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
                // Línea de log con el error completo, para que aparezca en
                // "Revisión de logs" sin tener que mirar el state crudo.
                // Si el step ya está terminal (ej. lo cancelamos antes
                // por cancel global o cancel-step y la task SQL retornó
                // tarde con Err), preservamos el state existente y solo
                // agregamos el log.
                let already_terminal: bool;
                {
                    let mut s = state.write().await;
                    if let Some(info) = s.steps.get_mut(&msg.step_id) {
                        already_terminal = info.state.is_terminal();
                        info.logs.push(LogLine {
                            at: Utc::now(),
                            level: "error".to_string(),
                            line: format!("step falló: {error}"),
                        });
                        if !already_terminal {
                            info.state = StepRuntimeState::Failed {
                                started_at: None,
                                finished_at: Utc::now(),
                                error: error.clone(),
                            };
                            info.sql_session = None;
                        }
                    } else {
                        already_terminal = false;
                    }
                }
                if already_terminal {
                    // Solo asegurarse de que no sigue contando como Running
                    // y seguir al próximo mensaje. No emitimos state change.
                    done_or_terminal.insert(msg.step_id.clone());
                    continue;
                }
                let _ = broadcaster.send(ProgressEvent::StepLog {
                    step_id: msg.step_id.clone(),
                    line: format!("step falló: {error}"),
                    level: "error".to_string(),
                });
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
                if options.stop_on_failure {
                    tracing::info!(
                        "stop_on_failure enabled: cancelling job after `{}` failed",
                        msg.step_id
                    );
                    cancel.cancel();
                }
                // Marcar descendientes como Skipped + persistir línea de log
                // en cada uno para que la causa raíz quede registrada también
                // donde el usuario va a mirar primero (los pasos saltados).
                let descendants = collect_descendants(&dag.successors, &msg.step_id);
                for d in descendants {
                    if !done_or_terminal.contains(&d) {
                        {
                            let mut s = state.write().await;
                            if let Some(info) = s.steps.get_mut(&d) {
                                info.logs.push(LogLine {
                                    at: Utc::now(),
                                    level: "warn".to_string(),
                                    line: format!(
                                        "saltado: el upstream `{}` falló — error: {}",
                                        msg.step_id, error
                                    ),
                                });
                            }
                        }
                        let _ = broadcaster.send(ProgressEvent::StepLog {
                            step_id: d.clone(),
                            line: format!(
                                "saltado: el upstream `{}` falló — error: {}",
                                msg.step_id, error
                            ),
                            level: "warn".to_string(),
                        });
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
                let already_terminal = {
                    let s = state.read().await;
                    s.steps
                        .get(&msg.step_id)
                        .map(|i| i.state.is_terminal())
                        .unwrap_or(false)
                };
                if already_terminal {
                    done_or_terminal.insert(msg.step_id.clone());
                    continue;
                }
                set_step_state(&state, &msg.step_id, StepRuntimeState::Cancelled, &broadcaster)
                    .await;
                done_or_terminal.insert(msg.step_id.clone());
                running_count = running_count.saturating_sub(1);
            }
            StepUpdate::SqlSession { connection, sid } => {
                {
                    let mut s = state.write().await;
                    if let Some(info) = s.steps.get_mut(&msg.step_id) {
                        info.sql_session = Some(
                            crate::orchestrator::state::SqlSessionInfo {
                                connection: connection.clone(),
                                sid,
                            },
                        );
                    }
                }
                let _ = broadcaster.send(ProgressEvent::StepSqlSession {
                    step_id: msg.step_id.clone(),
                    connection,
                    sid,
                });
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
                                // Resolver nombre + nivel desde el config.
                                let step_def = cfg
                                    .steps
                                    .iter()
                                    .find(|s| s.id == step_id_s);
                                let ds_name = step_def
                                    .and_then(|s| s.dataset_name.clone())
                                    .unwrap_or_else(|| step_id_s.clone());
                                let ds_level = step_def
                                    .map(|s| s.log_level.as_str().to_string())
                                    .unwrap_or_else(|| "info".to_string());
                                if let Err(e) = st
                                    .persist_dataset(
                                        &job_id, step_uid, &ds_name, &ds_level, df.as_ref(),
                                    )
                                    .await
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
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
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
        // Fechas/horas: emitimos string ISO. El frontend re-formatea a
        // dd/mm/yyyy (Date) o dd/mm/yyyy HH:MM:SS (Datetime). Lo
        // importante acá es NO caer al Debug crudo de polars que
        // muestra `DateTime { days: ... }`.
        Some(AnyValue::Date(days)) => {
            let d = NaiveDate::from_ymd_opt(1970, 1, 1)
                .unwrap()
                + chrono::Duration::days(days as i64);
            JsonValue::String(d.format("%Y-%m-%d").to_string())
        }
        Some(AnyValue::Datetime(ts, unit, _tz)) => {
            let dt: Option<NaiveDateTime> = match unit {
                TimeUnit::Nanoseconds => {
                    let secs = ts.div_euclid(1_000_000_000);
                    let nanos = ts.rem_euclid(1_000_000_000) as u32;
                    chrono::DateTime::from_timestamp(secs, nanos).map(|d| d.naive_utc())
                }
                TimeUnit::Microseconds => {
                    let secs = ts.div_euclid(1_000_000);
                    let nanos = (ts.rem_euclid(1_000_000) as u32) * 1_000;
                    chrono::DateTime::from_timestamp(secs, nanos).map(|d| d.naive_utc())
                }
                TimeUnit::Milliseconds => {
                    let secs = ts.div_euclid(1_000);
                    let nanos = (ts.rem_euclid(1_000) as u32) * 1_000_000;
                    chrono::DateTime::from_timestamp(secs, nanos).map(|d| d.naive_utc())
                }
            };
            match dt {
                Some(d) => JsonValue::String(d.format("%Y-%m-%dT%H:%M:%S").to_string()),
                None => JsonValue::Null,
            }
        }
        Some(AnyValue::Time(nanos)) => {
            let t = NaiveTime::from_hms_opt(0, 0, 0).unwrap()
                + chrono::Duration::nanoseconds(nanos);
            JsonValue::String(t.format("%H:%M:%S").to_string())
        }
        Some(other) => JsonValue::String(other.to_string()),
    }
}

/// Lanza `KILL <sid>` contra la conexión SQL Server indicada. Usa un
/// lease nuevo del pool (no toca el cliente que tiene la query del step
/// corriendo) — eso es lo que hace que el cancel funcione: la query del
/// step recibe el error de cancelación del lado del servidor y libera
/// su lease cuando vuelve.
async fn kill_sql_server_session(
    pool: Arc<ConnectionPool>,
    connection: &str,
    sid: i32,
) -> anyhow::Result<()> {
    use anyhow::anyhow;
    let opened = pool.get_any(Some(connection)).await?;
    let pool = match &*opened {
        crate::engine::OpenedConnection::SqlServer(p) => p.clone(),
        _ => return Err(anyhow!("la conexión `{connection}` no es SQL Server")),
    };
    let mut lease = pool.acquire().await?;
    let client = lease.client_mut();
    let sql = format!("KILL {sid}");
    client
        .simple_query(sql)
        .await
        .map_err(|e| anyhow!("KILL {sid}: {e}"))?;
    Ok(())
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
