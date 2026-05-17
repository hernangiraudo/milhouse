"use client";

import { useEffect, useMemo, useState } from "react";
import { SqlQueryVisual } from "./step_editors/SqlQueryVisual";
import { SqlExecVisual } from "./step_editors/SqlExecVisual";
import { JoinVisual } from "./step_editors/JoinVisual";
import { LookupVisual } from "./step_editors/LookupVisual";
import { TransformVisual } from "./step_editors/TransformVisual";
import { FilterSubsetVisual } from "./step_editors/FilterSubsetVisual";
import { SortVisual } from "./step_editors/SortVisual";
import { ProceduralVisual } from "./step_editors/ProceduralVisual";
import { ExportVisual } from "./step_editors/ExportVisual";
import { UnionVisual } from "./step_editors/UnionVisual";

export type Step = Record<string, unknown> & {
  id: string;
  kind: string;
  depends_on?: string[];
  group?: string | null;
  log_level?: "info" | "warn" | "error";
  dataset_name?: string | null;
  priority?: "low" | "normal" | "high";
};

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "sql_query", label: "SQL query → tabla" },
  { value: "sql_exec", label: "SQL exec (DDL/DML)" },
  { value: "join", label: "Join" },
  { value: "lookup", label: "Lookup (descripciones)" },
  { value: "transform", label: "Transform (columnas)" },
  { value: "filter_and_subset", label: "Filter + subset" },
  { value: "sort", label: "Sort" },
  { value: "procedural", label: "Procedural (Rhai/Rust)" },
  { value: "export", label: "Export (archivo/DB)" },
];

interface Props {
  step: Step;
  allStepIds: string[];
  allGroups: string[];
  /** Pasos previos con su output_table, para que el editor Join elija de ahí. */
  availableTables?: Array<{ output_table: string; step_id: string }>;
  onChange: (next: Step) => void;
  onDelete: () => void;
}

export function StepEditor({
  step,
  allStepIds,
  allGroups,
  availableTables = [],
  onChange,
  onDelete,
}: Props) {
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState(() =>
    JSON.stringify(step, null, 2),
  );
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  // Sync el JSON crudo cuando cambia step desde afuera (cambio de tipo, etc).
  useEffect(() => {
    if (mode === "form") {
      setJsonText(JSON.stringify(step, null, 2));
      setJsonErr(null);
    }
  }, [step, mode]);

  function update<K extends keyof Step>(key: K, value: Step[K]) {
    onChange({ ...step, [key]: value });
  }

  function updateMany(patch: Partial<Step>) {
    onChange({ ...step, ...patch });
  }

  // Al cambiar el `kind`, dejar los campos comunes pero limpiar los del tipo
  // anterior, plantando defaults razonables del nuevo.
  function changeKind(newKind: string) {
    const base: Step = {
      id: step.id,
      kind: newKind,
      depends_on: step.depends_on ?? [],
      group: step.group ?? null,
      log_level: step.log_level ?? "info",
      dataset_name: step.dataset_name ?? null,
    };
    const defaults = defaultsForKind(newKind);
    onChange({ ...base, ...defaults });
  }

  function applyJson() {
    try {
      const parsed = JSON.parse(jsonText) as Step;
      if (!parsed.id || !parsed.kind) {
        throw new Error("`id` y `kind` son obligatorios.");
      }
      setJsonErr(null);
      onChange(parsed);
    } catch (e) {
      setJsonErr(String(e));
    }
  }

  const otherStepIds = useMemo(
    () => allStepIds.filter((id) => id !== step.id),
    [allStepIds, step.id],
  );

  return (
    <div className="bg-surface-2 border border-surface rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <code className="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-700">
            {step.kind}
          </code>
          <code className="font-mono font-semibold text-sm">{step.id}</code>
          {(step as Step & { step_uid?: number }).step_uid != null && (
            <code className="text-[10px] text-dim">
              uid: {String((step as Step & { step_uid?: number }).step_uid)}
            </code>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setMode("form")}
            className={`px-2 py-1 rounded border ${
              mode === "form"
                ? "bg-accent-token border-transparent"
                : "bg-surface border-surface-strong"
            }`}
          >
            Formulario
          </button>
          <button
            type="button"
            onClick={() => setMode("json")}
            className={`px-2 py-1 rounded border ${
              mode === "json"
                ? "bg-accent-token border-transparent"
                : "bg-surface border-surface-strong"
            }`}
          >
            JSON
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="ml-2 px-2 py-1 rounded border border-red-700 bg-red-500/10 text-red-300 hover:bg-red-500/30"
          >
            Eliminar
          </button>
        </div>
      </div>

      {mode === "form" ? (
        <>
          <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
            <Field label="ID (legible)">
              <input
                value={step.id}
                onChange={(e) => update("id", e.target.value)}
                className="w-full milhouse-field font-mono"
              />
            </Field>
            <Field label="Tipo">
              <select
                value={step.kind}
                onChange={(e) => changeKind(e.target.value)}
                className="w-full milhouse-field"
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Grupo (opcional)">
              <input
                list={`groups-${step.id}`}
                value={step.group ?? ""}
                onChange={(e) =>
                  update("group", e.target.value ? e.target.value : null)
                }
                className="w-full milhouse-field"
                placeholder="ej. ingest"
              />
              <datalist id={`groups-${step.id}`}>
                {allGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
          </div>

          <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
            <Field label="Depende de">
              <DependsSelect
                value={step.depends_on ?? []}
                options={otherStepIds}
                onChange={(v) => update("depends_on", v)}
              />
            </Field>
            <Field label="Log level">
              <select
                value={step.log_level ?? "info"}
                onChange={(e) =>
                  update(
                    "log_level",
                    e.target.value as "info" | "warn" | "error",
                  )
                }
                className="w-full milhouse-field"
              >
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </Field>
            <Field label="Prioridad">
              <select
                value={step.priority ?? "normal"}
                onChange={(e) =>
                  update(
                    "priority",
                    e.target.value as "low" | "normal" | "high",
                  )
                }
                className="w-full milhouse-field"
                title="High se ejecuta antes que Normal/Low. Low espera a que terminen los High/Normal. Las dependencias del DAG siempre se respetan."
              >
                <option value="high">★ Alta</option>
                <option value="normal">Normal</option>
                <option value="low">Baja</option>
              </select>
            </Field>
            <Field label="Dataset name (debug)">
              <input
                value={(step.dataset_name as string) ?? ""}
                onChange={(e) =>
                  update(
                    "dataset_name",
                    e.target.value.trim() ? e.target.value : null,
                  )
                }
                placeholder="opcional"
                className="w-full milhouse-field"
              />
            </Field>
          </div>

          <KindFields
            step={step}
            update={updateMany}
            availableTables={availableTables}
          />
        </>
      ) : (
        <>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            rows={12}
            className="w-full milhouse-codeblock"
            spellCheck={false}
          />
          {jsonErr && <div className="text-red-400 text-xs">{jsonErr}</div>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setJsonText(JSON.stringify(step, null, 2));
                setJsonErr(null);
              }}
              className="text-xs px-3 py-1 rounded border border-surface-strong bg-surface"
            >
              Resetear
            </button>
            <button
              type="button"
              onClick={applyJson}
              className="text-xs px-3 py-1 rounded font-semibold"
              style={{
                background: "var(--accent)",
                color: "var(--accent-ink)",
              }}
            >
              Aplicar JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// =====================================================================
// Forms por kind
// =====================================================================
function KindFields({
  step,
  update,
  availableTables,
}: {
  step: Step;
  update: (p: Partial<Step>) => void;
  availableTables: Array<{ output_table: string; step_id: string }>;
}) {
  const k = step.kind;
  if (k === "sql_query") {
    return (
      <SqlQueryVisual
        step={step as Parameters<typeof SqlQueryVisual>[0]["step"]}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "sql_exec") {
    return (
      <SqlExecVisual
        step={step as Parameters<typeof SqlExecVisual>[0]["step"]}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "join") {
    return (
      <JoinVisual
        step={step as Parameters<typeof JoinVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "lookup") {
    return (
      <LookupVisual
        step={step as Parameters<typeof LookupVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "transform") {
    return (
      <TransformVisual
        step={step as Parameters<typeof TransformVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "filter_and_subset") {
    return (
      <FilterSubsetVisual
        step={step as Parameters<typeof FilterSubsetVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "sort") {
    return (
      <SortVisual
        step={step as Parameters<typeof SortVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "procedural") {
    return (
      <ProceduralVisual
        step={step as Parameters<typeof ProceduralVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "export") {
    return (
      <ExportVisual
        step={step as Parameters<typeof ExportVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  if (k === "union") {
    return (
      <UnionVisual
        step={step as Parameters<typeof UnionVisual>[0]["step"]}
        available={availableTables}
        onChange={(next) => update(next as Partial<Step>)}
      />
    );
  }
  return null;
}

/* Legacy non-visual KindFields removed - all kinds have visual editors now.
   The block below is preserved inside a comment so future Claude sessions can
   recover it if needed, but it's not executed.

   ORIGINAL CODE FOLLOWS (commented out):
=========================================================================
    return (
      <>
        <div className="grid grid-cols-2 gap-3">
          <Field label="input (tabla a enriquecer)">
            <input
              value={(step.input as string) ?? ""}
              onChange={(e) => update({ input: e.target.value })}
              className="w-full milhouse-field font-mono"
            />
          </Field>
          <Field label="master (tabla maestra)">
            <input
              value={(step.master as string) ?? ""}
              onChange={(e) => update({ master: e.target.value })}
              className="w-full milhouse-field font-mono"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="key (en input)">
            <input
              value={(step.key as string) ?? ""}
              onChange={(e) => update({ key: e.target.value })}
              className="w-full milhouse-field font-mono"
            />
          </Field>
          <Field label="master_key (en master)">
            <input
              value={(step.master_key as string) ?? ""}
              onChange={(e) => update({ master_key: e.target.value })}
              className="w-full milhouse-field font-mono"
            />
          </Field>
        </div>
        <Field label='select (JSON: [{"from":"campo","as":"alias"}])'>
          <textarea
            value={JSON.stringify(step.select ?? [], null, 2)}
            onChange={(e) => {
              try {
                update({ select: JSON.parse(e.target.value) });
              } catch {
                // ignorar; el usuario sigue escribiendo
              }
            }}
            rows={4}
            className="w-full milhouse-codeblock"
            spellCheck={false}
          />
        </Field>
        <Field label="output_table">
          <input
            value={(step.output_table as string) ?? ""}
            onChange={(e) => update({ output_table: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
      </>
    );
  }
  if (k === "transform") {
    return (
      <>
        <Field label="input">
          <input
            value={(step.input as string) ?? ""}
            onChange={(e) => update({ input: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
        <Field
          label={
            'operations (JSON: [{"op":"cast","column":"x","to":"f64"}, ...])'
          }
        >
          <textarea
            value={JSON.stringify(step.operations ?? [], null, 2)}
            onChange={(e) => {
              try {
                update({ operations: JSON.parse(e.target.value) });
              } catch {
                // ignorar
              }
            }}
            rows={6}
            className="w-full milhouse-codeblock"
            spellCheck={false}
          />
          <p className="text-[11px] text-dim mt-1">
            ops: <code>to_date</code>, <code>cast</code>, <code>uppercase</code>,
            <code>lowercase</code>, <code>rename</code>,{" "}
            <code>add_constant</code>.
          </p>
        </Field>
        <Field label="output_table">
          <input
            value={(step.output_table as string) ?? ""}
            onChange={(e) => update({ output_table: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
      </>
    );
  }
  if (k === "filter_and_subset") {
    return (
      <>
        <Field label="input">
          <input
            value={(step.input as string) ?? ""}
            onChange={(e) => update({ input: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
        <Field label="filter (expresión)">
          <input
            value={(step.filter as string) ?? ""}
            onChange={(e) =>
              update({
                filter: e.target.value.trim() ? e.target.value : null,
              })
            }
            placeholder="ej. amount > 1000 AND status == 'ok'"
            className="w-full milhouse-field font-mono"
          />
        </Field>
        <Field label="select (columnas separadas por coma)">
          <input
            value={((step.select as string[]) ?? []).join(", ")}
            onChange={(e) =>
              update({
                select: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className="w-full milhouse-field font-mono"
          />
        </Field>
        <Field label="output_table">
          <input
            value={(step.output_table as string) ?? ""}
            onChange={(e) => update({ output_table: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
      </>
    );
  }
  if (k === "sort") {
    return (
      <>
        <Field label="input">
          <input
            value={(step.input as string) ?? ""}
            onChange={(e) => update({ input: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
        <Field
          label='by (JSON: [{"column":"x","desc":true}, ...])'
        >
          <textarea
            value={JSON.stringify(step.by ?? [], null, 2)}
            onChange={(e) => {
              try {
                update({ by: JSON.parse(e.target.value) });
              } catch {}
            }}
            rows={4}
            className="w-full milhouse-codeblock"
            spellCheck={false}
          />
        </Field>
        <Field label="output_table">
          <input
            value={(step.output_table as string) ?? ""}
            onChange={(e) => update({ output_table: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
      </>
    );
  }
  if (k === "procedural") {
    const engine = ((step.engine as string) ?? "rhai") as "rhai" | "rust";
    return (
      <>
        <div className="grid grid-cols-[1fr_2fr] gap-3">
          <Field label="Engine">
            <select
              value={engine}
              onChange={(e) =>
                update({ engine: e.target.value as "rhai" | "rust" })
              }
              className="w-full milhouse-field"
            >
              <option value="rhai">Rhai (script)</option>
              <option value="rust">Rust (función registrada)</option>
            </select>
          </Field>
          <Field label="input">
            <input
              value={(step.input as string) ?? ""}
              onChange={(e) => update({ input: e.target.value })}
              className="w-full milhouse-field font-mono"
            />
          </Field>
        </div>
        {engine === "rhai" ? (
          <>
            <Field label="state_init (JSON, opcional)">
              <textarea
                value={JSON.stringify(step.state_init ?? {}, null, 2)}
                onChange={(e) => {
                  try {
                    update({ state_init: JSON.parse(e.target.value) });
                  } catch {}
                }}
                rows={3}
                className="w-full milhouse-codeblock"
                spellCheck={false}
              />
            </Field>
            <Field label="script (Rhai)">
              <textarea
                value={(step.script as string) ?? ""}
                onChange={(e) => update({ script: e.target.value })}
                rows={8}
                className="w-full milhouse-codeblock"
                spellCheck={false}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="fn_name (registrada en backend)">
              <input
                value={(step.fn_name as string) ?? ""}
                onChange={(e) => update({ fn_name: e.target.value })}
                placeholder="ej. fraud_scoring_v1"
                className="w-full milhouse-field font-mono"
              />
            </Field>
            <Field label="params (JSON, opcional)">
              <textarea
                value={JSON.stringify(step.params ?? {}, null, 2)}
                onChange={(e) => {
                  try {
                    update({ params: JSON.parse(e.target.value) });
                  } catch {}
                }}
                rows={4}
                className="w-full milhouse-codeblock"
                spellCheck={false}
              />
            </Field>
          </>
        )}
        <Field label="output_table">
          <input
            value={(step.output_table as string) ?? ""}
            onChange={(e) => update({ output_table: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
      </>
    );
  }
  if (k === "export") {
    const target = (step.target as Record<string, unknown>) ?? {
      kind: "file",
      format: "csv",
      path: "",
    };
    return (
      <>
        <Field label="input">
          <input
            value={(step.input as string) ?? ""}
            onChange={(e) => update({ input: e.target.value })}
            className="w-full milhouse-field font-mono"
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="target kind">
            <select
              value={(target.kind as string) ?? "file"}
              onChange={(e) =>
                update({ target: { ...target, kind: e.target.value } })
              }
              className="w-full milhouse-field"
            >
              <option value="file">file</option>
              <option value="duckdb">duckdb (tabla)</option>
            </select>
          </Field>
          {target.kind === "file" ? (
            <>
              <Field label="format">
                <select
                  value={(target.format as string) ?? "csv"}
                  onChange={(e) =>
                    update({
                      target: { ...target, format: e.target.value },
                    })
                  }
                  className="w-full milhouse-field"
                >
                  <option value="csv">csv</option>
                  <option value="parquet">parquet</option>
                  <option value="json">json</option>
                </select>
              </Field>
              <Field label="path">
                <input
                  value={(target.path as string) ?? ""}
                  onChange={(e) =>
                    update({ target: { ...target, path: e.target.value } })
                  }
                  placeholder="data/exports/out.csv"
                  className="w-full milhouse-field font-mono"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="table">
                <input
                  value={(target.table as string) ?? ""}
                  onChange={(e) =>
                    update({
                      target: { ...target, table: e.target.value },
                    })
                  }
                  className="w-full milhouse-field font-mono"
                />
              </Field>
              <label className="flex items-center gap-2 mt-5 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={!!target.replace}
                  onChange={(e) =>
                    update({
                      target: { ...target, replace: e.target.checked },
                    })
                  }
                />
                <span>replace</span>
              </label>
            </>
          )}
        </div>
      </>
    );
  }
  return null;
}
*/

// =====================================================================
// Helpers
// =====================================================================

function defaultsForKind(kind: string): Partial<Step> {
  switch (kind) {
    case "sql_query":
      return { query: "SELECT 1 AS dummy", output_table: "out" };
    case "sql_exec":
      return { query: "CREATE TABLE IF NOT EXISTS tmp(x INT);" };
    case "join":
      return {
        left: "",
        right: "",
        left_on: [""],
        right_on: [""],
        how: "inner",
        output_table: "joined",
      };
    case "lookup":
      return {
        input: "",
        master: "",
        key: "",
        master_key: "",
        select: [],
        output_table: "enriched",
      };
    case "transform":
      return { input: "", operations: [], output_table: "transformed" };
    case "filter_and_subset":
      return { input: "", filter: null, select: [], output_table: "filtered" };
    case "sort":
      return { input: "", by: [], output_table: "sorted" };
    case "procedural":
      return {
        input: "",
        engine: "rhai",
        script: "row",
        state_init: {},
        output_table: "scored",
      };
    case "export":
      return {
        input: "",
        target: { kind: "file", format: "csv", path: "data/exports/out.csv" },
      };
    default:
      return {};
  }
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

function DependsSelect({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(
      value.includes(id) ? value.filter((x) => x !== id) : [...value, id],
    );
  }
  return (
    <div className="border border-surface-strong rounded-md p-2 max-h-32 overflow-auto bg-surface">
      {options.length === 0 && (
        <div className="text-xs text-dim">(no hay otros pasos aún)</div>
      )}
      {options.map((id) => (
        <label
          key={id}
          className="flex items-center gap-2 text-sm cursor-pointer py-0.5"
        >
          <input
            type="checkbox"
            checked={value.includes(id)}
            onChange={() => toggle(id)}
          />
          <code className="font-mono text-xs">{id}</code>
        </label>
      ))}
    </div>
  );
}
