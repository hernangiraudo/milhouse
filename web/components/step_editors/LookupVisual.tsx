"use client";

import {
  AvailableTable,
  Field,
  InPlaceOrNewTable,
  TableSelect,
} from "./_shared";

interface SelectItem {
  from: string;
  as?: string | null;
}

interface LookupStep {
  id: string;
  kind: "lookup";
  input?: string;
  master?: string;
  key?: string;
  master_key?: string;
  select?: SelectItem[];
  output_table?: string | null;
  depends_on?: string[];
  [k: string]: unknown;
}

export function LookupVisual({
  step,
  available,
  onChange,
}: {
  step: LookupStep;
  available: AvailableTable[];
  onChange: (next: LookupStep) => void;
}) {
  function setSide(side: "input" | "master", tbl: string) {
    const stepId = available.find((a) => a.output_table === tbl)?.step_id;
    const otherTable =
      side === "input" ? step.master : step.input;
    const otherStepId = available.find((a) => a.output_table === otherTable)
      ?.step_id;
    const deps = new Set<string>();
    if (otherStepId) deps.add(otherStepId);
    if (stepId) deps.add(stepId);
    onChange({
      ...step,
      [side]: tbl,
      depends_on: Array.from(deps),
    });
  }

  const items = step.select ?? [];

  function addSelect() {
    onChange({ ...step, select: [...items, { from: "", as: null }] });
  }
  function updateSelect(i: number, patch: Partial<SelectItem>) {
    const arr = [...items];
    arr[i] = { ...arr[i], ...patch };
    onChange({ ...step, select: arr });
  }
  function deleteSelect(i: number) {
    onChange({ ...step, select: items.filter((_, j) => j !== i) });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tabla input (a enriquecer)">
          <TableSelect
            value={step.input ?? ""}
            available={available}
            onChange={(v) => setSide("input", v)}
          />
        </Field>
        <Field label="Tabla master (diccionario)">
          <TableSelect
            value={step.master ?? ""}
            available={available}
            onChange={(v) => setSide("master", v)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Clave en input">
          <input
            value={step.key ?? ""}
            onChange={(e) => onChange({ ...step, key: e.target.value })}
            placeholder="ej. currency_id"
            className="w-full milhouse-field font-mono text-sm"
          />
        </Field>
        <Field label="Clave en master">
          <input
            value={step.master_key ?? ""}
            onChange={(e) =>
              onChange({ ...step, master_key: e.target.value })
            }
            placeholder="ej. id"
            className="w-full milhouse-field font-mono text-sm"
          />
        </Field>
      </div>

      <div className="bg-surface-2 border border-surface rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs uppercase tracking-wider text-muted">
            Columnas a traer del master ({items.length})
          </h5>
          <button
            type="button"
            onClick={addSelect}
            className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
          >
            + Columna
          </button>
        </div>
        {items.length === 0 ? (
          <div className="text-xs text-dim">
            Si no agregás ninguna, el lookup une todas las columnas del master.
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((it, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_24px_1fr_30px] gap-2 items-center"
              >
                <input
                  value={it.from}
                  onChange={(e) => updateSelect(i, { from: e.target.value })}
                  placeholder="columna en master"
                  className="milhouse-field font-mono text-xs py-1"
                />
                <span className="text-center text-dim">→</span>
                <input
                  value={it.as ?? ""}
                  onChange={(e) =>
                    updateSelect(i, { as: e.target.value || null })
                  }
                  placeholder="alias (opcional)"
                  className="milhouse-field font-mono text-xs py-1"
                />
                <button
                  type="button"
                  onClick={() => deleteSelect(i)}
                  className="text-red-400 text-xs"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <InPlaceOrNewTable
        value={step.output_table ?? null}
        inputTable={step.input}
        onChange={(v) => onChange({ ...step, output_table: v })}
      />
    </div>
  );
}
