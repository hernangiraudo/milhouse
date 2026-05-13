"use client";

import type { StepInfo } from "@/lib/types";
import { StepCard } from "./StepCard";

export function StepColumns({
  steps,
  order,
  selectedId,
  onSelect,
}: {
  steps: Record<string, StepInfo>;
  order: string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups: Record<string, StepInfo[]> = {
    pending: [],
    running: [],
    done: [],
    failed: [],
  };
  for (const id of order) {
    const info = steps[id];
    if (!info) continue;
    const s = info.state.state;
    if (s === "pending" || s === "ready") groups.pending.push(info);
    else if (s === "running") groups.running.push(info);
    else if (s === "done") groups.done.push(info);
    else groups.failed.push(info);
  }

  return (
    <div className="grid grid-cols-4 gap-4">
      <Column title="Pending" count={groups.pending.length} tone="slate">
        {groups.pending.map((s) => (
          <StepCard
            key={s.id}
            info={s}
            onClick={() => onSelect(s.id)}
            selected={selectedId === s.id}
          />
        ))}
      </Column>
      <Column title="Running" count={groups.running.length} tone="yellow">
        {groups.running.map((s) => (
          <StepCard
            key={s.id}
            info={s}
            onClick={() => onSelect(s.id)}
            selected={selectedId === s.id}
          />
        ))}
      </Column>
      <Column title="Done" count={groups.done.length} tone="emerald">
        {groups.done.map((s) => (
          <StepCard
            key={s.id}
            info={s}
            onClick={() => onSelect(s.id)}
            selected={selectedId === s.id}
          />
        ))}
      </Column>
      <Column title="Failed / Cancelled" count={groups.failed.length} tone="red">
        {groups.failed.map((s) => (
          <StepCard
            key={s.id}
            info={s}
            onClick={() => onSelect(s.id)}
            selected={selectedId === s.id}
          />
        ))}
      </Column>
    </div>
  );
}

function Column({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone: "slate" | "yellow" | "emerald" | "red";
  children: React.ReactNode;
}) {
  const toneCls: Record<typeof tone, string> = {
    slate: "text-slate-300",
    yellow: "text-yellow-300",
    emerald: "text-emerald-300",
    red: "text-red-300",
  };
  return (
    <div className="bg-panel rounded-xl border border-slate-800 p-3 min-h-[200px]">
      <h3 className={`text-sm font-semibold mb-3 ${toneCls[tone]}`}>
        {title}{" "}
        <span className="text-slate-500 font-normal">({count})</span>
      </h3>
      <div>{children}</div>
    </div>
  );
}
