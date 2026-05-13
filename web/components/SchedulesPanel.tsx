"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createSchedule,
  deleteSchedule,
  listConfigs,
  listSchedules,
  patchSchedule,
  type ConfigSummary,
  type ScheduleDto,
  type ScheduleSpec,
} from "@/lib/api";
import { useUser } from "@/lib/session";

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

type Mode = "at" | "window" | "cron";

export function SchedulesPanel() {
  const me = useUser();
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

  async function reload() {
    try {
      const [s, c] = await Promise.all([listSchedules(), listConfigs()]);
      setList(s);
      setConfigs(c);
      if (!configName && c.length > 0) setConfigName(c[0].name);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
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
    setBusy(true);
    setErr(null);
    try {
      await createSchedule({
        name: name.trim(),
        config_name: configName,
        spec,
        created_by: me,
        enabled: true,
      });
      setName("");
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
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
    if (!confirm(`¿Eliminar el schedule "${name}"?`)) return;
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
            disabled={busy || !name.trim() || !configName}
            className="font-semibold px-4 py-2 rounded-md disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {busy ? "Creando…" : "Crear schedule"}
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
