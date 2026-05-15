"use client";

import { AvailableTable, Field, TableSelect } from "./_shared";

type Target =
  | { kind: "file"; format: "csv" | "parquet" | "json"; path: string }
  | { kind: "duckdb"; table: string; replace?: boolean };

interface ExportStep {
  id: string;
  kind: "export";
  input?: string;
  target?: Target;
  depends_on?: string[];
  [k: string]: unknown;
}

export function ExportVisual({
  step,
  available,
  onChange,
}: {
  step: ExportStep;
  available: AvailableTable[];
  onChange: (next: ExportStep) => void;
}) {
  function setInput(tbl: string) {
    const stepId = available.find((a) => a.output_table === tbl)?.step_id;
    const deps = new Set<string>();
    if (stepId) deps.add(stepId);
    onChange({ ...step, input: tbl, depends_on: Array.from(deps) });
  }

  const target = step.target ?? { kind: "file" as const, format: "csv" as const, path: "" };

  function setTargetKind(kind: "file" | "duckdb") {
    if (kind === "file") {
      onChange({
        ...step,
        target: {
          kind: "file",
          format: "csv",
          path:
            (target.kind === "file" && (target as { path: string }).path) ||
            suggestPath(step.input),
        },
      });
    } else {
      onChange({
        ...step,
        target: {
          kind: "duckdb",
          table: step.input ? `${step.input}_out` : "",
          replace: false,
        },
      });
    }
  }

  function updateTarget(patch: Partial<Target>) {
    onChange({ ...step, target: { ...target, ...patch } as Target });
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

      <Field label="Destino">
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() => setTargetKind("file")}
            className={`px-3 py-1 rounded border flex-1 ${
              target.kind === "file"
                ? "bg-accent-token border-transparent"
                : "bg-surface-2 border-surface-strong"
            }`}
          >
            📄 Archivo
          </button>
          <button
            type="button"
            onClick={() => setTargetKind("duckdb")}
            className={`px-3 py-1 rounded border flex-1 ${
              target.kind === "duckdb"
                ? "bg-accent-token border-transparent"
                : "bg-surface-2 border-surface-strong"
            }`}
          >
            🦆 Tabla DuckDB
          </button>
        </div>
      </Field>

      {target.kind === "file" && (
        <>
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="Formato">
              <select
                value={target.format}
                onChange={(e) =>
                  updateTarget({
                    format: e.target.value as "csv" | "parquet" | "json",
                  })
                }
                className="w-full milhouse-field"
              >
                <option value="csv">csv</option>
                <option value="parquet">parquet</option>
                <option value="json">json</option>
              </select>
            </Field>
            <Field label="Path">
              <input
                value={target.path}
                onChange={(e) => updateTarget({ path: e.target.value })}
                placeholder="data/exports/out.csv"
                className="w-full milhouse-field font-mono"
              />
            </Field>
          </div>
        </>
      )}

      {target.kind === "duckdb" && (
        <>
          <Field label="Tabla destino (en la conexión default)">
            <input
              value={target.table}
              onChange={(e) => updateTarget({ table: e.target.value })}
              placeholder="ej. tx_export"
              className="w-full milhouse-field font-mono"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={!!target.replace}
              onChange={(e) => updateTarget({ replace: e.target.checked })}
            />
            <span>
              Reemplazar tabla si existe
              <span className="text-dim ml-1">(DROP + CREATE)</span>
            </span>
          </label>
        </>
      )}
    </div>
  );
}

function suggestPath(inputTable?: string | null): string {
  const safe = (inputTable ?? "out").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `data/exports/${safe}.csv`;
}
