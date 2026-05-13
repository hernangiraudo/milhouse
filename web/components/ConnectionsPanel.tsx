"use client";

import { useEffect, useState } from "react";
import { listConnections, reloadConnections } from "@/lib/api";
import type { ConnectionsResponse, ConnectionSummary } from "@/lib/types";

const TYPE_STYLES: Record<string, { color: string; glyph: string; label: string }> = {
  duckdb: { color: "#10b981", glyph: "🦆", label: "DuckDB (archivo)" },
  duckdb_memory: { color: "#06b6d4", glyph: "⚡", label: "DuckDB (memoria)" },
  postgres: { color: "#3b82f6", glyph: "🐘", label: "Postgres" },
  sqlite: { color: "#a855f7", glyph: "📦", label: "SQLite" },
  sql_server: { color: "#ef4444", glyph: "🟦", label: "SQL Server" },
};

export function ConnectionsPanel() {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const d = await listConnections();
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onReload() {
    setBusy(true);
    setErr(null);
    try {
      await reloadConnections();
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-panel rounded-xl p-6 mb-8 border border-slate-800">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-200">Conexiones</h2>
        <div className="flex items-center gap-3">
          <code className="text-xs text-slate-500">configs/connections.json</code>
          <button
            onClick={onReload}
            disabled={busy}
            className="text-xs px-2 py-1 rounded border border-surface-strong bg-surface-2 hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Recargando…" : "Recargar"}
          </button>
        </div>
      </div>
      {err && <div className="text-red-400 text-sm mb-2">{err}</div>}
      {!data && !err && (
        <div className="text-slate-500 text-sm">Cargando…</div>
      )}
      {data && data.connections.length === 0 && (
        <div className="text-slate-500 text-sm">
          No hay conexiones definidas. Creá el archivo{" "}
          <code>configs/connections.json</code> y dale click a "Recargar".
        </div>
      )}
      {data && data.connections.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.connections.map((c) => (
            <ConnectionCard key={c.name} c={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function ConnectionCard({ c }: { c: ConnectionSummary }) {
  const t = TYPE_STYLES[c.type] ?? { color: "#94a3b8", glyph: "?", label: c.type };
  return (
    <div
      className="rounded-lg border bg-surface-2 p-3 relative"
      style={{ borderColor: c.implemented ? t.color : "#475569" }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span style={{ color: t.color }}>{t.glyph}</span>
          <code className="font-semibold text-slate-100">{c.name}</code>
        </div>
        <div className="flex items-center gap-1">
          {c.is_default && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-700">
              default
            </span>
          )}
          {!c.implemented && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-700"
              title="Declarada en el archivo pero no implementada en este MVP"
            >
              placeholder
            </span>
          )}
        </div>
      </div>
      <div className="text-xs text-slate-400 mt-1" style={{ color: t.color }}>
        {t.label}
      </div>
      {c.description && (
        <div className="text-xs text-slate-400 mt-2 leading-snug">
          {c.description}
        </div>
      )}
      <SpecLines spec={c.spec} />
    </div>
  );
}

function SpecLines({ spec }: { spec: Record<string, unknown> }) {
  const fields: Array<[string, unknown]> = [];
  const SKIP = new Set(["name", "description", "type", "password"]);
  for (const k of Object.keys(spec)) {
    if (SKIP.has(k)) continue;
    fields.push([k, spec[k]]);
  }
  if (fields.length === 0) return null;
  return (
    <div className="mt-2 text-[11px] font-mono space-y-0.5">
      {fields.map(([k, v]) => (
        <div key={k} className="text-slate-500">
          <span className="text-slate-400">{k}:</span>{" "}
          <span className="text-slate-300">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}
