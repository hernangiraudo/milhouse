"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  API_BASE,
  cancelJob,
  createConfig,
  createJob,
  deletePreload,
  exportRunBundleUrl,
  getConfig,
  getPreloadStatus,
  importPreload,
  slugifyFilename,
  updateConfig,
  WS_BASE,
} from "@/lib/api";
import { StepEditor, type Step } from "./StepEditor";
import { MilhouseAIDialog } from "./MilhouseAIDialog";
import { DesignCanvas, type NodeStatus, type RunMode } from "./DesignCanvas";
import { useDialog } from "./Dialog";
import { useUser } from "@/lib/session";
import { LogsPanel } from "./LogsPanel";
import { SamplePanel } from "./SamplePanel";
import type { LogLine, TableSample } from "@/lib/types";
import { ParametersPanel } from "./ParametersPanel";
import { ParameterPromptDialog } from "./ParameterPromptDialog";

export type ParamKind =
  | "date"
  | "number"
  | "text"
  | "list_number"
  | "list_text";

export interface ParamSpec {
  name: string;
  kind: ParamKind;
  label?: string | null;
  description?: string | null;
}

export type ParamValueJson = string | string[];

export interface ParamPreset {
  name: string;
  description?: string | null;
  values: Record<string, ParamValueJson>;
}

type ProjectShape = {
  name: string;
  version?: number;
  groups?: Array<{
    name: string;
    description?: string | null;
    color?: string | null;
    parent_group?: string | null;
  }>;
  steps: Step[];
  parameters?: ParamSpec[];
  presets?: ParamPreset[];
  duckdb_path?: string | null;
  [k: string]: unknown;
};

/**
 * Editor del proyecto. Cubre crear (currentName=null, initial=null) y editar.
 */
export function DesignEditor({
  currentName,
}: {
  currentName: string | null;
}) {
  const router = useRouter();
  const dialog = useDialog();
  const user = useUser();
  const [cfg, setCfg] = useState<ProjectShape | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [dirty, setDirty] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [savingMsg, setSavingMsg] = useState<string | null>(null);

  // Estado de ejecución desde el lienzo
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  // Último job_id ejecutado para este proyecto (se mantiene aún después de
  // que el job termina, para que re-ejecutar un paso reuse el mismo run).
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  // Pasos del subset actual; cuando es null, la corrida es completa.
  // Mientras hay una corrida parcial activa, el reconciler sólo aplica
  // estados a estos pasos (para no sobrescribir los badges de los demás
  // con "skipped").
  const [activeSubset, setActiveSubset] = useState<Set<string> | null>(null);
  const [stepStates, setStepStates] = useState<Record<string, NodeStatus>>({});
  // Diálogo de respuesta a parámetros antes de ejecutar.
  const [paramPrompt, setParamPrompt] = useState<{
    params: ParamSpec[];
    onResolved: (vals: Record<string, ParamValueJson>) => Promise<void> | void;
  } | null>(null);
  const [stepLogs, setStepLogs] = useState<Record<string, LogLine[]>>({});
  const [stepSamples, setStepSamples] = useState<Record<string, TableSample>>(
    {},
  );
  const [execTab, setExecTab] = useState<"logs" | "sample">("logs");
  const [preloadInfo, setPreloadInfo] = useState<{
    has_preload: boolean;
    preloaded_step_ids: string[];
  }>({ has_preload: false, preloaded_step_ids: [] });

  useEffect(() => {
    if (!currentName) return;
    getPreloadStatus(currentName).then(setPreloadInfo).catch(() => {});
    // Cambiar de proyecto resetea el estado de ejecución.
    setLastJobId(null);
    setActiveJobId(null);
    setActiveSubset(null);
    setStepStates({});
    setStepLogs({});
    setStepSamples({});
  }, [currentName]);

  // Reconciliar stepStates desde el snapshot del job (en GET /api/jobs/:id).
  // El WS sólo recibe eventos posteriores a su conexión; pasos muy rápidos
  // pueden terminar antes y nunca llegar por ahí. Por eso pollemos el
  // snapshot también, hasta que el job termina.
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    async function pullSnapshot() {
      try {
        const r = await fetch(`${API_BASE}/api/jobs/${activeJobId}`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as {
          status: string;
          steps: Record<
            string,
            {
              state: { state: string } | string;
              logs?: LogLine[];
              sample?: TableSample | null;
            }
          >;
        };
        if (cancelled) return;
        const next: Record<string, NodeStatus> = {};
        const logsMerge: Record<string, LogLine[]> = {};
        const samplesMerge: Record<string, TableSample> = {};
        for (const [k, v] of Object.entries(j.steps)) {
          // Si hay subset activo, ignorar pasos fuera del subset (sus badges
          // previos deben preservarse).
          if (activeSubset && !activeSubset.has(k)) continue;
          const st = v.state;
          const s = typeof st === "string" ? st : st?.state ?? "idle";
          next[k] = s as NodeStatus;
          if (v.logs && v.logs.length > 0) logsMerge[k] = v.logs;
          if (v.sample) samplesMerge[k] = v.sample;
        }
        setStepStates((prev) => ({ ...prev, ...next }));
        setStepLogs((prev) => {
          // sólo overwrite si el snapshot trae más logs que lo que tenemos
          const out = { ...prev };
          for (const [k, ls] of Object.entries(logsMerge)) {
            if ((out[k]?.length ?? 0) < ls.length) out[k] = ls;
          }
          return out;
        });
        setStepSamples((prev) => ({ ...prev, ...samplesMerge }));
        if (j.status !== "running") setActiveJobId(null);
      } catch {
        /* ignore */
      }
    }
    // Fetch inicial inmediato + WS
    pullSnapshot();
    const ws = new WebSocket(`${WS_BASE}/api/jobs/${activeJobId}/ws`);
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data) as { type: string; [k: string]: unknown };
        const sid = m.step_id as string | undefined;
        const inSubset = !activeSubset || (sid != null && activeSubset.has(sid));
        if (m.type === "step_state_changed" && sid && inSubset) {
          const stRaw = m.state as { state: string } | string;
          const stName =
            typeof stRaw === "string" ? stRaw : stRaw?.state ?? "idle";
          setStepStates((p) => ({
            ...p,
            [sid]: stName as NodeStatus,
          }));
        } else if (m.type === "step_log" && sid && inSubset) {
          const line: LogLine = {
            at: new Date().toISOString(),
            level: (m.level as string) ?? "info",
            line: (m.line as string) ?? "",
          };
          setStepLogs((p) => ({ ...p, [sid]: [...(p[sid] ?? []), line] }));
        } else if (m.type === "step_completed" && sid && inSubset) {
          setStepStates((p) => ({ ...p, [sid]: "done" }));
          const sample = m.sample as TableSample | null | undefined;
          if (sample) {
            setStepSamples((p) => ({ ...p, [sid]: sample }));
          }
        } else if (m.type === "job_finished") {
          // Pull final por las dudas
          pullSnapshot();
          setActiveJobId(null);
        }
      } catch {
        /* ignore */
      }
    };
    // Poll de respaldo cada 1.5s mientras el job está activo
    const t = setInterval(pullSnapshot, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
      ws.close();
    };
  }, [activeJobId]);

  useEffect(() => {
    if (currentName == null) {
      setCfg({
        name: "Proyecto nuevo",
        version: 1,
        groups: [],
        steps: [],
      });
      setDirty(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    getConfig(currentName)
      .then((v) => {
        const c = v as ProjectShape;
        if (!Array.isArray(c.steps)) c.steps = [];
        setCfg(c);
        setDirty(false);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [currentName]);

  function applyChange(next: ProjectShape) {
    setCfg(next);
    setDirty(true);
  }

  const stepIds = useMemo(() => (cfg?.steps ?? []).map((s) => s.id), [cfg?.steps]);
  const groupNames = useMemo(() => {
    if (!cfg) return [];
    const set = new Set<string>();
    (cfg.groups ?? []).forEach((g) => g.name && set.add(g.name));
    cfg.steps.forEach((s) => s.group && set.add(s.group));
    return Array.from(set).sort();
  }, [cfg]);

  const [showAI, setShowAI] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  useEffect(() => {
    if (cfg && selectedIdx != null && selectedIdx >= cfg.steps.length) {
      setSelectedIdx(null);
    }
  }, [cfg, selectedIdx]);

  const existingTablesMap = useMemo(() => {
    if (!cfg) return {} as Record<string, string>;
    const m: Record<string, string> = {};
    for (const s of cfg.steps) {
      const out = (s as { output_table?: string }).output_table;
      if (out) m[s.id] = out;
    }
    return m;
  }, [cfg]);

  if (loading) {
    return <div className="text-muted">Cargando…</div>;
  }
  if (err) {
    return (
      <div className="text-red-400">
        {err}{" "}
        <button
          onClick={() => router.push("/")}
          className="text-accent underline"
        >
          Volver
        </button>
      </div>
    );
  }
  if (!cfg) return null;

  function updateProject<K extends keyof ProjectShape>(
    key: K,
    value: ProjectShape[K],
  ) {
    if (!cfg) return;
    applyChange({ ...cfg, [key]: value });
  }

  function addStepOfKind(kind: string, nearId?: string) {
    if (!cfg) return;
    const baseId = kind.replace(/[^a-z_]/g, "");
    let id = baseId;
    let n = 1;
    const existing = new Set(stepIds);
    while (existing.has(id)) {
      n += 1;
      id = `${baseId}_${n}`;
    }
    const depends_on = nearId ? [nearId] : [];
    const defaults: Record<string, Partial<Step>> = {
      sql_query: { query: "SELECT 1 AS dummy", output_table: id },
      sql_exec: { query: "CREATE TABLE IF NOT EXISTS tmp(x INT);" },
      join: {
        left: "",
        right: "",
        left_on: [""],
        right_on: [""],
        how: "inner",
        output_table: id,
      },
      lookup: {
        input: "",
        master: "",
        key: "",
        master_key: "",
        select: [],
        output_table: id,
      },
      transform: { input: "", operations: [], output_table: id },
      filter_and_subset: {
        input: "",
        filter: null,
        select: [],
        output_table: id,
      },
      sort: { input: "", by: [], output_table: id },
      procedural: {
        input: "",
        engine: "rhai",
        script: "row",
        state_init: {},
        output_table: id,
      },
      export: {
        input: "",
        target: { kind: "file", format: "csv", path: `data/exports/${id}.csv` },
      },
    };
    const newStep: Step = {
      id,
      kind,
      depends_on,
      ...(defaults[kind] ?? {}),
    } as Step;
    applyChange({ ...cfg, steps: [...cfg.steps, newStep] });
    setSelectedIdx(cfg.steps.length);
  }

  function addDependency(from: string, to: string) {
    if (!cfg || from === to) return;
    const target = cfg.steps.find((s) => s.id === to);
    if (!target) return;
    const deps = new Set(target.depends_on ?? []);
    if (deps.has(from)) return;
    if (createsCycle(cfg.steps, from, to)) {
      dialog.alert(
        `No se puede crear la dependencia ${from} → ${to}: causaría un ciclo.`,
        { variant: "danger", title: "Ciclo detectado" },
      );
      return;
    }
    deps.add(from);
    const steps = cfg.steps.map((s) =>
      s.id === to ? { ...s, depends_on: Array.from(deps) } : s,
    );
    applyChange({ ...cfg, steps });
  }

  function updateStep(idx: number, next: Step) {
    if (!cfg) return;
    const arr = [...cfg.steps];
    const oldId = arr[idx].id;
    arr[idx] = next;
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
    applyChange({ ...cfg, steps: arr });
  }

  function deleteStep(idx: number) {
    if (!cfg) return;
    const removedId = cfg.steps[idx].id;
    const arr = cfg.steps
      .filter((_, i) => i !== idx)
      .map((s) =>
        s.depends_on?.includes(removedId)
          ? { ...s, depends_on: s.depends_on.filter((d) => d !== removedId) }
          : s,
      );
    applyChange({ ...cfg, steps: arr });
    if (selectedIdx === idx) setSelectedIdx(null);
    else if (selectedIdx != null && selectedIdx > idx) setSelectedIdx(selectedIdx - 1);
  }

  async function addGroup() {
    if (!cfg) return;
    const name = await dialog.prompt("Nombre del grupo:", {
      title: "Nuevo grupo",
      placeholder: "p.ej. extracción",
    });
    if (!name?.trim()) return;
    const groups = [
      ...(cfg.groups ?? []),
      { name: name.trim(), description: null, color: null },
    ];
    applyChange({ ...cfg, groups });
  }
  async function deleteGroup(name: string) {
    if (!cfg) return;
    const ok = await dialog.confirm(
      `¿Eliminar el grupo "${name}"? Los pasos del grupo quedan sin asignar (no se eliminan).`,
      { title: "Eliminar grupo", variant: "warning", ok: "Eliminar grupo" },
    );
    if (!ok) return;
    const groups = (cfg.groups ?? []).filter((g) => g.name !== name);
    const steps = cfg.steps.map((s) =>
      s.group === name ? { ...s, group: null } : s,
    );
    applyChange({ ...cfg, groups, steps });
  }
  async function renameGroup(oldName: string) {
    if (!cfg) return;
    const newName = await dialog.prompt(`Nuevo nombre para "${oldName}":`, {
      title: "Renombrar grupo",
      defaultValue: oldName,
    });
    if (!newName || newName.trim() === oldName) return;
    const trimmed = newName.trim();
    if ((cfg.groups ?? []).some((g) => g.name === trimmed)) {
      await dialog.alert(`Ya existe un grupo "${trimmed}".`, { variant: "danger" });
      return;
    }
    const groups = (cfg.groups ?? []).map((g) =>
      g.name === oldName ? { ...g, name: trimmed } : g,
    );
    const steps = cfg.steps.map((s) =>
      s.group === oldName ? { ...s, group: trimmed } : s,
    );
    applyChange({ ...cfg, groups, steps });
  }

  /** Define (o limpia) el grupo padre de un grupo. Detecta ciclos. */
  function setGroupParent(name: string, parent: string | null) {
    if (!cfg) return;
    if (parent === name) return;
    const groups = cfg.groups ?? [];
    // Detección de ciclos: subir por la cadena de padres del candidato.
    if (parent) {
      let cursor: string | null = parent;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === name) {
          dialog.alert(
            `No se puede asignar "${parent}" como padre de "${name}": crearía un ciclo.`,
            { title: "Ciclo de grupos", variant: "danger" },
          );
          return;
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const g = groups.find((x) => x.name === cursor);
        cursor = g?.parent_group ?? null;
      }
    }
    const nextGroups = groups.map((g) =>
      g.name === name ? { ...g, parent_group: parent } : g,
    );
    applyChange({ ...cfg, groups: nextGroups });
  }

  /** Asigna un grupo a un conjunto de pasos por id. */
  function assignGroupTo(ids: string[], groupName: string) {
    if (!cfg) return;
    // Asegurar que el grupo existe en cfg.groups (sino agregarlo).
    const groups = cfg.groups ?? [];
    const groupsArr = groups.some((g) => g.name === groupName)
      ? groups
      : [...groups, { name: groupName, description: null, color: null }];
    const setIds = new Set(ids);
    const steps = cfg.steps.map((s) =>
      setIds.has(s.id) ? { ...s, group: groupName } : s,
    );
    applyChange({ ...cfg, groups: groupsArr, steps });
  }

  /** Quita la asignación de grupo a todos los pasos del grupo (sin borrar pasos). */
  function ungroupAll(name: string) {
    if (!cfg) return;
    const steps = cfg.steps.map((s) =>
      s.group === name ? { ...s, group: null } : s,
    );
    applyChange({ ...cfg, steps });
  }

  /** Marca/desmarca un grupo como colapsado (estado solo en cliente; no se persiste). */
  // (manejado dentro del canvas)

  /** Ejecuta el proyecto (todo o subset). Si hay cambios sin guardar, los
   *  guarda primero — sino el servidor leería una versión vieja del config. */
  async function runJobWithMode(mode: RunMode) {
    if (!cfg) return;
    if (activeJobId) {
      const ok = await dialog.confirm(
        "Ya hay una ejecución activa para este proyecto. ¿Iniciar otra de todas formas?",
        { title: "Ejecución en curso", variant: "warning", ok: "Sí, ejecutar" },
      );
      if (!ok) return;
    }
    let savedName = currentName;
    if (dirty || !currentName) {
      try {
        if (!cfg.name.trim()) throw new Error("Falta nombre del proyecto");
        if (currentName) {
          savedName = await updateConfig(
            currentName,
            cfg as Record<string, unknown>,
          );
        } else {
          const filename = await slugifyFilename(cfg.name);
          savedName = await createConfig(
            filename,
            cfg as Record<string, unknown>,
          );
          router.replace(`/design/${encodeURIComponent(savedName)}`);
        }
        setDirty(false);
      } catch (e) {
        await dialog.alert(`No se pudo guardar antes de ejecutar: ${e}`, {
          variant: "danger",
        });
        return;
      }
    }
    if (!savedName) return;
    let target: string[] | null = null;
    if (mode.kind === "single") {
      target = [mode.stepId];
    } else if (mode.kind === "upto") {
      target = Array.from(ancestorsInclusive(cfg.steps, mode.stepId));
    } else if (mode.kind === "from") {
      target = Array.from(descendantsInclusive(cfg.steps, mode.stepId));
    } else if (mode.kind === "group") {
      target = [...mode.stepIds];
    } else if (mode.kind === "group_upto") {
      const set = new Set<string>();
      for (const sid of mode.stepIds) {
        for (const a of ancestorsInclusive(cfg.steps, sid)) set.add(a);
      }
      target = Array.from(set);
    } else if (mode.kind === "group_from") {
      const set = new Set<string>();
      for (const sid of mode.stepIds) {
        for (const d of descendantsInclusive(cfg.steps, sid)) set.add(d);
      }
      target = Array.from(set);
    } else {
      target = null; // ejecutar todo
    }
    const isFullRun = target === null;
    // Pre-check: pasos SQL sin conexión definida.
    const stepsToRun = isFullRun
      ? cfg.steps.map((s) => s.id)
      : (target as string[]);
    const stepsToRunSet = new Set(stepsToRun);
    const missingConn: string[] = [];
    for (const s of cfg.steps) {
      if (!stepsToRunSet.has(s.id)) continue;
      if (s.kind !== "sql_query" && s.kind !== "sql_exec") continue;
      const c = (s as { connection?: string | null }).connection;
      if (!c || (typeof c === "string" && c.trim() === "")) {
        missingConn.push(s.id);
      }
    }
    if (missingConn.length > 0) {
      await dialog.alert(
        `Los siguientes pasos SQL no tienen conexión asignada y no se pueden ejecutar:\n\n  • ${missingConn.join("\n  • ")}\n\nAbrí cada paso y elegí una conexión antes de ejecutar.`,
        { title: "Falta conexión en pasos SQL", variant: "danger" },
      );
      return;
    }

    // ¿El proyecto declara parámetros usados por los steps a ejecutar?
    const declaredParams = cfg.parameters ?? [];
    const usedParamNames = new Set<string>();
    if (declaredParams.length > 0) {
      const declaredSet = new Set(declaredParams.map((p) => p.name));
      for (const s of cfg.steps) {
        if (!stepsToRunSet.has(s.id)) continue;
        const texts: string[] = [];
        if (s.kind === "sql_query" || s.kind === "sql_exec") {
          const q = (s as { query?: string }).query;
          if (q) texts.push(q);
        }
        if (s.kind === "filter_and_subset") {
          const f = (s as { filter?: string | null }).filter;
          if (f) texts.push(f);
        }
        for (const t of texts) {
          for (const name of scanParamRefs(t)) {
            if (declaredSet.has(name)) usedParamNames.add(name);
          }
        }
      }
    }

    const launch = async (resolvedParams: Record<string, ParamValueJson>) => {
      const reuseJobId = !isFullRun ? lastJobId : null;
      setActiveSubset(target ? new Set(target) : null);
      if (isFullRun) {
        setStepStates({});
        setStepLogs({});
        setStepSamples({});
      } else if (target) {
        const toClear = new Set(target);
        setStepStates((p) => {
          const out = { ...p };
          for (const id of toClear) delete out[id];
          return out;
        });
        setStepLogs((p) => {
          const out = { ...p };
          for (const id of toClear) delete out[id];
          return out;
        });
        setStepSamples((p) => {
          const out = { ...p };
          for (const id of toClear) delete out[id];
          return out;
        });
      }
      try {
        const { job_id } = await createJob(savedName as string, {
          user,
          debug: true,
          target_steps: target,
          stop_on_failure: true,
          use_preload: preloadInfo.has_preload,
          existing_job_id: reuseJobId,
          parameters: resolvedParams,
        });
        setActiveJobId(job_id);
        setLastJobId(job_id);
      } catch (e) {
        await dialog.alert(`Error al lanzar ejecución: ${e}`, {
          variant: "danger",
        });
      }
    };

    if (usedParamNames.size === 0) {
      await launch({});
      return;
    }
    // Abrir prompt de parámetros. Filtro la lista a los que usan los steps
    // a ejecutar — más limpio.
    const needed = declaredParams.filter((p) => usedParamNames.has(p.name));
    setParamPrompt({ params: needed, onResolved: launch });
  }

  async function onExportBundle() {
    if (!activeJobId) {
      // si no hay job activo, ofrecemos exportar el último job conocido vía
      // la URL del bundle. Como esto requiere job_id, lo desambiguamos
      // navegando a la sección de Revisión: por simplicidad acá solo
      // permitimos exportar el job activo o el último que se ejecutó en
      // esta misma sesión.
      await dialog.alert(
        "Ejecutá el proyecto primero (con debug habilitado) y luego podés exportar sus datasets.",
        { title: "Sin ejecución para exportar", variant: "info" },
      );
      return;
    }
    window.open(exportRunBundleUrl(activeJobId), "_blank");
  }

  async function onImportBundle(file: File) {
    if (!currentName) {
      await dialog.alert(
        "Guardá el proyecto antes de importar datasets para él.",
        { variant: "warning" },
      );
      return;
    }
    try {
      const r = await importPreload(currentName, file);
      const count = r.manifest.datasets.length;
      await dialog.alert(
        `Importado: ${count} dataset(s) precargado(s). Al ejecutar, esos pasos se omiten y sus tablas vienen del bundle.`,
        { title: "Bundle importado", variant: "info" },
      );
      const s = await getPreloadStatus(currentName);
      setPreloadInfo(s);
    } catch (e) {
      await dialog.alert(`No se pudo importar el bundle: ${e}`, {
        variant: "danger",
      });
    }
  }

  async function onClearPreload() {
    if (!currentName) return;
    const ok = await dialog.confirm(
      `¿Eliminar los datasets precargados para "${cfg?.name}"?`,
      { title: "Quitar preload", variant: "warning", ok: "Quitar" },
    );
    if (!ok) return;
    try {
      await deletePreload(currentName);
      setPreloadInfo({ has_preload: false, preloaded_step_ids: [] });
    } catch (e) {
      await dialog.alert(`Error al borrar preload: ${e}`, {
        variant: "danger",
      });
    }
  }

  async function onSave() {
    if (!cfg) return;
    setErr(null);
    setSavingMsg("Guardando…");
    try {
      if (!cfg.name.trim())
        throw new Error("El nombre del proyecto es obligatorio.");
      const ids = new Set<string>();
      for (const s of cfg.steps) {
        if (!s.id.trim()) throw new Error("Hay steps sin id.");
        if (ids.has(s.id)) throw new Error(`Step duplicado: ${s.id}`);
        ids.add(s.id);
      }
      let savedName: string;
      if (currentName) {
        savedName = await updateConfig(currentName, cfg as Record<string, unknown>);
      } else {
        const filename = await slugifyFilename(cfg.name);
        savedName = await createConfig(filename, cfg as Record<string, unknown>);
        // Si era nuevo, redirigir a la URL del proyecto creado.
        router.replace(`/design/${encodeURIComponent(savedName)}`);
        return;
      }
      setSavingMsg(`✓ Guardado como ${savedName}`);
      setTimeout(() => setSavingMsg(null), 3000);
      const fresh = (await getConfig(savedName)) as ProjectShape;
      setCfg(fresh);
      setDirty(false);
    } catch (e) {
      setErr(String(e));
      setSavingMsg(null);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              if (dirty) {
                const ok = await dialog.confirm(
                  "Hay cambios sin guardar. ¿Salir igualmente?",
                  { title: "Cambios sin guardar", variant: "warning", ok: "Salir" },
                );
                if (!ok) return;
              }
              router.push("/");
            }}
            className="text-sm px-3 py-1 rounded border border-surface-strong bg-surface-2"
          >
            ← Proyectos
          </button>
          <h2 className="font-semibold text-lg">
            {currentName ? "Editar proyecto" : "Nuevo proyecto"}
            {dirty && (
              <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-700">
                sin guardar
              </span>
            )}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {savingMsg && (
            <span className="text-xs text-emerald-300">{savingMsg}</span>
          )}
          <button
            onClick={onSave}
            className="text-sm font-semibold px-4 py-1.5 rounded"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
            }}
          >
            Guardar
          </button>
        </div>
      </header>

      <div className="grid grid-cols-[2fr_1fr] gap-3 bg-panel rounded-xl p-4 border border-surface">
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

      {/* Parámetros + respuestas guardadas */}
      <ParametersPanel
        parameters={cfg.parameters ?? []}
        presets={cfg.presets ?? []}
        onChange={(next) =>
          applyChange({
            ...cfg,
            parameters: next.parameters,
            presets: next.presets,
          })
        }
      />

      {/* Grupos */}
      <div className="bg-panel border border-surface rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs uppercase tracking-wider text-muted">
            Grupos · {(cfg.groups ?? []).length}
          </h4>
          <button
            onClick={addGroup}
            className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface-2"
          >
            + Nuevo grupo
          </button>
        </div>
        {(cfg.groups ?? []).length === 0 ? (
          <div className="text-xs text-dim">
            Tip: seleccioná varios pasos en el lienzo (Ctrl/Shift+click o drag
            en background) y click derecho → "Crear grupo".
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(cfg.groups ?? []).map((g) => (
              <div
                key={g.name}
                className="flex items-center gap-2 px-2 py-1 rounded border border-surface-strong bg-surface text-sm"
              >
                <code className="font-mono">{g.name}</code>
                <select
                  value={g.parent_group ?? ""}
                  onChange={(e) => setGroupParent(g.name, e.target.value || null)}
                  className="milhouse-field text-[10px] py-0 px-1"
                  title="Grupo padre (anidamiento)"
                >
                  <option value="">(sin padre)</option>
                  {(cfg.groups ?? [])
                    .filter((x) => x.name !== g.name)
                    .map((x) => (
                      <option key={x.name} value={x.name}>
                        ↰ {x.name}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => renameGroup(g.name)}
                  className="text-dim text-xs"
                  title="Renombrar"
                >
                  ✎
                </button>
                <button
                  onClick={() => ungroupAll(g.name)}
                  className="text-dim text-xs"
                  title="Quitar grupo a sus pasos (sin eliminarlos)"
                >
                  ⏏
                </button>
                <button
                  onClick={() => deleteGroup(g.name)}
                  className="text-red-400 text-xs"
                  title="Eliminar grupo"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Canvas */}
      <div className="bg-panel border border-surface rounded-xl p-3">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h4 className="text-xs uppercase tracking-wider text-muted">
            Lienzo · {cfg.steps.length} paso{cfg.steps.length === 1 ? "" : "s"}
          </h4>
          <div className="flex gap-2 text-xs text-dim items-center flex-wrap">
            <span>
              Click derecho: crear · Ctrl/Shift+click: multi · Drag puerto:
              conectar
            </span>
            <button
              onClick={() => setShowAI(true)}
              className="text-xs px-3 py-1 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 ml-2"
            >
              ✨ Milhouse-AI
            </button>
          </div>
        </div>

        {/* Toolbar de ejecución / bundle */}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2 p-2 rounded bg-surface-2 border border-surface">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => runJobWithMode({ kind: "all" })}
              disabled={cfg.steps.length === 0 || activeJobId != null}
              className="text-xs font-semibold px-3 py-1 rounded disabled:opacity-50"
              style={{
                background: "var(--accent)",
                color: "var(--accent-ink)",
              }}
            >
              {activeJobId ? "Ejecutando…" : "▶ Ejecutar todo"}
            </button>
            {activeJobId && (
              <>
                <button
                  onClick={async () => {
                    if (!activeJobId) return;
                    try {
                      await cancelJob(activeJobId);
                    } catch (e) {
                      await dialog.alert(`No se pudo cancelar: ${e}`, {
                        variant: "danger",
                      });
                    }
                  }}
                  className="text-xs px-2 py-1 rounded border border-red-700 bg-red-500/20 text-red-300"
                  title="Cancela el job: el paso en ejecución recibe la señal de interrupción y los pendientes quedan como Cancelled"
                >
                  ⏹ Cancelar
                </button>
                <span className="text-[11px] text-emerald-400">
                  job activo: {activeJobId.slice(0, 8)}
                </span>
              </>
            )}
            <span className="text-[11px] text-dim">
              · Tip: click derecho sobre un paso para opciones parciales
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={onExportBundle}
              disabled={!activeJobId}
              className="text-xs px-3 py-1 rounded border border-surface-strong bg-surface disabled:opacity-50"
              title="Descarga zip con los datasets persistidos de la última ejecución"
            >
              ⬇ Exportar bundle
            </button>
            <label className="text-xs px-3 py-1 rounded border border-surface-strong bg-surface cursor-pointer">
              ⬆ Importar bundle…
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImportBundle(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>

        {preloadInfo.has_preload && (
          <div className="mb-2 px-3 py-2 rounded text-xs border border-cyan-700 bg-cyan-500/10 text-cyan-300 flex items-center justify-between flex-wrap gap-2">
            <span>
              📦 Bundle precargado: <code className="font-mono">
                {preloadInfo.preloaded_step_ids.length}
              </code>{" "}
              paso(s) van a omitirse y usar los datos del bundle al ejecutar.
            </span>
            <button
              onClick={onClearPreload}
              className="text-[11px] underline"
            >
              quitar
            </button>
          </div>
        )}

        <DesignCanvas
          project={cfg}
          selectedStepIds={
            selectedIdx != null ? [cfg.steps[selectedIdx]?.id ?? ""] : []
          }
          onSelectionChange={(ids) => {
            if (ids.length === 0) {
              setSelectedIdx(null);
              return;
            }
            const last = ids[ids.length - 1];
            const idx = cfg.steps.findIndex((s) => s.id === last);
            setSelectedIdx(idx >= 0 ? idx : null);
          }}
          onAddStep={(kind, near) => addStepOfKind(kind, near)}
          onAddDependency={addDependency}
          onDeleteStep={(id) => {
            const idx = cfg.steps.findIndex((s) => s.id === id);
            if (idx >= 0) deleteStep(idx);
          }}
          onOpenAI={() => setShowAI(true)}
          onCreateGroupFromSelection={async (ids) => {
            const name = await dialog.prompt(
              `Nombre del grupo para ${ids.length} paso(s):`,
              {
                title: "Crear grupo",
                defaultValue: `grupo_${(cfg.groups ?? []).length + 1}`,
              },
            );
            if (!name?.trim()) return;
            assignGroupTo(ids, name.trim());
          }}
          onUngroup={(name) => ungroupAll(name)}
          onDeleteGroup={(name) => deleteGroup(name)}
          stepStates={stepStates}
          onRun={runJobWithMode}
          onCancelJob={
            activeJobId
              ? async () => {
                  try {
                    await cancelJob(activeJobId);
                  } catch (e) {
                    await dialog.alert(`No se pudo cancelar: ${e}`, {
                      variant: "danger",
                    });
                  }
                }
              : undefined
          }
        />
      </div>

      {/* Panel de ejecución del step seleccionado (logs + sample) */}
      {selectedIdx != null &&
        cfg.steps[selectedIdx] &&
        (stepLogs[cfg.steps[selectedIdx].id]?.length ||
          stepSamples[cfg.steps[selectedIdx].id]) && (
          <div className="bg-panel border border-surface rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs uppercase tracking-wider text-muted">
                Ejecución · {cfg.steps[selectedIdx].id}
              </h4>
              <div className="flex gap-1 text-xs">
                <button
                  onClick={() => setExecTab("logs")}
                  className={`px-2 py-0.5 rounded ${
                    execTab === "logs"
                      ? "bg-surface-strong"
                      : "border border-surface-strong bg-surface"
                  }`}
                >
                  Logs ({stepLogs[cfg.steps[selectedIdx].id]?.length ?? 0})
                </button>
                <button
                  onClick={() => setExecTab("sample")}
                  className={`px-2 py-0.5 rounded ${
                    execTab === "sample"
                      ? "bg-surface-strong"
                      : "border border-surface-strong bg-surface"
                  }`}
                >
                  Datos de salida
                  {stepSamples[cfg.steps[selectedIdx].id]
                    ? ` (${stepSamples[cfg.steps[selectedIdx].id].sampled_rows.toLocaleString()} filas)`
                    : ""}
                </button>
              </div>
            </div>
            {execTab === "logs" ? (
              <LogsPanel logs={stepLogs[cfg.steps[selectedIdx].id] ?? []} />
            ) : (
              <SamplePanel
                sample={stepSamples[cfg.steps[selectedIdx].id] ?? null}
              />
            )}
          </div>
        )}

      {/* Editor del step seleccionado */}
      {selectedIdx != null && cfg.steps[selectedIdx] && (
        <div className="bg-panel border border-surface rounded-xl p-3">
          <StepEditor
            step={cfg.steps[selectedIdx]}
            allStepIds={stepIds}
            allGroups={groupNames}
            availableTables={cfg.steps
              .filter(
                (p) =>
                  p.id !== cfg.steps[selectedIdx!].id &&
                  (p as { output_table?: string }).output_table,
              )
              .map((p) => ({
                step_id: p.id,
                output_table: (p as { output_table?: string }).output_table!,
              }))}
            onChange={(next) => updateStep(selectedIdx, next)}
            onDelete={() => deleteStep(selectedIdx)}
          />
        </div>
      )}

      {paramPrompt && (
        <ParameterPromptDialog
          parameters={paramPrompt.params}
          presets={cfg.presets ?? []}
          onCancel={() => setParamPrompt(null)}
          onResolved={async (vals) => {
            const cb = paramPrompt.onResolved;
            setParamPrompt(null);
            await cb(vals);
          }}
        />
      )}

      {showAI && (
        <MilhouseAIDialog
          existingStepIds={stepIds}
          existingTables={existingTablesMap}
          onClose={() => setShowAI(false)}
          onApply={(generatedStep) => {
            const newStep = generatedStep as Step;
            const existing = new Set(stepIds);
            let id = newStep.id || "ai_step";
            let n = 1;
            while (existing.has(id)) {
              n += 1;
              id = `${newStep.id || "ai_step"}_${n}`;
            }
            applyChange({
              ...cfg,
              steps: [...cfg.steps, { ...newStep, id }],
            });
            setShowAI(false);
          }}
        />
      )}
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

/** Devuelve los nombres referenciados como `:nombre` en un texto. Ignora
 *  `::` (casts) y referencias dentro de strings/comentarios. Igual semántica
 *  que la del backend. */
function scanParamRefs(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  let inSingle = false,
    inDouble = false,
    inLine = false,
    inBlock = false;
  while (i < n) {
    const c = text[i];
    const nx = text[i + 1] ?? "";
    if (inLine) {
      if (c === "\n") inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && nx === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inSingle) {
      if (c === "'") {
        if (nx === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (c === "-" && nx === "-") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && nx === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === ":" && /[A-Za-z_]/.test(nx)) {
      if (i > 0 && text[i - 1] === ":") {
        i++;
        continue;
      }
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_]/.test(text[end])) end++;
      out.push(text.slice(i + 1, end));
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

function ancestorsInclusive(steps: Step[], target: string): Set<string> {
  const deps = new Map<string, string[]>();
  for (const s of steps) deps.set(s.id, s.depends_on ?? []);
  const out = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    for (const d of deps.get(n) ?? []) {
      if (!out.has(d)) stack.push(d);
    }
  }
  return out;
}

function descendantsInclusive(steps: Step[], target: string): Set<string> {
  const succ = new Map<string, string[]>();
  for (const s of steps) succ.set(s.id, []);
  for (const s of steps)
    for (const d of s.depends_on ?? []) {
      succ.get(d)?.push(s.id);
    }
  const out = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    for (const c of succ.get(n) ?? []) {
      if (!out.has(c)) stack.push(c);
    }
  }
  return out;
}

function createsCycle(steps: Step[], from: string, to: string): boolean {
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  function reaches(id: string, target: string): boolean {
    if (id === target) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const s = stepById.get(id);
    for (const d of s?.depends_on ?? []) {
      if (reaches(d, target)) return true;
    }
    return false;
  }
  return reaches(from, to);
}
