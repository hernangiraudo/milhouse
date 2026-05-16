"use client";

import { useEffect, useMemo, useState } from "react";
import { listConnections } from "@/lib/api";
import type { ConnectionsResponse } from "@/lib/types";
import { SqlEditor } from "../SqlEditor";
import { prettyFormatSql, splitSqlStatements } from "@/lib/sqlFormat";

interface SqlExecStep {
  id: string;
  kind: "sql_exec";
  connection?: string | null;
  query?: string;
  [k: string]: unknown;
}

export function SqlExecVisual({
  step,
  onChange,
}: {
  step: SqlExecStep;
  onChange: (next: SqlExecStep) => void;
}) {
  const [connections, setConnections] = useState<ConnectionsResponse | null>(
    null,
  );
  useEffect(() => {
    listConnections().then(setConnections).catch(() => {});
  }, []);

  const conn = (step.connection as string) ?? "";

  const stmts = useMemo(
    () => splitSqlStatements(step.query ?? ""),
    [step.query],
  );

  function format() {
    const next = stmts.map(prettyFormatSql).join(";\n\n") + (stmts.length ? ";" : "");
    onChange({ ...step, query: next });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Conexión">
          <select
            value={conn}
            onChange={(e) =>
              onChange({
                ...step,
                connection: e.target.value || null,
              })
            }
            className="w-full milhouse-field"
          >
            <option value="">(default)</option>
            {connections?.connections
              .filter((c) => c.implemented)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} · {c.type}
                </option>
              ))}
          </select>
        </Field>
        <div className="flex items-end justify-end gap-2">
          <button
            type="button"
            onClick={format}
            className="text-xs px-3 py-2 rounded milhouse-btn-secondary"
            title="Indentar y normalizar todas las sentencias (separadas por ;)"
          >
            ✨ Formatear
          </button>
        </div>
      </div>

      <Field label={`SQL (${stmts.length} sentencia${stmts.length === 1 ? "" : "s"})`}>
        <SqlEditor
          value={step.query ?? ""}
          onChange={(v) => onChange({ ...step, query: v })}
          height="320px"
          connection={conn || null}
          reviewContext={{
            step_id: step.id,
            connection_type:
              connections?.connections.find((c) => c.name === conn)?.type ??
              undefined,
          }}
        />
        <p className="text-[11px] text-dim mt-1">
          Separá varias sentencias con <code>;</code>. Cada una se ejecuta por
          separado y se reporta su progreso. El formateo capitaliza
          palabras reservadas y mete saltos antes de cláusulas mayores.
        </p>
      </Field>

      {/* Preview de splits para confirmar al usuario */}
      {stmts.length > 1 && (
        <div className="bg-surface-2 border border-surface rounded p-3">
          <h5 className="text-xs uppercase tracking-wider text-muted mb-2">
            Vista de sentencias
          </h5>
          <ol className="space-y-1 text-xs">
            {stmts.map((s, i) => (
              <li
                key={i}
                className="flex gap-2 items-start border-l-2 border-surface-strong pl-2"
              >
                <code className="text-dim shrink-0">{i + 1}/{stmts.length}</code>
                <code className="font-mono text-app whitespace-pre-wrap break-all">
                  {s.length > 200 ? s.slice(0, 197) + "…" : s}
                </code>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
