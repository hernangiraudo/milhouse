"use client";

import type { StepInfo } from "@/lib/types";

export function StepCard({
  info,
  onClick,
  selected,
}: {
  info: StepInfo;
  onClick: () => void;
  selected: boolean;
}) {
  const s = info.state;
  const isRunning = s.state === "running";
  const isDone = s.state === "done";
  const isFailed = s.state === "failed";
  const isCancelled = s.state === "cancelled";
  const isSkipped = s.state === "skipped";

  const color =
    isRunning
      ? "border-yellow-700 bg-yellow-500/10"
      : isDone
      ? "border-emerald-700 bg-emerald-500/10"
      : isFailed
      ? "border-red-700 bg-red-500/10"
      : isCancelled || isSkipped
      ? "border-slate-700 bg-slate-500/10"
      : "border-slate-700 bg-panel2";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border ${color} p-3 mb-2 hover:border-accent transition-colors ${
        selected ? "ring-2 ring-accent" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm">{info.id}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">
          {info.kind}
        </span>
      </div>
      {info.output_table && (
        <div className="text-xs text-slate-500 mt-1 font-mono">
          → {info.output_table}
        </div>
      )}
      {isRunning && (
        <div className="mt-2">
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-yellow-400 h-full transition-all"
              style={{ width: `${Math.round((s.progress ?? 0) * 100)}%` }}
            />
          </div>
          <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
            {Math.round((s.progress ?? 0) * 100)}%
            {s.rows_done != null && s.rows_total != null && (
              <span>
                {" "}
                · {s.rows_done.toLocaleString()} / {s.rows_total.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
      {isDone && (
        <div className="text-[11px] text-emerald-300/80 mt-1 tabular-nums">
          {s.row_count.toLocaleString()} filas · {s.duration_ms} ms
        </div>
      )}
      {isFailed && (
        <div className="text-[11px] text-red-300/80 mt-1 truncate">
          {s.error.split("\n")[0]}
        </div>
      )}
      {isSkipped && (
        <div className="text-[11px] text-slate-400 mt-1 truncate">
          skipped: {s.reason}
        </div>
      )}
    </button>
  );
}
