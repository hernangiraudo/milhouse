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
 *
 * Muestra TODOS los parámetros del proyecto (locales + globales opt-in),
 * marcando obligatorios (★) y opcionales, con el valor resuelto por la
 * cadena de prioridad y permitiendo overridearlo manualmente.
 *
 * Cadena de prioridad por parámetro (de mayor a menor):
 *   1. override del usuario en este modal
 *   2. preset elegido en este modal (último gana si hay varios)
 *   3. grupo de respuestas activo del proyecto (selectedPresetGroupsActive)
 *   4. run_defaults del proyecto
 *   5. param.default
 */
export interface PresetGroupDto {
  name: string;
  description?: string | null;
  preset_names: string[];
}

type ParamRequirement = "optional" | "required";

type ValueOrigin =
  | { source: "override" }
  | { source: "preset"; presetName: string }
  | { source: "active_group"; groupName: string; presetName: string }
  | { source: "run_default" }
  | { source: "param_default" }
  | { source: "none" };

export function ParameterPromptDialog({
  parameters,
  presets,
  presetGroups,
  defaultRunName,
  initialValues,
  paramRequirements,
  runDefaults,
  selectedPresetGroupsActive,
  onCancel,
  onResolved,
}: {
  parameters: ParamSpec[];
  presets: ParamPreset[];
  presetGroups?: PresetGroupDto[];
  /** Sugerencia para el nombre de la ejecución (ej. "Demo · 2026-05-16"). */
  defaultRunName?: string;
  /** Valores por default que pre-rellenan los inputs. Cuando no se pasa
   *  `runDefaults` separado, este viene a ser el merge ya hecho de
   *  run_defaults + sesión. */
  initialValues?: Record<string, ParamValueJson>;
  /** Requirement por parámetro (local + global). Default: optional. */
  paramRequirements?: Record<string, ParamRequirement>;
  /** Respuestas por default del proyecto (cfg.run_defaults). Separadas
   *  para poder mostrar el origen del valor. */
  runDefaults?: Record<string, ParamValueJson>;
  /** Grupos de respuestas que el proyecto tiene activos
   *  (cfg.selected_preset_groups). Sus presets se aplican en orden y se
   *  muestran como origen del valor. */
  selectedPresetGroupsActive?: string[];
  onCancel: () => void;
  onResolved: (args: {
    values: Record<string, ParamValueJson>;
    runName: string | null;
    /** Nombres de presets que el usuario tildó en el prompt. Útil cuando
     *  el caller quiere persistir la selección (ej. schedules) en vez de
     *  congelar los valores resueltos. */
    selectedPresets: string[];
    /** Nombres de grupos de respuestas que el usuario aplicó. */
    selectedPresetGroups: string[];
  }) => void;
}) {
  const dialog = useDialog();
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ParamValueJson>>(
    {},
  );
  const [runName, setRunName] = useState<string>(defaultRunName ?? "");
  // Mostrar / ocultar parámetros que ya tienen valor por prioridad.
  // Por default mostramos todo; el usuario puede colapsar los resueltos
  // para enfocarse en los que falten o quiera tocar.
  const [hideResolved, setHideResolved] = useState(false);

  // Valor que cada preset MANUAL (elegido en el modal) le da a cada
  // parámetro. Mergeados en orden de selección — el último gana.
  const fromManualPresets = useMemo<{
    values: Record<string, ParamValueJson>;
    origin: Record<string, string>; // param → presetName
  }>(() => {
    const values: Record<string, ParamValueJson> = {};
    const origin: Record<string, string> = {};
    for (const name of selectedPresets) {
      const pr = presets.find((p) => p.name === name);
      if (!pr) continue;
      for (const [k, v] of Object.entries(pr.values)) {
        values[k] = v;
        origin[k] = name;
      }
    }
    return { values, origin };
  }, [selectedPresets, presets]);

  // Valor que aportan los GRUPOS activos del proyecto (siempre aplican).
  // No se controlan desde este modal — solo se muestran como origen.
  const fromActiveGroups = useMemo<{
    values: Record<string, ParamValueJson>;
    origin: Record<string, { groupName: string; presetName: string }>;
  }>(() => {
    const values: Record<string, ParamValueJson> = {};
    const origin: Record<
      string,
      { groupName: string; presetName: string }
    > = {};
    for (const groupName of selectedPresetGroupsActive ?? []) {
      const g = (presetGroups ?? []).find((x) => x.name === groupName);
      if (!g) continue;
      for (const presetName of g.preset_names) {
        const pr = presets.find((p) => p.name === presetName);
        if (!pr) continue;
        for (const [k, v] of Object.entries(pr.values)) {
          values[k] = v;
          origin[k] = { groupName, presetName };
        }
      }
    }
    return { values, origin };
  }, [presetGroups, presets, selectedPresetGroupsActive]);

  // Resolver valor + origen por parámetro, respetando la cadena de prioridad.
  function resolveFor(p: ParamSpec): { value: ParamValueJson | undefined; origin: ValueOrigin } {
    if (Object.prototype.hasOwnProperty.call(overrides, p.name)) {
      return { value: overrides[p.name], origin: { source: "override" } };
    }
    if (Object.prototype.hasOwnProperty.call(fromManualPresets.values, p.name)) {
      return {
        value: fromManualPresets.values[p.name],
        origin: {
          source: "preset",
          presetName: fromManualPresets.origin[p.name],
        },
      };
    }
    if (Object.prototype.hasOwnProperty.call(fromActiveGroups.values, p.name)) {
      const { groupName, presetName } = fromActiveGroups.origin[p.name];
      return {
        value: fromActiveGroups.values[p.name],
        origin: { source: "active_group", groupName, presetName },
      };
    }
    if (runDefaults && Object.prototype.hasOwnProperty.call(runDefaults, p.name)) {
      return {
        value: runDefaults[p.name],
        origin: { source: "run_default" },
      };
    }
    // Fallback: lo que venga en initialValues (típicamente sesión), si no, param.default.
    if (initialValues && Object.prototype.hasOwnProperty.call(initialValues, p.name)) {
      return {
        value: initialValues[p.name],
        origin: { source: "run_default" },
      };
    }
    if (p.default != null) {
      return { value: p.default, origin: { source: "param_default" } };
    }
    return { value: undefined, origin: { source: "none" } };
  }

  const effective = useMemo<Record<string, ParamValueJson>>(() => {
    const out: Record<string, ParamValueJson> = {};
    for (const p of parameters) {
      const { value } = resolveFor(p);
      if (value != null) out[p.name] = value;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parameters, overrides, fromManualPresets, fromActiveGroups, runDefaults, initialValues]);

  function isEmpty(v: ParamValueJson | undefined): boolean {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return v === "";
  }

  // Faltantes obligatorios: solo bloquean si el param es Required.
  const requiredMissing = parameters
    .filter((p) => (paramRequirements ?? {})[p.name] === "required")
    .filter((p) => isEmpty(effective[p.name]))
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

  function clearOverride(name: string) {
    setOverrides((prev) => {
      const out = { ...prev };
      delete out[name];
      return out;
    });
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)" }}
    >
      <div
        className="bg-surface border border-surface-strong rounded-xl p-5 w-full max-w-3xl max-h-[90vh] overflow-auto"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <h3 className="text-lg font-bold mb-1">Parámetros de ejecución</h3>
        <p className="text-xs text-muted mb-3">
          Se muestran todos los parámetros del proyecto. Los marcados con
          {" "}<span className="text-amber-300">★</span>{" "}son obligatorios. El
          valor de cada uno viene de la cadena de prioridad (preset elegido
          → grupo activo → respuestas por default → default del parámetro)
          y podés sobreescribirlo manualmente.
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

        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs uppercase tracking-wider text-muted">
            Parámetros del proyecto · {parameters.length}
          </h4>
          <label className="text-[11px] flex items-center gap-1 text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={hideResolved}
              onChange={(e) => setHideResolved(e.target.checked)}
            />
            ocultar los ya resueltos
          </label>
        </div>

        {(() => {
          const CAT_ORDER: Array<
            "dates" | "comitentes" | "abreviaturas" | "execution" | "other"
          > = ["dates", "comitentes", "abreviaturas", "execution", "other"];
          const CAT_LABEL: Record<(typeof CAT_ORDER)[number], string> = {
            dates: "Fechas",
            comitentes: "Comitentes",
            abreviaturas: "Abreviaturas",
            execution: "Ejecución",
            other: "Otros",
          };
          const grouped: Record<(typeof CAT_ORDER)[number], typeof parameters> = {
            dates: [],
            comitentes: [],
            abreviaturas: [],
            execution: [],
            other: [],
          };
          for (const p of parameters) {
            const cat = (p.category ??
              "other") as (typeof CAT_ORDER)[number];
            grouped[cat].push(p);
          }

          const renderParam = (p: ParamSpec) => {
            const { value: current, origin } = resolveFor(p);
            const req = (paramRequirements ?? {})[p.name] ?? "optional";
            const isRequired = req === "required";
            const isOverridden = origin.source === "override";
            const empty = isEmpty(current);
            const requiredMiss = isRequired && empty;

            // Si el usuario eligió ocultar resueltos, solo escondemos los
            // que tienen valor y no son override (que son los que el usuario
            // está tocando explícitamente).
            if (hideResolved && !empty && !isOverridden && !requiredMiss) {
              return null;
            }

            return (
              <div
                key={p.name}
                className={`bg-surface-2 border rounded p-2 ${
                  requiredMiss
                    ? "border-red-700"
                    : "border-surface"
                }`}
              >
                <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`text-[10px] font-bold ${
                        isRequired ? "text-amber-300" : "text-dim"
                      }`}
                      title={
                        isRequired
                          ? "Obligatorio: el job no arranca sin valor"
                          : "Opcional"
                      }
                    >
                      {isRequired ? "★" : "○"}
                    </span>
                    <code className="text-sm font-mono font-semibold truncate">
                      :{p.name}
                    </code>
                    {p.label && (
                      <span className="text-xs text-muted truncate">
                        — {p.label}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] text-dim">
                      {kindLabel(p.kind)}
                    </span>
                  </div>
                </div>
                {p.description && (
                  <p className="text-[11px] text-dim mb-1">{p.description}</p>
                )}
                <ValueEditor
                  param={p}
                  value={current}
                  onChange={(v) => setOverride(p.name, v)}
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
                <div className="flex items-center justify-between mt-1 gap-2 flex-wrap">
                  <OriginBadge origin={origin} required={isRequired} empty={empty} />
                  {isOverridden && (
                    <button
                      onClick={() => clearOverride(p.name)}
                      className="text-[10px] text-cyan-300 underline"
                      title="Quitar el override y volver al valor heredado"
                    >
                      ↶ restaurar
                    </button>
                  )}
                </div>
              </div>
            );
          };

          return (
            <div className="space-y-3">
              {CAT_ORDER.filter((c) => grouped[c].length > 0).map((c) => {
                const rendered = grouped[c].map(renderParam).filter(Boolean);
                if (rendered.length === 0) return null;
                return (
                  <div key={c}>
                    <h5 className="text-[10px] uppercase tracking-wider text-dim mb-1">
                      {CAT_LABEL[c]} · {grouped[c].length}
                    </h5>
                    <div className="space-y-2">{rendered}</div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {requiredMissing.length > 0 && (
          <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-700 rounded p-2">
            ⚠ Faltan valores obligatorios:{" "}
            <code>{requiredMissing.join(", ")}</code>
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
            onClick={() => {
              const fullyOnGroups = (presetGroups ?? [])
                .filter(
                  (g) =>
                    g.preset_names.length > 0 &&
                    g.preset_names.every((n) => selectedPresets.includes(n)),
                )
                .map((g) => g.name);
              onResolved({
                values: effective,
                runName: runName.trim() || null,
                selectedPresets,
                selectedPresetGroups: fullyOnGroups,
              });
            }}
            disabled={requiredMissing.length > 0}
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

function OriginBadge({
  origin,
  required,
  empty,
}: {
  origin: ValueOrigin;
  required: boolean;
  empty: boolean;
}) {
  if (empty) {
    return (
      <span
        className={`text-[10px] ${
          required ? "text-red-300" : "text-dim"
        }`}
      >
        {required ? "⚠ sin valor (obligatorio)" : "sin valor"}
      </span>
    );
  }
  switch (origin.source) {
    case "override":
      return (
        <span className="text-[10px] text-cyan-300">
          ✎ modificado por vos
        </span>
      );
    case "preset":
      return (
        <span className="text-[10px] text-dim">
          ← respuesta guardada{" "}
          <code className="text-cyan-300">{origin.presetName}</code>
        </span>
      );
    case "active_group":
      return (
        <span className="text-[10px] text-dim">
          ← grupo activo{" "}
          <code className="text-cyan-300">{origin.groupName}</code>
          {" → "}
          <code className="text-cyan-300">{origin.presetName}</code>
        </span>
      );
    case "run_default":
      return (
        <span className="text-[10px] text-dim">
          ← respuesta por default del proyecto
        </span>
      );
    case "param_default":
      return (
        <span className="text-[10px] text-dim">
          ← default del parámetro
        </span>
      );
    case "none":
      return <span className="text-[10px] text-dim">—</span>;
  }
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
  onLoadExcel,
}: {
  param: ParamSpec;
  value: ParamValueJson | undefined;
  onChange: (v: ParamValueJson | null) => void;
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
        <div className="space-y-1">
          <input
            type="text"
            inputMode="decimal"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
            onBlur={(e) => {
              const raw = e.target.value;
              if (raw.includes(",") || raw.includes(";")) {
                const parts = raw
                  .split(/[,;]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (parts.length > 1) {
                  const formatted = parts.join(", ");
                  if (formatted !== raw) onChange(formatted);
                }
              }
            }}
            placeholder="ej. 101  ó  101, 102, 103"
            className="milhouse-field text-sm w-full font-mono"
          />
          <p className="text-[10px] text-dim">
            Un ID, o varios separados por coma o punto y coma. Solo
            enteros.
          </p>
        </div>
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
    </div>
  );
}
