import type {
  ConfigSummary,
  ConnectionsResponse,
  JobState,
  JobSummary,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8090";
export const WS_BASE =
  process.env.NEXT_PUBLIC_WS_BASE ?? "ws://localhost:8090";

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

export async function createJob(
  configName: string,
  opts?: { user?: string | null; debug?: boolean },
): Promise<{ job_id: string }> {
  const r = await fetch(`${API_BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config_name: configName,
      user: opts?.user ?? null,
      debug: opts?.debug ?? false,
    }),
  });
  if (!r.ok) throw new Error(`createJob ${r.status} ${await r.text()}`);
  return r.json();
}

export async function cancelJob(id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/jobs/${id}/cancel`, { method: "POST" });
  if (!r.ok && r.status !== 204) throw new Error(`cancelJob ${r.status}`);
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
