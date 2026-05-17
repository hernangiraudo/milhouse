"use client";

import { useEffect, useMemo, useState } from "react";
import type { NodeStatus } from "./DesignCanvas";

export interface StepStats {
  startedAtMs?: number;
  durationMs?: number;
  rowCount?: number;
}

interface StepLike {
  id: string;
  kind: string;
  depends_on?: string[];
  group?: string | null;
  [k: string]: unknown;
}

interface Props {
  jobId: string;
  /** true mientras el job está corriendo; false cuando ya terminó pero
   *  todavía mostramos el resumen. Cuando es false, los botones de
   *  cancelar quedan deshabilitados y aparece "Limpiar y cerrar". */
  isActive: boolean;
  steps: StepLike[];
  stepStates: Record<string, NodeStatus>;
  /** Sesión SQL Server por step (cuando el step está corriendo una query
   *  contra SQL Server). Muestra el SPID al lado del paso y permite
   *  cancelar la query con KILL. */
  stepSessions?: Record<string, { connection: string; sid: number }>;
  /** Métricas por step: tiempo de inicio (running clock) + filas/duración (done). */
  stepStats?: Record<string, StepStats>;
  stepStartedAt?: Record<string, string>; // timestamp ISO opcional
  /** Subset activo de la ejecución actual (target_steps). Si está, los
   *  pasos fuera del subset no se muestran. */
  activeSubset?: Set<string> | null;
  onCancelAll: () => void;
  onDrain: () => void;
  onCancelStep: (stepId: string) => void;
  /** Limpia el estado local y cierra el panel. Disponible cuando el
   *  job ya no está activo. */
  onClearAndClose?: () => void;
}

type Bucket = "running" | "waiting" | "done" | "failed" | "cancelled" | "skipped";

const BUCKET_META: Record<
  Bucket,
  { label: string; color: string; bg: string }
> = {
  running: {
    label: "Ejecutando",
    color: "#0ea5e9",
    bg: "rgba(14,165,233,0.10)",
  },
  waiting: {
    label: "Esperando",
    color: "#a855f7",
    bg: "rgba(168,85,247,0.10)",
  },
  done: {
    label: "Terminadas",
    color: "#10b981",
    bg: "rgba(16,185,129,0.08)",
  },
  failed: {
    label: "Fallidas",
    color: "#ef4444",
    bg: "rgba(239,68,68,0.10)",
  },
  cancelled: {
    label: "Canceladas",
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.10)",
  },
  skipped: {
    label: "Salteadas",
    color: "#64748b",
    bg: "rgba(100,116,139,0.08)",
  },
};

const BUCKET_ORDER: Bucket[] = [
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "skipped",
];

function classify(status: NodeStatus): Bucket {
  switch (status) {
    case "running":
      return "running";
    case "pending":
    case "ready":
    case "idle":
      return "waiting";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
  }
}

/**
 * Panel de ejecución en vivo: agrupa los pasos por estado para que el
 * operador vea de un vistazo qué corre, qué espera, qué terminó y qué
 * falló. Permite cancelar uno (pendientes/ready), drenar (deja terminar
 * los Running) o cancelar todo.
 */
export function RunQueuePanel({
  jobId,
  isActive,
  steps,
  stepStates,
  stepSessions,
  stepStats,
  activeSubset,
  onCancelAll,
  onDrain,
  onCancelStep,
  onClearAndClose,
}: Props) {
  // Tick para que el clock de "Running" se actualice cada segundo sin
  // requerir nuevos eventos del backend.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;
  const buckets = useMemo(() => {
    const out: Record<Bucket, StepLike[]> = {
      running: [],
      waiting: [],
      done: [],
      failed: [],
      cancelled: [],
      skipped: [],
    };
    for (const s of steps) {
      if (activeSubset && !activeSubset.has(s.id)) continue;
      const st: NodeStatus = stepStates[s.id] ?? "idle";
      out[classify(st)].push(s);
    }
    return out;
  }, [steps, stepStates, activeSubset]);

  const runningCount = buckets.running.length;
  const waitingCount = buckets.waiting.length;

  // Lugar en cola para los waiting: orden = priority desc, después orden
  // original del proyecto. Espejo del scheduler. Solo asigna posición a
  // los Pending/Ready (los waiting reales) — los Running tienen su clock,
  // los Done están terminados.
  const queuePosition = useMemo(() => {
    const order: Record<string, number> = {};
    const prioRank = (p: unknown) =>
      p === "high" ? 0 : p === "low" ? 2 : 1;
    const stepIdxByOrig = new Map<string, number>(
      steps.map((s, i) => [s.id, i]),
    );
    const sorted = [...buckets.waiting].sort((a, b) => {
      const pa = prioRank((a as { priority?: unknown }).priority);
      const pb = prioRank((b as { priority?: unknown }).priority);
      if (pa !== pb) return pa - pb;
      return (
        (stepIdxByOrig.get(a.id) ?? 0) - (stepIdxByOrig.get(b.id) ?? 0)
      );
    });
    sorted.forEach((s, idx) => {
      order[s.id] = idx + 1;
    });
    return order;
  }, [buckets.waiting, steps]);

  // Agregados para el header: total de filas devueltas (suma de Done) y
  // duración total (suma de durationMs de Done; aprox del job).
  const totals = useMemo(() => {
    let rows = 0;
    let rowsAny = false;
    let durMs = 0;
    let durAny = false;
    for (const s of buckets.done) {
      const st = stepStats?.[s.id];
      if (!st) continue;
      if (typeof st.rowCount === "number") {
        rows += st.rowCount;
        rowsAny = true;
      }
      if (typeof st.durationMs === "number") {
        durMs += st.durationMs;
        durAny = true;
      }
    }
    return { rows: rowsAny ? rows : null, durMs: durAny ? durMs : null };
  }, [buckets.done, stepStats]);

  return (
    <div className="bg-panel border border-surface rounded-xl p-3 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-xs uppercase tracking-wider text-muted">
            Cola de ejecución{isActive ? "" : " · terminada"}
          </h4>
          <code className="text-[11px] text-dim">
            job {jobId.slice(0, 8)}
          </code>
          {totals.rows != null && (
            <span className="text-[11px] text-dim tabular-nums">
              · {totals.rows.toLocaleString("es-AR")} filas
            </span>
          )}
          {totals.durMs != null && (
            <span className="text-[11px] text-dim tabular-nums">
              · Σ {fmtDuration(totals.durMs)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {isActive ? (
            <>
              <button
                onClick={onDrain}
                disabled={waitingCount === 0}
                className="text-xs px-2 py-1 rounded border border-amber-700 bg-amber-500/20 text-amber-300 disabled:opacity-40"
                title="Cancela los pasos pendientes/ready. Los que están corriendo terminan."
              >
                ⏸ Drenar pendientes
              </button>
              <button
                onClick={onCancelAll}
                disabled={runningCount === 0 && waitingCount === 0}
                className="text-xs px-2 py-1 rounded border border-red-700 bg-red-500/20 text-red-300 disabled:opacity-40"
                title="Cancela todo el job (running + pendientes)"
              >
                ⏹ Cancelar todo
              </button>
            </>
          ) : (
            onClearAndClose && (
              <button
                onClick={onClearAndClose}
                className="text-xs px-2 py-1 rounded milhouse-btn-secondary"
                title="Limpia la lista y cierra el panel. Los datos siguen disponibles en Revisión."
              >
                ✕ Limpiar y cerrar
              </button>
            )
          )}
        </div>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {BUCKET_ORDER.map((b) => {
          const items = buckets[b];
          if (items.length === 0) return null;
          const meta = BUCKET_META[b];
          return (
            <div
              key={b}
              className="rounded-lg border p-2"
              style={{
                borderColor: meta.color + "55",
                background: meta.bg,
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: meta.color }}
                >
                  {meta.label}
                </span>
                <code
                  className="text-[10px] font-mono"
                  style={{ color: meta.color }}
                >
                  {items.length}
                </code>
              </div>
              <ul className="space-y-0.5">
                {(b === "waiting"
                  ? [...items].sort(
                      (a, c) =>
                        (queuePosition[a.id] ?? 999) -
                        (queuePosition[c.id] ?? 999),
                    )
                  : items
                ).map((s) => {
                  const status: NodeStatus = stepStates[s.id] ?? "idle";
                  // Cancelar uno: aplica a pendientes/ready y también a
                  // running (cuando hay sql_session, el backend manda KILL;
                  // si no hay session, igual se marca cancelled aunque el
                  // task siga corriendo hasta detectar el cancel global).
                  const canCancel =
                    isActive &&
                    ((b === "waiting" &&
                      (status === "pending" || status === "ready")) ||
                      b === "running");
                  const session = stepSessions?.[s.id];
                  const prio = (s as { priority?: string }).priority;
                  const queuePos = queuePosition[s.id];
                  return (
                    <li
                      key={s.id}
                      className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded hover:bg-surface-2"
                    >
                      {b === "waiting" && queuePos != null && (
                        <span
                          className="text-[10px] font-mono text-dim shrink-0 w-6 text-right"
                          title={`Lugar en la cola: #${queuePos}`}
                        >
                          #{queuePos}
                        </span>
                      )}
                      {b === "running" && (
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full"
                          style={{
                            background: meta.color,
                            animation: "milhouse-pulse 1.2s infinite",
                          }}
                          aria-hidden
                        />
                      )}
                      <code
                        className="font-mono flex-1 truncate"
                        title={
                          session
                            ? `${s.id} · ${s.kind} · SPID ${session.sid} en ${session.connection}`
                            : `${s.id} · ${s.kind}`
                        }
                      >
                        {s.id}
                      </code>
                      {prio && prio !== "normal" && (
                        <span
                          className={`text-[9px] px-1 rounded font-semibold uppercase tracking-wider ${
                            prio === "high"
                              ? "bg-amber-500/20 text-amber-300 border border-amber-700"
                              : "bg-slate-500/20 text-slate-300 border border-slate-700"
                          }`}
                          title={`Prioridad ${prio}`}
                        >
                          {prio === "high" ? "★" : "▼"}
                        </span>
                      )}
                      {session && b === "running" && (
                        <span
                          className="text-[10px] px-1 rounded font-mono"
                          style={{
                            background: "rgba(14,165,233,0.15)",
                            color: "#0ea5e9",
                            border: "1px solid rgba(14,165,233,0.4)",
                          }}
                          title={`Sesión SQL Server ${session.sid} en ${session.connection}. Al cancelar este paso se manda KILL ${session.sid}.`}
                        >
                          SPID {session.sid}
                        </span>
                      )}
                      {(() => {
                        const st = stepStats?.[s.id];
                        if (!st) return null;
                        if (b === "running" && st.startedAtMs != null) {
                          const elapsed = performance.now() - st.startedAtMs;
                          return (
                            <span
                              className="text-[10px] text-dim font-mono tabular-nums shrink-0"
                              title="Tiempo transcurrido"
                            >
                              {fmtDuration(elapsed)}
                            </span>
                          );
                        }
                        if (b === "done") {
                          const parts: string[] = [];
                          if (typeof st.rowCount === "number") {
                            parts.push(`${st.rowCount.toLocaleString("es-AR")} filas`);
                          }
                          if (typeof st.durationMs === "number") {
                            parts.push(fmtDuration(st.durationMs));
                          }
                          if (parts.length === 0) return null;
                          return (
                            <span
                              className="text-[10px] text-dim font-mono tabular-nums shrink-0"
                              title={parts.join(" · ")}
                            >
                              {parts.join(" · ")}
                            </span>
                          );
                        }
                        return null;
                      })()}
                      <span className="text-[9px] text-dim shrink-0">
                        {s.kind}
                      </span>
                      {canCancel && (
                        <button
                          onClick={() => onCancelStep(s.id)}
                          className="text-[10px] px-1 text-red-400 hover:text-red-300"
                          title={
                            b === "running"
                              ? session
                                ? `Cancelar este paso (manda KILL ${session.sid} al SQL Server)`
                                : "Cancelar este paso"
                              : "Cancelar este paso"
                          }
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <style>{`
        @keyframes milhouse-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s - mins * 60);
  return `${mins}m ${rem}s`;
}
