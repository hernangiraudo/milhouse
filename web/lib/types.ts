// Tipos espejo de los DTOs del backend Rust.

export type JobStatus = "running" | "ok" | "failed" | "cancelled";

export interface ConfigSummary {
  name: string;
  path: string;
}

export interface ColumnMeta {
  name: string;
  dtype: string;
}

export interface TableSample {
  columns: ColumnMeta[];
  rows: unknown[][];
  total_rows: number;
  sampled_rows: number;
}

export type StepRuntimeState =
  | { state: "pending" }
  | { state: "ready" }
  | {
      state: "running";
      started_at: string;
      progress: number;
      rows_done?: number | null;
      rows_total?: number | null;
    }
  | {
      state: "done";
      started_at: string;
      finished_at: string;
      duration_ms: number;
      row_count: number;
    }
  | {
      state: "failed";
      started_at?: string | null;
      finished_at: string;
      error: string;
    }
  | { state: "cancelled" }
  | { state: "skipped"; reason: string };

export interface LogLine {
  at: string;
  level: string;
  line: string;
}

export interface StepInfo {
  id: string;
  kind: string;
  depends_on: string[];
  output_table?: string | null;
  group?: string | null;
  state: StepRuntimeState;
  logs: LogLine[];
  sample?: TableSample | null;
  spec: Record<string, unknown>;
}

export interface GroupMeta {
  name: string;
  description?: string | null;
  color?: string | null;
}

export interface JobState {
  job_id: string;
  config_name: string;
  user?: string | null;
  debug?: boolean;
  started_at: string;
  finished_at: string | null;
  status: JobStatus;
  steps: Record<string, StepInfo>;
  step_order: string[];
  groups?: GroupMeta[];
  eta_seconds: number | null;
  job_pct: number;
}

export interface JobSummary {
  job_id: string;
  config_name: string;
  user: string | null;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  job_pct: number;
}

export type ProgressEvent =
  | { type: "job_started"; job_id: string; total_steps: number }
  | { type: "step_state_changed"; step_id: string; state: StepRuntimeState }
  | {
      type: "step_progress";
      step_id: string;
      pct: number;
      rows_done?: number | null;
      rows_total?: number | null;
    }
  | { type: "step_log"; step_id: string; line: string; level: string }
  | {
      type: "step_completed";
      step_id: string;
      row_count: number;
      duration_ms: number;
      sample?: TableSample | null;
    }
  | {
      type: "job_eta";
      job_pct: number;
      eta_seconds: number | null;
      steps_done: number;
      steps_total: number;
    }
  | { type: "job_finished"; status: JobStatus; duration_ms: number };

export type WsMessage =
  | { type: "snapshot"; state: JobState }
  | { type: "error"; message: string }
  | ProgressEvent;

export interface ConnectionSummary {
  name: string;
  type: string;
  implemented: boolean;
  description: string | null;
  is_default: boolean;
  spec: Record<string, unknown>;
}

export interface ConnectionsResponse {
  default: string | null;
  connections: ConnectionSummary[];
}
