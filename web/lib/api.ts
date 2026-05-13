import type {
  ConfigSummary,
  ConnectionsResponse,
  JobState,
  JobSummary,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";
export const WS_BASE =
  process.env.NEXT_PUBLIC_WS_BASE ?? "ws://localhost:8080";

export async function listConfigs(): Promise<ConfigSummary[]> {
  const r = await fetch(`${API_BASE}/api/configs`, { cache: "no-store" });
  if (!r.ok) throw new Error(`listConfigs ${r.status}`);
  return r.json();
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

export async function getJob(id: string): Promise<JobState> {
  const r = await fetch(`${API_BASE}/api/jobs/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`getJob ${r.status}`);
  return r.json();
}
