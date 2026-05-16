"use client";

import { useMemo } from "react";
import type { NodeStatus } from "./DesignCanvas";

interface StepLike {
  id: string;
  kind: string;
  depends_on?: string[];
  group?: string | null;
  [k: string]: unknown;
}

interface Props {
  jobId: string;
  steps: StepLike[];
  stepStates: Record<string, NodeStatus>;
  /** Sesión SQL Server por step (cuando el step está corriendo una query
   *  contra SQL Server). Muestra el SPID al lado del paso y permite
   *  cancelar la query con KILL. */
  stepSessions?: Record<string, { connection: string; sid: number }>;
  stepStartedAt?: Record<string, string>; // timestamp ISO opcional
  /** Subset activo de la ejecución actual (target_steps). Si está, los
   *  pasos fuera del subset no se muestran. */
  activeSubset?: Set<string> | null;
  onCancelAll: () => void;
  onDrain: () => void;
  onCancelStep: (stepId: string) => void;
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
  steps,
  stepStates,
  stepSessions,
  activeSubset,
  onCancelAll,
  onDrain,
  onCancelStep,
}: Props) {
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

  return (
    <div className="bg-panel border border-surface rounded-xl p-3 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs uppercase tracking-wider text-muted">
            Cola de ejecución
          </h4>
          <code className="text-[11px] text-dim">
            job {jobId.slice(0, 8)}
          </code>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
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
                {items.map((s) => {
                  const status: NodeStatus = stepStates[s.id] ?? "idle";
                  // Cancelar uno: aplica a pendientes/ready y también a
                  // running (cuando hay sql_session, el backend manda KILL;
                  // si no hay session, igual se marca cancelled aunque el
                  // task siga corriendo hasta detectar el cancel global).
                  const canCancel =
                    (b === "waiting" &&
                      (status === "pending" || status === "ready")) ||
                    b === "running";
                  const session = stepSessions?.[s.id];
                  return (
                    <li
                      key={s.id}
                      className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded hover:bg-surface-2"
                    >
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
