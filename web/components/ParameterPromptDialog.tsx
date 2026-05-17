"use client";

import { useMemo, useState } from "react";
import type {
  ParamPreset,
  ParamSpec,
  ParamValueJson,
} from "./DesignEditor";
import { parseExcelForParam } from "@/lib/api";
import { useDialog } from "./Dialog";
import { DateOrDynamicInput } from "./ParametersPanel";

/**
 * Diálogo que aparece al ejecutar un proyecto que declara `parameters`.
 * Para cada parámetro:
 *   - permite elegir uno o varios "presets" guardados (se mergean en orden:
 *     el último gana en caso de conflicto);
 *   - permite sobreescribir el valor manualmente;
 *   - para listas, ofrece cargar desde Excel.
 *
 * Al confirmar, llama a `onResolved(values)` con el Record<name, value>.
 */
export interface PresetGroupDto {
  name: string;
  description?: string | null;
  preset_names: string[];
}

export function ParameterPromptDialog({
  parameters,
  presets,
  presetGroups,
  defaultRunName,
  initialValues,
  onCancel,
  onResolved,
}: {
  parameters: ParamSpec[];
  presets: ParamPreset[];
  presetGroups?: PresetGroupDto[];
  /** Sugerencia para el nombre de la ejecución (ej. "Demo · 2026-05-16"). */
  defaultRunName?: string;
  /** Valores por default que pre-rellenan los inputs. Vienen del
   *  `run_defaults` del proyecto. El usuario puede sobreescribirlos. */
  initialValues?: Record<string, ParamValueJson>;
  onCancel: () => void;
  onResolved: (args: {
    values: Record<string, ParamValueJson>;
    runName: string | null;
  }) => void;
}) {
  const dialog = useDialog();
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ParamValueJson>>(
    () => ({ ...(initialValues ?? {}) }),
  );
  const [runName, setRunName] = useState<string>(defaultRunName ?? "");

  // Merge presets en orden de selección.
  const fromPresets = useMemo<Record<string, ParamValueJson>>(() => {
    const out: Record<string, ParamValueJson> = {};
    for (const name of selectedPresets) {
      const pr = presets.find((p) => p.name === name);
      if (!pr) continue;
      for (const [k, v] of Object.entries(pr.values)) {
        out[k] = v;
      }
    }
    return out;
  }, [selectedPresets, presets]);

  const effective = useMemo<Record<string, ParamValueJson>>(() => {
    return { ...fromPresets, ...overrides };
  }, [fromPresets, overrides]);

  const missing = parameters
    .filter((p) => {
      const v = effective[p.name];
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      return v === "";
    })
    .map((p) => p.name);

  function togglePreset(name: string) {
    setSelectedPresets((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  function setOverride(name: string, v: ParamValueJson | null) {
    setOverrides((prev) => {
      const out = { ...prev };
      if (v == null) delete out[name];
      else out[name] = v;
      return out;
    });
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)" }}
    >
      <div
        className="bg-surface border border-surface-strong rounded-xl p-5 w-full max-w-2xl max-h-[90vh] overflow-auto"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <h3 className="text-lg font-bold mb-1">Parámetros de ejecución</h3>
        <p className="text-xs text-muted mb-3">
          Elegí una o varias respuestas guardadas, o ajustá los valores
          manualmente. Si elegís varias, los valores se combinan en orden y
          el último gana en caso de superposición.
        </p>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
            Nombre de la ejecución (opcional)
          </span>
          <input
            value={runName}
            onChange={(e) => setRunName(e.target.value)}
            placeholder="ej. cierre marzo, YTD con clientes A…"
            className="w-full milhouse-field"
          />
          <p className="text-[11px] text-dim mt-1">
            Te ayuda a identificar este run en la lista de ejecuciones cuando
            corrés el mismo proyecto con distintos parámetros.
          </p>
        </label>

        {presetGroups && presetGroups.length > 0 && (
          <div className="bg-surface-2 border border-surface rounded p-2 mb-3">
            <div className="text-[11px] uppercase tracking-wider text-dim mb-1">
              Grupo de respuestas
            </div>
            <p className="text-[11px] text-dim mb-1.5">
              Elegir un grupo aplica todas sus respuestas de una. Después
              podés afinar los valores abajo si querés.
            </p>
            <div className="flex flex-wrap gap-1">
              {presetGroups.map((g) => {
                const allSelected =
                  g.preset_names.length > 0 &&
                  g.preset_names.every((n) => selectedPresets.includes(n));
                return (
                  <button
                    key={g.name}
                    onClick={() => {
                      // Aplicar grupo = setear selectedPresets a sus presets
                      // en orden. Si ya estaba aplicado, lo quitamos.
                      if (allSelected) {
                        setSelectedPresets((prev) =>
                          prev.filter((n) => !g.preset_names.includes(n)),
                        );
                      } else {
                        const rest = selectedPresets.filter(
                          (n) => !g.preset_names.includes(n),
                        );
                        setSelectedPresets([...rest, ...g.preset_names]);
                      }
                    }}
                    className={`text-xs px-2 py-1 rounded border ${
                      allSelected
                        ? "border-cyan-600"
                        : "milhouse-btn-secondary border-surface-strong"
                    }`}
                    style={
                      allSelected
                        ? { background: "var(--accent)", color: "var(--accent-ink)" }
                        : undefined
                    }
                    title={
                      (g.description ? g.description + " · " : "") +
                      `Aplica: ${g.preset_names.join(", ")}`
                    }
                  >
                    {allSelected ? "✓ " : "📦 "}
                    {g.name}
                    <span className="text-[10px] opacity-75 ml-1">
                      ({g.preset_names.length})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {presets.length > 0 && (
          <div className="bg-surface-2 border border-surface rounded p-2 mb-3">
            <div className="text-[11px] uppercase tracking-wider text-dim mb-1">
              Respuestas guardadas
            </div>
            <div className="flex flex-wrap gap-1">
              {presets.map((p) => {
                const on = selectedPresets.includes(p.name);
                return (
                  <button
                    key={p.name}
                    onClick={() => togglePreset(p.name)}
                    className={`text-xs px-2 py-1 rounded border ${
                      on
                        ? "border-cyan-600"
                        : "milhouse-btn-secondary border-surface-strong"
                    }`}
                    style={
                      on
                        ? { background: "var(--accent)", color: "var(--accent-ink)" }
                        : undefined
                    }
                    title={p.description ?? ""}
                  >
                    {on ? "✓ " : ""}
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-2">
          {parameters.map((p) => {
            const inherited = fromPresets[p.name];
            const override = overrides[p.name];
            const current = override ?? inherited;
            return (
              <div
                key={p.name}
                className="bg-surface-2 border border-surface rounded p-2"
              >
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <code className="text-sm font-mono font-semibold">
                      :{p.name}
                    </code>
                    {p.label && (
                      <span className="ml-2 text-xs text-muted">{p.label}</span>
                    )}
                  </div>
                  <span className="text-[10px] text-dim">{kindLabel(p.kind)}</span>
                </div>
                {p.description && (
                  <p className="text-[11px] text-dim mb-1">{p.description}</p>
                )}
                <ValueEditor
                  param={p}
                  value={current}
                  onChange={(v) => setOverride(p.name, v)}
                  inheritedFrom={
                    inherited != null && override == null
                      ? selectedPresets.find((sp) =>
                          (presets.find((pr) => pr.name === sp)?.values[p.name]) != null,
                        ) ?? null
                      : null
                  }
                  onLoadExcel={async (f) => {
                    try {
                      const r = await parseExcelForParam(f);
                      setOverride(p.name, r.values);
                      await dialog.alert(
                        `Cargué ${r.rows_total} valor(es).`,
                        { variant: "info" },
                      );
                    } catch (e) {
                      await dialog.alert(String(e), {
                        title: "No se pudo leer el Excel",
                        variant: "danger",
                      });
                    }
                  }}
                />
              </div>
            );
          })}
        </div>

        {missing.length > 0 && (
          <div className="mt-3 text-xs text-amber-300 bg-amber-500/10 border border-amber-700 rounded p-2">
            ⚠ Faltan valores para: <code>{missing.join(", ")}</code>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2 pt-3 border-t border-surface">
          <button
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary"
          >
            Cancelar
          </button>
          <button
            onClick={() =>
              onResolved({
                values: effective,
                runName: runName.trim() || null,
              })
            }
            disabled={missing.length > 0}
            className="text-sm font-semibold px-3 py-1.5 rounded disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            Ejecutar
          </button>
        </div>
      </div>
    </div>
  );
}

function kindLabel(k: ParamSpec["kind"]): string {
  switch (k) {
    case "date":
      return "fecha";
    case "number":
      return "número";
    case "text":
      return "texto";
    case "boolean":
      return "sí/no";
    case "list_number":
      return "lista (números)";
    case "list_text":
      return "lista (textos)";
  }
}

function ValueEditor({
  param,
  value,
  onChange,
  inheritedFrom,
  onLoadExcel,
}: {
  param: ParamSpec;
  value: ParamValueJson | undefined;
  onChange: (v: ParamValueJson | null) => void;
  inheritedFrom: string | null;
  onLoadExcel: (f: File) => void;
}) {
  const k = param.kind;
  const list = k === "list_number" || k === "list_text";
  return (
    <div>
      {k === "date" && (
        <DateOrDynamicInput
          value={typeof value === "string" ? value : ""}
          onChange={(s) => onChange(s || null)}
        />
      )}
      {k === "number" && (
        <input
          type="number"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="milhouse-field text-sm w-full font-mono"
        />
      )}
      {k === "text" && (
        <input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="milhouse-field text-sm w-full"
        />
      )}
      {k === "boolean" && (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="milhouse-field text-sm w-full"
        >
          <option value="">(sin respuesta)</option>
          <option value="1">Sí</option>
          <option value="0">No</option>
        </select>
      )}
      {list && (
        <>
          <textarea
            value={Array.isArray(value) ? value.join("\n") : ""}
            onChange={(e) => {
              const arr = e.target.value
                .split(/[\n,;]+/)
                .map((s) => s.trim())
                .filter(Boolean);
              onChange(arr.length === 0 ? null : arr);
            }}
            rows={3}
            placeholder="Un valor por línea (o coma)"
            className="milhouse-field text-xs w-full font-mono"
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-dim">
              {Array.isArray(value) ? value.length : 0} valor(es)
            </span>
            <label className="text-[11px] px-2 py-0.5 rounded milhouse-btn-secondary cursor-pointer">
              📂 Cargar Excel
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onLoadExcel(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </>
      )}
      {inheritedFrom && (
        <div className="text-[10px] text-cyan-300 mt-1">
          ← heredado de "{inheritedFrom}"
        </div>
      )}
    </div>
  );
}
