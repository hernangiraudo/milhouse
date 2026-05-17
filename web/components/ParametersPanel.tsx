"use client";

import { useState } from "react";
import { useDialog } from "./Dialog";
import { parseExcelForParam } from "@/lib/api";
import type {
  ParamCategory,
  ParamKind,
  ParamPreset,
  ParamSpec,
  ParamValueJson,
} from "./DesignEditor";
import { ExcelImportDialog } from "./ExcelImportDialog";

const KIND_LABEL: Record<ParamKind, string> = {
  date: "Fecha",
  number: "Número",
  text: "Texto",
  boolean: "Sí/No",
  list_number: "Lista de números",
  list_text: "Lista de textos",
};

// Kinds que aparecen en el selector del editor. Las listas siguen
// soportadas en el motor por compat con configs viejos — si un param
// ya tiene kind=list_*, el select lo preserva via "current value".
const KIND_OPTIONS: ParamKind[] = ["date", "number", "text", "boolean"];

const CATEGORY_LABEL: Record<ParamCategory, string> = {
  dates: "Fechas",
  comitentes: "Comitentes",
  abreviaturas: "Abreviaturas",
  execution: "Ejecución",
  other: "Otros",
};

const CATEGORY_ORDER: ParamCategory[] = [
  "dates",
  "comitentes",
  "abreviaturas",
  "execution",
  "other",
];

function getCategory(p: ParamSpec): ParamCategory {
  return p.category ?? "other";
}

function isListKind(k: ParamKind): boolean {
  return k === "list_number" || k === "list_text";
}

export interface PresetGroup {
  name: string;
  description?: string | null;
  preset_names: string[];
}

type Tab = "parameters" | "presets" | "groups";

export function ParametersPanel({
  parameters,
  presets,
  presetGroups,
  onChange,
  onChangeGroups,
}: {
  parameters: ParamSpec[];
  presets: ParamPreset[];
  /** Grupos de respuestas. Si se pasa, aparece el tab "Grupos". */
  presetGroups?: PresetGroup[];
  onChange: (next: { parameters: ParamSpec[]; presets: ParamPreset[] }) => void;
  onChangeGroups?: (next: PresetGroup[]) => void;
}) {
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("parameters");
  const [expandedPreset, setExpandedPreset] = useState<number | null>(null);
  // Categorías colapsadas en el tab Parámetros. Arrancan expandidas
  // (set vacío) para que el editor se vea sin click extra; el usuario
  // colapsa lo que no le interesa.
  const [collapsedCategories, setCollapsedCategories] = useState<
    Set<ParamCategory>
  >(new Set());
  // Switch para mostrar/ocultar el selector de "kind" (tipo de dato)
  // en cada fila. Default off — pocos usuarios necesitan cambiar el
  // tipo después de crear el param.
  const [showKindEditor, setShowKindEditor] = useState(false);
  // Switch separado para el selector de "categoría" (Fechas, Comitentes,
  // Abreviaturas, Ejecución, Otros). Default off para mantener la fila
  // limpia; el usuario lo prende para reclasificar parámetros.
  const [showCategoryEditor, setShowCategoryEditor] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null);
  const showGroupsTab = presetGroups != null && onChangeGroups != null;

  function setParams(next: ParamSpec[]) {
    onChange({ parameters: next, presets });
  }
  function setPresets(next: ParamPreset[]) {
    onChange({ parameters, presets: next });
  }
  function setGroups(next: PresetGroup[]) {
    onChangeGroups?.(next);
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

  // Estado del asistente de Excel: cuando hay file pendiente, mostramos
  // el modal. El parametroDestino se pidió antes de abrir el modal.
  const [excelImport, setExcelImport] = useState<{
    file: File;
    targetParam: string;
    targetKind: ParamKind;
  } | null>(null);
  // Selector de "a qué parámetro aplicar la respuesta importada". Se
  // abre primero (ANTES del asistente de Excel) cuando el usuario elige
  // un archivo desde el botón "Importar Excel".
  const [excelTargetPicker, setExcelTargetPicker] = useState<{
    file: File;
    candidates: ParamSpec[];
    /** Selección actual del select. Pre-seleccionada con el primer
     *  candidato; el usuario puede cambiarla antes de continuar. */
    selectedName: string;
  } | null>(null);

  // Parámetros que admiten importar listas:
  //  - `number`: el motor splittea "1,2,3" como lista al sustituir.
  //  - Legacy `list_number` / `list_text`: siguen funcionando si existen.
  function isImportTarget(p: ParamSpec): boolean {
    return p.kind === "number" || isListKind(p.kind);
  }

  async function startExcelImport(file: File) {
    const candidates = parameters.filter(isImportTarget);
    if (candidates.length === 0) {
      await dialog.alert(
        "Necesitás al menos un parámetro tipo Número para importar valores. Creá uno y volvé a intentar.",
        { variant: "warning" },
      );
      return;
    }
    // Siempre mostramos el selector — el usuario confirma a qué
    // parámetro va aunque haya uno solo. Consistencia + menos sorpresas.
    setExcelTargetPicker({
      file,
      candidates,
      selectedName: candidates[0].name,
    });
  }

  async function finishExcelImport(
    values: string[],
    descriptionTable: string[][],
  ) {
    if (!excelImport) return;
    const { file, targetParam, targetKind } = excelImport;
    const presetName = await dialog.prompt(
      `Nombre para la respuesta:`,
      {
        title: "Guardar respuesta importada",
        placeholder: "ej. Comitentes activos · 2026-Q1",
        defaultValue: file.name.replace(/\.xlsx?$/i, ""),
        validate: (v) => {
          const t = v.trim();
          if (!t) return "obligatorio";
          if (presets.some((p) => p.name === t))
            return "ya existe una respuesta con ese nombre";
          return null;
        },
      },
    );
    if (!presetName?.trim()) {
      setExcelImport(null);
      return;
    }
    // Serialización del valor según el kind del destino:
    //  - number: lo guardamos como string "1,2,3" — el motor lo expande.
    //  - list_*: array nativo.
    const stored: ParamValueJson =
      targetKind === "number" ? values.join(", ") : values;
    const newPreset: ParamPreset = {
      name: presetName.trim(),
      description: `Importado de ${file.name} (${values.length} valor${values.length === 1 ? "" : "es"})`,
      values: { [targetParam]: stored },
      description_table:
        descriptionTable.length > 0 ? descriptionTable : undefined,
    };
    setPresets([...presets, newPreset]);
    setTab("presets");
    setExpandedPreset(presets.length);
    setExcelImport(null);
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
        {showGroupsTab && (
          <TabBtn
            active={tab === "groups"}
            onClick={() => setTab("groups")}
            label={`Grupos de respuestas · ${presetGroups!.length}`}
          />
        )}
      </div>

      {/* Tab: Parámetros */}
      {tab === "parameters" && (
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-dim">
              Declará las variables que vas a usar en tus consultas como{" "}
              <code>:NombreDelParametro</code>.
            </p>
            <div className="flex items-center gap-3">
              <label
                className="flex items-center gap-1.5 text-[11px] text-dim cursor-pointer select-none"
                title="Mostrar el selector de tipo de dato (Fecha/Número/Texto/Sí-No) en cada fila"
              >
                <input
                  type="checkbox"
                  checked={showKindEditor}
                  onChange={(e) => setShowKindEditor(e.target.checked)}
                />
                <span>Tipo de Datos</span>
              </label>
              <label
                className="flex items-center gap-1.5 text-[11px] text-dim cursor-pointer select-none"
                title="Mostrar el selector de categoría (Fechas/Comitentes/Abreviaturas/Ejecución/Otros) en cada fila"
              >
                <input
                  type="checkbox"
                  checked={showCategoryEditor}
                  onChange={(e) => setShowCategoryEditor(e.target.checked)}
                />
                <span>Tipo de Parámetro</span>
              </label>
              <button
                onClick={addParam}
                className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface-2"
              >
                + Nuevo parámetro
              </button>
            </div>
          </div>

          {parameters.length === 0 ? (
            <div className="text-xs text-dim">Sin parámetros.</div>
          ) : (
            (() => {
              // Agrupar por categoría preservando el índice original
              // (necesario para updateParam/deleteParam).
              const groups: Record<
                ParamCategory,
                Array<{ p: ParamSpec; idx: number }>
              > = {
                dates: [],
                comitentes: [],
                abreviaturas: [],
                execution: [],
                other: [],
              };
              parameters.forEach((p, idx) => {
                groups[getCategory(p)].push({ p, idx });
              });
              return (
                <div className="space-y-3">
                  {CATEGORY_ORDER.filter(
                    (cat) => groups[cat].length > 0,
                  ).map((cat) => {
                    const isCollapsed = collapsedCategories.has(cat);
                    const dotColor =
                      cat === "dates"
                        ? "#22d3ee"
                        : cat === "comitentes"
                          ? "#a855f7"
                          : cat === "abreviaturas"
                            ? "#f59e0b"
                            : cat === "execution"
                              ? "#10b981"
                              : "#64748b";
                    return (
                    <div key={cat}>
                      <button
                        type="button"
                        onClick={() => {
                          setCollapsedCategories((prev) => {
                            const next = new Set(prev);
                            if (next.has(cat)) next.delete(cat);
                            else next.add(cat);
                            return next;
                          });
                        }}
                        className="w-full text-[10px] uppercase tracking-wider text-dim mb-1 flex items-center gap-2 hover:text-app text-left"
                        title={isCollapsed ? "Expandir" : "Colapsar"}
                      >
                        <span className="text-[11px]">
                          {isCollapsed ? "▸" : "▾"}
                        </span>
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full"
                          style={{ background: dotColor }}
                          aria-hidden
                        />
                        {CATEGORY_LABEL[cat]} · {groups[cat].length}
                      </button>
                      {!isCollapsed && (
                      <div className="space-y-1.5">
                        {groups[cat].map(({ p, idx }) => (
                          <div
                            key={idx}
                            className="bg-surface-2 border border-surface rounded p-2 space-y-1.5"
                          >
                            <div
                              className={`grid gap-2 items-center ${
                                showKindEditor && showCategoryEditor
                                  ? "grid-cols-[1fr_120px_120px_2fr_30px]"
                                  : showKindEditor || showCategoryEditor
                                    ? "grid-cols-[1fr_120px_2fr_30px]"
                                    : "grid-cols-[1fr_2fr_30px]"
                              }`}
                            >
                              <input
                                value={p.name}
                                onChange={(e) =>
                                  updateParam(idx, { name: e.target.value })
                                }
                                placeholder="Nombre (ej. FechaDesde)"
                                className="milhouse-field text-sm font-mono"
                              />
                              {showKindEditor && (
                                <select
                                  value={p.kind}
                                  onChange={(e) =>
                                    updateParam(idx, {
                                      kind: e.target.value as ParamKind,
                                    })
                                  }
                                  className="milhouse-field text-sm"
                                >
                                  {KIND_OPTIONS.map((k) => (
                                    <option key={k} value={k}>
                                      {KIND_LABEL[k]}
                                    </option>
                                  ))}
                                  {/* Si el param ya tiene un kind legacy
                                     (list_*), lo preservamos en el select
                                     para no perderlo sin querer al editar. */}
                                  {!KIND_OPTIONS.includes(p.kind) && (
                                    <option value={p.kind}>
                                      {KIND_LABEL[p.kind]} (legacy)
                                    </option>
                                  )}
                                </select>
                              )}
                              {showCategoryEditor && (
                                <select
                                  value={getCategory(p)}
                                  onChange={(e) =>
                                    updateParam(idx, {
                                      category: e.target.value as ParamCategory,
                                    })
                                  }
                                  className="milhouse-field text-sm"
                                  title="Categoría visual (agrupa el parámetro en la UI)"
                                >
                                  {CATEGORY_ORDER.map((c) => (
                                    <option key={c} value={c}>
                                      {CATEGORY_LABEL[c]}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <input
                                value={p.label ?? ""}
                                onChange={(e) =>
                                  updateParam(idx, {
                                    label: e.target.value || null,
                                  })
                                }
                                placeholder="Etiqueta visible (opcional)"
                                className="milhouse-field text-sm"
                              />
                              <button
                                onClick={() => deleteParam(idx)}
                                className="text-red-400 text-xs"
                                title="Eliminar"
                              >
                                ✕
                              </button>
                            </div>
                            <div className="grid grid-cols-[110px_1fr] gap-2 items-center">
                              <span
                                className="text-[10px] uppercase tracking-wider text-dim text-right pr-1"
                                title="Valor por default si nadie responde el parámetro al ejecutar"
                              >
                                Default
                              </span>
                              <ParamDefaultEditor
                                param={p}
                                value={p.default ?? undefined}
                                onChange={(next) =>
                                  updateParam(idx, { default: next })
                                }
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              );
            })()
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
            <div className="flex items-center gap-1">
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
              {parameters.some(isImportTarget) && (
                <label
                  className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface-2 cursor-pointer"
                  title="Importar lista de valores desde Excel y guardarla como nueva respuesta"
                >
                  📂 Importar Excel
                  <input
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      await startExcelImport(f);
                    }}
                  />
                </label>
              )}
            </div>
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
                    {pr.description_table && pr.description_table.length > 1 && (
                      <details className="text-xs">
                        <summary className="text-dim cursor-pointer hover:text-app">
                          📋 Tabla descriptiva importada ·{" "}
                          {pr.description_table.length - 1} fila(s)
                        </summary>
                        <div className="mt-1 overflow-auto max-h-48 border border-surface rounded">
                          <table className="milhouse-data-table text-[11px]">
                            <thead>
                              <tr>
                                {pr.description_table[0].map((h, ci) => (
                                  <th
                                    key={ci}
                                    className="px-2 py-1 text-left font-mono"
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {pr.description_table.slice(1).map((row, ri) => (
                                <tr key={ri}>
                                  {row.map((cell, ci) => (
                                    <td
                                      key={ci}
                                      className="px-2 py-1 font-mono whitespace-nowrap"
                                    >
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
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

      {/* Tab: Grupos de respuestas */}
      {showGroupsTab && tab === "groups" && (
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-dim">
              Un <strong>grupo de respuestas</strong> agrupa varias respuestas
              guardadas. Al ejecutar, elegir el grupo aplica todas sus
              respuestas de una. Si dos respuestas del grupo responden el
              mismo parámetro, gana la última en la lista.
            </p>
            <button
              onClick={async () => {
                const name = await dialog.prompt("Nombre del grupo:", {
                  title: "Nuevo grupo de respuestas",
                  validate: (v) => {
                    const t = v.trim();
                    if (!t) return "obligatorio";
                    if (presetGroups!.some((g) => g.name === t))
                      return "ya existe un grupo con ese nombre";
                    return null;
                  },
                });
                if (!name?.trim()) return;
                setGroups([
                  ...presetGroups!,
                  { name: name.trim(), preset_names: [] },
                ]);
                setExpandedGroup(presetGroups!.length);
              }}
              className="text-xs px-2 py-1 rounded milhouse-btn-secondary"
            >
              + Nuevo grupo
            </button>
          </div>
          {presetGroups!.length === 0 ? (
            <div className="text-sm text-dim">
              No hay grupos definidos. Click "+ Nuevo grupo" para crear uno.
            </div>
          ) : (
            presetGroups!.map((g, gIdx) => {
              const expanded = expandedGroup === gIdx;
              const memberSet = new Set(g.preset_names);
              return (
                <div
                  key={g.name + gIdx}
                  className="bg-surface-2 border border-surface rounded p-3"
                >
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <button
                      onClick={() => setExpandedGroup(expanded ? null : gIdx)}
                      className="flex items-center gap-2 text-left flex-1 min-w-0"
                    >
                      <span className="text-dim">{expanded ? "▾" : "▸"}</span>
                      <code className="font-mono font-semibold truncate">
                        {g.name}
                      </code>
                      <span className="text-[11px] text-dim">
                        · {g.preset_names.length} / {presets.length}{" "}
                        respuesta(s)
                      </span>
                    </button>
                    <button
                      onClick={async () => {
                        const ok = await dialog.confirm(
                          `¿Eliminar el grupo "${g.name}"?`,
                          {
                            title: "Eliminar grupo",
                            variant: "warning",
                            ok: "Eliminar",
                          },
                        );
                        if (!ok) return;
                        setGroups(
                          presetGroups!.filter((_, i) => i !== gIdx),
                        );
                        if (expandedGroup === gIdx) setExpandedGroup(null);
                      }}
                      className="text-xs text-red-400 hover:text-red-200"
                      title="Eliminar grupo"
                    >
                      🗑
                    </button>
                  </div>
                  {expanded && (
                    <div className="mt-3 space-y-2">
                      <label className="block">
                        <span className="text-[10px] uppercase tracking-wider text-dim block mb-0.5">
                          Descripción
                        </span>
                        <input
                          value={g.description ?? ""}
                          onChange={(e) => {
                            const next = [...presetGroups!];
                            next[gIdx] = {
                              ...g,
                              description: e.target.value || null,
                            };
                            setGroups(next);
                          }}
                          className="w-full milhouse-field text-xs"
                          placeholder="opcional"
                        />
                      </label>
                      <div>
                        <div className="text-[11px] uppercase tracking-wider text-dim mb-1">
                          Respuestas incluidas
                        </div>
                        {presets.length === 0 ? (
                          <div className="text-xs text-dim">
                            No hay respuestas guardadas. Creá algunas en el
                            tab "Respuestas guardadas".
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {presets.map((pr) => {
                              const checked = memberSet.has(pr.name);
                              return (
                                <label
                                  key={pr.name}
                                  className="flex items-start gap-2 text-sm cursor-pointer text-app p-1 rounded hover:bg-surface"
                                  title={pr.description ?? ""}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      const next = [...presetGroups!];
                                      const updated = checked
                                        ? g.preset_names.filter(
                                            (n) => n !== pr.name,
                                          )
                                        : [...g.preset_names, pr.name];
                                      next[gIdx] = {
                                        ...g,
                                        preset_names: updated,
                                      };
                                      setGroups(next);
                                    }}
                                    className="mt-0.5 shrink-0"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <code className="font-mono text-xs">
                                      {pr.name}
                                    </code>
                                    {pr.description && (
                                      <div className="text-[11px] text-dim leading-snug mt-0.5">
                                        {pr.description}
                                      </div>
                                    )}
                                    {!pr.description && (
                                      <div className="text-[10px] text-dim italic mt-0.5">
                                        (sin descripción) — agregá una al
                                        editar la respuesta
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      {g.preset_names.length > 1 && (
                        <p className="text-[11px] text-dim">
                          Aplica en orden: <code className="font-mono">
                            {g.preset_names.join(" → ")}
                          </code>. La última gana por colisión.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {excelTargetPicker && (
        <div
          className="fixed inset-0 z-[68] flex items-center justify-center p-6"
          style={{
            background: "rgba(0,0,0,0.45)",
            backdropFilter: "blur(2px)",
          }}
          onClick={() => setExcelTargetPicker(null)}
        >
          <div
            className="bg-surface border border-surface-strong rounded-xl p-5 w-full max-w-md space-y-3"
            style={{ boxShadow: "var(--shadow)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-app">
              📂 ¿A qué parámetro aplicar la respuesta?
            </h3>
            <p className="text-xs text-muted">
              Vas a importar valores desde{" "}
              <code className="font-mono">{excelTargetPicker.file.name}</code>.
              Elegí el parámetro destino — los valores van a quedar como
              respuesta de ese parámetro al ejecutar.
            </p>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
                Parámetro destino
              </span>
              <select
                value={excelTargetPicker.selectedName}
                onChange={(e) =>
                  setExcelTargetPicker({
                    ...excelTargetPicker,
                    selectedName: e.target.value,
                  })
                }
                className="w-full milhouse-field"
                autoFocus
              >
                {excelTargetPicker.candidates.map((p) => {
                  const cat = p.category ?? "other";
                  const catLabel =
                    cat in CATEGORY_LABEL
                      ? CATEGORY_LABEL[cat as ParamCategory]
                      : cat;
                  return (
                    <option key={p.name} value={p.name}>
                      {p.name} ({catLabel} · {KIND_LABEL[p.kind]})
                      {p.label ? ` — ${p.label}` : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2 border-t border-surface">
              <button
                onClick={() => setExcelTargetPicker(null)}
                className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  const sel = excelTargetPicker.candidates.find(
                    (p) => p.name === excelTargetPicker.selectedName,
                  );
                  if (!sel) return;
                  setExcelImport({
                    file: excelTargetPicker.file,
                    targetParam: sel.name,
                    targetKind: sel.kind,
                  });
                  setExcelTargetPicker(null);
                }}
                className="text-sm font-semibold px-3 py-1.5 rounded"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-ink)",
                }}
              >
                Continuar
              </button>
            </div>
          </div>
        </div>
      )}

      {excelImport && (
        <ExcelImportDialog
          file={excelImport.file}
          onCancel={() => setExcelImport(null)}
          onResolved={({ values, descriptionTable }) =>
            finishExcelImport(values, descriptionTable)
          }
        />
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
                // Al perder el foco: si hay separadores, normalizamos
                // a "id1, id2, id3" (con espacios) para facilitar lectura.
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
              className="milhouse-field text-xs w-full font-mono"
            />
            <p className="text-[10px] text-dim">
              Un ID, o varios separados por coma o punto y coma. Solo
              enteros (los IDs no llevan decimales).
            </p>
          </div>
        )}
        {k === "text" && (
          <input
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
            className="milhouse-field text-xs w-full"
          />
        )}
        {k === "boolean" && (
          <select
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
            className="milhouse-field text-xs w-full"
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

/**
 * Editor del valor "default" de la definición del parámetro. Para
 * kind=date soporta toggle entre fecha fija (date picker) y expresión
 * dinámica (`today`, `today - 20d`, `start_of_month`, etc), con preview
 * del valor resuelto contra el día actual.
 */
function ParamDefaultEditor({
  param,
  value,
  onChange,
}: {
  param: ParamSpec;
  value: ParamValueJson | undefined;
  onChange: (v: ParamValueJson | null) => void;
}) {
  const k = param.kind;
  if (k === "date") {
    return (
      <DateOrDynamicInput
        value={typeof value === "string" ? value : ""}
        onChange={(s) => onChange(s || null)}
      />
    );
  }
  if (k === "number") {
    return (
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
        className="milhouse-field text-sm w-full font-mono"
        placeholder="(sin default; ej. 101 ó 101, 102)"
      />
    );
  }
  if (k === "text") {
    return (
      <input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="milhouse-field text-sm w-full"
        placeholder="(sin default)"
      />
    );
  }
  if (k === "boolean") {
    return (
      <select
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="milhouse-field text-sm w-full"
      >
        <option value="">(sin default)</option>
        <option value="1">Sí</option>
        <option value="0">No</option>
      </select>
    );
  }
  // list_number / list_text
  return (
    <textarea
      value={Array.isArray(value) ? value.join("\n") : ""}
      onChange={(e) => {
        const arr = e.target.value
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        onChange(arr.length === 0 ? null : arr);
      }}
      rows={2}
      placeholder="Un valor por línea (opcional, default)"
      className="milhouse-field text-xs w-full font-mono"
    />
  );
}

/**
 * Input para kind=date que permite alternar entre:
 *   - fecha fija (date picker → "YYYY-MM-DD")
 *   - expresión dinámica (`today`, `yesterday`, `today - 20d`, etc).
 *
 * Cuando es dinámica, debajo del input se muestra el valor resuelto
 * contra el día de hoy.
 */
export function DateOrDynamicInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const isDyn = !looksLikeIsoDate(value);
  const [mode, setMode] = useState<"fixed" | "dynamic">(
    isDyn && value ? "dynamic" : "fixed",
  );
  return (
    <div className="space-y-1">
      <div className="flex items-stretch gap-1">
        <div className="flex border border-surface-strong rounded overflow-hidden text-[10px]">
          <button
            type="button"
            onClick={() => setMode("fixed")}
            className={`px-2 ${mode === "fixed" ? "bg-accent-token font-semibold" : "bg-surface"}`}
            title="Fecha fija"
          >
            📅 Fija
          </button>
          <button
            type="button"
            onClick={() => setMode("dynamic")}
            className={`px-2 ${mode === "dynamic" ? "bg-accent-token font-semibold" : "bg-surface"}`}
            title="Expresión dinámica (ej. today, today - 20d, start_of_month)"
          >
            ⏱ Dinámica
          </button>
        </div>
        {mode === "fixed" ? (
          <input
            type="date"
            value={looksLikeIsoDate(value) ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className="milhouse-field text-sm flex-1"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="today, today - 20d, start_of_month, ..."
            className="milhouse-field text-xs font-mono flex-1"
          />
        )}
      </div>
      {mode === "dynamic" && value.trim() && (
        <div className="text-[10px] text-dim ml-1">
          {(() => {
            const resolved = previewDynamicDate(value);
            return resolved
              ? `→ resuelve a ${resolved} (hoy)`
              : `⚠ no se pudo resolver — chequeá la sintaxis`;
          })()}
        </div>
      )}
    </div>
  );
}

function looksLikeIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Resuelve una expresión dinámica de fecha contra hoy. Espejado del
 * parser de `src/engine/dyn_dates.rs`. Devuelve "YYYY-MM-DD" o null.
 */
export function previewDynamicDate(s: string): string | null {
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return null;
  const today = new Date();
  // Buscar `+` o `-` como separador (no el primer carácter).
  let opIdx = -1;
  for (let i = 1; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "+" || c === "-") {
      opIdx = i;
      break;
    }
  }
  const tokenStr = (opIdx < 0 ? trimmed : trimmed.slice(0, opIdx)).trim();
  const base = resolveToken(tokenStr, today);
  if (!base) return null;
  if (opIdx < 0) return fmt(base);
  const op = trimmed[opIdx];
  const rest = trimmed.slice(opIdx + 1).trim();
  const amount = parseAmount(rest);
  if (!amount) return null;
  const signed = op === "-" ? -amount.n : amount.n;
  const next = applyAmount(base, signed, amount.unit);
  return next ? fmt(next) : null;
}

function resolveToken(token: string, today: Date): Date | null {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (token) {
    case "today":
    case "hoy":
      return new Date(y, m, today.getDate());
    case "yesterday":
    case "ayer":
      return new Date(y, m, today.getDate() - 1);
    case "tomorrow":
    case "manana":
    case "mañana":
      return new Date(y, m, today.getDate() + 1);
    case "start_of_month":
    case "inicio_de_mes":
    case "inicio_mes":
      return new Date(y, m, 1);
    case "end_of_month":
    case "fin_de_mes":
    case "fin_mes":
      return new Date(y, m + 1, 0);
    case "start_of_year":
    case "inicio_de_anio":
    case "inicio_anio":
      return new Date(y, 0, 1);
    case "end_of_year":
    case "fin_de_anio":
    case "fin_anio":
      return new Date(y, 11, 31);
    default:
      return null;
  }
}

function parseAmount(
  s: string,
): { n: number; unit: "d" | "m" | "y" } | null {
  const trimmed = s.trim().replace(/s$/, "");
  const last = trimmed.slice(-1);
  let num: string;
  let unit: "d" | "m" | "y";
  if (/[a-z]/.test(last)) {
    if (last !== "d" && last !== "m" && last !== "y") return null;
    unit = last;
    num = trimmed.slice(0, -1).trim();
  } else {
    unit = "d";
    num = trimmed;
  }
  const n = parseInt(num, 10);
  if (!Number.isFinite(n)) return null;
  return { n, unit };
}

function applyAmount(
  base: Date,
  n: number,
  unit: "d" | "m" | "y",
): Date | null {
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  if (unit === "d") return new Date(y, m, d + n);
  if (unit === "m") {
    const target = new Date(y, m + n, d);
    // Si el día no existe en el mes destino (ej. 31 -> feb), JS hace
    // overflow al mes siguiente. Forzamos último día del mes destino.
    if (target.getMonth() !== ((m + n) % 12 + 12) % 12) {
      return new Date(y, m + n + 1, 0);
    }
    return target;
  }
  return new Date(y + n, m, d);
}

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
