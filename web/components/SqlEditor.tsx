"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useTheme } from "@/lib/useTheme";
import { prettyFormatSql } from "@/lib/sqlFormat";
import { API_BASE } from "@/lib/api";

// Monaco es pesado: lo cargamos solo en el client.
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type CheckResult =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; supported: boolean; note?: string }
  | { kind: "error"; error: string };

export function SqlEditor({
  value,
  onChange,
  height = "240px",
  readOnly = false,
  connection,
  showToolbar = true,
}: {
  value: string;
  onChange: (v: string) => void;
  height?: string;
  readOnly?: boolean;
  /** Conexión a usar para el chequeo de sintaxis (si soporta). */
  connection?: string | null;
  showToolbar?: boolean;
}) {
  const theme = useTheme();
  const [check, setCheck] = useState<CheckResult>({ kind: "idle" });

  function onFormat() {
    if (readOnly) return;
    const next = prettyFormatSql(value);
    if (next !== value) onChange(next);
  }

  async function onCheck() {
    setCheck({ kind: "checking" });
    try {
      const r = await fetch(`${API_BASE}/api/sql/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: value, connection: connection ?? null }),
      });
      const j = (await r.json()) as {
        ok: boolean;
        error?: string;
        supported?: boolean;
        note?: string;
      };
      if (j.ok) {
        setCheck({
          kind: "ok",
          supported: j.supported ?? true,
          note: j.note,
        });
      } else {
        setCheck({ kind: "error", error: j.error ?? "error desconocido" });
      }
    } catch (e) {
      setCheck({ kind: "error", error: String(e) });
    }
  }

  return (
    <div className="space-y-1">
      {showToolbar && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onFormat}
            disabled={readOnly || !value.trim()}
            title="Reformatear: salta líneas en SELECT/FROM/WHERE/JOIN y normaliza cláusulas a mayúscula"
            className="text-xs px-2 py-1 rounded milhouse-btn-secondary disabled:opacity-50"
          >
            ⤷ Indentar
          </button>
          <button
            type="button"
            onClick={onCheck}
            disabled={!value.trim() || check.kind === "checking"}
            title="Valida la sintaxis preparando la sentencia contra la conexión (sin ejecutarla)"
            className="text-xs px-2 py-1 rounded milhouse-btn-secondary disabled:opacity-50"
          >
            {check.kind === "checking" ? "Chequeando…" : "✓ Chequear sintaxis"}
          </button>
          {check.kind === "ok" && (
            <span
              className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-700"
              title={check.note}
            >
              {check.supported
                ? "✓ Sintaxis OK"
                : `ℹ ${check.note ?? "no soportado para esta conexión"}`}
            </span>
          )}
          {check.kind === "error" && (
            <span
              className="text-[11px] px-2 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-700 max-w-[60ch] truncate"
              title={check.error}
            >
              ✗ {check.error}
            </span>
          )}
        </div>
      )}
      <div className="border border-surface rounded-md overflow-hidden">
        <Editor
          height={height}
          defaultLanguage="sql"
          value={value}
          onChange={(v) => {
            onChange(v ?? "");
            // Invalida el estado de chequeo si el usuario cambia el SQL.
            if (check.kind !== "idle" && check.kind !== "checking")
              setCheck({ kind: "idle" });
          }}
          theme={theme === "light" ? "vs" : "vs-dark"}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            tabSize: 2,
            wordWrap: "on",
            automaticLayout: true,
            readOnly,
            formatOnPaste: true,
            formatOnType: true,
          }}
        />
      </div>
    </div>
  );
}
