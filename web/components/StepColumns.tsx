"use client";

import type { GroupMeta, StepInfo } from "@/lib/types";
import { StepCard } from "./StepCard";

type Bucket = "pending" | "running" | "done" | "failed";

export function StepColumns({
  steps,
  order,
  groups,
  selectedId,
  onSelect,
}: {
  steps: Record<string, StepInfo>;
  order: string[];
  groups?: GroupMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Asignar cada step a su bucket de estado.
  function bucketOf(info: StepInfo): Bucket {
    const s = info.state.state;
    if (s === "pending" || s === "ready") return "pending";
    if (s === "running") return "running";
    if (s === "done") return "done";
    return "failed";
  }

  // Lista de grupos a usar (orden: explícitos del config + inferidos del order).
  const groupOrder: string[] = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    if (groups) {
      for (const g of groups) {
        if (!seen.has(g.name)) {
          seen.add(g.name);
          out.push(g.name);
        }
      }
    }
    for (const id of order) {
      const g = steps[id]?.group;
      if (g && !seen.has(g)) {
        seen.add(g);
        out.push(g);
      }
    }
    return out;
  })();

  // Para cada bucket, organizar los steps por grupo + un bucket de "sin grupo".
  type Section = { group: string | null; items: StepInfo[] };
  const byBucket: Record<Bucket, Section[]> = {
    pending: [],
    running: [],
    done: [],
    failed: [],
  };
  const sectionMap: Record<Bucket, Record<string, StepInfo[]>> = {
    pending: {},
    running: {},
    done: {},
    failed: {},
  };
  const ungrouped: Record<Bucket, StepInfo[]> = {
    pending: [],
    running: [],
    done: [],
    failed: [],
  };

  for (const id of order) {
    const info = steps[id];
    if (!info) continue;
    const bk = bucketOf(info);
    const g = info.group ?? null;
    if (!g) {
      ungrouped[bk].push(info);
    } else {
      sectionMap[bk][g] = sectionMap[bk][g] ?? [];
      sectionMap[bk][g].push(info);
    }
  }
  for (const bk of ["pending", "running", "done", "failed"] as const) {
    for (const g of groupOrder) {
      if (sectionMap[bk][g] && sectionMap[bk][g].length > 0) {
        byBucket[bk].push({ group: g, items: sectionMap[bk][g] });
      }
    }
    if (ungrouped[bk].length > 0) {
      byBucket[bk].push({ group: null, items: ungrouped[bk] });
    }
  }

  function total(bk: Bucket): number {
    return byBucket[bk].reduce((acc, s) => acc + s.items.length, 0);
  }

  const hasGroups = groupOrder.length > 0;

  return (
    <div className="grid grid-cols-4 gap-4">
      <Column title="Pending" count={total("pending")} tone="slate">
        {renderSections(byBucket.pending, selectedId, onSelect, hasGroups)}
      </Column>
      <Column title="Running" count={total("running")} tone="yellow">
        {renderSections(byBucket.running, selectedId, onSelect, hasGroups)}
      </Column>
      <Column title="Done" count={total("done")} tone="emerald">
        {renderSections(byBucket.done, selectedId, onSelect, hasGroups)}
      </Column>
      <Column title="Failed / Cancelled" count={total("failed")} tone="red">
        {renderSections(byBucket.failed, selectedId, onSelect, hasGroups)}
      </Column>
    </div>
  );
}

function renderSections(
  sections: Array<{ group: string | null; items: StepInfo[] }>,
  selectedId: string | null,
  onSelect: (id: string) => void,
  hasGroups: boolean,
) {
  if (sections.length === 0) return null;
  return sections.map((sec, idx) => (
    <div key={sec.group ?? "_ungrouped"} className={idx > 0 ? "mt-3" : ""}>
      {hasGroups && (
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1 flex items-center gap-2">
          <span className="font-semibold">
            {sec.group ?? "(sin grupo)"}
          </span>
          <span className="text-dim">{sec.items.length}</span>
          <span className="flex-1 h-px bg-surface-strong opacity-40" />
        </div>
      )}
      {sec.items.map((info) => (
        <StepCard
          key={info.id}
          info={info}
          onClick={() => onSelect(info.id)}
          selected={selectedId === info.id}
        />
      ))}
    </div>
  ));
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
