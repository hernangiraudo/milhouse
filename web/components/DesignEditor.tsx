"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  API_BASE,
  cancelJob,
  cancelStep,
  createConfig,
  createJob,
  drainJob,
  datasetPreview,
  deletePreload,
  exportRunBundleUrl,
  getConfig,
  getPreloadStatus,
  importPreload,
  slugifyFilename,
  updateConfig,
  WS_BASE,
  type DatasetPreview,
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
import { RunQueuePanel } from "./RunQueuePanel";
import { ParameterPromptDialog } from "./ParameterPromptDialog";
import { ApiExposurePanel } from "./ApiExposurePanel";

export type ParamKind =
  | "date"
  | "number"
  | "text"
  | "boolean"
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

export interface ProjectApiConfig {
  exposed?: boolean;
  token?: string | null;
  export_datasets?: string[];
  accept_parameters?: boolean;
}

export interface ProjectSettings {
  /** Cantidad máxima de pasos en paralelo. null/undefined = sin límite. */
  max_parallel_steps?: number | null;
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
  /** Nombres de parámetros globales que aplican a este proyecto.
   *  Solo los listados se mergean al ejecutar. */
  selected_global_params?: string[];
  /** Respuestas por default que pre-rellenan el prompt de ejecución. */
  run_defaults?: Record<string, ParamValueJson>;
  api?: ProjectApiConfig;
  settings?: ProjectSettings;
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
  // step_id → step_uid del último run (para abrir preview de tablas).
  const [lastRunStepUids, setLastRunStepUids] = useState<Record<string, number>>(
    {},
  );
  // Pasos del subset actual; cuando es null, la corrida es completa.
  // Mientras hay una corrida parcial activa, el reconciler sólo aplica
  // estados a estos pasos (para no sobrescribir los badges de los demás
  // con "skipped").
  const [activeSubset, setActiveSubset] = useState<Set<string> | null>(null);
  const [stepStates, setStepStates] = useState<Record<string, NodeStatus>>({});
  // Diálogo de respuesta a parámetros antes de ejecutar.
  const [paramPrompt, setParamPrompt] = useState<{
    params: ParamSpec[];
    defaultRunName: string;
    onResolved: (args: {
      values: Record<string, ParamValueJson>;
      runName: string | null;
    }) => Promise<void> | void;
  } | null>(null);
  const [stepLogs, setStepLogs] = useState<Record<string, LogLine[]>>({});
  const [stepSamples, setStepSamples] = useState<Record<string, TableSample>>(
    {},
  );
  // step_id → sesión SQL Server activa. Se llena cuando llega un evento
  // step_sql_session y se limpia al terminal del step. Permite mostrar
  // el SPID en la cola y cancelar Running con KILL.
  const [stepSessions, setStepSessions] = useState<
    Record<string, { connection: string; sid: number }>
  >({});
  // Métricas por step para la cola (running clock + done stats). Las
  // poblamos desde WS events y desde el snapshot poll.
  const [stepStats, setStepStats] = useState<
    Record<
      string,
      {
        startedAtMs?: number; // performance.now() al recibir Running
        durationMs?: number; // viene en step_completed o snapshot Done
        rowCount?: number;
      }
    >
  >({});
  const [execTab, setExecTab] = useState<"logs" | "sample">("logs");
  // "Propiedades del proyecto": grupos / parámetros / API. Colapsable.
  const [propsOpen, setPropsOpen] = useState(false);
  // Panel "Respuestas / propiedades de ejecución": editor de defaults de
  // los parámetros del proyecto (locales + globales seleccionados).
  const [runDefaultsOpen, setRunDefaultsOpen] = useState(false);
  // Vista del lienzo: "nodes" (solo pasos) | "nodes_and_tables" (pasos +
  // ícono de tabla a la salida de cada uno).
  const [canvasView, setCanvasView] = useState<"nodes" | "nodes_and_tables">(
    "nodes",
  );
  // Tabla abierta desde el ícono de salida del nodo (modal con preview).
  const [openedTable, setOpenedTable] = useState<{
    stepId: string;
    stepUid: number;
    name: string;
  } | null>(null);
  const [openedTablePreview, setOpenedTablePreview] = useState<
    DatasetPreview | null
  >(null);
  const [openedTableErr, setOpenedTableErr] = useState<string | null>(null);
  // Globales: parámetros + respuestas compartidas entre proyectos. Se
  // cargan al montar y se usan para mergear con los locales en runtime.
  const [globalParams, setGlobalParams] = useState<{
    parameters: ParamSpec[];
    presets: ParamPreset[];
    preset_groups: Array<{
      name: string;
      description?: string | null;
      preset_names: string[];
    }>;
  }>({ parameters: [], presets: [], preset_groups: [] });
  useEffect(() => {
    fetch(`${API_BASE}/api/parameters`, { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : { parameters: [], presets: [], preset_groups: [] },
      )
      .then((j) =>
        setGlobalParams({
          parameters: j.parameters ?? [],
          presets: j.presets ?? [],
          preset_groups: j.preset_groups ?? [],
        }),
      )
      .catch(() => {});
  }, []);
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
              state:
                | { state: string; duration_ms?: number; row_count?: number; started_at?: string }
                | string;
              logs?: LogLine[];
              sample?: TableSample | null;
              sql_session?: { connection: string; sid: number } | null;
            }
          >;
        };
        if (cancelled) return;
        const next: Record<string, NodeStatus> = {};
        const logsMerge: Record<string, LogLine[]> = {};
        const samplesMerge: Record<string, TableSample> = {};
        const sessionsMerge: Record<
          string,
          { connection: string; sid: number } | null
        > = {};
        const statsMerge: Record<
          string,
          { startedAtMs?: number; durationMs?: number; rowCount?: number }
        > = {};
        for (const [k, v] of Object.entries(j.steps)) {
          // Si hay subset activo, ignorar pasos fuera del subset (sus badges
          // previos deben preservarse).
          if (activeSubset && !activeSubset.has(k)) continue;
          const st = v.state;
          const s = typeof st === "string" ? st : st?.state ?? "idle";
          next[k] = s as NodeStatus;
          if (v.logs && v.logs.length > 0) logsMerge[k] = v.logs;
          if (v.sample) samplesMerge[k] = v.sample;
          sessionsMerge[k] = v.sql_session ?? null;
          if (typeof st === "object" && st) {
            const out: {
              startedAtMs?: number;
              durationMs?: number;
              rowCount?: number;
            } = {};
            if (typeof st.duration_ms === "number") out.durationMs = st.duration_ms;
            if (typeof st.row_count === "number") out.rowCount = st.row_count;
            if (typeof st.started_at === "string") {
              const parsed = Date.parse(st.started_at);
              if (Number.isFinite(parsed)) {
                // Convertimos a ref "performance.now()" estimando el offset:
                // performance.now() es relativo al navload; usamos
                // Date.now() para alinear.
                out.startedAtMs = parsed - Date.now() + performance.now();
              }
            }
            if (Object.keys(out).length > 0) statsMerge[k] = out;
          }
        }
        setStepStates((prev) => ({ ...prev, ...next }));
        setStepSessions((prev) => {
          const out = { ...prev };
          for (const [k, v] of Object.entries(sessionsMerge)) {
            if (v) out[k] = v;
            else delete out[k];
          }
          return out;
        });
        setStepStats((prev) => {
          const out = { ...prev };
          for (const [k, v] of Object.entries(statsMerge)) {
            out[k] = { ...out[k], ...v };
          }
          return out;
        });
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
          // Si arrancó: marcar inicio para el clock de running.
          if (stName === "running") {
            setStepStats((p) => ({
              ...p,
              [sid]: { ...(p[sid] ?? {}), startedAtMs: performance.now() },
            }));
          }
          // Si pasó a terminal, limpiamos la sesión SQL asociada — el
          // SPID ya no aplica (lo cancelaron, falló o terminó).
          if (
            stName === "done" ||
            stName === "failed" ||
            stName === "cancelled" ||
            stName === "skipped"
          ) {
            setStepSessions((p) => {
              if (!(sid in p)) return p;
              const out = { ...p };
              delete out[sid];
              return out;
            });
          }
        } else if (m.type === "step_log" && sid && inSubset) {
          const line: LogLine = {
            at: new Date().toISOString(),
            level: (m.level as string) ?? "info",
            line: (m.line as string) ?? "",
          };
          setStepLogs((p) => ({ ...p, [sid]: [...(p[sid] ?? []), line] }));
        } else if (m.type === "step_sql_session" && sid && inSubset) {
          const connection = m.connection as string | undefined;
          const ssid = m.sid as number | undefined;
          if (connection && typeof ssid === "number") {
            setStepSessions((p) => ({
              ...p,
              [sid]: { connection, sid: ssid },
            }));
          }
        } else if (m.type === "step_completed" && sid && inSubset) {
          setStepStates((p) => ({ ...p, [sid]: "done" }));
          const sample = m.sample as TableSample | null | undefined;
          if (sample) {
            setStepSamples((p) => ({ ...p, [sid]: sample }));
          }
          const rowCount = m.row_count as number | undefined;
          const durationMs = m.duration_ms as number | undefined;
          setStepStats((p) => ({
            ...p,
            [sid]: { ...(p[sid] ?? {}), rowCount, durationMs },
          }));
          // El step terminó: limpiar su sesión SQL si tenía una.
          setStepSessions((p) => {
            if (!(sid in p)) return p;
            const out = { ...p };
            delete out[sid];
            return out;
          });
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

  // Carga step_id → step_uid del último run para que el canvas pueda
  // abrir preview de las tablas al click.
  useEffect(() => {
    if (!lastJobId) {
      setLastRunStepUids({});
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/runs/${lastJobId}/steps`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as {
          columns: string[];
          rows: unknown[][];
        };
        const ciId = j.columns.indexOf("step_id");
        const ciUid = j.columns.indexOf("step_uid");
        const map: Record<string, number> = {};
        for (const row of j.rows) {
          const id = row[ciId] as string;
          const uid = Number(row[ciUid]);
          if (id && Number.isFinite(uid)) map[id] = uid;
        }
        if (alive) setLastRunStepUids(map);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [lastJobId, activeJobId]);

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
    // Para pasos SQL prefijamos la conexión con la última usada (si quedó
    // recordada en localStorage). Si no hay ninguna, el usuario la elige a
    // mano — la primera vez es lo único que pasa.
    const lastConn = readLastUsedConnection();
    const defaults: Record<string, Partial<Step>> = {
      sql_query: {
        query: "SELECT 1 AS dummy",
        output_table: id,
        ...(lastConn ? { connection: lastConn } : {}),
      },
      sql_exec: {
        query: "CREATE TABLE IF NOT EXISTS tmp(x INT);",
        ...(lastConn ? { connection: lastConn } : {}),
      },
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
      union: { inputs: [], output_table: id },
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
    // Si el step es SQL y trae una conexión, la recordamos como "última
    // usada" para que el próximo step SQL nuevo arranque con la misma.
    if (
      (next.kind === "sql_query" || next.kind === "sql_exec") &&
      typeof (next as { connection?: unknown }).connection === "string" &&
      (next as { connection?: string }).connection
    ) {
      writeLastUsedConnection(
        (next as { connection?: string }).connection as string,
      );
    }
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
    } else if (mode.kind === "from_imported") {
      // Ejecutar todo excepto los pasos cuyo dataset vino del bundle.
      // El backend igual carga esas tablas al TableStore así los
      // downstream las consumen sin reejecutar.
      const imported = new Set(preloadInfo.preloaded_step_ids);
      target = cfg.steps.filter((s) => !imported.has(s.id)).map((s) => s.id);
    } else {
      target = null; // ejecutar todo
    }
    const isFullRun = target === null;
    // Pre-check: pasos SQL sin conexión definida. Excluimos los pasos
    // preloadeados desde un bundle — esos no se ejecutan, su dataset
    // viene del archivo, así que no necesitan conexión.
    const stepsToRun = isFullRun
      ? cfg.steps.map((s) => s.id)
      : (target as string[]);
    const stepsToRunSet = new Set(stepsToRun);
    const preloadedSet = new Set(
      preloadInfo.has_preload ? preloadInfo.preloaded_step_ids : [],
    );
    const missingConn: string[] = [];
    for (const s of cfg.steps) {
      if (!stepsToRunSet.has(s.id)) continue;
      if (preloadedSet.has(s.id)) continue;
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

    // ¿El proyecto declara (o hereda de globales SELECCIONADOS)
    // parámetros usados por los steps a ejecutar? Mergeamos local +
    // globales-elegidos (local pisa por nombre — mismo criterio que el
    // backend). Solo los globales que el proyecto opt-in en
    // selected_global_params aplican.
    const localParams = cfg.parameters ?? [];
    const localNames = new Set(localParams.map((p) => p.name));
    const selectedGlobals = new Set(cfg.selected_global_params ?? []);
    const mergedParams: ParamSpec[] = [
      ...localParams,
      ...globalParams.parameters.filter(
        (g) => selectedGlobals.has(g.name) && !localNames.has(g.name),
      ),
    ];
    const usedParamNames = new Set<string>();
    if (mergedParams.length > 0) {
      const declaredSet = new Set(mergedParams.map((p) => p.name));
      for (const s of cfg.steps) {
        if (!stepsToRunSet.has(s.id)) continue;
        if (preloadedSet.has(s.id)) continue;
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

    const launch = async (
      resolvedParams: Record<string, ParamValueJson>,
      runName: string | null,
    ) => {
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
          run_name: runName,
        });
        setActiveJobId(job_id);
        setLastJobId(job_id);
      } catch (e) {
        await dialog.alert(`Error al lanzar ejecución: ${e}`, {
          variant: "danger",
        });
      }
    };

    // Sugerencia automática para el nombre: "<config display> · <fecha>"
    const today = new Date().toISOString().slice(0, 10);
    const suggestedRunName = `${cfg.name} · ${today}`;

    if (usedParamNames.size === 0) {
      // Sin parámetros declarados → no abrimos el prompt, lanzamos con
      // el nombre sugerido (el usuario lo puede editar dentro del Diseño
      // si quiere; o lo cambia en Revisión).
      await launch({}, suggestedRunName);
      return;
    }
    // Abrir prompt de parámetros + nombre de ejecución.
    const needed = mergedParams.filter((p) => usedParamNames.has(p.name));
    setParamPrompt({
      params: needed,
      defaultRunName: suggestedRunName,
      onResolved: ({ values, runName }) => launch(values, runName),
    });
  }

  async function onExportBundle() {
    // Usamos lastJobId, no activeJobId — así el botón sigue siendo útil
    // después que el job terminó. El backend persistió los datasets en
    // step_datasets.
    const jobIdToExport = activeJobId ?? lastJobId;
    if (!jobIdToExport) {
      await dialog.alert(
        "Ejecutá el proyecto primero (con debug habilitado) y luego podés exportar sus datasets.",
        { title: "Sin ejecución para exportar", variant: "info" },
      );
      return;
    }
    // Aviso si faltan pasos sql_query "raíz" (sin depends_on) que no
    // tienen dataset persistido. Esos son las fuentes de datos del
    // proyecto; un bundle sin ellos no le sirve a otra máquina que
    // quiera correr offline.
    if (cfg) {
      const persisted = new Set(Object.keys(lastRunStepUids));
      const missingRoots = cfg.steps
        .filter(
          (s) =>
            (s.kind === "sql_query" || s.kind === "sql_exec") &&
            (s.depends_on?.length ?? 0) === 0 &&
            !persisted.has(s.id),
        )
        .map((s) => s.id);
      if (missingRoots.length > 0) {
        const ok = await dialog.confirm(
          `Estos pasos SQL de origen (sin dependencias) no tienen datos en la última ejecución:\n\n  • ${missingRoots.join(
            "\n  • ",
          )}\n\nEl bundle se va a exportar igual con lo que haya, pero quien lo importe va a tener que ejecutar esos pasos contra una base. ¿Continuar?`,
          {
            title: "Faltan pasos de origen",
            variant: "warning",
            ok: "Exportar igual",
          },
        );
        if (!ok) return;
      }
    }
    window.open(exportRunBundleUrl(jobIdToExport), "_blank");
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
      const s = await getPreloadStatus(currentName);
      setPreloadInfo(s);

      // Refrescar el estado de ejecución: lanzamos un job parcial que sólo
      // "ejecuta" los pasos preloadeados. Con use_preload=true, el scheduler
      // los marca Done con sus datos del bundle, persiste los datasets y
      // emite eventos. Resultado: los nodos importados aparecen Done en el
      // lienzo y sus tablas quedan clickeables, sin tocar el resto del DAG.
      try {
        const importedIds = s.preloaded_step_ids;
        setStepStates({});
        setStepLogs({});
        setStepSamples({});
        setActiveSubset(new Set(importedIds));
        const { job_id } = await createJob(currentName, {
          user,
          debug: true,
          target_steps: importedIds,
          stop_on_failure: false,
          use_preload: true,
          parameters: {},
          run_name: `Bundle importado · ${new Date().toISOString().slice(0, 10)}`,
        });
        setActiveJobId(job_id);
        setLastJobId(job_id);
      } catch (refreshErr) {
        // No es fatal: el bundle quedó importado, sólo no pudimos
        // disparar el run de refresh.
        // eslint-disable-next-line no-console
        console.warn("refresh post-import falló:", refreshErr);
      }

      await dialog.alert(
        `Importado: ${count} dataset(s). Los pasos importados aparecen marcados en el lienzo. Apretá "Ejecutar desde Datos Importados" para correr el resto del proyecto usando estas tablas como entrada.`,
        { title: "Bundle importado", variant: "info" },
      );
    } catch (e) {
      await dialog.alert(`No se pudo importar el bundle: ${e}`, {
        variant: "danger",
      });
    }
  }

  async function onOpenTable(stepId: string) {
    if (!lastJobId) {
      await dialog.alert(
        "Ejecutá el proyecto al menos una vez para ver datos.",
        { variant: "info" },
      );
      return;
    }
    const uid = lastRunStepUids[stepId];
    if (uid == null) {
      await dialog.alert(
        `No hay dataset persistido para el paso "${stepId}" en el último run. Probá ejecutar con debug habilitado.`,
        { variant: "info" },
      );
      return;
    }
    const step = (cfg?.steps ?? []).find((s) => s.id === stepId);
    const name =
      (step as { output_table?: string } | undefined)?.output_table ?? stepId;
    setOpenedTable({ stepId, stepUid: uid, name });
    setOpenedTablePreview(null);
    setOpenedTableErr(null);
    try {
      const prev = await datasetPreview(lastJobId, uid, 500);
      setOpenedTablePreview(prev);
    } catch (e) {
      setOpenedTableErr(String(e));
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

      {/* Canvas (lienzo arriba de todo) */}
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
            {preloadInfo.has_preload && (
              <button
                onClick={() => runJobWithMode({ kind: "from_imported" })}
                disabled={cfg.steps.length === 0 || activeJobId != null}
                className="text-xs px-3 py-1 rounded disabled:opacity-50 milhouse-btn-imported"
                title="Ejecuta todos los pasos excepto los que vinieron precargados del bundle. Las tablas importadas se cargan al TableStore y los downstream las consumen."
              >
                📦 ▶ Ejecutar desde Datos Importados
              </button>
            )}
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
              disabled={
                !(activeJobId ?? lastJobId) ||
                Object.keys(lastRunStepUids).length === 0
              }
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
          viewMode={canvasView}
          onChangeViewMode={setCanvasView}
          tablesAvailable={lastRunStepUids}
          importedStepIds={
            preloadInfo.has_preload ? preloadInfo.preloaded_step_ids : []
          }
          onOpenTable={onOpenTable}
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

      {/* Cola de ejecución en vivo: visible mientras hay job activo. */}
      {/* Cola de ejecución: visible mientras hay job activo Y también
          después de que terminó (para inspeccionar resultados). Se cierra
          a mano con "Limpiar y cerrar". */}
      {(() => {
        const queueJobId = activeJobId ?? lastJobId;
        const hasAnyState = Object.keys(stepStates).length > 0;
        if (!queueJobId || !hasAnyState) return null;
        return (
          <RunQueuePanel
            jobId={queueJobId}
            isActive={activeJobId != null}
            steps={cfg.steps}
            stepStates={stepStates}
            stepSessions={stepSessions}
            stepStats={stepStats}
            activeSubset={activeSubset}
            onCancelAll={async () => {
              if (!activeJobId) return;
              try {
                await cancelJob(activeJobId);
              } catch (e) {
                await dialog.alert(`No se pudo cancelar: ${e}`, {
                  variant: "danger",
                });
              }
            }}
            onDrain={async () => {
              if (!activeJobId) return;
              try {
                await drainJob(activeJobId);
              } catch (e) {
                await dialog.alert(`No se pudo drenar: ${e}`, {
                  variant: "danger",
                });
              }
            }}
            onCancelStep={async (sid) => {
              if (!activeJobId) return;
              try {
                await cancelStep(activeJobId, sid);
              } catch (e) {
                await dialog.alert(`No se pudo cancelar el paso: ${e}`, {
                  variant: "danger",
                });
              }
            }}
            onClearAndClose={() => {
              setStepStates({});
              setStepLogs({});
              setStepSamples({});
              setStepSessions({});
              setStepStats({});
              setActiveSubset(null);
            }}
          />
        );
      })()}

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

      {/* Propiedades del proyecto (colapsable) */}
      <div className="bg-panel border border-surface rounded-xl">
        <button
          onClick={() => setPropsOpen(!propsOpen)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <h3 className="font-semibold">Propiedades del proyecto</h3>
            <p className="text-xs text-muted">
              Nombre, versión, grupos, parámetros locales, respuestas
              guardadas y exposición vía API.
            </p>
          </div>
          <span className="text-dim">{propsOpen ? "▾" : "▸"}</span>
        </button>
        {propsOpen && (
          <div className="border-t border-surface p-3 space-y-3">
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

            {/* Parámetros de ejecución del proyecto */}
            <div className="bg-panel border border-surface rounded-xl p-3">
              <h4 className="text-xs uppercase tracking-wider text-muted mb-2">
                Parámetros de ejecución
              </h4>
              <div className="grid grid-cols-[1fr_2fr] gap-3 items-end">
                <Field label="Máx. pasos en paralelo">
                  <input
                    type="number"
                    min={1}
                    max={64}
                    placeholder="sin límite"
                    value={cfg.settings?.max_parallel_steps ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      const num = raw === "" ? null : Math.max(1, Number(raw));
                      const next: ProjectSettings = {
                        ...(cfg.settings ?? {}),
                        max_parallel_steps: num,
                      };
                      updateProject("settings", next);
                    }}
                    className="w-full milhouse-field"
                  />
                </Field>
                <p className="text-[11px] text-dim leading-snug">
                  Dejá vacío para sin límite (lanza todos los <code>ready</code>{" "}
                  en paralelo). Bajalo si tu base se satura con muchas queries
                  simultáneas. Para serial estricto poné <code>1</code>.
                </p>
              </div>
            </div>

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
                  Tip: seleccioná varios pasos en el lienzo (Ctrl/Shift+click
                  o drag en background) y click derecho → "Crear grupo".
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
                        onChange={(e) =>
                          setGroupParent(g.name, e.target.value || null)
                        }
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

            {/* Parámetros locales del proyecto + respuestas */}
            <div>
              <p className="text-[11px] text-dim mb-2">
                Estos parámetros son <strong>locales</strong> al proyecto.
                Para parámetros y respuestas globales (compartidos entre
                proyectos) usá la sección "Parámetros de Ejecución". En
                caso de colisión por nombre, el local pisa al global.
              </p>
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

              {/* Globales que aplican a este proyecto */}
              <div className="mt-4 bg-surface-2 border border-surface rounded p-3">
                <h4 className="text-xs uppercase tracking-wider text-muted mb-2">
                  Aplicar parámetros globales (
                  {(cfg.selected_global_params ?? []).length} /{" "}
                  {globalParams.parameters.length})
                </h4>
                <p className="text-[11px] text-dim mb-2">
                  Tildá los globales que este proyecto necesita.{" "}
                  <em>Solo los seleccionados</em> se mergean al ejecutar. Si
                  un global se llama igual que un local, el local pisa al
                  global.
                </p>
                {globalParams.parameters.length === 0 ? (
                  <div className="text-xs text-dim">
                    No hay parámetros globales declarados.{" "}
                    <em>(Se definen en la sección "Parámetros de Ejecución".)</em>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {globalParams.parameters.map((g) => {
                      const list = cfg.selected_global_params ?? [];
                      const checked = list.includes(g.name);
                      const localCollision = (cfg.parameters ?? []).some(
                        (p) => p.name === g.name,
                      );
                      return (
                        <label
                          key={g.name}
                          className="flex items-center gap-2 text-sm cursor-pointer text-app"
                          title={g.description ?? ""}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const cur = cfg.selected_global_params ?? [];
                              const next = checked
                                ? cur.filter((n) => n !== g.name)
                                : [...cur, g.name];
                              applyChange({
                                ...cfg,
                                selected_global_params: next,
                              });
                            }}
                          />
                          <code className="font-mono text-xs">{g.name}</code>
                          <span className="text-[10px] text-dim">{g.kind}</span>
                          {g.label && (
                            <span className="text-[10px] text-dim truncate">
                              — {g.label}
                            </span>
                          )}
                          {localCollision && (
                            <span
                              className="text-[10px] px-1 rounded bg-amber-500/20 text-amber-300 border border-amber-700"
                              title="Hay un parámetro local con el mismo nombre — el local pisa al global"
                            >
                              pisado por local
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Exposición como API REST */}
            <ApiExposurePanel
              projectFilename={currentName}
              api={cfg.api ?? {}}
              steps={cfg.steps}
              onChange={(next) => applyChange({ ...cfg, api: next })}
            />
          </div>
        )}
      </div>

      {/* Respuestas del proyecto (defaults para el prompt de ejecución) */}
      <RunDefaultsPanel
        open={runDefaultsOpen}
        onToggle={() => setRunDefaultsOpen(!runDefaultsOpen)}
        localParams={cfg.parameters ?? []}
        globalParams={globalParams.parameters}
        selectedGlobals={cfg.selected_global_params ?? []}
        runDefaults={cfg.run_defaults ?? {}}
        onChange={(next) =>
          applyChange({ ...cfg, run_defaults: next })
        }
      />

      {paramPrompt && (
        <ParameterPromptDialog
          parameters={paramPrompt.params}
          presets={mergedPresetsForPrompt(cfg.presets ?? [], globalParams.presets)}
          presetGroups={globalParams.preset_groups}
          defaultRunName={paramPrompt.defaultRunName}
          initialValues={cfg.run_defaults ?? {}}
          onCancel={() => setParamPrompt(null)}
          onResolved={async (args) => {
            const cb = paramPrompt.onResolved;
            setParamPrompt(null);
            await cb(args);
          }}
        />
      )}

      {openedTable && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6"
          style={{
            background: "rgba(0,0,0,0.45)",
            backdropFilter: "blur(2px)",
          }}
          onClick={() => setOpenedTable(null)}
        >
          <div
            className="bg-surface border border-surface-strong rounded-xl p-5 w-full max-w-5xl max-h-[90vh] overflow-auto"
            style={{ boxShadow: "var(--shadow)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-lg font-bold">
                  Datos de <code className="font-mono">{openedTable.name}</code>
                </h3>
                <p className="text-xs text-muted">
                  Paso <code className="font-mono">{openedTable.stepId}</code> ·
                  último run <code className="font-mono">
                    {lastJobId?.slice(0, 8)}
                  </code>
                </p>
              </div>
              <button
                onClick={() => setOpenedTable(null)}
                className="text-dim hover:text-app text-xl"
              >
                ✕
              </button>
            </div>
            {openedTableErr && (
              <div className="text-red-400 text-sm whitespace-pre-wrap">
                {openedTableErr}
              </div>
            )}
            {!openedTableErr && !openedTablePreview && (
              <div className="text-dim text-sm">cargando…</div>
            )}
            {openedTablePreview && (
              <SamplePanel
                sample={{
                  columns: openedTablePreview.columns.map((n) => ({
                    name: n,
                    dtype: "",
                  })),
                  rows: openedTablePreview.rows,
                  total_rows: openedTablePreview.row_count,
                  sampled_rows: openedTablePreview.rows.length,
                }}
              />
            )}
          </div>
        </div>
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

/** Mergea presets local + global anteponiendo "(global)" a los heredados.
 *  Si un preset existe con el mismo nombre en ambos, gana el local. */
function mergedPresetsForPrompt(
  locals: ParamPreset[],
  globals: ParamPreset[],
): ParamPreset[] {
  const localNames = new Set(locals.map((p) => p.name));
  const tagged: ParamPreset[] = [
    ...locals,
    ...globals
      .filter((g) => !localNames.has(g.name))
      .map((g) => ({
        ...g,
        description: g.description
          ? `(global) ${g.description}`
          : "(global)",
      })),
  ];
  return tagged;
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

const LAST_USED_CONN_KEY = "milhouse.lastUsedConnection";

function readLastUsedConnection(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_USED_CONN_KEY);
  } catch {
    return null;
  }
}

function writeLastUsedConnection(name: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_USED_CONN_KEY, name);
  } catch {
    // localStorage puede estar deshabilitado (modo privado, etc).
  }
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

/**
 * Panel "Respuestas del proyecto": editor de valores por default para
 * cada parámetro disponible (locales + globales seleccionados). Estos
 * defaults pre-rellenan el prompt al ejecutar; el usuario puede
 * sobreescribirlos antes de lanzar.
 */
function RunDefaultsPanel({
  open,
  onToggle,
  localParams,
  globalParams,
  selectedGlobals,
  runDefaults,
  onChange,
}: {
  open: boolean;
  onToggle: () => void;
  localParams: ParamSpec[];
  globalParams: ParamSpec[];
  selectedGlobals: string[];
  runDefaults: Record<string, ParamValueJson>;
  onChange: (next: Record<string, ParamValueJson>) => void;
}) {
  // Lista efectiva de parámetros que aplican: locales + globales seleccionados.
  // Local pisa global por nombre (mismo criterio que el backend).
  const localNames = new Set(localParams.map((p) => p.name));
  const available: Array<ParamSpec & { source: "local" | "global" }> = [
    ...localParams.map((p) => ({ ...p, source: "local" as const })),
    ...globalParams
      .filter(
        (g) => selectedGlobals.includes(g.name) && !localNames.has(g.name),
      )
      .map((g) => ({ ...g, source: "global" as const })),
  ];

  function setVal(name: string, v: ParamValueJson | null) {
    const next = { ...runDefaults };
    if (v == null) {
      delete next[name];
    } else {
      next[name] = v;
    }
    onChange(next);
  }

  const answered = available.filter((p) => p.name in runDefaults).length;

  return (
    <div className="bg-panel border border-surface rounded-xl">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <h3 className="font-semibold">Propiedades de ejecución</h3>
          <p className="text-xs text-muted">
            Respuestas por default a los parámetros del proyecto (locales y
            globales seleccionados). Pre-rellenan el prompt al ejecutar; el
            usuario puede confirmarlas o cambiarlas.{" "}
            {available.length > 0 && (
              <strong>
                {answered} / {available.length} respondidos
              </strong>
            )}
          </p>
        </div>
        <span className="text-dim">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-surface p-3">
          {available.length === 0 ? (
            <div className="text-sm text-dim">
              Este proyecto no tiene parámetros locales ni globales
              seleccionados. Agregalos en "Propiedades del proyecto".
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-[10px] uppercase tracking-wider">
                  <th className="text-left px-2 py-1 font-medium">Parámetro</th>
                  <th className="text-left px-2 py-1 font-medium">Tipo</th>
                  <th className="text-left px-2 py-1 font-medium">Origen</th>
                  <th className="text-left px-2 py-1 font-medium">
                    Respuesta por default
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {available.map((p) => {
                  const v = runDefaults[p.name];
                  return (
                    <tr key={p.name} className="border-t border-surface">
                      <td className="px-2 py-1.5">
                        <code className="font-mono text-xs">{p.name}</code>
                        {p.label && (
                          <div className="text-[10px] text-dim">{p.label}</div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-[11px] text-dim">
                        {p.kind}
                      </td>
                      <td className="px-2 py-1.5 text-[11px]">
                        {p.source === "local" ? (
                          <span className="text-cyan-300">local</span>
                        ) : (
                          <span className="text-emerald-300">global</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <RunDefaultEditor
                          param={p}
                          value={v}
                          onChange={(next) => setVal(p.name, next)}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {p.name in runDefaults && (
                          <button
                            type="button"
                            onClick={() => setVal(p.name, null)}
                            className="text-xs text-dim hover:text-app"
                            title="Quitar respuesta default"
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function RunDefaultEditor({
  param,
  value,
  onChange,
}: {
  param: ParamSpec;
  value: ParamValueJson | undefined;
  onChange: (v: ParamValueJson | null) => void;
}) {
  const k = param.kind;
  const list = k === "list_number" || k === "list_text";
  if (k === "date") {
    return (
      <input
        type="date"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="milhouse-field text-sm w-full"
      />
    );
  }
  if (k === "number") {
    return (
      <input
        type="number"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="milhouse-field text-sm w-full font-mono"
      />
    );
  }
  if (k === "text") {
    return (
      <input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="milhouse-field text-sm w-full"
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
        <option value="">(sin respuesta)</option>
        <option value="1">Sí</option>
        <option value="0">No</option>
      </select>
    );
  }
  if (list) {
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
        placeholder="Un valor por línea"
        className="milhouse-field text-xs w-full font-mono"
      />
    );
  }
  return null;
}
