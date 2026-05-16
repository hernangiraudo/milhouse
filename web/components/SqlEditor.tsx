"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useTheme } from "@/lib/useTheme";
import { prettyFormatSql } from "@/lib/sqlFormat";
import { API_BASE } from "@/lib/api";

/** Chequeo rápido del lado cliente: paréntesis y comillas balanceadas.
 *  Ignora caracteres dentro de strings y comentarios. Devuelve la primera
 *  diferencia detectada o null si está OK. */
function quickSqlSanity(sql: string): string | null {
  let i = 0;
  let parens = 0;
  let inS = false; // single quote string
  let inD = false; // double quote ident
  let inLine = false;
  let inBlock = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLine) {
      if (ch === "\n") inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inS) {
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          continue;
        }
        inS = false;
      }
      i++;
      continue;
    }
    if (inD) {
      if (ch === '"') inD = false;
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inS = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inD = true;
      i++;
      continue;
    }
    if (ch === "(") parens++;
    else if (ch === ")") {
      parens--;
      if (parens < 0) return "Paréntesis ')' sin abrir";
    }
    i++;
  }
  if (inS) return "Comilla simple sin cerrar";
  if (inD) return "Comilla doble sin cerrar";
  if (inBlock) return "Comentario /* sin cerrar */";
  if (parens > 0) return `Faltan ${parens} ')' de cierre`;
  if (parens < 0) return `Sobran ${-parens} ')'`;
  return null;
}

// Monaco es pesado: lo cargamos solo en el client.
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type CheckResult =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; supported: boolean; note?: string }
  | { kind: "error"; error: string };

interface AiSuggestion {
  title: string;
  detail: string;
  severity?: "info" | "warn" | "major";
  suggested_sql?: string | null;
}
interface AiReview {
  summary?: string;
  severity?: "info" | "warn" | "major";
  suggestions?: AiSuggestion[];
}

interface ReviewContext {
  step_id?: string;
  connection_type?: string;
  downstream?: unknown;
  output_columns?: unknown;
}

export function SqlEditor({
  value,
  onChange,
  height = "240px",
  readOnly = false,
  connection,
  showToolbar = true,
  reviewContext,
}: {
  value: string;
  onChange: (v: string) => void;
  height?: string;
  readOnly?: boolean;
  /** Conexión a usar para el chequeo de sintaxis (si soporta). */
  connection?: string | null;
  showToolbar?: boolean;
  /** Contexto para Milhouse-AI revisor: step_id, downstream, etc. */
  reviewContext?: ReviewContext;
}) {
  const theme = useTheme();
  const [check, setCheck] = useState<CheckResult>({ kind: "idle" });
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<AiReview | null>(null);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  // Sanity check rápido (paréntesis, comillas). Solo informativo.
  const sanityWarn = useMemo(
    () => (value.trim() ? quickSqlSanity(value) : null),
    [value],
  );

  function onFormat() {
    if (readOnly) return;
    const next = prettyFormatSql(value);
    if (next !== value) onChange(next);
  }

  async function onAiReview() {
    setReviewing(true);
    setReview(null);
    setReviewErr(null);
    try {
      const r = await fetch(`${API_BASE}/api/ai/review-sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sql: value,
          step_id: reviewContext?.step_id ?? null,
          connection_type: reviewContext?.connection_type ?? null,
          downstream: reviewContext?.downstream ?? [],
          output_columns: reviewContext?.output_columns ?? [],
        }),
      });
      if (!r.ok) {
        setReviewErr(await r.text());
        return;
      }
      const j = (await r.json()) as { review?: AiReview; raw?: string };
      setReview(j.review ?? null);
    } catch (e) {
      setReviewErr(String(e));
    } finally {
      setReviewing(false);
    }
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
          <button
            type="button"
            onClick={onAiReview}
            disabled={!value.trim() || reviewing}
            title="Milhouse-AI analiza el SQL en el contexto del proyecto y sugiere mejoras"
            className="text-xs px-2 py-1 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 disabled:opacity-50"
          >
            {reviewing ? "Analizando…" : "✨ Revisar con Milhouse-AI"}
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
          {sanityWarn && check.kind !== "error" && (
            <span
              className="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-700"
              title="Chequeo local: balanceo de paréntesis y comillas"
            >
              ⚠ {sanityWarn}
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

      {/* Resultado del review AI */}
      {(review || reviewErr) && (
        <div className="bg-surface-2 border border-surface rounded p-3 mt-2 space-y-2">
          <div className="flex items-center justify-between">
            <h5 className="text-xs uppercase tracking-wider text-muted">
              Revisión Milhouse-AI
            </h5>
            <button
              type="button"
              onClick={() => {
                setReview(null);
                setReviewErr(null);
              }}
              className="text-xs text-dim hover:text-app"
              title="Cerrar"
            >
              ✕
            </button>
          </div>
          {reviewErr && (
            <div className="text-xs text-red-400 whitespace-pre-wrap">
              {reviewErr}
            </div>
          )}
          {review && (
            <>
              {review.summary && (
                <div className="text-sm flex items-start gap-2">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      review.severity === "major"
                        ? "bg-red-500/20 text-red-300 border border-red-700"
                        : review.severity === "warn"
                        ? "bg-amber-500/20 text-amber-300 border border-amber-700"
                        : "bg-cyan-500/20 text-cyan-300 border border-cyan-700"
                    }`}
                  >
                    {review.severity ?? "info"}
                  </span>
                  <span className="flex-1">{review.summary}</span>
                </div>
              )}
              {review.suggestions && review.suggestions.length === 0 && (
                <div className="text-xs text-emerald-300">
                  ✓ Sin sugerencias — el SQL se ve bien.
                </div>
              )}
              {review.suggestions && review.suggestions.length > 0 && (
                <ol className="space-y-2 text-sm">
                  {review.suggestions.map((s, i) => (
                    <li
                      key={i}
                      className="bg-surface border border-surface-strong rounded p-2"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-dim">#{i + 1}</span>
                        <span
                          className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            s.severity === "major"
                              ? "bg-red-500/20 text-red-300 border border-red-700"
                              : s.severity === "warn"
                              ? "bg-amber-500/20 text-amber-300 border border-amber-700"
                              : "bg-cyan-500/20 text-cyan-300 border border-cyan-700"
                          }`}
                        >
                          {s.severity ?? "info"}
                        </span>
                        <span className="font-medium">{s.title}</span>
                      </div>
                      <div className="text-xs text-muted whitespace-pre-wrap">
                        {s.detail}
                      </div>
                      {s.suggested_sql && (
                        <details className="mt-2">
                          <summary className="text-xs text-accent cursor-pointer">
                            Ver SQL sugerido
                          </summary>
                          <pre className="milhouse-codeblock text-xs mt-1 whitespace-pre-wrap">
                            {s.suggested_sql}
                          </pre>
                          <button
                            type="button"
                            onClick={() => {
                              if (!readOnly && s.suggested_sql) {
                                onChange(s.suggested_sql);
                              }
                            }}
                            disabled={readOnly}
                            className="text-xs mt-1 px-2 py-1 rounded milhouse-btn-secondary disabled:opacity-50"
                          >
                            Aplicar este SQL
                          </button>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
