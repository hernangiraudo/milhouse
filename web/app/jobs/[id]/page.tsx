"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { useParams } from "next/navigation";
import { cancelJob } from "@/lib/api";
import { openJobSocket } from "@/lib/ws";
import type {
  JobState,
  StepInfo,
  StepRuntimeState,
  WsMessage,
} from "@/lib/types";
import { EtaBadge } from "@/components/EtaBadge";
import { StepColumns } from "@/components/StepColumns";
import { LogsPanel } from "@/components/LogsPanel";
import { SamplePanel } from "@/components/SamplePanel";
import { StepDetails } from "@/components/StepDetails";
import { DagView } from "@/components/DagView";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserChip } from "@/components/LoginGate";

type State = JobState | null;

type Action =
  | { type: "snapshot"; state: JobState }
  | { type: "ws"; message: WsMessage };

function reducer(prev: State, action: Action): State {
  if (action.type === "snapshot") {
    return action.state;
  }
  const m = action.message;
  if (!prev) {
    if (m.type === "snapshot") return m.state;
    return prev;
  }
  const next: JobState = {
    ...prev,
    steps: { ...prev.steps },
  };
  switch (m.type) {
    case "snapshot":
      return m.state;
    case "job_started":
      return next;
    case "step_state_changed": {
      const cur = next.steps[m.step_id];
      if (cur) {
        next.steps[m.step_id] = { ...cur, state: m.state as StepRuntimeState };
      }
      return next;
    }
    case "step_progress": {
      const cur = next.steps[m.step_id];
      if (cur && cur.state.state === "running") {
        next.steps[m.step_id] = {
          ...cur,
          state: {
            ...cur.state,
            progress: m.pct,
            rows_done: m.rows_done ?? null,
            rows_total: m.rows_total ?? null,
          },
        };
      }
      return next;
    }
    case "step_log": {
      const cur = next.steps[m.step_id];
      if (cur) {
        next.steps[m.step_id] = {
          ...cur,
          logs: [
            ...cur.logs,
            { at: new Date().toISOString(), level: m.level, line: m.line },
          ],
        };
      }
      return next;
    }
    case "step_completed": {
      const cur = next.steps[m.step_id];
      if (cur) {
        next.steps[m.step_id] = {
          ...cur,
          sample: m.sample ?? cur.sample,
          state: {
            state: "done",
            started_at:
              cur.state.state === "running" ? cur.state.started_at : new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: m.duration_ms,
            row_count: m.row_count,
          },
        };
      }
      return next;
    }
    case "job_eta":
      next.job_pct = m.job_pct;
      next.eta_seconds = m.eta_seconds;
      return next;
    case "job_finished":
      next.status = m.status;
      next.finished_at = new Date().toISOString();
      next.job_pct = 1.0;
      next.eta_seconds = 0;
      return next;
    case "error":
      return next;
  }
  return next;
}

export default function JobPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [state, dispatch] = useReducer(reducer, null as State);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "logs" | "sample">("details");
  const [view, setView] = useState<"kanban" | "dag">("dag");
  const [wsOpen, setWsOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    const ws = openJobSocket(
      id,
      (m) => {
        if (m.type === "snapshot") {
          dispatch({ type: "snapshot", state: m.state });
        } else {
          dispatch({ type: "ws", message: m });
        }
      },
      () => setWsOpen(false),
    );
    ws.onopen = () => setWsOpen(true);
    return () => ws.close();
  }, [id]);

  const selected: StepInfo | null = useMemo(() => {
    if (!state || !selectedStep) return null;
    return state.steps[selectedStep] ?? null;
  }, [state, selectedStep]);

  if (!state) {
    return (
      <main className="min-h-screen p-8 max-w-7xl mx-auto">
        <a href="/" className="text-accent hover:underline">
          ← back
        </a>
        <p className="mt-8 text-slate-400">Conectando al job…</p>
      </main>
    );
  }

  const stepsDone = state.step_order.filter(
    (id) => state.steps[id]?.state.state === "done",
  ).length;

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <a href="/" className="text-accent hover:underline text-sm">
            ← jobs
          </a>
          <h1 className="text-2xl font-bold mt-1" title={state.config_name}>
            {state.config_display_name ?? state.config_name}{" "}
            <span className="text-slate-500 font-mono text-base">
              · {state.job_id.slice(0, 8)}
            </span>
          </h1>
          <div className="text-xs text-slate-500 mt-1">
            {wsOpen ? "● live" : "○ disconnected"} · status:{" "}
            <span className="text-slate-300">{state.status}</span>
            {state.user && (
              <>
                {" "}· lanzado por{" "}
                <code className="milhouse-chip" style={{ fontSize: "0.65rem" }}>
                  {state.user}
                </code>
              </>
            )}
            {state.debug && (
              <span
                className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-700"
                style={{ color: "#f59e0b" }}
              >
                debug
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <EtaBadge
            jobPct={state.job_pct}
            etaSeconds={state.eta_seconds}
            stepsDone={stepsDone}
            stepsTotal={state.step_order.length}
          />
          <button
            onClick={() => cancelJob(id)}
            disabled={state.status !== "running"}
            className="bg-red-500/80 hover:bg-red-500 text-white px-3 py-1.5 rounded-md text-sm disabled:opacity-30"
          >
            Cancelar
          </button>
          <UserChip />
          <ThemeToggle />
        </div>
      </header>

      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-300">
            {view === "kanban" ? "Estado por columnas" : "Grafo de dependencias"}
          </h2>
          <div className="flex gap-1 text-xs">
            <ViewToggle active={view === "dag"} onClick={() => setView("dag")}>
              DAG
            </ViewToggle>
            <ViewToggle
              active={view === "kanban"}
              onClick={() => setView("kanban")}
            >
              Kanban
            </ViewToggle>
          </div>
        </div>
        {view === "kanban" ? (
          <StepColumns
            steps={state.steps}
            order={state.step_order}
            groups={state.groups}
            selectedId={selectedStep}
            onSelect={setSelectedStep}
          />
        ) : (
          <DagView
            steps={state.steps}
            order={state.step_order}
            groups={state.groups}
            selectedId={selectedStep}
            onSelect={setSelectedStep}
          />
        )}
      </section>

      <section className="bg-panel rounded-xl border border-slate-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">
            {selected ? (
              <>
                Detalle de{" "}
                <span className="font-mono text-accent">{selected.id}</span>
              </>
            ) : (
              <span className="text-slate-400">Seleccioná un step…</span>
            )}
          </h2>
          {selected && (
            <div className="flex gap-1 text-sm">
              <Tab
                active={tab === "details"}
                onClick={() => setTab("details")}
              >
                Detalle
              </Tab>
              <Tab active={tab === "logs"} onClick={() => setTab("logs")}>
                Logs ({selected.logs.length})
              </Tab>
              <Tab active={tab === "sample"} onClick={() => setTab("sample")}>
                Sample
              </Tab>
            </div>
          )}
        </div>
        {selected && tab === "details" && <StepDetails info={selected} />}
        {selected && tab === "logs" && <LogsPanel logs={selected.logs} />}
        {selected && tab === "sample" && (
          <SamplePanel sample={selected.sample} />
        )}
      </section>
    </main>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded ${
        active
          ? "bg-accent text-ink"
          : "bg-panel2 text-slate-300 hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

function ViewToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded border ${
        active
          ? "bg-accent text-ink border-accent"
          : "bg-panel2 text-slate-300 border-slate-700 hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}
