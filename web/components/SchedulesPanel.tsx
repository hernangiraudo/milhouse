"use client";

import { useEffect, useMemo, useState } from "react";
import {
  API_BASE,
  createSchedule,
  deleteSchedule,
  getConfig,
  listConfigs,
  listSchedules,
  patchSchedule,
  runsHealth,
  type ConfigSummary,
  type ScheduleDto,
  type ScheduleSpec,
} from "@/lib/api";
import { useUser } from "@/lib/session";
import { useDialog } from "./Dialog";
import {
  ParameterPromptDialog,
  type PresetGroupDto,
} from "./ParameterPromptDialog";
import type {
  ParamPreset,
  ParamSpec,
  ParamValueJson,
} from "./DesignEditor";

function scanParamRefs(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  let inS = false,
    inD = false,
    inLine = false,
    inBlock = false;
  while (i < n) {
    const c = text[i];
    const nx = i + 1 < n ? text[i + 1] : "\0";
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
    if (inS) {
      if (c === "'") {
        if (nx === "'") {
          i += 2;
          continue;
        }
        inS = false;
      }
      i++;
      continue;
    }
    if (inD) {
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === "'") {
      inS = true;
      i++;
      continue;
    }
    if (c === '"') {
      inD = true;
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
    if (c === ":" && /[A-Za-z]/.test(nx)) {
      if (i > 0 && text[i - 1] === ":") {
        i++;
        continue;
      }
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_]/.test(text[end])) end++;
      if (
        end < n &&
        text[end] === "." &&
        end + 1 < n &&
        /[A-Za-z]/.test(text[end + 1])
      ) {
        end++;
        while (end < n && /[A-Za-z0-9_]/.test(text[end])) end++;
      }
      out.push(text.slice(i + 1, end));
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

type Mode = "at" | "window" | "cron";

export function SchedulesPanel() {
  const me = useUser();
  const dialog = useDialog();
  const [list, setList] = useState<ScheduleDto[]>([]);
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form
  const [name, setName] = useState("");
  const [configName, setConfigName] = useState("");
  const [mode, setMode] = useState<Mode>("at");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]); // Lun-Vie default
  const [timeAt, setTimeAt] = useState("09:00");
  const [winFrom, setWinFrom] = useState("08:00");
  const [winTo, setWinTo] = useState("23:00");
  const [winEvery, setWinEvery] = useState(5);
  const [cronExpr, setCronExpr] = useState("*/5 * * * *");

  // Globales + prompt state.
  const [globalParams, setGlobalParams] = useState<{
    parameters: ParamSpec[];
    presets: ParamPreset[];
    preset_groups: PresetGroupDto[];
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
  const [paramPrompt, setParamPrompt] = useState<{
    parameters: ParamSpec[];
    presets: ParamPreset[];
    presetGroups: PresetGroupDto[];
    initialValues: Record<string, ParamValueJson>;
    onResolved: (args: {
      values: Record<string, ParamValueJson>;
      selectedPresetGroups: string[];
    }) => Promise<void> | void;
  } | null>(null);
  // Disponibilidad de la DB de runs. Si está offline, deshabilitamos
  // la creación de schedules y mostramos un banner explicando cómo
  // configurarla.
  const [runsAvailable, setRunsAvailable] = useState<boolean>(true);
  useEffect(() => {
    runsHealth()
      .then((h) => setRunsAvailable(h.available))
      .catch(() => setRunsAvailable(false));
  }, []);

  async function reload() {
    // allSettled: si uno falla, el otro igual carga. Antes con
    // Promise.all, un 503 en listSchedules dejaba `configs` vacío y la
    // UI mostraba "no hay proyectos" aunque sí hubiera.
    const [schedulesRes, configsRes] = await Promise.allSettled([
      listSchedules(),
      listConfigs(),
    ]);
    const errs: string[] = [];
    if (schedulesRes.status === "fulfilled") {
      setList(schedulesRes.value);
    } else {
      errs.push(`listSchedules: ${schedulesRes.reason}`);
    }
    if (configsRes.status === "fulfilled") {
      setConfigs(configsRes.value);
      if (!configName && configsRes.value.length > 0) {
        setConfigName(configsRes.value[0].name);
      }
    } else {
      errs.push(`listConfigs: ${configsRes.reason}`);
    }
    setErr(errs.length > 0 ? errs.join(" · ") : null);
  }
  useEffect(() => {
    reload();
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );
  }

  function buildSpec(): ScheduleSpec | null {
    if (mode === "at") {
      if (days.length === 0) return null;
      return { kind: "at", days, time: timeAt };
    }
    if (mode === "window") {
      if (days.length === 0 || winEvery < 1) return null;
      return {
        kind: "window",
        days,
        from: winFrom,
        to: winTo,
        every_minutes: winEvery,
      };
    }
    return { kind: "cron", expr: cronExpr.trim() };
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const spec = buildSpec();
    if (!spec) {
      setErr("Spec inválido (faltan días o intervalo).");
      return;
    }
    setErr(null);

    // Si el proyecto tiene parámetros usados, mostramos el prompt para
    // que el usuario elija respuestas / grupos antes de crear el
    // schedule. Si no, creamos directo.
    let cfg: Record<string, unknown>;
    try {
      cfg = await getConfig(configName);
    } catch (e) {
      setErr(`No se pudo cargar el proyecto: ${e}`);
      return;
    }
    const localParams = ((cfg.parameters as ParamSpec[]) ?? []);
    const localPresets = ((cfg.presets as ParamPreset[]) ?? []);
    const selectedGlobals = new Set(
      (cfg.selected_global_params as string[] | undefined) ?? [],
    );
    const localNames = new Set(localParams.map((p) => p.name));
    const mergedParams: ParamSpec[] = [
      ...localParams,
      ...globalParams.parameters.filter(
        (g) => selectedGlobals.has(g.name) && !localNames.has(g.name),
      ),
    ];
    const declaredSet = new Set(mergedParams.map((p) => p.name));
    const usedNames = new Set<string>();
    const steps = (cfg.steps as Array<Record<string, unknown>> | undefined) ?? [];
    for (const s of steps) {
      const kind = s.kind as string | undefined;
      const texts: string[] = [];
      if (kind === "sql_query" || kind === "sql_exec") {
        const q = s.query as string | undefined;
        if (q) texts.push(q);
      } else if (kind === "filter_and_subset") {
        const f = s.filter as string | undefined | null;
        if (f) texts.push(f);
      }
      for (const t of texts) {
        for (const n of scanParamRefs(t)) {
          if (declaredSet.has(n)) usedNames.add(n);
        }
      }
    }
    const needed = mergedParams.filter((p) => usedNames.has(p.name));

    const persist = async (
      values: Record<string, ParamValueJson>,
      selectedPresetGroups: string[],
    ) => {
      setBusy(true);
      try {
        await createSchedule({
          name: name.trim(),
          config_name: configName,
          spec,
          created_by: me,
          enabled: true,
          parameters: values as Record<string, string | string[]>,
          selected_preset_groups: selectedPresetGroups,
        });
        setName("");
        await reload();
      } catch (e) {
        const msg = String(e);
        // Caso típico: la DB de runs no está disponible (sin conexión
        // `runs` declarada, archivo lockeado, etc). Mostramos un modal
        // amigable con instrucciones en vez del 503 crudo.
        if (msg.includes("503") || msg.includes("runs DB not configured")) {
          await dialog.alert(
            "Para guardar schedules necesitás tener configurada la base de runs.\n\n" +
              "Andá a la sección Conexiones y agregá una conexión con nombre 'runs' (puede ser DuckDB embebida apuntando a un archivo .duckdb local — Milhouse crea el schema solo la primera vez). Después reiniciá el backend para que la tome.\n\n" +
              "Mientras tanto podés diseñar y ejecutar proyectos a mano, pero la planificación queda inactiva.",
            {
              title: "Base de runs no configurada",
              variant: "warning",
            },
          );
        } else {
          await dialog.alert(`No se pudo crear el schedule: ${msg}`, {
            title: "Error al guardar",
            variant: "danger",
          });
        }
      } finally {
        setBusy(false);
      }
    };

    if (needed.length === 0) {
      await persist({}, []);
      return;
    }

    const allPresetNames = new Set(localPresets.map((p) => p.name));
    const mergedPresets: ParamPreset[] = [
      ...localPresets,
      ...globalParams.presets
        .filter((g) => !allPresetNames.has(g.name))
        .map((g) => ({
          ...g,
          description: g.description
            ? `(global) ${g.description}`
            : "(global)",
        })),
    ];
    setParamPrompt({
      parameters: needed,
      presets: mergedPresets,
      presetGroups: globalParams.preset_groups,
      initialValues:
        (cfg.run_defaults as Record<string, ParamValueJson>) ?? {},
      onResolved: async (args) => {
        await persist(args.values, args.selectedPresetGroups);
      },
    });
  }

  async function onToggle(id: number, enabled: boolean) {
    try {
      await patchSchedule(id, enabled);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }
  async function onDelete(id: number, name: string) {
    const ok = await dialog.confirm(`¿Eliminar el schedule "${name}"?`, {
      title: "Eliminar schedule",
      variant: "danger",
      ok: "Eliminar",
    });
    if (!ok) return;
    try {
      await deleteSchedule(id);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  const displayByConfig = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of configs) map[c.name] = c.display_name;
    return map;
  }, [configs]);

  return (
    <section className="space-y-6">
      <div className="bg-panel rounded-xl p-6 border border-slate-800 space-y-4">
        <header>
          <h2 className="font-semibold text-lg">Nuevo schedule</h2>
          <p className="text-sm text-muted">
            Programá la ejecución automática de un proyecto. El backend chequea
            cada minuto y dispara los jobs que correspondan.
          </p>
        </header>

        {!runsAvailable && (
          <div className="milhouse-alert-warn rounded p-3 text-sm space-y-2">
            <div className="font-semibold">
              ⚠ La base de runs no está configurada
            </div>
            <p className="text-xs leading-relaxed">
              La planificación necesita la conexión <code>runs</code> para
              guardar los schedules. Andá a <strong>Conexiones</strong> y
              agregá una con nombre <code>runs</code> (puede ser DuckDB
              embebida apuntando a un archivo <code>.duckdb</code> local —
              Milhouse crea el schema solo la primera vez). Después reiniciá
              el backend para que la tome.
            </p>
            <p className="text-xs">
              Mientras tanto podés diseñar y ejecutar proyectos a mano, pero
              no podés crear schedules.
            </p>
          </div>
        )}

        <form onSubmit={onCreate} className="space-y-3">
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <Field label="Nombre">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ej. Novedades cada 5 minutos"
                className="w-full milhouse-field"
              />
            </Field>
            <Field label="Proyecto">
              <select
                value={configName}
                onChange={(e) => setConfigName(e.target.value)}
                className="w-full milhouse-field"
              >
                {configs.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.display_name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Modo">
            <div className="flex gap-1 text-xs">
              {(
                [
                  ["at", "Hora fija"],
                  ["window", "Ventana"],
                  ["cron", "Cron"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-3 py-1 rounded border ${
                    mode === m
                      ? "bg-accent-token border-transparent"
                      : "bg-surface-2 border-surface-strong"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          {(mode === "at" || mode === "window") && (
            <Field label="Días de la semana">
              <div className="flex gap-1 flex-wrap">
                {DOW_LABELS.map((label, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => toggleDay(idx)}
                    className={`px-3 py-1 rounded border text-xs ${
                      days.includes(idx)
                        ? "bg-accent-token border-transparent"
                        : "bg-surface-2 border-surface-strong"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {mode === "at" && (
            <Field label="Hora (HH:MM)">
              <input
                type="time"
                value={timeAt}
                onChange={(e) => setTimeAt(e.target.value)}
                className="milhouse-field"
              />
            </Field>
          )}

          {mode === "window" && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Desde">
                <input
                  type="time"
                  value={winFrom}
                  onChange={(e) => setWinFrom(e.target.value)}
                  className="milhouse-field"
                />
              </Field>
              <Field label="Hasta">
                <input
                  type="time"
                  value={winTo}
                  onChange={(e) => setWinTo(e.target.value)}
                  className="milhouse-field"
                />
              </Field>
              <Field label="Cada (minutos)">
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={winEvery}
                  onChange={(e) => setWinEvery(Number(e.target.value))}
                  className="milhouse-field"
                />
              </Field>
            </div>
          )}

          {mode === "cron" && (
            <Field label="Expresión cron (min hora dom mes dow)">
              <input
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="w-full milhouse-field font-mono"
              />
              <p className="text-xs text-dim mt-1">
                Ejemplos:{" "}
                <code className="milhouse-chip">0 9 * * 1-5</code> 9:00 lun-vie ·{" "}
                <code className="milhouse-chip">*/15 8-23 * * *</code> cada 15 min entre 8 y 23.
              </p>
            </Field>
          )}

          {err && <div className="text-red-400 text-sm">{err}</div>}

          <button
            type="submit"
            disabled={busy || !name.trim() || !configName || !runsAvailable}
            className="font-semibold px-4 py-2 rounded-md disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            title={
              !runsAvailable
                ? "Necesitás configurar la conexión `runs` para crear schedules"
                : undefined
            }
          >
            {busy
              ? "Creando…"
              : !runsAvailable
              ? "Base de runs no configurada"
              : "Crear schedule"}
          </button>
        </form>
      </div>

      <div>
        <h2 className="font-semibold mb-3 text-slate-200">
          Schedules activos · {list.length}
        </h2>
        <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-muted">
              <tr>
                <th className="text-left px-4 py-2">#</th>
                <th className="text-left px-4 py-2">Nombre</th>
                <th className="text-left px-4 py-2">Proyecto</th>
                <th className="text-left px-4 py-2">Schedule</th>
                <th className="text-left px-4 py-2">Estado</th>
                <th className="text-left px-4 py-2">Último disparo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-dim text-center">
                    No hay schedules.
                  </td>
                </tr>
              )}
              {list.map((s) => (
                <tr key={s.id} className="border-t border-surface">
                  <td className="px-4 py-2 font-mono text-xs">#{s.id}</td>
                  <td className="px-4 py-2">{s.name}</td>
                  <td className="px-4 py-2" title={s.config_name}>
                    {displayByConfig[s.config_name] ?? s.config_name}
                  </td>
                  <td className="px-4 py-2 text-xs">{describeSpec(s.spec)}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => onToggle(s.id, !s.enabled)}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        s.enabled
                          ? "border-emerald-700 bg-emerald-500/20 text-emerald-300"
                          : "border-slate-700 bg-slate-500/20 text-slate-300"
                      }`}
                    >
                      {s.enabled ? "ACTIVO" : "pausado"}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {s.last_fired_at
                      ? new Date(s.last_fired_at).toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => onDelete(s.id, s.name)}
                      className="text-xs text-red-400 hover:underline"
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {paramPrompt && (
        <ParameterPromptDialog
          parameters={paramPrompt.parameters}
          presets={paramPrompt.presets}
          presetGroups={paramPrompt.presetGroups}
          initialValues={paramPrompt.initialValues}
          onCancel={() => setParamPrompt(null)}
          onResolved={async (args) => {
            const cb = paramPrompt.onResolved;
            setParamPrompt(null);
            await cb({
              values: args.values,
              selectedPresetGroups: args.selectedPresetGroups,
            });
          }}
        />
      )}
    </section>
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

function describeSpec(s: ScheduleSpec): string {
  if (s.kind === "at") {
    const ds = s.days.map((d) => DOW_LABELS[d]).join(", ");
    return `${ds} · a las ${s.time}`;
  }
  if (s.kind === "window") {
    const ds = s.days.map((d) => DOW_LABELS[d]).join(", ");
    return `${ds} · ${s.from}–${s.to} cada ${s.every_minutes} min`;
  }
  return `cron: ${s.expr}`;
}
