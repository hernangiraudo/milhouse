"use client";

import { AvailableTable, Field, TableSelect } from "./_shared";

interface SortKey {
  column: string;
  desc: boolean;
}

interface SortStep {
  id: string;
  kind: "sort";
  input?: string;
  by?: SortKey[];
  output_table?: string;
  depends_on?: string[];
  [k: string]: unknown;
}

export function SortVisual({
  step,
  available,
  onChange,
}: {
  step: SortStep;
  available: AvailableTable[];
  onChange: (next: SortStep) => void;
}) {
  function setInput(tbl: string) {
    const stepId = available.find((a) => a.output_table === tbl)?.step_id;
    const deps = new Set<string>();
    if (stepId) deps.add(stepId);
    onChange({ ...step, input: tbl, depends_on: Array.from(deps) });
  }
  const keys = step.by ?? [];
  function add() {
    onChange({ ...step, by: [...keys, { column: "", desc: false }] });
  }
  function update(i: number, patch: Partial<SortKey>) {
    const arr = [...keys];
    arr[i] = { ...arr[i], ...patch };
    onChange({ ...step, by: arr });
  }
  function del(i: number) {
    onChange({ ...step, by: keys.filter((_, j) => j !== i) });
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    const arr = [...keys];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange({ ...step, by: arr });
  }

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
            Criterios ({keys.length}) — orden de prioridad
          </h5>
          <button
            type="button"
            onClick={add}
            className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
          >
            + Criterio
          </button>
        </div>
        {keys.length === 0 && (
          <div className="text-xs text-dim">
            Agregá al menos uno. El orden de los criterios define la prioridad.
          </div>
        )}
        <div className="space-y-1">
          {keys.map((k, i) => (
            <div
              key={i}
              className="grid grid-cols-[24px_24px_1fr_120px_30px] gap-2 items-center"
            >
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="text-xs text-dim disabled:opacity-20"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === keys.length - 1}
                className="text-xs text-dim disabled:opacity-20"
              >
                ▼
              </button>
              <input
                value={k.column}
                onChange={(e) => update(i, { column: e.target.value })}
                placeholder="columna"
                className="milhouse-field text-xs py-1 font-mono"
              />
              <select
                value={k.desc ? "desc" : "asc"}
                onChange={(e) =>
                  update(i, { desc: e.target.value === "desc" })
                }
                className="milhouse-field text-xs py-1"
              >
                <option value="asc">↑ ASC</option>
                <option value="desc">↓ DESC</option>
              </select>
              <button
                type="button"
                onClick={() => del(i)}
                className="text-red-400 text-xs"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <Field label="output_table">
        <input
          value={step.output_table ?? ""}
          onChange={(e) =>
            onChange({ ...step, output_table: e.target.value })
          }
          placeholder="ej. tx_sorted"
          className="w-full milhouse-field font-mono"
        />
      </Field>
    </div>
  );
}
