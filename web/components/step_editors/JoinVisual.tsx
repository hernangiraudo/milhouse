"use client";

import { useMemo } from "react";

interface JoinStep {
  id: string;
  kind: "join";
  left?: string;
  right?: string;
  left_on?: string[];
  right_on?: string[];
  how?: "inner" | "left" | "right" | "full";
  output_table?: string;
  depends_on?: string[];
  [k: string]: unknown;
}

interface AvailableTable {
  /** Lo que el step previo expone como output_table. */
  output_table: string;
  /** El step id del cual sale esa tabla (para depends_on automático). */
  step_id: string;
}

export function JoinVisual({
  step,
  available,
  onChange,
}: {
  step: JoinStep;
  /** Tablas que producen los pasos anteriores. */
  available: AvailableTable[];
  onChange: (next: JoinStep) => void;
}) {
  const left = step.left ?? "";
  const right = step.right ?? "";

  // Cuando se elige una tabla como left/right, agregamos su step_id a
  // depends_on automáticamente.
  function setSide(side: "left" | "right", outputTable: string) {
    const stepId = available.find((a) => a.output_table === outputTable)?.step_id;
    const deps = new Set(step.depends_on ?? []);
    // Reemplazar la dep antigua del side
    const otherTable = side === "left" ? right : left;
    const otherStepId = available.find((a) => a.output_table === otherTable)?.step_id;
    deps.clear();
    if (otherStepId) deps.add(otherStepId);
    if (stepId) deps.add(stepId);
    onChange({
      ...step,
      [side]: outputTable,
      depends_on: Array.from(deps),
    });
  }

  function setKey(side: "left_on" | "right_on", idx: number, value: string) {
    const arr = [...(step[side] ?? [])];
    arr[idx] = value;
    onChange({ ...step, [side]: arr });
  }
  function addKeyRow() {
    onChange({
      ...step,
      left_on: [...(step.left_on ?? []), ""],
      right_on: [...(step.right_on ?? []), ""],
    });
  }
  function deleteKeyRow(idx: number) {
    onChange({
      ...step,
      left_on: (step.left_on ?? []).filter((_, i) => i !== idx),
      right_on: (step.right_on ?? []).filter((_, i) => i !== idx),
    });
  }

  const keysCount = Math.max(
    step.left_on?.length ?? 0,
    step.right_on?.length ?? 0,
    1,
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tabla izquierda">
          <select
            value={left}
            onChange={(e) => setSide("left", e.target.value)}
            className="w-full milhouse-field font-mono text-sm"
          >
            <option value="">(elegir)</option>
            {available.map((a) => (
              <option key={a.output_table} value={a.output_table}>
                {a.output_table}  · de {a.step_id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tabla derecha">
          <select
            value={right}
            onChange={(e) => setSide("right", e.target.value)}
            className="w-full milhouse-field font-mono text-sm"
          >
            <option value="">(elegir)</option>
            {available
              .filter((a) => a.output_table !== left)
              .map((a) => (
                <option key={a.output_table} value={a.output_table}>
                  {a.output_table}  · de {a.step_id}
                </option>
              ))}
          </select>
        </Field>
      </div>

      <Field label="Tipo de join">
        <div className="flex gap-1 text-xs">
          {(
            [
              ["inner", "INNER", "Solo filas con match en ambos lados"],
              ["left", "LEFT OUTER", "Todas las de izquierda; nulls en derecha si no hay match"],
              ["right", "RIGHT OUTER", "Todas las de derecha; nulls en izquierda si no hay match"],
              ["full", "FULL OUTER", "Todas las de ambos lados; nulls donde no hay match"],
            ] as const
          ).map(([v, label, hint]) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange({ ...step, how: v })}
              className={`px-3 py-1 rounded border ${
                (step.how ?? "inner") === v
                  ? "bg-accent-token border-transparent"
                  : "bg-surface-2 border-surface-strong"
              }`}
              title={hint}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-dim mt-1">
          {step.how === "left" && "Todas las filas de la izquierda; las de derecha llenan con NULL si no matchean."}
          {step.how === "right" && "Todas las filas de la derecha; las de izquierda llenan con NULL si no matchean."}
          {step.how === "full" && "Unión completa: si no hay match en algún lado, se rellena con NULL."}
          {(step.how === "inner" || !step.how) && "Solo las filas que matchean en ambos lados."}
        </div>
      </Field>

      <div className="bg-surface-2 border border-surface rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs uppercase tracking-wider text-muted">
            Claves de join ({keysCount})
          </h5>
          <button
            type="button"
            onClick={addKeyRow}
            className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
          >
            + Clave
          </button>
        </div>
        {Array.from({ length: keysCount }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_24px_1fr_30px] gap-2 mb-1 items-center"
          >
            <input
              value={(step.left_on ?? [])[i] ?? ""}
              onChange={(e) => setKey("left_on", i, e.target.value)}
              placeholder="columna en izquierda"
              className="milhouse-field font-mono text-xs py-1"
            />
            <span className="text-center text-dim">=</span>
            <input
              value={(step.right_on ?? [])[i] ?? ""}
              onChange={(e) => setKey("right_on", i, e.target.value)}
              placeholder="columna en derecha"
              className="milhouse-field font-mono text-xs py-1"
            />
            <button
              type="button"
              onClick={() => deleteKeyRow(i)}
              className="text-red-400 text-xs"
              title="Eliminar clave"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <Field label="output_table (tabla resultante)">
        <input
          value={step.output_table ?? ""}
          onChange={(e) => onChange({ ...step, output_table: e.target.value })}
          className="w-full milhouse-field font-mono"
          placeholder="ej. tx_with_account"
        />
      </Field>
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
