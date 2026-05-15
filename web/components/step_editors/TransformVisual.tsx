"use client";

import {
  AvailableTable,
  Field,
  InPlaceOrNewTable,
  TableSelect,
} from "./_shared";

type Op =
  | { op: "to_date"; column: string; format?: string | null; as?: string | null }
  | { op: "cast"; column: string; to: string; as?: string | null }
  | { op: "uppercase"; column: string; as?: string | null }
  | { op: "lowercase"; column: string; as?: string | null }
  | { op: "rename"; column: string; to: string }
  | { op: "add_constant"; column: string; value: unknown };

interface TransformStep {
  id: string;
  kind: "transform";
  input?: string;
  operations?: Op[];
  output_table?: string | null;
  depends_on?: string[];
  [k: string]: unknown;
}

const OP_LABELS: Array<{ value: Op["op"]; label: string; hint: string }> = [
  { value: "to_date", label: "to_date", hint: "Parsear string como fecha" },
  { value: "cast", label: "cast", hint: "Convertir tipo" },
  { value: "uppercase", label: "uppercase", hint: "Pasar a MAYÚSCULAS" },
  { value: "lowercase", label: "lowercase", hint: "Pasar a minúsculas" },
  { value: "rename", label: "rename", hint: "Renombrar columna" },
  { value: "add_constant", label: "add_constant", hint: "Agregar columna constante" },
];

const CAST_TYPES = [
  "i32",
  "i64",
  "u32",
  "u64",
  "f32",
  "f64",
  "bool",
  "string",
  "date",
];

export function TransformVisual({
  step,
  available,
  onChange,
}: {
  step: TransformStep;
  available: AvailableTable[];
  onChange: (next: TransformStep) => void;
}) {
  function setInput(tbl: string) {
    const stepId = available.find((a) => a.output_table === tbl)?.step_id;
    const deps = new Set<string>();
    if (stepId) deps.add(stepId);
    onChange({ ...step, input: tbl, depends_on: Array.from(deps) });
  }

  const ops = step.operations ?? [];

  function addOp(opName: Op["op"]) {
    const defaults: Record<Op["op"], Op> = {
      to_date: { op: "to_date", column: "", format: null, as: null },
      cast: { op: "cast", column: "", to: "f64", as: null },
      uppercase: { op: "uppercase", column: "", as: null },
      lowercase: { op: "lowercase", column: "", as: null },
      rename: { op: "rename", column: "", to: "" },
      add_constant: { op: "add_constant", column: "", value: 0 },
    };
    onChange({ ...step, operations: [...ops, defaults[opName]] });
  }
  function updateOp(i: number, next: Op) {
    const arr = [...ops];
    arr[i] = next;
    onChange({ ...step, operations: arr });
  }
  function deleteOp(i: number) {
    onChange({ ...step, operations: ops.filter((_, j) => j !== i) });
  }
  function moveOp(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= ops.length) return;
    const arr = [...ops];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange({ ...step, operations: arr });
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
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h5 className="text-xs uppercase tracking-wider text-muted">
            Operaciones ({ops.length})
          </h5>
          <div className="flex flex-wrap gap-1">
            {OP_LABELS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => addOp(o.value)}
                title={o.hint}
                className="text-[11px] px-2 py-0.5 rounded border border-surface-strong bg-surface hover:bg-slate-800"
              >
                + {o.label}
              </button>
            ))}
          </div>
        </div>

        {ops.length === 0 && (
          <div className="text-xs text-dim">
            Agregá una operación con los botones de arriba. Se aplican en orden.
          </div>
        )}

        <div className="space-y-2">
          {ops.map((op, i) => (
            <div
              key={i}
              className="bg-surface border border-surface-strong rounded p-2 flex items-start gap-2"
            >
              <div className="flex flex-col gap-0.5 pt-1">
                <button
                  type="button"
                  onClick={() => moveOp(i, -1)}
                  disabled={i === 0}
                  className="text-xs text-dim disabled:opacity-20"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => moveOp(i, 1)}
                  disabled={i === ops.length - 1}
                  className="text-xs text-dim disabled:opacity-20"
                >
                  ▼
                </button>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <code className="text-[11px] text-dim">{i + 1}.</code>
                  <code className="text-xs font-semibold uppercase tracking-wider text-accent">
                    {op.op}
                  </code>
                </div>
                <OpFields op={op} onChange={(n) => updateOp(i, n)} />
              </div>
              <button
                type="button"
                onClick={() => deleteOp(i)}
                className="text-red-400 text-xs"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <InPlaceOrNewTable
        value={step.output_table ?? null}
        inputTable={step.input}
        onChange={(v) => onChange({ ...step, output_table: v })}
        placeholder="ej. tx_typed"
      />
    </div>
  );
}

function OpFields({ op, onChange }: { op: Op; onChange: (next: Op) => void }) {
  if (op.op === "to_date") {
    return (
      <div className="grid grid-cols-3 gap-2">
        <input
          value={op.column}
          onChange={(e) => onChange({ ...op, column: e.target.value })}
          placeholder="columna"
          className="milhouse-field text-xs py-1 font-mono"
        />
        <input
          value={op.format ?? ""}
          onChange={(e) =>
            onChange({ ...op, format: e.target.value || null })
          }
          placeholder="formato (opcional, ej. %Y-%m-%d)"
          className="milhouse-field text-xs py-1 font-mono"
        />
        <input
          value={op.as ?? ""}
          onChange={(e) => onChange({ ...op, as: e.target.value || null })}
          placeholder="alias (opcional)"
          className="milhouse-field text-xs py-1 font-mono"
        />
      </div>
    );
  }
  if (op.op === "cast") {
    return (
      <div className="grid grid-cols-3 gap-2">
        <input
          value={op.column}
          onChange={(e) => onChange({ ...op, column: e.target.value })}
          placeholder="columna"
          className="milhouse-field text-xs py-1 font-mono"
        />
        <select
          value={op.to}
          onChange={(e) => onChange({ ...op, to: e.target.value })}
          className="milhouse-field text-xs py-1"
        >
          {CAST_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          value={op.as ?? ""}
          onChange={(e) => onChange({ ...op, as: e.target.value || null })}
          placeholder="alias (opcional)"
          className="milhouse-field text-xs py-1 font-mono"
        />
      </div>
    );
  }
  if (op.op === "uppercase" || op.op === "lowercase") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <input
          value={op.column}
          onChange={(e) => onChange({ ...op, column: e.target.value })}
          placeholder="columna"
          className="milhouse-field text-xs py-1 font-mono"
        />
        <input
          value={op.as ?? ""}
          onChange={(e) => onChange({ ...op, as: e.target.value || null })}
          placeholder="alias (opcional)"
          className="milhouse-field text-xs py-1 font-mono"
        />
      </div>
    );
  }
  if (op.op === "rename") {
    return (
      <div className="grid grid-cols-[1fr_24px_1fr] gap-2 items-center">
        <input
          value={op.column}
          onChange={(e) => onChange({ ...op, column: e.target.value })}
          placeholder="columna actual"
          className="milhouse-field text-xs py-1 font-mono"
        />
        <span className="text-center text-dim">→</span>
        <input
          value={op.to}
          onChange={(e) => onChange({ ...op, to: e.target.value })}
          placeholder="nuevo nombre"
          className="milhouse-field text-xs py-1 font-mono"
        />
      </div>
    );
  }
  if (op.op === "add_constant") {
    return (
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <input
          value={op.column}
          onChange={(e) => onChange({ ...op, column: e.target.value })}
          placeholder="nombre de columna nueva"
          className="milhouse-field text-xs py-1 font-mono"
        />
        <input
          value={
            typeof op.value === "string"
              ? op.value
              : JSON.stringify(op.value)
          }
          onChange={(e) => {
            const raw = e.target.value;
            // Intentar parsear como numérico, bool o JSON; sino string.
            let v: unknown = raw;
            if (/^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
            else if (raw === "true") v = true;
            else if (raw === "false") v = false;
            else if (raw === "null") v = null;
            onChange({ ...op, value: v });
          }}
          placeholder="valor (núm, string, true/false, null)"
          className="milhouse-field text-xs py-1 font-mono"
        />
      </div>
    );
  }
  return null;
}
