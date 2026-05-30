import type {
  ConfigSummary,
  ConnectionsResponse,
  JobState,
  JobSummary,
} from "./types";

export type { ConfigSummary, ConnectionsResponse, JobState, JobSummary };

const BACKEND_PORT = process.env.NEXT_PUBLIC_BACKEND_PORT ?? "8090";

function defaultApiBase(): string {
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${BACKEND_PORT}`;
  }
  return `http://localhost:${BACKEND_PORT}`;
}

function defaultWsBase(): string {
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.hostname}:${BACKEND_PORT}`;
  }
  return `ws://localhost:${BACKEND_PORT}`;
}

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? defaultApiBase();
export const WS_BASE =
  process.env.NEXT_PUBLIC_WS_BASE ?? defaultWsBase();

export async function listConfigs(): Promise<ConfigSummary[]> {
  const r = await fetch(`${API_BASE}/api/configs`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listConfigs ${r.status}`);
  return r.json();
}

export async function getConfig(name: string): Promise<Record<string, unknown>> {
  const r = await fetch(
    `${API_BASE}/api/configs/${encodeURIComponent(name)}`,
    { cache: "no-store" },
  );
  if (!r.ok) throw new Error(`getConfig ${r.status} ${await r.text()}`);
  return r.json();
}

export async function slugifyFilename(from: string): Promise<string> {
  const r = await fetch(
    `${API_BASE}/api/configs/slug?from=${encodeURIComponent(from)}`,
  );
  if (!r.ok) throw new Error(`slugify ${r.status}`);
  const d = (await r.json()) as { filename: string };
  return d.filename;
}

export async function createConfig(
  filename: string,
  config: Record<string, unknown>,
): Promise<string> {
  const r = await fetch(`${API_BASE}/api/configs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, config }),
  });
  if (!r.ok) throw new Error(await r.text());
  const d = (await r.json()) as { filename: string };
  return d.filename;
}

export async function updateConfig(
  currentName: string,
  config: Record<string, unknown>,
  newFilename?: string,
): Promise<string> {
  const r = await fetch(
    `${API_BASE}/api/configs/${encodeURIComponent(currentName)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: newFilename ?? currentName, config }),
    },
  );
  if (!r.ok) throw new Error(await r.text());
  const d = (await r.json()) as { filename: string };
  return d.filename;
}

export async function deleteConfig(name: string): Promise<void> {
  const r = await fetch(
    `${API_BASE}/api/configs/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!r.ok && r.status !== 204) throw new Error(await r.text());
}

export async function listJobs(): Promise<JobSummary[]> {
  const r = await fetch(`${API_BASE}/api/jobs`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listJobs ${r.status}`);
  return r.json();
}

/** Valor de parámetro: string (escalar) o lista de strings. El backend usa
 *  el `kind` declarado del parámetro para decidir si lo cita o no en SQL. */
export type ParamValue = string | string[];

export async function createJob(
  configName: string,
  opts?: {
    user?: string | null;
    debug?: boolean;
    target_steps?: string[] | null;
    stop_on_failure?: boolean;
    use_preload?: boolean;
    existing_job_id?: string | null;
    parameters?: Record<string, ParamValue>;
    run_name?: string | null;
  },
): Promise<{ job_id: string }> {
  const r = await fetch(`${API_BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config_name: configName,
      user: opts?.user ?? null,
      debug: opts?.debug ?? false,
      target_steps: opts?.target_steps ?? null,
      stop_on_failure: opts?.stop_on_failure ?? false,
      use_preload: opts?.use_preload ?? false,
      existing_job_id: opts?.existing_job_id ?? null,
      parameters: opts?.parameters ?? {},
      run_name: opts?.run_name ?? null,
    }),
  });
  if (!r.ok) throw new Error(`createJob ${r.status} ${await r.text()}`);
  return r.json();
}

export async function parseExcelForParam(file: File): Promise<{
  values: string[];
  rows_total: number;
  sheet: string;
}> {
  const r = await fetch(`${API_BASE}/api/parameters/parse-excel`, {
    method: "POST",
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    body: file,
  });
  if (!r.ok) throw new Error(`parseExcelForParam ${r.status} ${await r.text()}`);
  return r.json();
}

export interface ExcelPreview {
  sheets: string[];
  previews: Array<{
    sheet: string;
    rows: string[][];
    total_rows: number;
    total_cols: number;
  }>;
}

/** Preview de hojas + primeras filas de un xlsx. */
export async function excelPreview(file: File): Promise<ExcelPreview> {
  const r = await fetch(`${API_BASE}/api/parameters/excel-preview`, {
    method: "POST",
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    body: file,
  });
  if (!r.ok) throw new Error(`excelPreview ${r.status} ${await r.text()}`);
  return r.json();
}

/** Importa valores + description_table según la selección del asistente. */
export async function excelImport(req: {
  xlsx_base64: string;
  sheet: string;
  id_column: number;
  description_columns: number[];
  skip_header: boolean;
}): Promise<{
  values: string[];
  description_table: string[][];
  rows_total: number;
}> {
  const r = await fetch(`${API_BASE}/api/parameters/excel-import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`excelImport ${r.status} ${await r.text()}`);
  return r.json();
}

/** Lee un File como base64 (sin el prefix data:...). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader devolvió un tipo inesperado"));
        return;
      }
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read error"));
    reader.readAsDataURL(file);
  });
}

export function exportRunBundleUrl(jobId: string): string {
  return `${API_BASE}/api/runs/${encodeURIComponent(jobId)}/bundle`;
}

export async function importPreload(
  configName: string,
  file: File,
): Promise<{ manifest: { datasets: Array<{ step_id: string }> } }> {
  const r = await fetch(
    `${API_BASE}/api/configs/${encodeURIComponent(configName)}/preload`,
    {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file,
    },
  );
  if (!r.ok) throw new Error(`importPreload ${r.status} ${await r.text()}`);
  return r.json();
}

export async function getPreloadStatus(
  configName: string,
): Promise<{ has_preload: boolean; preloaded_step_ids: string[] }> {
  const r = await fetch(
    `${API_BASE}/api/configs/${encodeURIComponent(configName)}/preload`,
    { cache: "no-store" },
  );
  if (!r.ok) throw new Error(`getPreloadStatus ${r.status}`);
  return r.json();
}

export async function deletePreload(configName: string): Promise<void> {
  const r = await fetch(
    `${API_BASE}/api/configs/${encodeURIComponent(configName)}/preload`,
    { method: "DELETE" },
  );
  if (!r.ok) throw new Error(`deletePreload ${r.status}`);
}

/** Indica si la base de runs está disponible. La UI usa esto para
 *  deshabilitar features que dependen de ella (schedules, casos,
 *  revisión histórica) sin esperar al 503 del POST. */
export interface RunsHealth {
  available: boolean;
  /** Motivo cuando available=false: "not_configured" | "file_locked" |
   *  "io_error" | "other" | "transient". */
  reason?: string;
  /** Path al archivo .duckdb cuando se puede inferir desde la conn. */
  path?: string | null;
  /** Mensaje crudo del último intento de abrir. */
  error?: string | null;
}
export async function runsHealth(): Promise<RunsHealth> {
  const r = await fetch(`${API_BASE}/api/runs/health`, { cache: "no-store" });
  if (!r.ok) return { available: false };
  return r.json();
}

/** Renombra el archivo de la DB de runs a .bak.<ts> (si existe) y crea
 *  uno nuevo. Útil cuando quedó lockeado por otro proceso o corrupto. */
export async function runsReset(): Promise<{
  ok: boolean;
  backup_path?: string | null;
  path?: string;
}> {
  const r = await fetch(`${API_BASE}/api/runs/reset`, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function cancelJob(id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/jobs/${id}/cancel`, { method: "POST" });
  if (!r.ok && r.status !== 204) throw new Error(`cancelJob ${r.status}`);
}

/** Drena el job: deja terminar los Running pero cancela todos los Pending/Ready. */
export async function drainJob(id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/jobs/${id}/drain`, { method: "POST" });
  if (!r.ok && r.status !== 204) throw new Error(`drainJob ${r.status}`);
}

/** Cancela un step individual. Solo aplica si está Pending/Ready. */
export async function cancelStep(jobId: string, stepId: string): Promise<void> {
  const r = await fetch(
    `${API_BASE}/api/jobs/${jobId}/cancel-step/${encodeURIComponent(stepId)}`,
    { method: "POST" },
  );
  if (!r.ok && r.status !== 204) throw new Error(`cancelStep ${r.status}`);
}

export async function listConnections(): Promise<ConnectionsResponse> {
  const r = await fetch(`${API_BASE}/api/connections`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listConnections ${r.status}`);
  return r.json();
}

export async function reloadConnections(): Promise<void> {
  const r = await fetch(`${API_BASE}/api/connections/reload`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`reloadConnections ${r.status}`);
}

export interface ConnectionPayload {
  name: string;
  description?: string | null;
  /** El spec lleva `type` discriminador y los campos del tipo. */
  spec: Record<string, unknown>;
  make_default?: boolean;
}
export async function createConnection(p: ConnectionPayload): Promise<void> {
  const r = await fetch(`${API_BASE}/api/connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!r.ok) throw new Error(await r.text());
}
export async function updateConnection(
  currentName: string,
  p: ConnectionPayload,
): Promise<void> {
  const r = await fetch(
    `${API_BASE}/api/connections/${encodeURIComponent(currentName)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    },
  );
  if (!r.ok) throw new Error(await r.text());
}
export interface TableInfo {
  schema: string | null;
  name: string;
  kind: string;
}
export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean | null;
  is_primary_key?: boolean;
}

export async function listConnectionTables(name: string): Promise<TableInfo[]> {
  const r = await fetch(
    `${API_BASE}/api/connections/${encodeURIComponent(name)}/tables`,
    { cache: "no-store" },
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function listTableColumns(
  conn: string,
  table: string,
  schema?: string | null,
): Promise<ColumnInfo[]> {
  const qs = schema ? `?schema=${encodeURIComponent(schema)}` : "";
  const r = await fetch(
    `${API_BASE}/api/connections/${encodeURIComponent(
      conn,
    )}/tables/${encodeURIComponent(table)}/columns${qs}`,
    { cache: "no-store" },
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function listRegistryProcedural(): Promise<string[]> {
  const r = await fetch(`${API_BASE}/api/registry/procedural`, {
    cache: "no-store",
  });
  if (!r.ok) return [];
  const d = (await r.json()) as { functions: string[] };
  return d.functions;
}

// ---- Milhouse-AI ----
export async function aiAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/ai/available`, { cache: "no-store" });
    if (!r.ok) return false;
    const d = (await r.json()) as { available: boolean };
    return d.available;
  } catch {
    return false;
  }
}

export async function aiBuildStep(body: {
  description: string;
  existing_step_ids?: string[];
  existing_tables?: Record<string, string>;
  connections?: Array<{ name: string; type: string }>;
  known_tables?: string[];
}): Promise<{ step: Record<string, unknown>; raw: string }> {
  const r = await fetch(`${API_BASE}/api/ai/build-step`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function aiModifyStep(body: {
  current_step: Record<string, unknown>;
  instruction: string;
  last_error?: string | null;
  existing_step_ids?: string[];
  existing_tables?: Record<string, string>;
  connections?: Array<{ name: string; type: string }>;
}): Promise<{ step: Record<string, unknown>; raw: string }> {
  const r = await fetch(`${API_BASE}/api/ai/modify-step`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteConnection(name: string): Promise<void> {
  const r = await fetch(
    `${API_BASE}/api/connections/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!r.ok && r.status !== 204) throw new Error(await r.text());
}
export interface TestConnectionResult {
  ok: boolean;
  latency_ms?: number;
  info?: string;
  error?: string;
}
export async function testConnection(
  name: string,
  payload?: Partial<ConnectionPayload>,
): Promise<TestConnectionResult> {
  const r = await fetch(
    `${API_BASE}/api/connections/${encodeURIComponent(name)}/test`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    },
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getJob(id: string): Promise<JobState> {
  const r = await fetch(`${API_BASE}/api/jobs/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`getJob ${r.status}`);
  return r.json();
}

// ---- Users ----
export interface UserDef {
  name: string;
  email?: string | null;
  role?: string | null;
}
export interface UsersResponse {
  users: UserDef[];
}

export async function listUsers(): Promise<UsersResponse> {
  const r = await fetch(`${API_BASE}/api/users`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listUsers ${r.status}`);
  return r.json();
}
export async function createUser(u: UserDef): Promise<void> {
  const r = await fetch(`${API_BASE}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(u),
  });
  if (!r.ok) throw new Error(`createUser ${r.status} ${await r.text()}`);
}
export async function deleteUser(name: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/users/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 204) throw new Error(`deleteUser ${r.status}`);
}

// ---- Run history (read from runs DB) ----
export interface QueryRows {
  columns: string[];
  rows: unknown[][];
}

export async function listRunHistory(): Promise<QueryRows> {
  const r = await fetch(`${API_BASE}/api/runs`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listRunHistory ${r.status}`);
  return r.json();
}

export async function listRunSteps(jobId: string): Promise<QueryRows> {
  const r = await fetch(`${API_BASE}/api/runs/${jobId}/steps`, {
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`listRunSteps ${r.status}`);
  return r.json();
}

export async function listRunLogs(
  jobId: string,
  stepUid: number,
): Promise<QueryRows> {
  const r = await fetch(
    `${API_BASE}/api/runs/${jobId}/steps/${stepUid}/logs`,
    { cache: "no-store" },
  );
  if (!r.ok) throw new Error(`listRunLogs ${r.status}`);
  return r.json();
}

export async function listRunDatasets(jobId: string): Promise<QueryRows> {
  const r = await fetch(`${API_BASE}/api/runs/${jobId}/datasets`, {
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`listRunDatasets ${r.status}`);
  return r.json();
}

export interface DatasetPreview {
  name: string;
  level: string;
  table_name: string;
  row_count: number;
  size_bytes: number;
  columns: string[];
  rows: unknown[][];
}

export async function datasetPreview(
  jobId: string,
  stepUid: number,
  limit = 100,
): Promise<DatasetPreview> {
  const r = await fetch(
    `${API_BASE}/api/runs/${jobId}/datasets/${stepUid}/preview?limit=${limit}`,
    { cache: "no-store" },
  );
  if (!r.ok) throw new Error(`datasetPreview ${r.status} ${await r.text()}`);
  return r.json();
}

export class OpenCasesBlockError extends Error {
  cases: number[];
  constructor(cases: number[]) {
    super(`open_cases_block_delete: ${cases.join(",")}`);
    this.cases = cases;
  }
}

export async function deleteRun(jobId: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/runs/${jobId}`, { method: "DELETE" });
  if (r.status === 409) {
    const text = await r.text();
    try {
      const body = JSON.parse(text);
      throw new OpenCasesBlockError(
        Array.isArray(body.open_cases) ? body.open_cases : [],
      );
    } catch (e) {
      if (e instanceof OpenCasesBlockError) throw e;
      throw new Error(`deleteRun 409: ${text}`);
    }
  }
  if (!r.ok && r.status !== 204)
    throw new Error(`deleteRun ${r.status} ${await r.text()}`);
}

// ---- Casos ----

export interface CaseSummaryRow {
  id: number;
  title: string;
  severity: string;
  assignee: string | null;
  creator: string | null;
  status: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
  comments_count: number;
  datasets_count: number;
}

export async function listCases(): Promise<QueryRows> {
  const r = await fetch(`${API_BASE}/api/cases`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listCases ${r.status}`);
  return r.json();
}

export interface CaseDetail {
  header: QueryRows;
  comments: QueryRows;
  datasets: QueryRows;
}
export async function getCase(id: number): Promise<CaseDetail> {
  const r = await fetch(`${API_BASE}/api/cases/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`getCase ${r.status} ${await r.text()}`);
  return r.json();
}

export interface CreateCaseReq {
  title: string;
  description?: string | null;
  severity: string;
  assignee?: string | null;
  creator?: string | null;
  attach?: Array<{ job_id: string; step_uid: number }>;
}
export async function createCase(req: CreateCaseReq): Promise<{ id: number }> {
  const r = await fetch(`${API_BASE}/api/cases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`createCase ${r.status} ${await r.text()}`);
  return r.json();
}
export async function closeCase(id: number, user: string | null): Promise<void> {
  const r = await fetch(`${API_BASE}/api/cases/${id}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user }),
  });
  if (!r.ok && r.status !== 204)
    throw new Error(`closeCase ${r.status} ${await r.text()}`);
}
export async function addComment(
  id: number,
  body: string,
  author: string | null,
): Promise<void> {
  const r = await fetch(`${API_BASE}/api/cases/${id}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, author }),
  });
  if (!r.ok) throw new Error(`addComment ${r.status} ${await r.text()}`);
}
export async function attachDataset(
  caseId: number,
  jobId: string,
  stepUid: number,
  addedBy: string | null,
): Promise<void> {
  const r = await fetch(`${API_BASE}/api/cases/${caseId}/datasets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: jobId, step_uid: stepUid, added_by: addedBy }),
  });
  if (!r.ok && r.status !== 204)
    throw new Error(`attachDataset ${r.status} ${await r.text()}`);
}

export function exportDatasetUrl(
  jobId: string,
  stepUid: number,
  format: "csv" | "xlsx",
): string {
  return `${API_BASE}/api/runs/${jobId}/datasets/${stepUid}/export?format=${format}`;
}

// ---- Schedules ----

export type ScheduleSpec =
  | { kind: "at"; days: number[]; time: string }
  | {
      kind: "window";
      days: number[];
      from: string;
      to: string;
      every_minutes: number;
    }
  | { kind: "cron"; expr: string };

export interface ScheduleDto {
  id: number;
  name: string;
  config_name: string;
  enabled: boolean;
  spec: ScheduleSpec;
  created_by: string | null;
  created_at: string | null;
  last_fired_at: string | null;
}

export async function listSchedules(): Promise<ScheduleDto[]> {
  const r = await fetch(`${API_BASE}/api/schedules`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listSchedules ${r.status}`);
  const d = (await r.json()) as { schedules: ScheduleDto[] };
  return d.schedules;
}
export async function createSchedule(req: {
  name: string;
  config_name: string;
  enabled?: boolean;
  spec: ScheduleSpec;
  created_by?: string | null;
  parameters?: Record<string, string | string[]>;
  selected_preset_groups?: string[];
}): Promise<number> {
  const r = await fetch(`${API_BASE}/api/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`createSchedule ${r.status} ${await r.text()}`);
  const d = (await r.json()) as { id: number };
  return d.id;
}
export async function patchSchedule(
  id: number,
  enabled: boolean,
): Promise<void> {
  const r = await fetch(`${API_BASE}/api/schedules/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok && r.status !== 204)
    throw new Error(`patchSchedule ${r.status}`);
}
export async function deleteSchedule(id: number): Promise<void> {
  const r = await fetch(`${API_BASE}/api/schedules/${id}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 204)
    throw new Error(`deleteSchedule ${r.status}`);
}

/** Error de Anthropic ya procesado por el backend (`humanize_anthropic_error`)
 *  o detectado heurísticamente desde el mensaje crudo. Incluye un título y
 *  opcionalmente un link de ayuda relevante. */
export interface FriendlyError {
  title: string;
  detail: string;
  helpUrl?: string;
  helpLabel?: string;
}

/** Detecta errores conocidos (típicamente de la Anthropic API) y devuelve
 *  un FriendlyError con título + detalle + link. Si no matchea ningún
 *  patrón, devuelve null — el caller muestra el string crudo. */
export function humanizeApiError(raw: unknown): FriendlyError | null {
  const s = String(raw);
  const lower = s.toLowerCase();
  if (lower.includes("saldo suficiente") || lower.includes("credit balance")) {
    return {
      title: "Sin saldo en la cuenta de Anthropic",
      detail:
        "La cuenta cuya ANTHROPIC_API_KEY está cargada no tiene créditos disponibles. " +
        "Cargá créditos o configurá otra key con saldo " +
        "(./scripts/setup_apikey.{ps1,sh}) y reiniciá el backend.",
      helpUrl: "https://console.anthropic.com/settings/billing",
      helpLabel: "Ir a Billing en console.anthropic.com",
    };
  }
  if (lower.includes("anthropic_api_key") && lower.includes("no está")) {
    return {
      title: "ANTHROPIC_API_KEY no configurada",
      detail:
        "No hay API key cargada en el backend. Configurala con " +
        "./scripts/setup_apikey.{ps1,sh} y reiniciá el backend.",
    };
  }
  if (lower.includes("no es válida") || lower.includes("invalid x-api-key")) {
    return {
      title: "API key de Anthropic inválida",
      detail:
        "La ANTHROPIC_API_KEY no es válida o fue revocada. Generá una nueva y " +
        "configurala con ./scripts/setup_apikey.{ps1,sh}, después reiniciá el backend.",
      helpUrl: "https://console.anthropic.com/settings/keys",
      helpLabel: "Administrar API keys",
    };
  }
  if (lower.includes("rate limit") || lower.includes("limitando")) {
    return {
      title: "Rate limit de Anthropic",
      detail:
        "Anthropic está limitando los pedidos. Esperá unos segundos y reintentá. " +
        "Si pasa seguido, revisá tus límites o subí de plan.",
      helpUrl: "https://console.anthropic.com/settings/limits",
      helpLabel: "Ver mis límites",
    };
  }
  if (lower.includes("sobrecargada") || lower.includes("overloaded")) {
    return {
      title: "Anthropic está sobrecargada",
      detail:
        "La API de Anthropic está experimentando alta demanda. Reintentá en unos segundos.",
    };
  }
  return null;
}
