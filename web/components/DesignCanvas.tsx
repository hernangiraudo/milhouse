"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "./StepEditor";
import { useTheme } from "@/lib/useTheme";
import { useDialog } from "./Dialog";

// =====================================================================
// Paletas por kind, duales (dark/light).
// =====================================================================
type KindMeta = {
  value: string;
  label: string;
  icon: string;
  stroke: { dark: string; light: string };
  fill: { dark: string; light: string };
  textPrimary: { dark: string; light: string };
  textSecondary: { dark: string; light: string };
};

const KIND_MENU: KindMeta[] = [
  {
    value: "sql_query", label: "SQL query", icon: "▼",
    stroke: { dark: "#38bdf8", light: "#0369a1" },
    fill: { dark: "rgba(12,74,110,0.8)", light: "#dbeafe" },
    textPrimary: { dark: "#e0f2fe", light: "#0c4a6e" },
    textSecondary: { dark: "#7dd3fc", light: "#0369a1" },
  },
  {
    value: "sql_exec", label: "SQL exec", icon: "⚙",
    stroke: { dark: "#60a5fa", light: "#1d4ed8" },
    fill: { dark: "rgba(30,58,138,0.8)", light: "#dbeafe" },
    textPrimary: { dark: "#dbeafe", light: "#1e3a8a" },
    textSecondary: { dark: "#93c5fd", light: "#1d4ed8" },
  },
  {
    value: "join", label: "Join", icon: "⋈",
    stroke: { dark: "#a78bfa", light: "#6d28d9" },
    fill: { dark: "rgba(76,29,149,0.8)", light: "#ede9fe" },
    textPrimary: { dark: "#ede9fe", light: "#4c1d95" },
    textSecondary: { dark: "#c4b5fd", light: "#6d28d9" },
  },
  {
    value: "lookup", label: "Lookup", icon: "🔎",
    stroke: { dark: "#e879f9", light: "#a21caf" },
    fill: { dark: "rgba(112,26,117,0.8)", light: "#fae8ff" },
    textPrimary: { dark: "#fae8ff", light: "#701a75" },
    textSecondary: { dark: "#f0abfc", light: "#a21caf" },
  },
  {
    value: "transform", label: "Transform", icon: "ƒ",
    stroke: { dark: "#fbbf24", light: "#b45309" },
    fill: { dark: "rgba(120,53,15,0.8)", light: "#fef3c7" },
    textPrimary: { dark: "#fef3c7", light: "#78350f" },
    textSecondary: { dark: "#fcd34d", light: "#b45309" },
  },
  {
    value: "filter_and_subset", label: "Filter & subset", icon: "▾",
    stroke: { dark: "#22d3ee", light: "#0e7490" },
    fill: { dark: "rgba(22,78,99,0.8)", light: "#cffafe" },
    textPrimary: { dark: "#cffafe", light: "#164e63" },
    textSecondary: { dark: "#67e8f9", light: "#0e7490" },
  },
  {
    value: "sort", label: "Sort", icon: "↕",
    stroke: { dark: "#2dd4bf", light: "#0f766e" },
    fill: { dark: "rgba(19,78,74,0.8)", light: "#ccfbf1" },
    textPrimary: { dark: "#ccfbf1", light: "#134e4a" },
    textSecondary: { dark: "#5eead4", light: "#0f766e" },
  },
  {
    value: "procedural", label: "Procedural (Rhai/Rust)", icon: "λ",
    stroke: { dark: "#fb7185", light: "#be123c" },
    fill: { dark: "rgba(136,19,55,0.8)", light: "#ffe4e6" },
    textPrimary: { dark: "#ffe4e6", light: "#881337" },
    textSecondary: { dark: "#fda4af", light: "#be123c" },
  },
  {
    value: "export", label: "Export", icon: "⇧",
    stroke: { dark: "#a3e635", light: "#4d7c0f" },
    fill: { dark: "rgba(54,83,20,0.8)", light: "#ecfccb" },
    textPrimary: { dark: "#ecfccb", light: "#365314" },
    textSecondary: { dark: "#bef264", light: "#4d7c0f" },
  },
];

const FALLBACK_META: KindMeta = {
  value: "?", label: "?", icon: "?",
  stroke: { dark: "#94a3b8", light: "#475569" },
  fill: { dark: "rgba(15,23,42,0.6)", light: "#f1f5f9" },
  textPrimary: { dark: "#e2e8f0", light: "#0f172a" },
  textSecondary: { dark: "#94a3b8", light: "#475569" },
};

function kindMeta(kind: string): KindMeta {
  return KIND_MENU.find((m) => m.value === kind) ?? FALLBACK_META;
}

// =====================================================================
// Layout
// =====================================================================
const NODE_W = 180;
const NODE_H = 56;
const COL_GAP = 100;
const ROW_GAP = 24;
const PAD = 24;
const GROUP_PAD_X = 16;
const GROUP_HEADER_H = 28;
const GROUP_PAD_BOTTOM = 12;

interface ProjectShape {
  steps: Step[];
  groups?: Array<{
    name: string;
    description?: string | null;
    color?: string | null;
    parent_group?: string | null;
  }>;
  [k: string]: unknown;
}

interface NodeLayout {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GroupLayout {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  stepIds: string[];
}

interface LayoutResult {
  nodes: NodeLayout[];
  groups: GroupLayout[];
  nodeIndex: Record<string, NodeLayout>;
  width: number;
  height: number;
}

function layoutNodes(
  steps: Step[],
  collapsedGroups: Set<string>,
  groupMetas: ProjectShape["groups"] = [],
): LayoutResult {
  if (steps.length === 0) {
    return { nodes: [], groups: [], nodeIndex: {}, width: 400, height: 200 };
  }
  // Mapa nombre→parent
  const parentOfGroup: Record<string, string | null> = {};
  for (const g of groupMetas ?? []) {
    parentOfGroup[g.name] = g.parent_group ?? null;
  }

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const unitOfStep: Record<string, string> = {};
  const stepsOfGroup: Record<string, string[]> = {};
  for (const s of steps) {
    if (s.group && collapsedGroups.has(s.group)) {
      unitOfStep[s.id] = `group:${s.group}`;
      stepsOfGroup[`group:${s.group}`] = stepsOfGroup[`group:${s.group}`] ?? [];
      stepsOfGroup[`group:${s.group}`].push(s.id);
    } else {
      unitOfStep[s.id] = s.id;
    }
  }
  const unitIds: string[] = [];
  const seenU = new Set<string>();
  for (const s of steps) {
    const u = unitOfStep[s.id];
    if (!seenU.has(u)) {
      seenU.add(u);
      unitIds.push(u);
    }
  }

  const level: Record<string, number> = {};
  function unitDeps(u: string): string[] {
    if (u.startsWith("group:")) {
      const ids = stepsOfGroup[u] ?? [];
      const set = new Set<string>();
      for (const sid of ids) {
        const s = stepById.get(sid);
        for (const d of s?.depends_on ?? []) {
          const du = unitOfStep[d];
          if (du && du !== u) set.add(du);
        }
      }
      return Array.from(set);
    }
    const s = stepById.get(u);
    return (s?.depends_on ?? [])
      .map((d) => unitOfStep[d])
      .filter((d) => d && d !== u);
  }
  function getLevel(uid: string, visiting: Set<string>): number {
    if (level[uid] != null) return level[uid];
    if (visiting.has(uid)) return 0;
    visiting.add(uid);
    const deps = unitDeps(uid);
    level[uid] =
      deps.length === 0
        ? 0
        : Math.max(...deps.map((d) => getLevel(d, visiting))) + 1;
    visiting.delete(uid);
    return level[uid];
  }
  unitIds.forEach((u) => getLevel(u, new Set()));

  const byLevel: Record<number, string[]> = {};
  let maxLevel = 0;
  for (const u of unitIds) {
    const l = level[u] ?? 0;
    byLevel[l] = byLevel[l] ?? [];
    byLevel[l].push(u);
    maxLevel = Math.max(maxLevel, l);
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let l = 1; l <= maxLevel; l++) {
      const prev = byLevel[l - 1] ?? [];
      const idx = (id: string) => prev.indexOf(id);
      byLevel[l].sort((a, b) => {
        const da = unitDeps(a);
        const db = unitDeps(b);
        const ma = da.length
          ? da.reduce((s, d) => s + (idx(d) >= 0 ? idx(d) : 0), 0) / da.length
          : 0;
        const mb = db.length
          ? db.reduce((s, d) => s + (idx(d) >= 0 ? idx(d) : 0), 0) / db.length
          : 0;
        return ma - mb;
      });
    }
  }

  const expandedGroups: Record<string, string[]> = {};
  for (const s of steps) {
    if (s.group && !collapsedGroups.has(s.group)) {
      expandedGroups[s.group] = expandedGroups[s.group] ?? [];
      expandedGroups[s.group].push(s.id);
    }
  }

  let maxRows = 0;
  for (let l = 0; l <= maxLevel; l++) {
    maxRows = Math.max(maxRows, byLevel[l]?.length ?? 0);
  }
  const totalH = maxRows * (NODE_H + ROW_GAP) - ROW_GAP + PAD * 2;

  const nodes: NodeLayout[] = [];
  const groups: GroupLayout[] = [];
  const nodeIndex: Record<string, NodeLayout> = {};
  const groupSteps: Record<string, NodeLayout[]> = {};
  for (const g of Object.keys(expandedGroups)) groupSteps[g] = [];

  for (let l = 0; l <= maxLevel; l++) {
    const col = byLevel[l] ?? [];
    const colH = col.length * (NODE_H + ROW_GAP) - ROW_GAP;
    const startY = (totalH - colH) / 2;
    col.forEach((u, i) => {
      const x = PAD + l * (NODE_W + COL_GAP);
      const y = startY + i * (NODE_H + ROW_GAP);
      if (u.startsWith("group:")) {
        const name = u.slice("group:".length);
        const node: NodeLayout = { id: u, x, y, w: NODE_W, h: NODE_H };
        groups.push({
          name,
          x,
          y,
          w: NODE_W,
          h: NODE_H,
          collapsed: true,
          stepIds: stepsOfGroup[u] ?? [],
        });
        nodeIndex[u] = node;
      } else {
        const node: NodeLayout = { id: u, x, y, w: NODE_W, h: NODE_H };
        nodes.push(node);
        nodeIndex[u] = node;
        const s = stepById.get(u);
        if (s?.group && !collapsedGroups.has(s.group)) {
          groupSteps[s.group].push(node);
        }
      }
    });
  }

  for (const [name, ns] of Object.entries(groupSteps)) {
    if (ns.length === 0) continue;
    const minX = Math.min(...ns.map((n) => n.x)) - GROUP_PAD_X;
    const maxX = Math.max(...ns.map((n) => n.x + n.w)) + GROUP_PAD_X;
    for (const n of ns) {
      n.y += GROUP_HEADER_H;
    }
    const minY = Math.min(...ns.map((n) => n.y)) - GROUP_HEADER_H;
    const maxY = Math.max(...ns.map((n) => n.y + n.h)) + GROUP_PAD_BOTTOM;
    groups.push({
      name,
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      collapsed: false,
      stepIds: ns.map((n) => n.id),
    });
  }

  // Anidamiento: si un grupo declara parent_group, el padre debe abarcar sus
  // hijos. Hacemos varias pasadas para que los abuelos absorban a los nietos.
  // Sólo aplica a grupos expandidos (los colapsados son super-nodos atómicos).
  const groupByName: Record<string, GroupLayout> = {};
  for (const g of groups) groupByName[g.name] = g;
  for (let pass = 0; pass < 4; pass++) {
    for (const g of groups) {
      if (g.collapsed) continue;
      const parent = parentOfGroup[g.name];
      if (!parent) continue;
      const pg = groupByName[parent];
      if (!pg || pg.collapsed) continue;
      // Empujar el padre para que englobe al hijo.
      const newMinX = Math.min(pg.x, g.x - GROUP_PAD_X);
      const newMinY = Math.min(pg.y, g.y - GROUP_HEADER_H);
      const newMaxX = Math.max(pg.x + pg.w, g.x + g.w + GROUP_PAD_X);
      const newMaxY = Math.max(pg.y + pg.h, g.y + g.h + GROUP_PAD_BOTTOM);
      pg.x = newMinX;
      pg.y = newMinY;
      pg.w = newMaxX - newMinX;
      pg.h = newMaxY - newMinY;
    }
  }

  const totalW = PAD * 2 + (maxLevel + 1) * NODE_W + maxLevel * COL_GAP;
  let actualMaxY = totalH;
  for (const n of nodes) actualMaxY = Math.max(actualMaxY, n.y + n.h + PAD);
  for (const g of groups) actualMaxY = Math.max(actualMaxY, g.y + g.h + PAD);

  return { nodes, groups, nodeIndex, width: totalW, height: actualMaxY };
}

// =====================================================================
// Componente
// =====================================================================

export type NodeStatus =
  | "idle"
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export type RunMode =
  | { kind: "single"; stepId: string }
  | { kind: "upto"; stepId: string }
  | { kind: "from"; stepId: string }
  | { kind: "all" }
  | { kind: "group"; stepIds: string[] }
  | { kind: "group_upto"; stepIds: string[] }
  | { kind: "group_from"; stepIds: string[] };

export interface DesignCanvasProps {
  project: ProjectShape;
  selectedStepIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onAddStep: (kind: string, near?: string) => void;
  onAddDependency: (from: string, to: string) => void;
  onDeleteStep: (id: string) => void;
  onOpenAI?: () => void;
  onCreateGroupFromSelection: (ids: string[]) => void;
  onUngroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  /** Estado por step (en vivo si hay job corriendo). */
  stepStates?: Record<string, NodeStatus>;
  /** Lanzar ejecución parcial/total. */
  onRun?: (mode: RunMode) => void;
  /** Cancelar el job activo (si hay). */
  onCancelJob?: () => void;
}

export function DesignCanvas({
  project,
  selectedStepIds,
  onSelectionChange,
  onAddStep,
  onAddDependency,
  onDeleteStep,
  onOpenAI,
  onCreateGroupFromSelection,
  onUngroup,
  onDeleteGroup,
  stepStates,
  onRun,
  onCancelJob,
}: DesignCanvasProps) {
  const theme = useTheme();
  const dialog = useDialog();
  const containerRef = useRef<HTMLDivElement>(null);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );

  const layout = useMemo(
    () => layoutNodes(project.steps, collapsedGroups, project.groups),
    [project.steps, collapsedGroups, project.groups],
  );

  type Menu =
    | { kind: "background"; x: number; y: number }
    | { kind: "node"; x: number; y: number; nodeId: string }
    | { kind: "group"; x: number; y: number; groupName: string };
  const [menu, setMenu] = useState<Menu | null>(null);

  const [edgeDrag, setEdgeDrag] = useState<{
    from: string;
    cursorX: number;
    cursorY: number;
  } | null>(null);

  const [marquee, setMarquee] = useState<{
    sx: number;
    sy: number;
    cx: number;
    cy: number;
  } | null>(null);

  const selSet = useMemo(() => new Set(selectedStepIds), [selectedStepIds]);

  function toScreen(e: React.MouseEvent): { x: number; y: number } {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left + (containerRef.current?.scrollLeft ?? 0),
      y: e.clientY - rect.top + (containerRef.current?.scrollTop ?? 0),
    };
  }
  function toMenuCoords(e: React.MouseEvent): { x: number; y: number } {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onSvgMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as SVGElement).tagName !== "svg") return;
    const p = toScreen(e);
    setMarquee({ sx: p.x, sy: p.y, cx: p.x, cy: p.y });
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
      onSelectionChange([]);
    }
  }
  function onSvgMouseMove(e: React.MouseEvent) {
    const p = toScreen(e);
    if (edgeDrag) {
      setEdgeDrag({ ...edgeDrag, cursorX: p.x, cursorY: p.y });
    }
    if (marquee) {
      setMarquee({ ...marquee, cx: p.x, cy: p.y });
    }
  }
  function onSvgMouseUp(e: React.MouseEvent) {
    if (marquee) {
      const x1 = Math.min(marquee.sx, marquee.cx);
      const y1 = Math.min(marquee.sy, marquee.cy);
      const x2 = Math.max(marquee.sx, marquee.cx);
      const y2 = Math.max(marquee.sy, marquee.cy);
      const inside: string[] = [];
      for (const n of layout.nodes) {
        if (n.x + n.w > x1 && n.x < x2 && n.y + n.h > y1 && n.y < y2) {
          inside.push(n.id);
        }
      }
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const merged = new Set([...selectedStepIds, ...inside]);
        onSelectionChange(Array.from(merged));
      } else {
        onSelectionChange(inside);
      }
      setMarquee(null);
    }
    setEdgeDrag(null);
  }

  function onSvgContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if ((e.target as SVGElement).tagName !== "svg") return;
    const p = toMenuCoords(e);
    setMenu({ kind: "background", x: p.x, y: p.y });
  }

  function onNodeClick(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const next = new Set(selectedStepIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange(Array.from(next));
    } else {
      onSelectionChange([id]);
    }
  }

  function onNodeContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!selSet.has(id)) onSelectionChange([id]);
    const p = toMenuCoords(e);
    setMenu({ kind: "node", x: p.x, y: p.y, nodeId: id });
  }

  function onGroupContextMenu(e: React.MouseEvent, name: string) {
    e.preventDefault();
    e.stopPropagation();
    const p = toMenuCoords(e);
    setMenu({ kind: "group", x: p.x, y: p.y, groupName: name });
  }

  function toggleGroup(name: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenu(null);
        setEdgeDrag(null);
        setMarquee(null);
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedStepIds.length > 0 &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA" &&
        document.activeElement?.tagName !== "SELECT"
      ) {
        if (selectedStepIds.length === 1) {
          for (const id of selectedStepIds) onDeleteStep(id);
        } else {
          dialog
            .confirm(`¿Eliminar ${selectedStepIds.length} pasos?`, {
              title: "Eliminar pasos",
              variant: "danger",
              ok: "Eliminar",
            })
            .then((ok) => {
              if (ok) for (const id of selectedStepIds) onDeleteStep(id);
            });
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedStepIds, onDeleteStep, dialog]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  function groupColor(name: string): string {
    const palette = theme === "light"
      ? ["#0e7490", "#6d28d9", "#a21caf", "#b45309", "#0f766e", "#be123c", "#4d7c0f", "#1d4ed8"]
      : ["#22d3ee", "#a78bfa", "#e879f9", "#fbbf24", "#2dd4bf", "#fb7185", "#a3e635", "#60a5fa"];
    let h = 0;
    for (let i = 0; i < name.length; i++)
      h = (h * 31 + name.charCodeAt(i)) % palette.length;
    return palette[h];
  }

  return (
    <div
      ref={containerRef}
      className="relative bg-panel border border-surface rounded-xl overflow-auto"
      style={{ height: 480 }}
    >
      <svg
        width={Math.max(layout.width, 800)}
        height={Math.max(layout.height, 400)}
        onMouseDown={onSvgMouseDown}
        onMouseMove={onSvgMouseMove}
        onMouseUp={onSvgMouseUp}
        onContextMenu={onSvgContextMenu}
        onMouseLeave={() => {
          setEdgeDrag(null);
          setMarquee(null);
        }}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path
              d="M0,0 L10,5 L0,10 Z"
              fill={theme === "light" ? "#475569" : "#64748b"}
            />
          </marker>
        </defs>

        {/* Frames de grupos expandidos */}
        {layout.groups
          .filter((g) => !g.collapsed)
          .map((g) => {
            const color = groupColor(g.name);
            return (
              <g key={`gx-${g.name}`}>
                <rect
                  x={g.x}
                  y={g.y}
                  width={g.w}
                  height={g.h}
                  rx={10}
                  fill={
                    theme === "light"
                      ? "rgba(241,245,249,0.5)"
                      : "rgba(15,23,42,0.4)"
                  }
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  onContextMenu={(e) => onGroupContextMenu(e, g.name)}
                  style={{ cursor: "context-menu" }}
                />
                <rect
                  x={g.x}
                  y={g.y}
                  width={g.w}
                  height={GROUP_HEADER_H}
                  fill={color}
                  fillOpacity={theme === "light" ? 0.15 : 0.25}
                  rx={10}
                  onContextMenu={(e) => onGroupContextMenu(e, g.name)}
                  onDoubleClick={() => toggleGroup(g.name)}
                  style={{ cursor: "pointer" }}
                />
                <text
                  x={g.x + 12}
                  y={g.y + 19}
                  fontSize={12}
                  fill={color}
                  fontWeight={700}
                  fontFamily="ui-monospace, monospace"
                  pointerEvents="none"
                >
                  ▾ {g.name}
                </text>
                <text
                  x={g.x + g.w - 12}
                  y={g.y + 19}
                  fontSize={10}
                  fill={color}
                  textAnchor="end"
                  fontFamily="ui-monospace, monospace"
                  pointerEvents="none"
                >
                  {g.stepIds.length} pasos
                </text>
              </g>
            );
          })}

        {/* Edges */}
        {project.steps.map((s) => {
          const toUnit = collapsedGroups.has(s.group ?? "")
            ? `group:${s.group}`
            : s.id;
          const toLayout = layout.nodeIndex[toUnit];
          if (!toLayout) return null;
          return (s.depends_on ?? []).map((d) => {
            const dStep = project.steps.find((x) => x.id === d);
            const fromUnit = collapsedGroups.has(dStep?.group ?? "")
              ? `group:${dStep?.group}`
              : d;
            const fromLayout = layout.nodeIndex[fromUnit];
            if (!fromLayout) return null;
            if (fromUnit === toUnit) return null;
            const ax = fromLayout.x + fromLayout.w;
            const ay = fromLayout.y + fromLayout.h / 2;
            const bx = toLayout.x;
            const by = toLayout.y + toLayout.h / 2;
            const midX = (ax + bx) / 2;
            const path = `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
            return (
              <path
                key={`${d}->${s.id}-${fromUnit}-${toUnit}`}
                d={path}
                fill="none"
                stroke={theme === "light" ? "#475569" : "#64748b"}
                strokeWidth={1.6}
                markerEnd="url(#arrow)"
              />
            );
          });
        })}

        {edgeDrag && layout.nodeIndex[edgeDrag.from] && (
          <path
            d={`M ${
              layout.nodeIndex[edgeDrag.from].x +
              layout.nodeIndex[edgeDrag.from].w
            } ${
              layout.nodeIndex[edgeDrag.from].y +
              layout.nodeIndex[edgeDrag.from].h / 2
            } L ${edgeDrag.cursorX} ${edgeDrag.cursorY}`}
            stroke={theme === "light" ? "#0e7490" : "#22d3ee"}
            strokeWidth={2}
            strokeDasharray="4 4"
            fill="none"
            pointerEvents="none"
          />
        )}

        {/* Grupos colapsados (super-nodos) */}
        {layout.groups
          .filter((g) => g.collapsed)
          .map((g) => {
            const color = groupColor(g.name);
            return (
              <g
                key={`gc-${g.name}`}
                transform={`translate(${g.x}, ${g.y})`}
                onContextMenu={(e) => onGroupContextMenu(e, g.name)}
                onDoubleClick={() => toggleGroup(g.name)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  width={g.w}
                  height={g.h}
                  rx={8}
                  fill={
                    theme === "light"
                      ? "rgba(241,245,249,0.9)"
                      : "rgba(15,23,42,0.7)"
                  }
                  stroke={color}
                  strokeWidth={2.4}
                />
                <rect width={4} height={g.h} rx={2} fill={color} />
                <text
                  x={14}
                  y={20}
                  fontSize={13}
                  fontWeight={700}
                  fill={color}
                  fontFamily="ui-monospace, monospace"
                >
                  ▸ {g.name.length > 16 ? g.name.slice(0, 15) + "…" : g.name}
                </text>
                <text
                  x={14}
                  y={38}
                  fontSize={10}
                  fill={theme === "light" ? "#475569" : "#94a3b8"}
                  fontFamily="ui-monospace, monospace"
                >
                  {g.stepIds.length} pasos
                </text>
              </g>
            );
          })}

        {/* Nodos */}
        {layout.nodes.map((n) => {
          const step = project.steps.find((s) => s.id === n.id)!;
          const meta = kindMeta(step.kind);
          const isSel = selSet.has(n.id);
          const stroke = meta.stroke[theme];
          const fill = meta.fill[theme];
          const textP = meta.textPrimary[theme];
          const textS = meta.textSecondary[theme];
          const selFill =
            theme === "light" ? "#cffafe" : "rgba(34,211,238,0.15)";
          const selStroke = theme === "light" ? "#0e7490" : "#22d3ee";
          const status: NodeStatus = stepStates?.[n.id] ?? "idle";
          const badge = statusBadge(status, theme);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x}, ${n.y})`}
              onClick={(e) => onNodeClick(e, n.id)}
              onContextMenu={(e) => onNodeContextMenu(e, n.id)}
              style={{ cursor: "pointer", opacity: status === "skipped" ? 0.55 : 1 }}
            >
              <rect
                width={n.w}
                height={n.h}
                rx={8}
                fill={isSel ? selFill : fill}
                stroke={isSel ? selStroke : badge?.borderOverride ?? stroke}
                strokeWidth={isSel ? 2.8 : status === "running" || status === "failed" ? 2.6 : 1.8}
              />
              <rect width={4} height={n.h} rx={2} fill={stroke} />
              <text x={14} y={20} fontSize={13} fill={stroke}>
                {meta.icon}
              </text>
              <text
                x={32}
                y={22}
                fontSize={12}
                fill={textP}
                fontWeight={600}
                fontFamily="ui-monospace, monospace"
              >
                {step.id.length > 22 ? step.id.slice(0, 21) + "…" : step.id}
              </text>
              <text
                x={32}
                y={38}
                fontSize={10}
                fill={textS}
                fontFamily="ui-monospace, monospace"
              >
                {step.kind}
              </text>
              {(step as Step & { output_table?: string }).output_table && (
                <text
                  x={n.w - 8}
                  y={n.h - 8}
                  fontSize={9}
                  fill={textS}
                  textAnchor="end"
                  fontFamily="ui-monospace, monospace"
                >
                  →{" "}
                  {truncate(
                    (step as Step & { output_table?: string }).output_table!,
                    18,
                  )}
                </text>
              )}
              {(step.kind === "sql_query" || step.kind === "sql_exec") &&
                !(step as Step & { connection?: string | null }).connection && (
                  <g pointerEvents="none">
                    <title>
                      Paso SQL sin conexión asignada — no se va a poder ejecutar
                    </title>
                    <circle
                      cx={14}
                      cy={n.h - 12}
                      r={8}
                      fill="#ef4444"
                      stroke="#7f1d1d"
                      strokeWidth={1.2}
                    />
                    <text
                      x={14}
                      y={n.h - 8}
                      fontSize={11}
                      fontWeight={700}
                      textAnchor="middle"
                      fill="#ffffff"
                    >
                      !
                    </text>
                  </g>
                )}
              {badge && (
                <g transform={`translate(${n.w - 26}, 6)`} pointerEvents="none">
                  <circle
                    cx={9}
                    cy={9}
                    r={9}
                    fill={badge.fill}
                    stroke={badge.stroke}
                    strokeWidth={1.4}
                  >
                    {status === "running" && (
                      <animate
                        attributeName="opacity"
                        values="1;0.4;1"
                        dur="1.2s"
                        repeatCount="indefinite"
                      />
                    )}
                  </circle>
                  <text
                    x={9}
                    y={13}
                    fontSize={11}
                    fontWeight={700}
                    textAnchor="middle"
                    fill={badge.glyphColor}
                  >
                    {badge.glyph}
                  </text>
                </g>
              )}
              <circle
                cx={n.w}
                cy={n.h / 2}
                r={6}
                fill={theme === "light" ? "#ffffff" : "#1e293b"}
                stroke={stroke}
                strokeWidth={1.5}
                style={{ cursor: "crosshair" }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  const p = toScreen(e);
                  setEdgeDrag({ from: n.id, cursorX: p.x, cursorY: p.y });
                }}
                onMouseUp={(e) => e.stopPropagation()}
              />
              <circle
                cx={0}
                cy={n.h / 2}
                r={6}
                fill={theme === "light" ? "#ffffff" : "#1e293b"}
                stroke={stroke}
                strokeWidth={1.5}
                onMouseUp={(e) => {
                  e.stopPropagation();
                  if (edgeDrag && edgeDrag.from !== n.id) {
                    onAddDependency(edgeDrag.from, n.id);
                  }
                  setEdgeDrag(null);
                }}
              />
            </g>
          );
        })}

        {marquee && (
          <rect
            x={Math.min(marquee.sx, marquee.cx)}
            y={Math.min(marquee.sy, marquee.cy)}
            width={Math.abs(marquee.cx - marquee.sx)}
            height={Math.abs(marquee.cy - marquee.sy)}
            fill={
              theme === "light"
                ? "rgba(14,116,144,0.1)"
                : "rgba(34,211,238,0.1)"
            }
            stroke={theme === "light" ? "#0e7490" : "#22d3ee"}
            strokeDasharray="4 4"
            pointerEvents="none"
          />
        )}

        {project.steps.length === 0 && (
          <text
            x={400}
            y={200}
            fontSize={14}
            fill="#64748b"
            textAnchor="middle"
            pointerEvents="none"
          >
            Lienzo vacío. Click derecho para crear un paso.
          </text>
        )}
      </svg>

      {/* Context menu */}
      {menu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bg-surface border border-surface-strong rounded-lg shadow-xl py-1 z-10"
          style={{ left: menu.x, top: menu.y, minWidth: 240 }}
        >
          {menu.kind === "background" && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-dim">
                Crear paso
              </div>
              {KIND_MENU.map((m) => (
                <button
                  key={m.value}
                  onClick={() => {
                    onAddStep(m.value);
                    setMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                >
                  <span
                    style={{
                      color: m.stroke[theme],
                      width: 16,
                      textAlign: "center",
                    }}
                  >
                    {m.icon}
                  </span>
                  <span>{m.label}</span>
                </button>
              ))}
              {onOpenAI && (
                <>
                  <div className="my-1 border-t border-surface" />
                  <button
                    onClick={() => {
                      onOpenAI();
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#0e7490" : "#22d3ee",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ✨
                    </span>
                    <span>Milhouse-AI…</span>
                  </button>
                </>
              )}
              {onRun && project.steps.length > 0 && (
                <>
                  <div className="my-1 border-t border-surface" />
                  <button
                    onClick={() => {
                      onRun({ kind: "all" });
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#16a34a" : "#22c55e",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ▶▶
                    </span>
                    <span>Ejecutar todo el proyecto</span>
                  </button>
                </>
              )}
            </>
          )}

          {menu.kind === "node" && (
            <>
              {selectedStepIds.length > 1 && (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-dim">
                    {selectedStepIds.length} pasos seleccionados
                  </div>
                  <button
                    onClick={() => {
                      onCreateGroupFromSelection(selectedStepIds);
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span style={{ width: 16, textAlign: "center" }}>📦</span>
                    <span>Crear grupo con {selectedStepIds.length} pasos…</span>
                  </button>
                  <button
                    onClick={async () => {
                      setMenu(null);
                      const ok = await dialog.confirm(
                        `¿Eliminar ${selectedStepIds.length} pasos?`,
                        {
                          title: "Eliminar pasos",
                          variant: "danger",
                          ok: "Eliminar",
                        },
                      );
                      if (ok) {
                        for (const id of selectedStepIds) onDeleteStep(id);
                      }
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2 text-red-300"
                  >
                    <span style={{ width: 16, textAlign: "center" }}>🗑</span>
                    <span>Eliminar seleccionados</span>
                  </button>
                  <div className="my-1 border-t border-surface" />
                </>
              )}
              {onCancelJob &&
                (stepStates?.[menu.nodeId] === "running" ||
                  stepStates?.[menu.nodeId] === "ready") && (
                  <>
                    <button
                      onClick={() => {
                        onCancelJob();
                        setMenu(null);
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2 text-red-300"
                    >
                      <span style={{ width: 16, textAlign: "center" }}>⏹</span>
                      <span>Cancelar ejecución</span>
                    </button>
                    <div className="my-1 border-t border-surface" />
                  </>
                )}
              {onRun && (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-dim">
                    Ejecutar
                  </div>
                  <button
                    onClick={() => {
                      onRun({ kind: "single", stepId: menu.nodeId });
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#16a34a" : "#22c55e",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ▶
                    </span>
                    <span>Ejecutar este paso</span>
                  </button>
                  <button
                    onClick={() => {
                      onRun({ kind: "upto", stepId: menu.nodeId });
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#16a34a" : "#22c55e",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ⏭
                    </span>
                    <span>Ejecutar hasta acá (incluido)</span>
                  </button>
                  <button
                    onClick={() => {
                      onRun({ kind: "from", stepId: menu.nodeId });
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#16a34a" : "#22c55e",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ⏮
                    </span>
                    <span>Ejecutar desde acá</span>
                  </button>
                  <div className="my-1 border-t border-surface" />
                </>
              )}
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-dim">
                Crear paso conectado
              </div>
              {KIND_MENU.slice(0, 5).map((m) => (
                <button
                  key={m.value}
                  onClick={() => {
                    onAddStep(m.value, menu.nodeId);
                    setMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                >
                  <span
                    style={{
                      color: m.stroke[theme],
                      width: 16,
                      textAlign: "center",
                    }}
                  >
                    {m.icon}
                  </span>
                  <span>{m.label}</span>
                </button>
              ))}
              <div className="my-1 border-t border-surface" />
              <button
                onClick={() => {
                  onDeleteStep(menu.nodeId);
                  setMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2 text-red-300"
              >
                <span style={{ width: 16, textAlign: "center" }}>🗑</span>
                <span>Eliminar &ldquo;{menu.nodeId}&rdquo;</span>
              </button>
            </>
          )}

          {menu.kind === "group" && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-dim">
                Grupo: {menu.groupName}
              </div>
              <button
                onClick={() => {
                  toggleGroup(menu.groupName);
                  setMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
              >
                <span style={{ width: 16, textAlign: "center" }}>
                  {collapsedGroups.has(menu.groupName) ? "▾" : "▸"}
                </span>
                <span>
                  {collapsedGroups.has(menu.groupName)
                    ? "Expandir grupo"
                    : "Colapsar grupo"}
                </span>
              </button>
              {onRun && (
                <>
                  <div className="my-1 border-t border-surface" />
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-dim">
                    Ejecutar grupo
                  </div>
                  <button
                    onClick={() => {
                      const grp = layout.groups.find(
                        (g) => g.name === menu.groupName,
                      );
                      const ids = grp?.stepIds ?? [];
                      if (ids.length > 0) onRun({ kind: "group", stepIds: ids });
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#16a34a" : "#22c55e",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ▶
                    </span>
                    <span>Ejecutar este grupo</span>
                  </button>
                  <button
                    onClick={() => {
                      const grp = layout.groups.find(
                        (g) => g.name === menu.groupName,
                      );
                      const ids = grp?.stepIds ?? [];
                      if (ids.length > 0)
                        onRun({ kind: "group_upto", stepIds: ids });
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#16a34a" : "#22c55e",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ⏭
                    </span>
                    <span>Ejecutar hasta el grupo (incluido)</span>
                  </button>
                  <button
                    onClick={() => {
                      const grp = layout.groups.find(
                        (g) => g.name === menu.groupName,
                      );
                      const ids = grp?.stepIds ?? [];
                      if (ids.length > 0)
                        onRun({ kind: "group_from", stepIds: ids });
                      setMenu(null);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span
                      style={{
                        color: theme === "light" ? "#16a34a" : "#22c55e",
                        width: 16,
                        textAlign: "center",
                      }}
                    >
                      ⏮
                    </span>
                    <span>Ejecutar desde el grupo</span>
                  </button>
                  <div className="my-1 border-t border-surface" />
                </>
              )}
              <button
                onClick={() => {
                  onUngroup(menu.groupName);
                  setMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2"
              >
                <span style={{ width: 16, textAlign: "center" }}>⏏</span>
                <span>Eliminar grupo (preservar pasos)</span>
              </button>
              <button
                onClick={async () => {
                  const groupName = menu.groupName;
                  setMenu(null);
                  const ok = await dialog.confirm(
                    `¿Eliminar el grupo "${groupName}" Y todos sus pasos?`,
                    {
                      title: "Eliminar grupo y pasos",
                      variant: "danger",
                      ok: "Eliminar todo",
                    },
                  );
                  if (ok) {
                    const grp = layout.groups.find((g) => g.name === groupName);
                    if (grp) {
                      for (const id of grp.stepIds) onDeleteStep(id);
                    }
                    onDeleteGroup(groupName);
                  }
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-800 flex items-center gap-2 text-red-300"
              >
                <span style={{ width: 16, textAlign: "center" }}>🗑</span>
                <span>Eliminar grupo y sus pasos</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type BadgeSpec = {
  glyph: string;
  fill: string;
  stroke: string;
  glyphColor: string;
  borderOverride?: string;
};

function statusBadge(s: NodeStatus, theme: "dark" | "light"): BadgeSpec | null {
  switch (s) {
    case "done":
      return {
        glyph: "✓",
        fill: theme === "light" ? "#16a34a" : "#22c55e",
        stroke: theme === "light" ? "#15803d" : "#16a34a",
        glyphColor: "#ffffff",
      };
    case "running":
      return {
        glyph: "▶",
        fill: theme === "light" ? "#fbbf24" : "#fbbf24",
        stroke: theme === "light" ? "#b45309" : "#f59e0b",
        glyphColor: theme === "light" ? "#78350f" : "#451a03",
        borderOverride: theme === "light" ? "#b45309" : "#fbbf24",
      };
    case "failed":
      return {
        glyph: "!",
        fill: theme === "light" ? "#dc2626" : "#ef4444",
        stroke: theme === "light" ? "#991b1b" : "#b91c1c",
        glyphColor: "#ffffff",
        borderOverride: theme === "light" ? "#991b1b" : "#ef4444",
      };
    case "cancelled":
      return {
        glyph: "⏹",
        fill: theme === "light" ? "#94a3b8" : "#64748b",
        stroke: theme === "light" ? "#64748b" : "#475569",
        glyphColor: "#ffffff",
      };
    case "skipped":
      return {
        glyph: "—",
        fill: theme === "light" ? "#cbd5e1" : "#475569",
        stroke: theme === "light" ? "#94a3b8" : "#64748b",
        glyphColor: theme === "light" ? "#475569" : "#cbd5e1",
      };
    case "ready":
    case "pending":
    case "idle":
    default:
      return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
