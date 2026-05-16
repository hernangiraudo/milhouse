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
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("elapsed_minutes");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
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
    let out = rows;
    if (filter === "milhouse") out = out.filter((r) => r.is_milhouse);
    else if (filter === "others") out = out.filter((r) => !r.is_milhouse);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => {
        const hay =
          (r.login_name ?? "") +
          " " +
          (r.host_name ?? "") +
          " " +
          (r.program_name ?? "") +
          " " +
          (r.database_name ?? "") +
          " " +
          (r.status ?? "") +
          " " +
          (r.command ?? "") +
          " " +
          (r.sql_text ?? "") +
          " " +
          String(r.session_id ?? "");
        return hay.toLowerCase().includes(q);
      });
    }
    return [...out].sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [rows, filter, search, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      // Defaults razonables: tiempo/CPU desc (lo más pesado arriba),
      // texto asc (alfabético).
      setSortDir(
        k === "cpu_time" || k === "elapsed_minutes" || k === "session_id"
          ? "desc"
          : "asc",
      );
    }
  }

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

      <div className="flex items-center gap-2 text-xs flex-wrap">
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
        <div className="flex-1" />
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="buscar en usuario / programa / SQL…"
            className="milhouse-field text-xs py-1 pr-6 w-64"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-dim hover:text-app text-xs"
              title="Limpiar"
            >
              ✕
            </button>
          )}
        </div>
        {filtered && rows && filtered.length !== rows.length && (
          <span className="text-dim">
            {filtered.length}/{rows.length}
          </span>
        )}
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
                <SortHeader label="SID" k="session_id" current={sortKey} dir={sortDir} onClick={() => toggleSort("session_id")} />
                <SortHeader label="Bloqueado por" k="blocking_session_id" current={sortKey} dir={sortDir} onClick={() => toggleSort("blocking_session_id")} />
                <SortHeader label="Usuario" k="login_name" current={sortKey} dir={sortDir} onClick={() => toggleSort("login_name")} />
                <SortHeader label="Programa" k="program_name" current={sortKey} dir={sortDir} onClick={() => toggleSort("program_name")} />
                <SortHeader label="DB" k="database_name" current={sortKey} dir={sortDir} onClick={() => toggleSort("database_name")} />
                <SortHeader label="Status" k="status" current={sortKey} dir={sortDir} onClick={() => toggleSort("status")} />
                <SortHeader label="Cmd" k="command" current={sortKey} dir={sortDir} onClick={() => toggleSort("command")} />
                <SortHeader label="CPU" k="cpu_time" current={sortKey} dir={sortDir} align="right" onClick={() => toggleSort("cpu_time")} />
                <SortHeader label="min" k="elapsed_minutes" current={sortKey} dir={sortDir} align="right" onClick={() => toggleSort("elapsed_minutes")} />
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

type SortKey =
  | "session_id"
  | "blocking_session_id"
  | "login_name"
  | "program_name"
  | "database_name"
  | "status"
  | "command"
  | "cpu_time"
  | "elapsed_minutes";

function compareRows(
  a: ProcessRow,
  b: ProcessRow,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  const mult = dir === "asc" ? 1 : -1;
  const av = a[key];
  const bv = b[key];
  // Nulls al final independiente de la dirección.
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (key === "elapsed_minutes") {
    // viene como string; intentamos parsear.
    const an = parseFloat(String(av));
    const bn = parseFloat(String(bv));
    if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * mult;
  }
  if (typeof av === "number" && typeof bv === "number") {
    return (av - bv) * mult;
  }
  return String(av).localeCompare(String(bv)) * mult;
}

function SortHeader({
  label,
  k,
  current,
  dir,
  align,
  onClick,
}: {
  label: string;
  k: SortKey;
  current: SortKey;
  dir: "asc" | "desc";
  align?: "left" | "right";
  onClick: () => void;
}) {
  const active = current === k;
  return (
    <th
      className={`px-3 py-2 cursor-pointer select-none ${
        align === "right" ? "text-right" : "text-left"
      } ${active ? "text-app" : ""}`}
      onClick={onClick}
      title={`Ordenar por ${label}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span
          className={`text-[9px] ${active ? "" : "text-dim opacity-50"}`}
          aria-hidden
        >
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </span>
    </th>
  );
}
