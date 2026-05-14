"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createConfig,
  deleteConfig,
  getConfig,
  listConfigs,
  slugifyFilename,
  updateConfig,
} from "@/lib/api";
import type { ConfigSummary } from "@/lib/types";
import { StepEditor, type Step } from "./StepEditor";

type EditorState = {
  // null para "crear nuevo"; string si estoy editando uno existente.
  currentName: string | null;
  config: ProjectShape;
  // Dirty: flag local para indicar cambios sin guardar.
  dirty: boolean;
};

type ProjectShape = {
  name: string;
  version?: number;
  groups?: Array<{ name: string; description?: string | null; color?: string | null }>;
  steps: Step[];
  duckdb_path?: string | null;
  [k: string]: unknown;
};

export function DesignPanel() {
  const [list, setList] = useState<ConfigSummary[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savingMsg, setSavingMsg] = useState<string | null>(null);

  async function reload() {
    try {
      const c = await listConfigs();
      setList(c);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  useEffect(() => {
    reload();
  }, []);

  async function openExisting(name: string) {
    try {
      const cfg = (await getConfig(name)) as ProjectShape;
      if (!Array.isArray(cfg.steps)) cfg.steps = [];
      setEditor({ currentName: name, config: cfg, dirty: false });
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  function openNew() {
    setEditor({
      currentName: null,
      config: {
        name: "Proyecto nuevo",
        version: 1,
        groups: [],
        steps: [],
      },
      dirty: true,
    });
    setErr(null);
  }

  async function onDelete(name: string, displayName: string) {
    if (
      !confirm(
        `¿Eliminar el proyecto "${displayName}"?\nSe borra el archivo ${name}.`,
      )
    )
      return;
    try {
      await deleteConfig(name);
      await reload();
      if (editor?.currentName === name) setEditor(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onDuplicate(c: ConfigSummary) {
    try {
      const cfg = (await getConfig(c.name)) as ProjectShape;
      const dupName = `${c.display_name} (copia)`;
      const filename = await slugifyFilename(dupName);
      // Limpiar uids: el server los re-asigna al crear.
      const cleaned: ProjectShape = {
        ...cfg,
        name: dupName,
        steps: cfg.steps.map((s) => {
          const { step_uid, ...rest } = s as Step & { step_uid?: number };
          return rest;
        }),
      };
      await createConfig(filename, cleaned as Record<string, unknown>);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onSave() {
    if (!editor) return;
    setErr(null);
    setSavingMsg("Guardando…");
    try {
      const cfg = editor.config;
      // Validaciones front mínimas.
      if (!cfg.name.trim()) throw new Error("El nombre del proyecto es obligatorio.");
      const ids = new Set<string>();
      for (const s of cfg.steps) {
        if (!s.id.trim()) throw new Error("Hay steps sin id.");
        if (ids.has(s.id)) throw new Error(`Step duplicado: ${s.id}`);
        ids.add(s.id);
      }
      let savedName: string;
      if (editor.currentName) {
        savedName = await updateConfig(
          editor.currentName,
          cfg as Record<string, unknown>,
        );
      } else {
        const filename = await slugifyFilename(cfg.name);
        savedName = await createConfig(filename, cfg as Record<string, unknown>);
      }
      setSavingMsg(`✓ Guardado como ${savedName}`);
      setTimeout(() => setSavingMsg(null), 3000);
      // Refrescar config desde el server para tomar los step_uids asignados.
      const fresh = (await getConfig(savedName)) as ProjectShape;
      setEditor({ currentName: savedName, config: fresh, dirty: false });
      await reload();
    } catch (e) {
      setErr(String(e));
      setSavingMsg(null);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-lg">Diseño de proyectos</h2>
          <p className="text-sm text-muted">
            Crear, editar y eliminar definiciones ETL. Cada proyecto vive como
            un JSON en <code>configs/</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openNew}
            className="text-sm font-semibold px-3 py-1 rounded"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            + Nuevo proyecto
          </button>
        </div>
      </header>

      {err && <div className="text-red-400 text-sm">{err}</div>}

      <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
        <header className="px-4 py-2 bg-panel2 text-xs uppercase tracking-wider text-muted">
          Proyectos · {list.length}
        </header>
        <table className="w-full text-sm">
          <thead className="text-muted">
            <tr>
              <th className="text-left px-3 py-2">Nombre</th>
              <th className="text-left px-3 py-2">Archivo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-dim text-center">
                  No hay proyectos. Creá uno con "+ Nuevo".
                </td>
              </tr>
            )}
            {list.map((c) => (
              <tr
                key={c.name}
                className={`border-t border-surface cursor-pointer ${
                  editor?.currentName === c.name ? "bg-cyan-500/10" : "hover:bg-slate-800/30"
                }`}
                onClick={() => openExisting(c.name)}
              >
                <td className="px-3 py-2">{c.display_name}</td>
                <td className="px-3 py-2 font-mono text-xs text-dim">
                  {c.name}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicate(c);
                    }}
                    className="text-xs text-accent hover:underline mr-3"
                  >
                    Duplicar
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c.name, c.display_name);
                    }}
                    className="text-xs text-red-400 hover:underline"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editor && (
        <EditorView
          state={editor}
          onChange={(next) =>
            setEditor({
              ...editor,
              config: next,
              dirty: true,
            })
          }
          onClose={() => setEditor(null)}
          onSave={onSave}
          savingMsg={savingMsg}
        />
      )}
    </section>
  );
}

function EditorView({
  state,
  onChange,
  onClose,
  onSave,
  savingMsg,
}: {
  state: EditorState;
  onChange: (next: ProjectShape) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  savingMsg: string | null;
}) {
  const cfg = state.config;
  const stepIds = useMemo(() => cfg.steps.map((s) => s.id), [cfg.steps]);
  const groupNames = useMemo(() => {
    const set = new Set<string>();
    (cfg.groups ?? []).forEach((g) => g.name && set.add(g.name));
    cfg.steps.forEach((s) => s.group && set.add(s.group));
    return Array.from(set).sort();
  }, [cfg.groups, cfg.steps]);

  function updateProject<K extends keyof ProjectShape>(
    key: K,
    value: ProjectShape[K],
  ) {
    onChange({ ...cfg, [key]: value });
  }

  function addStep() {
    const baseId = `step_${cfg.steps.length + 1}`;
    let id = baseId;
    let n = 1;
    const existing = new Set(stepIds);
    while (existing.has(id)) {
      n += 1;
      id = `${baseId}_${n}`;
    }
    const newStep: Step = {
      id,
      kind: "sql_query",
      depends_on: [],
      query: "SELECT 1 AS dummy",
      output_table: "out",
    };
    onChange({ ...cfg, steps: [...cfg.steps, newStep] });
  }

  function updateStep(idx: number, next: Step) {
    const arr = [...cfg.steps];
    const oldId = arr[idx].id;
    arr[idx] = next;
    // Si cambió el id, actualizar referencias en depends_on de otros pasos.
    if (oldId !== next.id) {
      for (let i = 0; i < arr.length; i++) {
        if (i === idx) continue;
        if (arr[i].depends_on?.includes(oldId)) {
          arr[i] = {
            ...arr[i],
            depends_on: arr[i].depends_on!.map((d) =>
              d === oldId ? next.id : d,
            ),
          };
        }
      }
    }
    onChange({ ...cfg, steps: arr });
  }

  function deleteStep(idx: number) {
    if (!confirm(`¿Eliminar el step "${cfg.steps[idx].id}"?`)) return;
    const removedId = cfg.steps[idx].id;
    const arr = cfg.steps
      .filter((_, i) => i !== idx)
      .map((s) =>
        s.depends_on?.includes(removedId)
          ? { ...s, depends_on: s.depends_on.filter((d) => d !== removedId) }
          : s,
      );
    onChange({ ...cfg, steps: arr });
  }

  function moveStep(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= cfg.steps.length) return;
    const arr = [...cfg.steps];
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    onChange({ ...cfg, steps: arr });
  }

  function addGroup() {
    const name = prompt("Nombre del grupo:");
    if (!name) return;
    const groups = [
      ...(cfg.groups ?? []),
      { name: name.trim(), description: null, color: null },
    ];
    onChange({ ...cfg, groups });
  }

  function deleteGroup(name: string) {
    if (!confirm(`Eliminar el grupo "${name}"? Los pasos del grupo quedan sin asignar.`))
      return;
    const groups = (cfg.groups ?? []).filter((g) => g.name !== name);
    const steps = cfg.steps.map((s) =>
      s.group === name ? { ...s, group: null } : s,
    );
    onChange({ ...cfg, groups, steps });
  }

  return (
    <div className="bg-panel border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="font-semibold text-lg">
          {state.currentName ? "Editar proyecto" : "Nuevo proyecto"}
          {state.dirty && (
            <span
              className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-700"
            >
              sin guardar
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {savingMsg && (
            <span className="text-xs text-emerald-300">{savingMsg}</span>
          )}
          <button
            onClick={onClose}
            className="text-xs px-3 py-1 rounded border border-surface-strong bg-surface-2"
          >
            Cerrar
          </button>
          <button
            onClick={onSave}
            className="text-xs font-semibold px-3 py-1 rounded"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            Guardar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <Field label="Nombre legible del proyecto">
          <input
            value={cfg.name}
            onChange={(e) => updateProject("name", e.target.value)}
            className="w-full milhouse-field"
          />
        </Field>
        <Field label="Versión">
          <input
            type="number"
            value={cfg.version ?? 1}
            onChange={(e) =>
              updateProject("version", Number(e.target.value) || 1)
            }
            className="w-full milhouse-field"
          />
        </Field>
      </div>

      {/* Grupos */}
      <div className="bg-surface-2 border border-surface rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs uppercase tracking-wider text-muted">
            Grupos · {(cfg.groups ?? []).length}
          </h4>
          <button
            onClick={addGroup}
            className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
          >
            + Nuevo grupo
          </button>
        </div>
        {(cfg.groups ?? []).length === 0 ? (
          <div className="text-xs text-dim">
            Los grupos son opcionales. Sirven para agrupar pasos relacionados
            en la vista DAG y Kanban.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(cfg.groups ?? []).map((g) => (
              <div
                key={g.name}
                className="flex items-center gap-2 px-2 py-1 rounded border border-surface-strong bg-surface text-sm"
              >
                <code className="font-mono">{g.name}</code>
                <button
                  onClick={() => deleteGroup(g.name)}
                  className="text-red-400 text-xs hover:text-red-200"
                  title="Eliminar grupo"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs uppercase tracking-wider text-muted">
            Pasos · {cfg.steps.length}
          </h4>
          <button
            onClick={addStep}
            className="text-xs font-semibold px-3 py-1 rounded"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            + Paso
          </button>
        </div>
        {cfg.steps.length === 0 && (
          <div className="text-sm text-dim py-6 text-center bg-surface-2 rounded-lg border border-surface">
            El proyecto no tiene pasos todavía. Click "+ Paso" para agregar uno.
          </div>
        )}
        {cfg.steps.map((s, i) => (
          <div key={`${i}-${s.id}`} className="relative">
            <div className="absolute left-[-24px] top-2 flex flex-col gap-0.5">
              <button
                onClick={() => moveStep(i, -1)}
                disabled={i === 0}
                className="text-xs text-dim hover:text-app disabled:opacity-20"
                title="Mover arriba"
              >
                ▲
              </button>
              <button
                onClick={() => moveStep(i, 1)}
                disabled={i === cfg.steps.length - 1}
                className="text-xs text-dim hover:text-app disabled:opacity-20"
                title="Mover abajo"
              >
                ▼
              </button>
            </div>
            <StepEditor
              step={s}
              allStepIds={stepIds}
              allGroups={groupNames}
              onChange={(next) => updateStep(i, next)}
              onDelete={() => deleteStep(i)}
            />
          </div>
        ))}
      </div>
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
