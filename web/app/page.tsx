"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listConfigs, listJobs, createJob } from "@/lib/api";
import type { ConfigSummary, JobSummary } from "@/lib/types";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { UserChip } from "@/components/LoginGate";
import { useUser } from "@/lib/session";

export default function Home() {
  const router = useRouter();
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const user = useUser();

  async function reload() {
    try {
      const [cfgs, js] = await Promise.all([listConfigs(), listJobs()]);
      setConfigs(cfgs);
      if (!selected && cfgs.length > 0) setSelected(cfgs[0].name);
      setJobs(js);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (!selected) return;
    setLoading(true);
    setErr(null);
    try {
      const { job_id } = await createJob(selected, { user, debug });
      router.push(`/jobs/${job_id}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      <header className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">
            Milhouse <span className="text-accent">·</span>{" "}
            <span className="text-slate-400 text-2xl">ETL Manager</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <UserChip />
          <ThemeToggle />
        </div>
      </header>

      <section className="bg-panel rounded-xl p-6 mb-8 border border-slate-800">
        <h2 className="font-semibold mb-3 text-slate-200">Ejecutar un ETL</h2>
        <div className="flex gap-3 items-center">
          <select
            className="bg-panel2 border border-slate-700 rounded-md px-3 py-2"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {configs.length === 0 && <option value="">(sin configs)</option>}
            {configs.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={run}
            disabled={loading || !selected}
            className="bg-accent text-ink font-semibold px-4 py-2 rounded-md disabled:opacity-50"
          >
            {loading ? "Lanzando..." : "Run job"}
          </button>
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer ml-2">
            <input
              type="checkbox"
              checked={debug}
              onChange={(e) => setDebug(e.target.checked)}
            />
            <span>
              Debug
              <span className="text-dim ml-1">
                (persiste datasets resultantes en la DB de runs)
              </span>
            </span>
          </label>
          {err && <span className="text-red-400 text-sm">{err}</span>}
        </div>
      </section>

      <ConnectionsPanel />

      <section>
        <h2 className="font-semibold mb-3 text-slate-200">Jobs recientes</h2>
        <div className="bg-panel rounded-xl border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-slate-400">
              <tr>
                <th className="text-left px-4 py-2">Job ID</th>
                <th className="text-left px-4 py-2">Config</th>
                <th className="text-left px-4 py-2">Usuario</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">%</th>
                <th className="text-left px-4 py-2">Inicio</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-slate-500 text-center">
                    No hay jobs todavía.
                  </td>
                </tr>
              )}
              {jobs.map((j) => (
                <tr key={j.job_id} className="border-t border-slate-800">
                  <td className="px-4 py-2 font-mono text-xs">
                    {j.job_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2">{j.config_name}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {j.user ?? <span className="text-dim">—</span>}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={j.status} />
                  </td>
                  <td className="px-4 py-2">{Math.round(j.job_pct * 100)}%</td>
                  <td className="px-4 py-2 text-slate-400">
                    {new Date(j.started_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <a
                      href={`/jobs/${j.job_id}`}
                      className="text-accent hover:underline"
                    >
                      Ver →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: "bg-yellow-500/20 text-yellow-300 border-yellow-700",
    ok: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
    failed: "bg-red-500/20 text-red-300 border-red-700",
    cancelled: "bg-slate-500/20 text-slate-300 border-slate-700",
  };
  return (
    <span
      className={`inline-block text-xs px-2 py-0.5 rounded border ${
        map[status] ?? "bg-slate-500/20 text-slate-300 border-slate-700"
      }`}
    >
      {status}
    </span>
  );
}
