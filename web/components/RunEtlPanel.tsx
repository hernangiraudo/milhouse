"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  API_BASE,
  createJob,
  deleteRun,
  getConfig,
  listConfigs,
  listJobs,
  OpenCasesBlockError,
} from "@/lib/api";
import type { ConfigSummary, JobSummary } from "@/lib/types";
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

// Mismo scanner que DesignEditor (extraído por simplicidad).
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

type SortCol = "config" | "user" | "started_at";
type SortDir = "asc" | "desc";

export function RunEtlPanel() {
  const router = useRouter();
  const dialog = useDialog();
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const user = useUser();

  // filtro + sort
  const [filterCfg, setFilterCfg] = useState<string>("__all__");
  const [sortCol, setSortCol] = useState<SortCol>("started_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // selección múltiple para bulk delete
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Parámetros globales + grupos (compartidos entre proyectos). Se cargan
  // al montar y se usan para armar el prompt al ejecutar.
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

  // Estado del prompt — abre cuando hay params usados que pedir.
  const [paramPrompt, setParamPrompt] = useState<{
    parameters: ParamSpec[];
    presets: ParamPreset[];
    presetGroups: PresetGroupDto[];
    initialValues: Record<string, ParamValueJson>;
    onResolved: (args: {
      values: Record<string, ParamValueJson>;
      runName: string | null;
    }) => Promise<void> | void;
  } | null>(null);

  async function reload() {
    try {
      const [cfgs, js] = await Promise.all([listConfigs(), listJobs()]);
      setConfigs(cfgs);
      if (!selected && cfgs.length > 0) setSelected(cfgs[0].name);
      setJobs(js);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (!selected) return;
    setErr(null);
    // Cargar el config del proyecto para saber qué parámetros usa.
    let cfg: Record<string, unknown>;
    try {
      cfg = await getConfig(selected);
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

    // Escanear los pasos para ver qué params se usan realmente.
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
    const cfgName = (cfg.name as string | undefined) ?? selected;
    const today = new Date().toISOString().slice(0, 10);

    const launch = async (
      values: Record<string, ParamValueJson>,
      runName: string | null,
    ) => {
      setLoading(true);
      try {
        const { job_id } = await createJob(selected, {
          user,
          debug: true,
          parameters: values,
          run_name: runName,
        });
        router.push(`/jobs/${job_id}`);
      } catch (e) {
        setErr(String(e));
      } finally {
        setLoading(false);
      }
    };

    if (needed.length === 0) {
      // No hay parámetros que pedir — lanzar directo.
      await launch({}, null);
      return;
    }

    // Mergear presets (locales primero, globales después por compat con
    // DesignEditor). Esto permite que el dialog ofrezca todos.
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
        await launch(args.values, args.runName);
      },
    });
    void cfgName;
    void today;
  }

  async function onDelete(j: JobSummary) {
    const cfgLabel = j.config_display_name ?? j.config_name;
    const ok = await dialog.confirm(
      `¿Eliminar la ejecución ${j.job_id.slice(0, 8)} de "${cfgLabel}" y todos sus logs?`,
      { title: "Eliminar ejecución", variant: "danger", ok: "Eliminar" },
    );
    if (!ok) return;
    try {
      await deleteRun(j.job_id);
      checked.delete(j.job_id);
      setChecked(new Set(checked));
      await reload();
    } catch (e) {
      if (e instanceof OpenCasesBlockError) {
        const list = e.cases.map((c) => `#${c}`).join(", ");
        await dialog.alert(
          `No se puede eliminar la ejecución ${j.job_id.slice(0, 8)}.\n\n` +
            `Tiene datasets adjuntos a los siguientes casos abiertos: ${list}\n\n` +
            `Cerralos primero desde la sección "Casos" y volvé a intentar.`,
          { title: "Bloqueado por casos abiertos", variant: "warning" },
        );
      } else {
        setErr(String(e));
      }
    }
  }

  function toggleCheck(jobId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  async function onDeleteSelected() {
    if (checked.size === 0) return;
    const ok = await dialog.confirm(
      `¿Eliminar ${checked.size} ejecución(es) y todos sus logs? Esta acción no se puede deshacer.`,
      { title: "Eliminar ejecuciones", variant: "danger", ok: "Eliminar todo" },
    );
    if (!ok) return;
    const blocked: Array<{ jobId: string; cases: number[] }> = [];
    let deletedAny = false;
    for (const id of Array.from(checked)) {
      try {
        await deleteRun(id);
        deletedAny = true;
      } catch (e) {
        if (e instanceof OpenCasesBlockError) {
          blocked.push({ jobId: id, cases: e.cases });
        } else {
          setErr(String(e));
          break;
        }
      }
    }
    if (deletedAny) setChecked(new Set());
    await reload();
    if (blocked.length > 0) {
      const lines = blocked
        .map(
          (b) =>
            `  • ${b.jobId.slice(0, 8)} → casos abiertos: ${b.cases.map((c) => `#${c}`).join(", ")}`,
        )
        .join("\n");
      await dialog.alert(
        `${blocked.length} ejecución(es) no se eliminaron porque tienen datasets adjuntos a casos abiertos:\n\n${lines}\n\nCerralos primero desde "Casos".`,
        { title: "Algunos no se eliminaron", variant: "warning" },
      );
    }
  }

  // Lista de proyectos presentes (para el dropdown del filtro), preserva
  // el label legible.
  const configsAvailable = useMemo(() => {
    const seen = new Map<string, string>();
    for (const j of jobs) {
      if (!seen.has(j.config_name)) {
        seen.set(j.config_name, j.config_display_name ?? j.config_name);
      }
    }
    return Array.from(seen.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [jobs]);

  const visibleJobs = useMemo(() => {
    let xs =
      filterCfg === "__all__"
        ? [...jobs]
        : jobs.filter((j) => j.config_name === filterCfg);
    const dir = sortDir === "asc" ? 1 : -1;
    xs.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      if (sortCol === "config") {
        av = (a.config_display_name ?? a.config_name).toLowerCase();
        bv = (b.config_display_name ?? b.config_name).toLowerCase();
      } else if (sortCol === "user") {
        av = (a.user ?? "").toLowerCase();
        bv = (b.user ?? "").toLowerCase();
      } else {
        av = a.started_at;
        bv = b.started_at;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return xs;
  }, [jobs, filterCfg, sortCol, sortDir]);

  function toggleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir(col === "started_at" ? "desc" : "asc");
    }
  }

  const allChecked =
    visibleJobs.length > 0 &&
    visibleJobs.every((j) => checked.has(j.job_id));
  function onCheckAll() {
    const ids = visibleJobs.map((j) => j.job_id);
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  return (
    <section className="space-y-6">
      <div className="bg-panel rounded-xl p-6 border border-slate-800">
        <h2 className="font-semibold text-lg mb-1">Ejecutar un proyecto</h2>
        <p className="text-sm text-muted mb-4">
          Elegí un proyecto y lanzalo. La ejecución queda registrada con tu
          usuario.
        </p>
        <div className="flex gap-3 items-center flex-wrap">
          <select
            className="milhouse-field"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {configs.length === 0 && <option value="">(sin proyectos)</option>}
            {configs.map((c) => (
              <option key={c.name} value={c.name}>
                {c.display_name}
              </option>
            ))}
          </select>
          <button
            onClick={run}
            disabled={loading || !selected}
            className="bg-accent text-ink font-semibold px-4 py-2 rounded-md disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {loading ? "Lanzando..." : "Ejecutar"}
          </button>
          {err && <span className="text-red-400 text-sm">{err}</span>}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="font-semibold text-slate-200">
            Ejecuciones recientes
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {checked.size > 0 && (
              <button
                onClick={onDeleteSelected}
                className="text-xs px-3 py-1 rounded border border-red-700 bg-red-500/20 text-red-300 hover:bg-red-500/40"
              >
                Eliminar {checked.size} seleccionado
                {checked.size > 1 ? "s" : ""}
              </button>
            )}
            <label className="text-xs text-muted flex items-center gap-2">
              Proyecto:
              <select
                value={filterCfg}
                onChange={(e) => setFilterCfg(e.target.value)}
                className="milhouse-field text-xs py-1 px-2"
              >
                <option value="__all__">(todos)</option>
                {configsAvailable.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="bg-panel rounded-xl border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-slate-400">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={onCheckAll}
                    title="Seleccionar todas las visibles"
                  />
                </th>
                <th className="text-left px-4 py-2">Job ID</th>
                <SortableTh
                  col="config"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={toggleSort}
                >
                  Proyecto
                </SortableTh>
                <SortableTh
                  col="user"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={toggleSort}
                >
                  Usuario
                </SortableTh>
                <th className="text-left px-4 py-2">Estado</th>
                <th className="text-left px-4 py-2">%</th>
                <SortableTh
                  col="started_at"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={toggleSort}
                >
                  Inicio
                </SortableTh>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleJobs.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-6 text-slate-500 text-center"
                  >
                    No hay ejecuciones todavía.
                  </td>
                </tr>
              )}
              {visibleJobs.map((j) => (
                <tr key={j.job_id} className="border-t border-slate-800">
                  <td
                    className="px-3 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(j.job_id)}
                      onChange={() => toggleCheck(j.job_id)}
                    />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {j.job_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2" title={j.config_name}>
                    {j.config_display_name ?? j.config_name}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {j.user ? (
                      j.user.startsWith("scheduler#") ? (
                        <span
                          className="inline-block text-[10px] px-1.5 py-0.5 rounded border border-cyan-700 bg-cyan-500/20 text-cyan-300"
                          title={`Disparado por ${j.user}`}
                        >
                          📅 {j.user}
                        </span>
                      ) : (
                        j.user
                      )
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={j.status} />
                  </td>
                  <td className="px-4 py-2">{Math.round(j.job_pct * 100)}%</td>
                  <td className="px-4 py-2 text-slate-400">
                    {new Date(j.started_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <a
                      href={`/jobs/${j.job_id}`}
                      className="text-accent hover:underline"
                    >
                      Ver →
                    </a>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => onDelete(j)}
                      className="text-red-400 hover:text-red-200"
                      title="Eliminar ejecución (y sus logs)"
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
          defaultRunName={`${selected.replace(/\.json$/, "")} · ${new Date()
            .toISOString()
            .slice(0, 10)}`}
          initialValues={paramPrompt.initialValues}
          onCancel={() => setParamPrompt(null)}
          onResolved={async (args) => {
            const cb = paramPrompt.onResolved;
            setParamPrompt(null);
            await cb(args);
          }}
        />
      )}
    </section>
  );
}

function SortableTh({
  children,
  col,
  sortCol,
  sortDir,
  onSort,
}: {
  children: React.ReactNode;
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
}) {
  const active = sortCol === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`text-left px-4 py-2 cursor-pointer select-none hover:text-app ${
        active ? "text-app" : ""
      }`}
    >
      {children}
      <span className="ml-1 text-dim">
        {active ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
      </span>
    </th>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    running: {
      cls: "bg-yellow-500/20 text-yellow-300 border-yellow-700",
      label: "ejecutando",
    },
    ok: {
      cls: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
      label: "ok",
    },
    failed: {
      cls: "bg-red-500/20 text-red-300 border-red-700",
      label: "falló",
    },
    cancelled: {
      cls: "bg-slate-500/20 text-slate-300 border-slate-700",
      label: "cancelado",
    },
  };
  const v = map[status] ?? {
    cls: "bg-slate-500/20 text-slate-300 border-slate-700",
    label: status,
  };
  return (
    <span
      className={`inline-block text-xs px-2 py-0.5 rounded border ${v.cls}`}
    >
      {v.label}
    </span>
  );
}
