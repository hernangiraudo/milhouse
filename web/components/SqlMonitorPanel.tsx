"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE, listConnections } from "@/lib/api";
import type { ConnectionsResponse } from "@/lib/types";
import { useDialog } from "./Dialog";

interface ProcessRow {
  session_id: number | null;
  blocking_session_id: number | null;
  login_name: string | null;
  host_name: string | null;
  program_name: string | null;
  database_name: string | null;
  status: string | null;
  command: string | null;
  cpu_time: number | null;
  elapsed_minutes: string | null;
  sql_text: string | null;
  is_milhouse: boolean;
}

export function SqlMonitorPanel() {
  const dialog = useDialog();
  const [connections, setConnections] = useState<ConnectionsResponse | null>(
    null,
  );
  const [selectedConn, setSelectedConn] = useState<string>("");
  const [rows, setRows] = useState<ProcessRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState<"all" | "milhouse" | "others">("all");
  const [sqlPreview, setSqlPreview] = useState<ProcessRow | null>(null);

  useEffect(() => {
    listConnections().then(setConnections).catch((e) => setErr(String(e)));
  }, []);

  const sqlConnections = useMemo(
    () =>
      (connections?.connections ?? []).filter((c) => c.type === "sql_server"),
    [connections],
  );

  useEffect(() => {
    if (!selectedConn && sqlConnections.length > 0) {
      setSelectedConn(sqlConnections[0].name);
    }
  }, [sqlConnections, selectedConn]);

  async function reload() {
    if (!selectedConn) return;
    setLoading(true);
    try {
      const r = await fetch(
        `${API_BASE}/api/sql-monitor/${encodeURIComponent(selectedConn)}`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { rows: ProcessRow[] };
      setRows(j.rows);
      setErr(null);
    } catch (e) {
      setErr(String(e));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedConn) return;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConn]);

  useEffect(() => {
    if (!autoRefresh || !selectedConn) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, selectedConn]);

  async function onKill(r: ProcessRow) {
    if (r.session_id == null) return;
    const ok = await dialog.confirm(
      `¿Matar la sesión ${r.session_id}?\n\nUsuario: ${r.login_name ?? "?"}\nPrograma: ${r.program_name ?? "?"}\nComando: ${r.command ?? "?"}\n\nSe ejecutará "KILL ${r.session_id}" en el servidor.`,
      { title: "Matar proceso SQL", variant: "danger", ok: "Matar sesión" },
    );
    if (!ok) return;
    try {
      const resp = await fetch(
        `${API_BASE}/api/sql-monitor/${encodeURIComponent(
          selectedConn,
        )}/kill/${r.session_id}`,
        { method: "POST" },
      );
      if (!resp.ok) throw new Error(await resp.text());
      await reload();
    } catch (e) {
      await dialog.alert(`No se pudo matar la sesión: ${e}`, {
        variant: "danger",
      });
    }
  }

  const filtered = useMemo(() => {
    if (!rows) return null;
    if (filter === "all") return rows;
    if (filter === "milhouse") return rows.filter((r) => r.is_milhouse);
    return rows.filter((r) => !r.is_milhouse);
  }, [rows, filter]);

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-semibold text-lg">Monitor SQL</h2>
          <p className="text-sm text-muted">
            Procesos activos en una base SQL Server. Las sesiones abiertas por
            Milhouse están marcadas. Podés ver el SQL completo y matar una
            sesión.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedConn}
            onChange={(e) => setSelectedConn(e.target.value)}
            className="milhouse-field text-sm"
          >
            {sqlConnections.length === 0 && (
              <option value="">(no hay conexiones SQL Server)</option>
            )}
            {sqlConnections.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="text-xs flex items-center gap-1 text-dim">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>auto-refresh 5s</span>
          </label>
          <button
            onClick={reload}
            disabled={!selectedConn || loading}
            className="text-xs px-3 py-1 rounded milhouse-btn-secondary disabled:opacity-50"
          >
            {loading ? "Cargando…" : "↻ Refrescar"}
          </button>
        </div>
      </header>

      {err && (
        <div className="text-red-400 text-sm whitespace-pre-wrap">{err}</div>
      )}

      <div className="flex gap-1 text-xs flex-wrap">
        {(
          [
            ["all", "Todas"],
            ["milhouse", "Solo Milhouse"],
            ["others", "Otras"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-3 py-1 rounded ${
              filter === k ? "bg-accent-token font-semibold" : "milhouse-btn-secondary"
            }`}
          >
            {label} ·{" "}
            {!rows
              ? 0
              : k === "all"
              ? rows.length
              : k === "milhouse"
              ? rows.filter((r) => r.is_milhouse).length
              : rows.filter((r) => !r.is_milhouse).length}
          </button>
        ))}
      </div>

      {filtered != null && filtered.length === 0 && (
        <div className="text-dim text-sm">
          No hay procesos activos que coincidan con el filtro.
        </div>
      )}

      {filtered != null && filtered.length > 0 && (
        <div className="bg-panel border border-surface rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-muted text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2">SID</th>
                <th className="text-left px-3 py-2">Bloqueado por</th>
                <th className="text-left px-3 py-2">Usuario</th>
                <th className="text-left px-3 py-2">Programa</th>
                <th className="text-left px-3 py-2">DB</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Cmd</th>
                <th className="text-right px-3 py-2">CPU</th>
                <th className="text-right px-3 py-2">min</th>
                <th className="text-left px-3 py-2">SQL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr
                  key={r.session_id ?? i}
                  className={`border-t border-surface ${
                    r.is_milhouse ? "bg-cyan-500/5" : ""
                  }`}
                >
                  <td className="px-3 py-1.5 font-mono">
                    <div className="flex items-center gap-1">
                      {r.is_milhouse && (
                        <span
                          className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-700"
                          title="Sesión abierta por Milhouse"
                        >
                          M
                        </span>
                      )}
                      <span>{r.session_id}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-dim">
                    {r.blocking_session_id && r.blocking_session_id > 0
                      ? r.blocking_session_id
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {r.login_name ?? "—"}
                    {r.host_name && (
                      <div className="text-[10px] text-dim">{r.host_name}</div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {r.program_name ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {r.database_name ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{r.status ?? "—"}</td>
                  <td className="px-3 py-1.5 text-xs font-mono">
                    {r.command ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums">
                    {r.cpu_time ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums">
                    {r.elapsed_minutes ?? "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    <button
                      onClick={() => setSqlPreview(r)}
                      className="text-xs text-accent hover:underline"
                      disabled={!r.sql_text}
                    >
                      {r.sql_text
                        ? truncate(r.sql_text.replace(/\s+/g, " "), 40)
                        : "(sin texto)"}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button
                      onClick={() => onKill(r)}
                      disabled={r.session_id == null}
                      className="text-xs px-2 py-1 rounded border border-red-700 bg-red-500/20 text-red-300"
                      title="Mata la sesión con KILL <sid>"
                    >
                      ⏹ Matar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sqlPreview && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-6"
          style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)" }}
          onClick={() => setSqlPreview(null)}
        >
          <div
            className="bg-surface border border-surface-strong rounded-xl p-5 w-full max-w-3xl max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold">
                SQL de la sesión {sqlPreview.session_id}
                {sqlPreview.is_milhouse && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-700">
                    Milhouse
                  </span>
                )}
              </h3>
              <button
                onClick={() => setSqlPreview(null)}
                className="text-dim hover:text-app"
              >
                ✕
              </button>
            </div>
            <pre className="milhouse-codeblock text-xs whitespace-pre-wrap">
              {sqlPreview.sql_text ?? "(sin texto)"}
            </pre>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setSqlPreview(null)}
                className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary"
              >
                Cerrar
              </button>
              <button
                onClick={async () => {
                  const r = sqlPreview;
                  setSqlPreview(null);
                  await onKill(r);
                }}
                className="text-sm px-3 py-1.5 rounded border border-red-700 bg-red-500/20 text-red-300"
              >
                ⏹ Matar esta sesión
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
