use super::state::{JobStatus, StepRuntimeState, TableSample};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProgressEvent {
    JobStarted {
        job_id: String,
        total_steps: usize,
    },
    StepStateChanged {
        step_id: String,
        state: StepStateDto,
    },
    StepProgress {
        step_id: String,
        pct: f32,
        rows_done: Option<usize>,
        rows_total: Option<usize>,
    },
    StepLog {
        step_id: String,
        line: String,
        level: String,
    },
    StepCompleted {
        step_id: String,
        row_count: usize,
        duration_ms: u128,
        sample: Option<TableSample>,
    },
    /// Una query del step quedó asignada a una sesión en SQL Server.
    /// Se usa para mostrar el SPID en la UI y para poder matar la sesión
    /// con KILL si el usuario cancela el step.
    StepSqlSession {
        step_id: String,
        connection: String,
        sid: i32,
    },
    JobEta {
        job_pct: f32,
        eta_seconds: Option<u64>,
        steps_done: usize,
        steps_total: usize,
    },
    JobFinished {
        status: JobStatus,
        duration_ms: u128,
    },
}

/// Versión "simplificada" de StepRuntimeState para el evento.
pub type StepStateDto = StepRuntimeState;

#[derive(Debug, Clone)]
pub enum StepUpdate {
    Started,
    Progress {
        pct: f32,
        rows_done: Option<usize>,
        rows_total: Option<usize>,
    },
    Log {
        line: String,
        level: String,
    },
    Completed {
        row_count: usize,
        sample: Option<TableSample>,
    },
    Failed {
        error: String,
    },
    Cancelled,
    SqlSession {
        connection: String,
        sid: i32,
    },
}

#[derive(Debug, Clone)]
pub struct StepUpdateMsg {
    pub step_id: String,
    pub update: StepUpdate,
}

/// Reporter pasado a cada step. Es Clone para que cualquier subtask lo use.
#[derive(Clone)]
pub struct ProgressReporter {
    step_id: String,
    /// Nivel de log default emitido por este step (definido en el config).
    /// Cuando alguien llama `log()` sin nivel explícito, se usa éste.
    default_level: String,
    tx: mpsc::Sender<StepUpdateMsg>,
}

impl ProgressReporter {
    pub fn new(step_id: String, default_level: String, tx: mpsc::Sender<StepUpdateMsg>) -> Self {
        Self {
            step_id,
            default_level,
            tx,
        }
    }
    pub fn step_id(&self) -> &str {
        &self.step_id
    }
    pub fn default_level(&self) -> &str {
        &self.default_level
    }
    pub fn started(&self) {
        // started() es informativo: si la cola está llena, podemos perderlo
        // y el step queda visualmente en Ready hasta el primer Progress —
        // no es crítico.
        let _ = self.tx.try_send(StepUpdateMsg {
            step_id: self.step_id.clone(),
            update: StepUpdate::Started,
        });
    }
    pub fn report_progress(&self, pct: f32, rows_done: Option<usize>, rows_total: Option<usize>) {
        let _ = self.tx.try_send(StepUpdateMsg {
            step_id: self.step_id.clone(),
            update: StepUpdate::Progress {
                pct,
                rows_done,
                rows_total,
            },
        });
    }
    /// Emite un log usando el nivel default del step (definido en el config).
    pub fn log(&self, line: String) {
        self.log_with(line, &self.default_level);
    }
    /// Emite un log con un nivel explícito (override). Usar `log()` salvo
    /// que sea un error real (donde se fuerza `"error"`).
    pub fn log_with(&self, line: String, level: &str) {
        let _ = self.tx.try_send(StepUpdateMsg {
            step_id: self.step_id.clone(),
            update: StepUpdate::Log {
                line,
                level: level.to_string(),
            },
        });
    }
    pub fn completed(&self, row_count: usize, sample: Option<TableSample>) {
        // Mensajes TERMINALES no pueden perderse: si el buffer del mpsc
        // está lleno (1024 slots — pasa con muchos steps emitiendo logs
        // rápido), `try_send` los descartaría silenciosamente y el step
        // quedaría visualmente Running para siempre. Usamos `send()`
        // bloqueante en blocking-context vía `blocking_send` o el
        // helper async-blocking. Como el `ProgressReporter` es Clone y
        // se llama desde async, usamos un detach que reintenta hasta
        // que el supervisor lea.
        send_terminal(
            &self.tx,
            StepUpdateMsg {
                step_id: self.step_id.clone(),
                update: StepUpdate::Completed { row_count, sample },
            },
        );
    }
    pub fn failed(&self, error: String) {
        send_terminal(
            &self.tx,
            StepUpdateMsg {
                step_id: self.step_id.clone(),
                update: StepUpdate::Failed { error },
            },
        );
    }
    pub fn cancelled(&self) {
        send_terminal(
            &self.tx,
            StepUpdateMsg {
                step_id: self.step_id.clone(),
                update: StepUpdate::Cancelled,
            },
        );
    }
    pub fn sql_session(&self, connection: String, sid: i32) {
        let _ = self.tx.try_send(StepUpdateMsg {
            step_id: self.step_id.clone(),
            update: StepUpdate::SqlSession { connection, sid },
        });
    }
}

/// Envía un mensaje terminal (Completed / Failed / Cancelled) sin que
/// se pueda perder. Si el buffer del mpsc está lleno, spawnea una task
/// que await el send hasta que el supervisor consuma. Si el receptor
/// se cerró (job ya terminó), simplemente descarta — no es bug.
fn send_terminal(tx: &mpsc::Sender<StepUpdateMsg>, msg: StepUpdateMsg) {
    // Fast path: cola con espacio, send sin reschedule.
    if tx.try_send(msg.clone()).is_ok() {
        return;
    }
    // Cola llena: spawnamos una task que await hasta poder enviar.
    let tx2 = tx.clone();
    tokio::spawn(async move {
        let _ = tx2.send(msg).await;
    });
}
