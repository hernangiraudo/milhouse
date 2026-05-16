"use client";

import { useState } from "react";
import { useDialog } from "./Dialog";
import { parseExcelForParam } from "@/lib/api";
import type {
  ParamKind,
  ParamPreset,
  ParamSpec,
  ParamValueJson,
} from "./DesignEditor";

const KIND_LABEL: Record<ParamKind, string> = {
  date: "Fecha",
  number: "Número",
  text: "Texto",
  list_number: "Lista de números",
  list_text: "Lista de textos",
};

function isListKind(k: ParamKind): boolean {
  return k === "list_number" || k === "list_text";
}

type Tab = "parameters" | "presets";

export function ParametersPanel({
  parameters,
  presets,
  onChange,
}: {
  parameters: ParamSpec[];
  presets: ParamPreset[];
  onChange: (next: { parameters: ParamSpec[]; presets: ParamPreset[] }) => void;
}) {
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("parameters");
  const [expandedPreset, setExpandedPreset] = useState<number | null>(null);

  function setParams(next: ParamSpec[]) {
    onChange({ parameters: next, presets });
  }
  function setPresets(next: ParamPreset[]) {
    onChange({ parameters, presets: next });
  }

  async function addParam() {
    const name = await dialog.prompt("Nombre del parámetro (ej. FechaDesde):", {
      title: "Nuevo parámetro",
      placeholder: "FechaDesde",
      validate: (v) => {
        if (!v.trim()) return "obligatorio";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))
          return "usá letras, dígitos y _ (debe empezar con letra)";
        if (parameters.some((p) => p.name === v))
          return "ya existe un parámetro con ese nombre";
        return null;
      },
    });
    if (!name?.trim()) return;
    setParams([
      ...parameters,
      { name: name.trim(), kind: "date", label: null, description: null },
    ]);
  }

  function updateParam(i: number, patch: Partial<ParamSpec>) {
    const arr = [...parameters];
    arr[i] = { ...arr[i], ...patch };
    setParams(arr);
  }

  async function deleteParam(i: number) {
    const p = parameters[i];
    const usedIn = presets
      .filter((pr) => p.name in pr.values)
      .map((pr) => pr.name);
    const msg = usedIn.length
      ? `¿Eliminar el parámetro "${p.name}"? Lo usan estas respuestas: ${usedIn.join(", ")}. Se quitará de cada una.`
      : `¿Eliminar el parámetro "${p.name}"?`;
    const ok = await dialog.confirm(msg, {
      title: "Eliminar parámetro",
      variant: "danger",
      ok: "Eliminar",
    });
    if (!ok) return;
    const nextParams = parameters.filter((_, j) => j !== i);
    const nextPresets = presets.map((pr) => {
      const v = { ...pr.values };
      delete v[p.name];
      return { ...pr, values: v };
    });
    onChange({ parameters: nextParams, presets: nextPresets });
  }

  async function addPreset() {
    const name = await dialog.prompt(
      "Nombre de la respuesta guardada (ej. Year to Date):",
      {
        title: "Nueva respuesta",
        placeholder: "Year to Date",
        validate: (v) => {
          if (!v.trim()) return "obligatorio";
          if (presets.some((p) => p.name === v.trim()))
            return "ya existe una respuesta con ese nombre";
          return null;
        },
      },
    );
    if (!name?.trim()) return;
    setPresets([
      ...presets,
      { name: name.trim(), description: null, values: {} },
    ]);
    setExpandedPreset(presets.length);
    setTab("presets");
  }

  async function deletePreset(i: number) {
    const ok = await dialog.confirm(
      `¿Eliminar la respuesta "${presets[i].name}"?`,
      { variant: "danger", ok: "Eliminar" },
    );
    if (!ok) return;
    setPresets(presets.filter((_, j) => j !== i));
    if (expandedPreset === i) setExpandedPreset(null);
  }

  function updatePresetValue(
    pIdx: number,
    paramName: string,
    value: ParamValueJson | null,
  ) {
    const arr = [...presets];
    const values = { ...arr[pIdx].values };
    if (value == null || (typeof value === "string" && value === "")) {
      delete values[paramName];
    } else {
      values[paramName] = value;
    }
    arr[pIdx] = { ...arr[pIdx], values };
    setPresets(arr);
  }

  /** Toggle: si el parámetro está en values, lo saca; si no, lo agrega
   *  con un valor neutral según el kind. */
  function togglePresetParam(pIdx: number, param: ParamSpec) {
    const arr = [...presets];
    const values = { ...arr[pIdx].values };
    if (param.name in values) {
      delete values[param.name];
    } else {
      values[param.name] = isListKind(param.kind) ? [] : "";
    }
    arr[pIdx] = { ...arr[pIdx], values };
    setPresets(arr);
  }

  return (
    <div className="bg-panel border border-surface rounded-xl">
      {/* Tabs */}
      <div className="flex border-b border-surface">
        <TabBtn
          active={tab === "parameters"}
          onClick={() => setTab("parameters")}
          label={`Parámetros · ${parameters.length}`}
        />
        <TabBtn
          active={tab === "presets"}
          onClick={() => setTab("presets")}
          label={`Respuestas guardadas · ${presets.length}`}
        />
      </div>

      {/* Tab: Parámetros */}
      {tab === "parameters" && (
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-dim">
              Declará las variables que vas a usar en tus consultas como{" "}
              <code>:NombreDelParametro</code>.
            </p>
            <button
              onClick={addParam}
              className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface-2"
            >
              + Nuevo parámetro
            </button>
          </div>

          {parameters.length === 0 ? (
            <div className="text-xs text-dim">Sin parámetros.</div>
          ) : (
            <div className="space-y-1.5">
              {parameters.map((p, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_140px_2fr_30px] gap-2 items-center bg-surface-2 border border-surface rounded p-2"
                >
                  <input
                    value={p.name}
                    onChange={(e) => updateParam(i, { name: e.target.value })}
                    placeholder="Nombre (ej. FechaDesde)"
                    className="milhouse-field text-sm font-mono"
                  />
                  <select
                    value={p.kind}
                    onChange={(e) =>
                      updateParam(i, { kind: e.target.value as ParamKind })
                    }
                    className="milhouse-field text-sm"
                  >
                    {Object.entries(KIND_LABEL).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={p.label ?? ""}
                    onChange={(e) =>
                      updateParam(i, { label: e.target.value || null })
                    }
                    placeholder="Etiqueta visible (opcional)"
                    className="milhouse-field text-sm"
                  />
                  <button
                    onClick={() => deleteParam(i)}
                    className="text-red-400 text-xs"
                    title="Eliminar"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Respuestas */}
      {tab === "presets" && (
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-dim">
              Cada respuesta guarda valores para uno o varios parámetros. Una
              respuesta puede contestar <strong>algunos</strong> de los
              parámetros (no todos). Al ejecutar, podés combinar varias.
            </p>
            <button
              onClick={addPreset}
              disabled={parameters.length === 0}
              className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface-2 disabled:opacity-50"
              title={
                parameters.length === 0
                  ? "Primero declará al menos un parámetro"
                  : ""
              }
            >
              + Nueva respuesta
            </button>
          </div>

          {parameters.length === 0 && (
            <div className="text-xs text-dim">
              Declará parámetros primero en la pestaña "Parámetros".
            </div>
          )}

          {parameters.length > 0 && presets.length === 0 && (
            <div className="text-xs text-dim">
              Sin respuestas todavía. Ejemplos: "Year to Date" setea
              FechaDesde y FechaHasta, "Lista clientes A" setea solo
              Comitente.
            </div>
          )}

          {presets.map((pr, i) => {
            const answeredCount = parameters.filter(
              (p) => p.name in pr.values,
            ).length;
            return (
              <div
                key={i}
                className="bg-surface-2 border border-surface rounded p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 flex items-center gap-2">
                    <button
                      onClick={() =>
                        setExpandedPreset(expandedPreset === i ? null : i)
                      }
                      className="text-dim"
                    >
                      {expandedPreset === i ? "▾" : "▸"}
                    </button>
                    <input
                      value={pr.name}
                      onChange={(e) => {
                        const arr = [...presets];
                        arr[i] = { ...arr[i], name: e.target.value };
                        setPresets(arr);
                      }}
                      className="milhouse-field text-sm font-semibold flex-1"
                    />
                    <span
                      className="text-[11px] text-dim whitespace-nowrap"
                      title="Cuántos parámetros del proyecto responde esta respuesta"
                    >
                      {answeredCount} / {parameters.length} parámetro
                      {parameters.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <button
                    onClick={() => deletePreset(i)}
                    className="text-red-400 text-xs"
                  >
                    ✕
                  </button>
                </div>
                {expandedPreset === i && (
                  <div className="mt-2 space-y-2 pl-5">
                    <input
                      value={pr.description ?? ""}
                      onChange={(e) => {
                        const arr = [...presets];
                        arr[i] = {
                          ...arr[i],
                          description: e.target.value || null,
                        };
                        setPresets(arr);
                      }}
                      placeholder="Descripción (opcional)"
                      className="milhouse-field text-xs w-full"
                    />
                    <p className="text-[11px] text-dim">
                      Tildá los parámetros que esta respuesta responde. Los
                      que queden sin tildar quedan vacíos en la respuesta —
                      los va a tener que completar otra respuesta o el
                      usuario al ejecutar.
                    </p>
                    {parameters.map((p) => {
                      const included = p.name in pr.values;
                      return (
                        <div
                          key={p.name}
                          className={`border rounded p-2 ${
                            included
                              ? "border-cyan-700 bg-cyan-500/5"
                              : "border-surface bg-surface"
                          }`}
                        >
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={included}
                              onChange={() => togglePresetParam(i, p)}
                            />
                            <code className="text-xs font-mono">
                              {p.name}
                            </code>
                            {p.label && (
                              <span className="text-[10px] text-dim">
                                {p.label}
                              </span>
                            )}
                            <span className="ml-auto text-[10px] text-dim">
                              {KIND_LABEL[p.kind]}
                            </span>
                          </label>
                          {included && (
                            <div className="mt-2">
                              <PresetParamRow
                                param={p}
                                value={pr.values[p.name]}
                                onChange={(v) =>
                                  updatePresetValue(i, p.name, v)
                                }
                                onLoadExcel={async (f) => {
                                  try {
                                    const r = await parseExcelForParam(f);
                                    updatePresetValue(i, p.name, r.values);
                                    await dialog.alert(
                                      `Cargué ${r.rows_total} valor(es) de "${r.sheet}".`,
                                      {
                                        title: "Excel cargado",
                                        variant: "info",
                                      },
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
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "px-4 py-2 text-sm border-b-2 transition-colors " +
        (active
          ? "font-semibold"
          : "border-transparent text-muted hover:text-app")
      }
      style={active ? { borderBottomColor: "var(--accent)" } : undefined}
    >
      {label}
    </button>
  );
}

function PresetParamRow({
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
  const list = isListKind(k);
  return (
    <div className="grid grid-cols-[1fr_140px] gap-2 items-start">
      <div>
        {k === "date" && (
          <input
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
            className="milhouse-field text-xs w-full"
          />
        )}
        {k === "number" && (
          <input
            type="number"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
            className="milhouse-field text-xs w-full font-mono"
          />
        )}
        {k === "text" && (
          <input
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
            className="milhouse-field text-xs w-full"
          />
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
                onChange(arr.length === 0 ? [] : arr);
              }}
              rows={3}
              placeholder="Un valor por línea (o separados por coma)"
              className="milhouse-field text-xs w-full font-mono"
            />
            <div className="text-[10px] text-dim mt-0.5">
              {Array.isArray(value) ? value.length : 0} valor(es)
            </div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1 pt-1">
        {list && (
          <label className="text-[11px] px-2 py-1 rounded milhouse-btn-secondary cursor-pointer text-center">
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
        )}
      </div>
    </div>
  );
}
