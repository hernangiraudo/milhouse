"use client";

import { AvailableTable, Field, TableSelect } from "./_shared";

interface UnionStep {
  id: string;
  kind: "union";
  inputs?: string[];
  output_table?: string;
  depends_on?: string[];
  [k: string]: unknown;
}

export function UnionVisual({
  step,
  available,
  onChange,
}: {
  step: UnionStep;
  available: AvailableTable[];
  onChange: (next: UnionStep) => void;
}) {
  const inputs = step.inputs ?? [];

  function recalcDeps(nextInputs: string[]): string[] {
    const deps = new Set<string>();
    for (const tbl of nextInputs) {
      const sid = available.find((a) => a.output_table === tbl)?.step_id;
      if (sid) deps.add(sid);
    }
    return Array.from(deps);
  }

  function setInput(i: number, value: string) {
    const arr = [...inputs];
    arr[i] = value;
    onChange({ ...step, inputs: arr, depends_on: recalcDeps(arr) });
  }
  function addInput() {
    const arr = [...inputs, ""];
    onChange({ ...step, inputs: arr });
  }
  function delInput(i: number) {
    const arr = inputs.filter((_, j) => j !== i);
    onChange({ ...step, inputs: arr, depends_on: recalcDeps(arr) });
  }
  function moveInput(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= inputs.length) return;
    const arr = [...inputs];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange({ ...step, inputs: arr });
  }

  return (
    <div className="space-y-3">
      <div className="bg-surface-2 border border-surface rounded p-3 space-y-1.5">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs uppercase tracking-wider text-muted">
            Datasets a apilar · {inputs.length}
          </h5>
          <button
            type="button"
            onClick={addInput}
            className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
          >
            + Dataset
          </button>
        </div>
        {inputs.length === 0 ? (
          <div className="text-xs text-dim">
            Agregá al menos dos datasets para apilar. Si las columnas no
            coinciden 100%, las que falten se completan con vacíos.
          </div>
        ) : (
          inputs.map((inp, i) => (
            <div
              key={i}
              className="grid grid-cols-[28px_1fr_30px] gap-2 items-center"
            >
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => moveInput(i, -1)}
                  disabled={i === 0}
                  className="text-[10px] text-dim disabled:opacity-20 leading-none"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => moveInput(i, 1)}
                  disabled={i === inputs.length - 1}
                  className="text-[10px] text-dim disabled:opacity-20 leading-none"
                >
                  ▼
                </button>
              </div>
              <TableSelect
                value={inp}
                available={available}
                onChange={(v) => setInput(i, v)}
              />
              <button
                type="button"
                onClick={() => delInput(i)}
                className="text-red-400 text-xs"
                title="Eliminar"
              >
                ✕
              </button>
            </div>
          ))
        )}
        <p className="text-[11px] text-dim">
          Esquema final = unión de columnas. Donde un dataset no tiene una
          columna, se completa con NULL.
        </p>
      </div>

      <Field label="output_table">
        <input
          value={step.output_table ?? ""}
          onChange={(e) => onChange({ ...step, output_table: e.target.value })}
          placeholder="ej. tx_unificadas"
          className="w-full milhouse-field font-mono"
        />
      </Field>
    </div>
  );
}
