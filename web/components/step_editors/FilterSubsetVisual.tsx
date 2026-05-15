"use client";

import { useEffect, useState } from "react";
import {
  AvailableTable,
  Field,
  InPlaceOrNewTable,
  TableSelect,
} from "./_shared";

interface FilterStep {
  id: string;
  kind: "filter_and_subset";
  input?: string;
  filter?: string | null;
  select?: string[];
  output_table?: string | null;
  depends_on?: string[];
  [k: string]: unknown;
}

interface Cond {
  col: string;
  op: string;
  val: string;
  logic: "AND" | "OR"; // operador hacia la SIGUIENTE condición
}

const OPS = ["==", "!=", "<", "<=", ">", ">=", "IN", "IS NULL", "IS NOT NULL"];

export function FilterSubsetVisual({
  step,
  available,
  onChange,
}: {
  step: FilterStep;
  available: AvailableTable[];
  onChange: (next: FilterStep) => void;
}) {
  const [conds, setConds] = useState<Cond[]>(() => parseFilter(step.filter));

  function setInput(tbl: string) {
    const stepId = available.find((a) => a.output_table === tbl)?.step_id;
    const deps = new Set<string>();
    if (stepId) deps.add(stepId);
    onChange({ ...step, input: tbl, depends_on: Array.from(deps) });
  }

  function setCols(raw: string) {
    const arr = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onChange({ ...step, select: arr });
  }

  // Cada vez que cambian las conds, reescribir el filter del step.
  useEffect(() => {
    const expr = buildFilter(conds);
    onChange({ ...step, filter: expr || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conds]);

  function addCond() {
    setConds([...conds, { col: "", op: "==", val: "", logic: "AND" }]);
  }
  function updateCond(i: number, patch: Partial<Cond>) {
    const arr = [...conds];
    arr[i] = { ...arr[i], ...patch };
    setConds(arr);
  }
  function deleteCond(i: number) {
    setConds(conds.filter((_, j) => j !== i));
  }

  const colsString = (step.select ?? []).join(", ");

  return (
    <div className="space-y-3">
      <Field label="Tabla input">
        <TableSelect
          value={step.input ?? ""}
          available={available}
          onChange={setInput}
        />
      </Field>

      <div className="bg-surface-2 border border-surface rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs uppercase tracking-wider text-muted">
            Filtro ({conds.length} condición{conds.length === 1 ? "" : "es"})
          </h5>
          <button
            type="button"
            onClick={addCond}
            className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
          >
            + Condición
          </button>
        </div>

        {conds.length === 0 ? (
          <div className="text-xs text-dim">
            Sin condiciones → trae todas las filas.
          </div>
        ) : (
          <div className="space-y-1">
            {conds.map((c, i) => (
              <div key={i}>
                <div className="grid grid-cols-[1fr_90px_1fr_30px] gap-2">
                  <input
                    value={c.col}
                    onChange={(e) => updateCond(i, { col: e.target.value })}
                    placeholder="columna"
                    className="milhouse-field text-xs py-1 font-mono"
                  />
                  <select
                    value={c.op}
                    onChange={(e) => updateCond(i, { op: e.target.value })}
                    className="milhouse-field text-xs py-1"
                  >
                    {OPS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <input
                    value={c.val}
                    onChange={(e) => updateCond(i, { val: e.target.value })}
                    disabled={c.op === "IS NULL" || c.op === "IS NOT NULL"}
                    placeholder="valor (núm, 'string', true/false)"
                    className="milhouse-field text-xs py-1 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => deleteCond(i)}
                    className="text-red-400 text-xs"
                  >
                    ✕
                  </button>
                </div>
                {i < conds.length - 1 && (
                  <div className="flex justify-center my-1">
                    <select
                      value={c.logic}
                      onChange={(e) =>
                        updateCond(i, { logic: e.target.value as "AND" | "OR" })
                      }
                      className="milhouse-field text-[10px] py-0 px-2 w-20"
                    >
                      <option value="AND">AND</option>
                      <option value="OR">OR</option>
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <details className="mt-3 milhouse-codeblock-details">
          <summary>Expresión generada</summary>
          <code className="block mt-2 text-xs text-app font-mono whitespace-pre-wrap">
            {step.filter || "(sin filtro)"}
          </code>
        </details>
      </div>

      <Field label="Columnas a quedarse (vacío = todas)">
        <input
          value={colsString}
          onChange={(e) => setCols(e.target.value)}
          placeholder="ej. tx_id, amount, date"
          className="w-full milhouse-field font-mono text-sm"
        />
      </Field>

      <InPlaceOrNewTable
        value={step.output_table ?? null}
        inputTable={step.input}
        onChange={(v) => onChange({ ...step, output_table: v })}
        placeholder="ej. tx_large"
      />
    </div>
  );
}

function buildFilter(conds: Cond[]): string {
  const valid = conds.filter(
    (c) =>
      c.col &&
      ((c.op !== "IS NULL" && c.op !== "IS NOT NULL" && c.val !== "") ||
        c.op === "IS NULL" ||
        c.op === "IS NOT NULL"),
  );
  if (valid.length === 0) return "";
  return valid
    .map((c, i) => {
      const expr = formatCond(c);
      if (i === 0) return expr;
      const prev = valid[i - 1];
      return ` ${prev.logic} ${expr}`;
    })
    .join("");
}

function formatCond(c: Cond): string {
  if (c.op === "IS NULL" || c.op === "IS NOT NULL") {
    return `${c.col} ${c.op}`;
  }
  const v = c.val.trim();
  const isNum = /^-?\d+(\.\d+)?$/.test(v);
  const isBool = v === "true" || v === "false";
  const isQuoted = v.startsWith("'") && v.endsWith("'");
  const isList = c.op === "IN" && v.startsWith("(");
  const lit =
    isNum || isBool || isQuoted || isList
      ? v
      : `'${v.replace(/'/g, "''")}'`;
  return `${c.col} ${c.op} ${lit}`;
}

/** Parser muy simple: si el filter del step viene como string, intentamos
 *  descomponerlo en condiciones; si no podemos, queda una sola condición
 *  con todo el texto en `val` para edición manual. */
function parseFilter(s: string | null | undefined): Cond[] {
  if (!s || !s.trim()) return [];
  const parts = s.split(/\s+(AND|OR)\s+/i);
  // parts: [cond, op, cond, op, cond, ...]
  if (parts.length < 1) return [];
  const out: Cond[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const c = parts[i].trim();
    const nextLogic = (parts[i + 1] || "AND").toUpperCase() as "AND" | "OR";
    out.push(parseSingle(c, nextLogic));
  }
  return out;
}

function parseSingle(s: string, logic: "AND" | "OR"): Cond {
  // Detectar IS NULL / IS NOT NULL primero.
  const sn = s.trim();
  const mNull = sn.match(/^([\w.]+)\s+(IS NOT NULL|IS NULL)$/i);
  if (mNull) return { col: mNull[1], op: mNull[2].toUpperCase(), val: "", logic };
  for (const op of ["==", "!=", "<=", ">=", "<", ">", "IN"]) {
    const idx = sn.indexOf(op);
    if (idx > 0) {
      const col = sn.slice(0, idx).trim();
      const val = sn.slice(idx + op.length).trim();
      return { col, op, val, logic };
    }
  }
  return { col: sn, op: "==", val: "", logic };
}
