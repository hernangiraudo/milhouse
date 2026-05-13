"use client";

import { useMemo, useState } from "react";
import type { GroupMeta, StepInfo } from "@/lib/types";
import { useTheme } from "@/lib/useTheme";

// =====================================================================
// Dimensiones
// =====================================================================
const NODE_W = 200;
const NODE_H = 60;
const GROUP_NODE_W = 220;
const GROUP_NODE_H = 80;
const LEVEL_GAP_X = 90;
const ROW_GAP_Y = 24;
const PAD = 24;
const GROUP_PAD_X = 16;
const GROUP_PAD_Y = 38; // espacio para el header

// =====================================================================
// Tipos
// =====================================================================

/** Unidad virtual del grafo: un step suelto o un grupo. */
type UnitKind = "step" | "group-collapsed" | "group-expanded";

interface Unit {
  kind: UnitKind;
  id: string; // step id, o `group:NAME`
  groupName?: string; // si pertenece a un grupo (incluido el self-collapsed)
  stepIds?: string[]; // si es grupo: ids de los pasos hijos
  // Asignados por el layout:
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LaidOutChild {
  stepId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  units: Unit[];
  /** Subnodos de grupos expandidos, ya posicionados en coordenadas globales. */
  expandedChildren: LaidOutChild[];
  edges: Array<{ from: string; to: string }>;
  width: number;
  height: number;
}

// =====================================================================
// Estilos por tipo
// =====================================================================

type KindStyle = {
  baseFill: string;
  baseStroke: string;
  textPrimary: string;
  textSecondary: string;
  glyph: string;
};

const KIND_STYLES_DARK: Record<string, KindStyle> = {
  sql_query: { baseFill: "#0c4a6e", baseStroke: "#38bdf8", textPrimary: "#e0f2fe", textSecondary: "#7dd3fc", glyph: "▼" },
  sql_exec: { baseFill: "#1e3a8a", baseStroke: "#60a5fa", textPrimary: "#dbeafe", textSecondary: "#93c5fd", glyph: "⚙" },
  join: { baseFill: "#4c1d95", baseStroke: "#a78bfa", textPrimary: "#ede9fe", textSecondary: "#c4b5fd", glyph: "⋈" },
  lookup: { baseFill: "#701a75", baseStroke: "#e879f9", textPrimary: "#fae8ff", textSecondary: "#f0abfc", glyph: "🔎" },
  transform: { baseFill: "#78350f", baseStroke: "#fbbf24", textPrimary: "#fef3c7", textSecondary: "#fcd34d", glyph: "ƒ" },
  filter_and_subset: { baseFill: "#164e63", baseStroke: "#22d3ee", textPrimary: "#cffafe", textSecondary: "#67e8f9", glyph: "▾" },
  sort: { baseFill: "#134e4a", baseStroke: "#2dd4bf", textPrimary: "#ccfbf1", textSecondary: "#5eead4", glyph: "↕" },
  procedural: { baseFill: "#881337", baseStroke: "#fb7185", textPrimary: "#ffe4e6", textSecondary: "#fda4af", glyph: "λ" },
  export: { baseFill: "#365314", baseStroke: "#a3e635", textPrimary: "#ecfccb", textSecondary: "#bef264", glyph: "⇧" },
};

const KIND_STYLES_LIGHT: Record<string, KindStyle> = {
  sql_query: { baseFill: "#dbeafe", baseStroke: "#0369a1", textPrimary: "#0c4a6e", textSecondary: "#075985", glyph: "▼" },
  sql_exec: { baseFill: "#dbeafe", baseStroke: "#1d4ed8", textPrimary: "#1e3a8a", textSecondary: "#1e40af", glyph: "⚙" },
  join: { baseFill: "#ede9fe", baseStroke: "#6d28d9", textPrimary: "#4c1d95", textSecondary: "#5b21b6", glyph: "⋈" },
  lookup: { baseFill: "#fae8ff", baseStroke: "#a21caf", textPrimary: "#701a75", textSecondary: "#86198f", glyph: "🔎" },
  transform: { baseFill: "#fef3c7", baseStroke: "#b45309", textPrimary: "#78350f", textSecondary: "#92400e", glyph: "ƒ" },
  filter_and_subset: { baseFill: "#cffafe", baseStroke: "#0e7490", textPrimary: "#164e63", textSecondary: "#155e75", glyph: "▾" },
  sort: { baseFill: "#ccfbf1", baseStroke: "#0f766e", textPrimary: "#134e4a", textSecondary: "#115e59", glyph: "↕" },
  procedural: { baseFill: "#ffe4e6", baseStroke: "#be123c", textPrimary: "#881337", textSecondary: "#9f1239", glyph: "λ" },
  export: { baseFill: "#ecfccb", baseStroke: "#4d7c0f", textPrimary: "#365314", textSecondary: "#3f6212", glyph: "⇧" },
};

function kindStyle(kind: string, theme: "dark" | "light"): KindStyle {
  const map = theme === "light" ? KIND_STYLES_LIGHT : KIND_STYLES_DARK;
  return (
    map[kind] ?? {
      baseFill: theme === "light" ? "#f1f5f9" : "#0f172a",
      baseStroke: theme === "light" ? "#475569" : "#334155",
      textPrimary: theme === "light" ? "#0f172a" : "#e2e8f0",
      textSecondary: theme === "light" ? "#475569" : "#94a3b8",
      glyph: "?",
    }
  );
}

// Paleta de colores asignada a grupos sin color explícito (cycling).
const GROUP_PALETTE_DARK = [
  { fill: "#1e293b", stroke: "#94a3b8" },
  { fill: "#0c4a6e", stroke: "#38bdf8" },
  { fill: "#3b0764", stroke: "#a855f7" },
  { fill: "#7c2d12", stroke: "#fb923c" },
  { fill: "#064e3b", stroke: "#34d399" },
  { fill: "#831843", stroke: "#f472b6" },
];
const GROUP_PALETTE_LIGHT = [
  { fill: "#f1f5f9", stroke: "#475569" },
  { fill: "#e0f2fe", stroke: "#0369a1" },
  { fill: "#f3e8ff", stroke: "#7e22ce" },
  { fill: "#ffedd5", stroke: "#c2410c" },
  { fill: "#dcfce7", stroke: "#15803d" },
  { fill: "#fce7f3", stroke: "#be185d" },
];

function groupColor(
  name: string,
  idx: number,
  theme: "dark" | "light",
  explicit?: string | null,
) {
  if (explicit) {
    return { fill: explicit, stroke: explicit };
  }
  const palette = theme === "light" ? GROUP_PALETTE_LIGHT : GROUP_PALETTE_DARK;
  return palette[idx % palette.length];
}

function stateOverlay(
  info: StepInfo,
  theme: "dark" | "light",
): { fillAlpha: number; strokeColor: string | null; pulse: boolean; ghost: boolean } {
  const s = info.state.state;
  if (theme === "light") {
    switch (s) {
      case "running": return { fillAlpha: 1, strokeColor: "#b45309", pulse: true, ghost: false };
      case "done": return { fillAlpha: 1, strokeColor: null, pulse: false, ghost: false };
      case "failed": return { fillAlpha: 1, strokeColor: "#b91c1c", pulse: false, ghost: false };
      case "cancelled":
      case "skipped": return { fillAlpha: 0.5, strokeColor: "#94a3b8", pulse: false, ghost: true };
      case "ready": return { fillAlpha: 0.85, strokeColor: "#0e7490", pulse: false, ghost: false };
      default: return { fillAlpha: 0.55, strokeColor: null, pulse: false, ghost: true };
    }
  }
  switch (s) {
    case "running": return { fillAlpha: 0.55, strokeColor: "#fbbf24", pulse: true, ghost: false };
    case "done": return { fillAlpha: 0.45, strokeColor: null, pulse: false, ghost: false };
    case "failed": return { fillAlpha: 0.5, strokeColor: "#ef4444", pulse: false, ghost: false };
    case "cancelled":
    case "skipped": return { fillAlpha: 0.15, strokeColor: "#475569", pulse: false, ghost: true };
    case "ready": return { fillAlpha: 0.25, strokeColor: "#22d3ee", pulse: false, ghost: false };
    default: return { fillAlpha: 0.18, strokeColor: null, pulse: false, ghost: true };
  }
}

function hexWithAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// =====================================================================
// Layout
// =====================================================================

function baricentro(
  id: string,
  neighborLevel: string[],
  neighbors: Record<string, string[]>,
): number {
  const ns = neighbors[id] ?? [];
  if (ns.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (const n of ns) {
    const idx = neighborLevel.indexOf(n);
    if (idx >= 0) {
      sum += idx;
      count += 1;
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count;
}

interface BuildLayoutOpts {
  steps: Record<string, StepInfo>;
  order: string[];
  expanded: Set<string>; // nombres de grupos expandidos
}

function computeLayout({ steps, order, expanded }: BuildLayoutOpts): Layout {
  const ids = order.filter((id) => steps[id]);

  // Mapear: cada stepId → unit virtual al que pertenece.
  // Un grupo colapsado tiene id "group:NAME"; uno expandido, también, pero
  // sus pasos figuran como children renderizados aparte.
  const unitOfStep: Record<string, string> = {};
  const stepsOfGroup: Record<string, string[]> = {};
  for (const sid of ids) {
    const g = steps[sid].group ?? null;
    if (!g) {
      unitOfStep[sid] = sid; // step suelto → unit propio
    } else {
      const unitId = `group:${g}`;
      unitOfStep[sid] = unitId;
      stepsOfGroup[unitId] = stepsOfGroup[unitId] ?? [];
      stepsOfGroup[unitId].push(sid);
    }
  }
  // Lista de unitIds (orden estable según primera aparición de cada uno).
  const unitIds: string[] = [];
  const seenUnit = new Set<string>();
  for (const sid of ids) {
    const u = unitOfStep[sid];
    if (!seenUnit.has(u)) {
      seenUnit.add(u);
      unitIds.push(u);
    }
  }

  // ---------- DAG entre units ----------
  const succU: Record<string, Set<string>> = {};
  const predU: Record<string, Set<string>> = {};
  const inDegU: Record<string, number> = {};
  for (const u of unitIds) {
    succU[u] = new Set();
    predU[u] = new Set();
    inDegU[u] = 0;
  }
  for (const sid of ids) {
    const u = unitOfStep[sid];
    for (const dep of steps[sid].depends_on) {
      const v = unitOfStep[dep];
      if (!v || v === u) continue;
      if (!succU[v].has(u)) {
        succU[v].add(u);
        predU[u].add(v);
        inDegU[u] += 1;
      }
    }
  }

  // ---------- Niveles topológicos (longest path) ----------
  const levelU: Record<string, number> = {};
  const remain = { ...inDegU };
  const queueU: string[] = unitIds.filter((u) => remain[u] === 0);
  for (const u of queueU) levelU[u] = 0;
  while (queueU.length > 0) {
    const cur = queueU.shift()!;
    for (const next of succU[cur]) {
      remain[next] -= 1;
      levelU[next] = Math.max(levelU[next] ?? 0, (levelU[cur] ?? 0) + 1);
      if (remain[next] === 0) queueU.push(next);
    }
  }
  let maxLevel = 0;
  for (const u of unitIds) maxLevel = Math.max(maxLevel, levelU[u] ?? 0);
  const byLevel: string[][] = [];
  for (let l = 0; l <= maxLevel; l++) byLevel.push([]);
  for (const u of unitIds) byLevel[levelU[u] ?? 0].push(u);

  // ---------- Reordenar por baricentro ----------
  const predUarr: Record<string, string[]> = {};
  const succUarr: Record<string, string[]> = {};
  for (const u of unitIds) {
    predUarr[u] = Array.from(predU[u]);
    succUarr[u] = Array.from(succU[u]);
  }
  for (let iter = 0; iter < 6; iter++) {
    const forward = iter % 2 === 0;
    if (forward) {
      for (let l = 1; l <= maxLevel; l++) {
        const cur = byLevel[l];
        const prev = byLevel[l - 1];
        cur.sort((a, b) => baricentro(a, prev, predUarr) - baricentro(b, prev, predUarr));
      }
    } else {
      for (let l = maxLevel - 1; l >= 0; l--) {
        const cur = byLevel[l];
        const next = byLevel[l + 1];
        cur.sort((a, b) => baricentro(a, next, succUarr) - baricentro(b, next, succUarr));
      }
    }
  }

  // ---------- Calcular tamaño de cada unit ----------
  function unitSize(uid: string): { w: number; h: number; kind: UnitKind } {
    if (!uid.startsWith("group:")) {
      return { w: NODE_W, h: NODE_H, kind: "step" };
    }
    const groupName = uid.slice("group:".length);
    if (expanded.has(groupName)) {
      // Para expandidos: layout interno simple = filas a una columna sub-DAG.
      // Computamos sub-niveles internos para mostrar el flujo intra-grupo.
      const sub = stepsOfGroup[uid] ?? [];
      const sub2 = subLayout(sub, steps);
      return {
        w: sub2.w + GROUP_PAD_X * 2,
        h: sub2.h + GROUP_PAD_Y + GROUP_PAD_X,
        kind: "group-expanded",
      };
    }
    return { w: GROUP_NODE_W, h: GROUP_NODE_H, kind: "group-collapsed" };
  }

  // Layout sub-grupo: similar a top-level pero solo dentro de los pasos
  // del grupo (respetando dependencias internas y baricentro).
  function subLayout(stepIds: string[], steps: Record<string, StepInfo>): {
    placements: Array<{ stepId: string; x: number; y: number }>;
    w: number;
    h: number;
  } {
    const set = new Set(stepIds);
    const succ: Record<string, string[]> = {};
    const pred: Record<string, string[]> = {};
    const inD: Record<string, number> = {};
    for (const id of stepIds) {
      succ[id] = [];
      pred[id] = [];
      inD[id] = 0;
    }
    for (const id of stepIds) {
      for (const d of steps[id].depends_on) {
        if (set.has(d)) {
          succ[d].push(id);
          pred[id].push(d);
          inD[id] += 1;
        }
      }
    }
    const level: Record<string, number> = {};
    const q: string[] = stepIds.filter((id) => inD[id] === 0);
    for (const id of q) level[id] = 0;
    const rem = { ...inD };
    while (q.length > 0) {
      const cur = q.shift()!;
      for (const n of succ[cur]) {
        rem[n] -= 1;
        level[n] = Math.max(level[n] ?? 0, (level[cur] ?? 0) + 1);
        if (rem[n] === 0) q.push(n);
      }
    }
    let maxL = 0;
    for (const id of stepIds) maxL = Math.max(maxL, level[id] ?? 0);
    const byL: string[][] = [];
    for (let l = 0; l <= maxL; l++) byL.push([]);
    for (const id of stepIds) byL[level[id] ?? 0].push(id);
    // 4 pasadas de baricentro intra-grupo
    for (let iter = 0; iter < 4; iter++) {
      const fwd = iter % 2 === 0;
      if (fwd) {
        for (let l = 1; l <= maxL; l++) {
          byL[l].sort((a, b) => baricentro(a, byL[l - 1], pred) - baricentro(b, byL[l - 1], pred));
        }
      } else {
        for (let l = maxL - 1; l >= 0; l--) {
          byL[l].sort((a, b) => baricentro(a, byL[l + 1], succ) - baricentro(b, byL[l + 1], succ));
        }
      }
    }
    let maxRows = 0;
    for (let l = 0; l <= maxL; l++) maxRows = Math.max(maxRows, byL[l].length);
    const subNodeW = NODE_W * 0.85;
    const subNodeH = NODE_H * 0.85;
    const subGapX = 50;
    const subGapY = 12;
    const totalH = maxRows * (subNodeH + subGapY) - subGapY;
    const placements: Array<{ stepId: string; x: number; y: number }> = [];
    for (let l = 0; l <= maxL; l++) {
      const col = byL[l];
      const colH = col.length * (subNodeH + subGapY) - subGapY;
      const startY = (totalH - colH) / 2;
      col.forEach((id, i) => {
        placements.push({
          stepId: id,
          x: l * (subNodeW + subGapX),
          y: startY + i * (subNodeH + subGapY),
        });
      });
    }
    return {
      placements,
      w: (maxL + 1) * subNodeW + maxL * subGapX,
      h: totalH,
    };
  }

  // ---------- Asignar coordenadas a units ----------
  // Calcular altura máxima de cada nivel (puede variar por grupos expandidos)
  const levelMaxH: number[] = [];
  for (let l = 0; l <= maxLevel; l++) {
    let h = 0;
    for (const u of byLevel[l]) {
      h = Math.max(h, unitSize(u).h);
    }
    levelMaxH.push(h);
  }
  // Altura del canvas = suma del max(rows*size + gaps) por cada nivel,
  // pero los niveles van en X (no en Y). Y dentro de un nivel se apilan
  // verticalmente sus units (cada una con altura propia).
  // Calculamos cada columna y luego la altura total = max columna.
  const colMetrics: Array<{
    units: Array<{ uid: string; w: number; h: number }>;
    totalH: number;
    totalW: number;
  }> = [];
  let maxColW = 0;
  for (let l = 0; l <= maxLevel; l++) {
    const items = byLevel[l].map((uid) => {
      const s = unitSize(uid);
      return { uid, w: s.w, h: s.h };
    });
    const totalH = items.reduce((acc, it) => acc + it.h, 0) + Math.max(0, items.length - 1) * ROW_GAP_Y;
    const totalW = Math.max(0, ...items.map((it) => it.w));
    if (totalW > maxColW) maxColW = totalW;
    colMetrics.push({ units: items, totalH, totalW });
  }
  const canvasH = Math.max(NODE_H, ...colMetrics.map((c) => c.totalH)) + PAD * 2;

  // X de cada columna depende del ancho acumulado de las anteriores.
  const colX: number[] = [];
  let cursorX = PAD;
  for (let l = 0; l <= maxLevel; l++) {
    colX.push(cursorX);
    cursorX += colMetrics[l].totalW + LEVEL_GAP_X;
  }
  const canvasW = cursorX - LEVEL_GAP_X + PAD;

  const units: Unit[] = [];
  const expandedChildren: LaidOutChild[] = [];

  for (let l = 0; l <= maxLevel; l++) {
    const { units: items, totalH } = colMetrics[l];
    let cursorY = (canvasH - totalH) / 2;
    for (const item of items) {
      const x = colX[l] + (colMetrics[l].totalW - item.w) / 2;
      const y = cursorY;
      const kind: UnitKind = item.uid.startsWith("group:")
        ? expanded.has(item.uid.slice(6))
          ? "group-expanded"
          : "group-collapsed"
        : "step";
      const unit: Unit = {
        kind,
        id: item.uid,
        groupName: item.uid.startsWith("group:") ? item.uid.slice(6) : undefined,
        stepIds: stepsOfGroup[item.uid],
        x,
        y,
        w: item.w,
        h: item.h,
      };
      units.push(unit);
      // si es expandido: posicionar children
      if (kind === "group-expanded") {
        const stepIds = stepsOfGroup[item.uid] ?? [];
        const sub = subLayout(stepIds, steps);
        const subOriginX = x + GROUP_PAD_X;
        const subOriginY = y + GROUP_PAD_Y;
        for (const pl of sub.placements) {
          expandedChildren.push({
            stepId: pl.stepId,
            x: subOriginX + pl.x,
            y: subOriginY + pl.y,
            w: NODE_W * 0.85,
            h: NODE_H * 0.85,
          });
        }
      }
      cursorY += item.h + ROW_GAP_Y;
    }
  }

  // ---------- Edges entre units ----------
  const edges: Array<{ from: string; to: string }> = [];
  const seenEdge = new Set<string>();
  for (const u of unitIds) {
    for (const v of succU[u]) {
      const k = `${u}→${v}`;
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        edges.push({ from: u, to: v });
      }
    }
  }

  return { units, expandedChildren, edges, width: canvasW, height: canvasH };
}

// =====================================================================
// Componente
// =====================================================================

export function DagView({
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
  const theme = useTheme();
  // Conjunto de grupos presentes
  const groupNames = useMemo(() => {
    const set = new Set<string>();
    for (const id of order) {
      const g = steps[id]?.group;
      if (g) set.add(g);
    }
    return Array.from(set);
  }, [steps, order]);

  // Default: TODOS los grupos colapsados.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  function toggle(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  function expandAll() {
    setExpanded(new Set(groupNames));
  }
  function collapseAll() {
    setExpanded(new Set());
  }

  const layout = useMemo(
    () => computeLayout({ steps, order, expanded }),
    [steps, order, expanded],
  );

  const unitMap = useMemo(() => {
    const m: Record<string, Unit> = {};
    for (const u of layout.units) m[u.id] = u;
    return m;
  }, [layout]);

  const kindsPresent = useMemo(() => {
    const set = new Set<string>();
    for (const u of layout.units) {
      if (u.kind === "step") set.add(steps[u.id].kind);
    }
    for (const c of layout.expandedChildren) set.add(steps[c.stepId].kind);
    return Array.from(set);
  }, [layout, steps]);

  // Posición efectiva para resolver dónde sale/llega una flecha cuando el
  // origen/destino real está dentro de un grupo (colapsado o expandido).
  function anchor(stepOrUnitId: string): { x: number; y: number; w: number; h: number } | null {
    // Si pasamos un unit id (ej. "group:foo"), lo buscamos directo.
    const u = unitMap[stepOrUnitId];
    if (u) return { x: u.x, y: u.y, w: u.w, h: u.h };
    return null;
  }

  const edgeBase = theme === "light" ? "#475569" : "#475569";
  const edgeActive = theme === "light" ? "#0e7490" : "#22d3ee";
  const arrowBaseFill = theme === "light" ? "#475569" : "#64748b";
  const arrowActiveFill = theme === "light" ? "#0e7490" : "#22d3ee";

  // Agregar estado a un grupo (resumen) → dominante.
  function summarizeGroup(stepIds: string[]) {
    let running = 0;
    let failed = 0;
    let done = 0;
    let cancelled = 0;
    let skipped = 0;
    let pending = 0;
    let progSum = 0;
    let progCount = 0;
    let rowsDone = 0;
    let totalDurMs = 0;
    for (const sid of stepIds) {
      const st = steps[sid].state;
      switch (st.state) {
        case "running":
          running += 1;
          progSum += st.progress ?? 0;
          progCount += 1;
          break;
        case "failed":
          failed += 1;
          break;
        case "done":
          done += 1;
          rowsDone += st.row_count;
          totalDurMs += st.duration_ms;
          break;
        case "cancelled":
          cancelled += 1;
          break;
        case "skipped":
          skipped += 1;
          break;
        default:
          pending += 1;
      }
    }
    const total = stepIds.length;
    let dominant: "running" | "failed" | "done" | "skipped" | "pending" = "pending";
    if (running > 0) dominant = "running";
    else if (failed > 0) dominant = "failed";
    else if (done === total) dominant = "done";
    else if (skipped > 0 || cancelled > 0) dominant = "skipped";
    const overallProgress =
      total === 0
        ? 0
        : (done + (progCount > 0 ? progSum / progCount : 0) * (running / Math.max(1, total))) /
          total;
    return { dominant, done, total, running, failed, rowsDone, totalDurMs, overallProgress };
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Legend kinds={kindsPresent} theme={theme} />
        {groupNames.length > 0 && (
          <div className="flex gap-1 text-xs">
            <ToggleButton onClick={expandAll}>Expandir todo</ToggleButton>
            <ToggleButton onClick={collapseAll}>Colapsar todo</ToggleButton>
          </div>
        )}
      </div>
      <div className="overflow-auto border border-surface rounded-xl bg-surface p-2">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ minWidth: layout.width, minHeight: layout.height }}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 Z" fill={arrowBaseFill} />
            </marker>
            <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 Z" fill={arrowActiveFill} />
            </marker>
            <style>{`
              @keyframes pulseRunning {
                0%, 100% { stroke-opacity: 1; filter: drop-shadow(0 0 0 currentColor); }
                50% { stroke-opacity: 0.55; filter: drop-shadow(0 0 8px currentColor); }
              }
              .pulse { animation: pulseRunning 1.4s ease-in-out infinite; }
            `}</style>
          </defs>

          {/* edges entre units */}
          {layout.edges.map((e, i) => {
            const a = anchor(e.from);
            const b = anchor(e.to);
            if (!a || !b) return null;
            const ax = a.x + a.w;
            const ay = a.y + a.h / 2;
            const bx = b.x;
            const by = b.y + b.h / 2;
            const midX = (ax + bx) / 2;
            const d = `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
            // detectar si "está activa" (algún paso del origen done/running con destino running/ready)
            const isActive = isEdgeActive(e.from, e.to, steps, unitMap);
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={isActive ? edgeActive : edgeBase}
                strokeWidth={isActive ? 2.4 : 1.6}
                markerEnd={`url(#${isActive ? "arrow-active" : "arrow"})`}
              />
            );
          })}

          {/* units: primero los grupos expandidos (de fondo), luego steps/colapsados, luego sus children */}
          {layout.units
            .filter((u) => u.kind === "group-expanded")
            .map((u) => {
              const idx = groupNames.indexOf(u.groupName!);
              const meta = groups?.find((g) => g.name === u.groupName);
              const c = groupColor(u.groupName!, idx, theme, meta?.color ?? null);
              const summary = summarizeGroup(u.stepIds ?? []);
              return (
                <g
                  key={u.id}
                  transform={`translate(${u.x}, ${u.y})`}
                  onClick={() => toggle(u.groupName!)}
                  className="cursor-pointer"
                >
                  <rect
                    width={u.w}
                    height={u.h}
                    rx={12}
                    ry={12}
                    fill={theme === "light" ? c.fill : hexWithAlpha(c.fill, 0.5)}
                    stroke={c.stroke}
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                  />
                  <text x={12} y={22} fontFamily="ui-monospace" fontSize={12} fill={c.stroke} fontWeight={700}>
                    ▾ {u.groupName}
                  </text>
                  <text x={u.w - 12} y={22} fontFamily="ui-monospace" fontSize={10} fill={c.stroke} textAnchor="end">
                    {summary.done}/{summary.total} · {Math.round(summary.overallProgress * 100)}%
                  </text>
                </g>
              );
            })}

          {layout.units
            .filter((u) => u.kind !== "group-expanded")
            .map((u) => {
              if (u.kind === "step") {
                return renderStepNode({
                  info: steps[u.id],
                  x: u.x,
                  y: u.y,
                  w: u.w,
                  h: u.h,
                  theme,
                  isSelected: selectedId === u.id,
                  onClick: () => onSelect(u.id),
                });
              }
              // group-collapsed
              const idx = groupNames.indexOf(u.groupName!);
              const meta = groups?.find((g) => g.name === u.groupName);
              const c = groupColor(u.groupName!, idx, theme, meta?.color ?? null);
              const summary = summarizeGroup(u.stepIds ?? []);
              return renderGroupCollapsed({
                u,
                color: c,
                summary,
                theme,
                onClick: () => toggle(u.groupName!),
                description: meta?.description ?? null,
              });
            })}

          {/* children de grupos expandidos */}
          {layout.expandedChildren.map((c) =>
            renderStepNode({
              info: steps[c.stepId],
              x: c.x,
              y: c.y,
              w: c.w,
              h: c.h,
              theme,
              isSelected: selectedId === c.stepId,
              onClick: () => onSelect(c.stepId),
              compact: true,
            }),
          )}
        </svg>
      </div>
    </div>
  );
}

function isEdgeActive(
  from: string,
  to: string,
  steps: Record<string, StepInfo>,
  unitMap: Record<string, Unit>,
): boolean {
  function isFromActive(uid: string): boolean {
    const u = unitMap[uid];
    if (!u) return false;
    if (u.kind === "step") {
      const st = steps[u.id].state.state;
      return st === "done" || st === "running";
    }
    return (u.stepIds ?? []).some((sid) => {
      const st = steps[sid].state.state;
      return st === "done" || st === "running";
    });
  }
  function isToActive(uid: string): boolean {
    const u = unitMap[uid];
    if (!u) return false;
    if (u.kind === "step") {
      const st = steps[u.id].state.state;
      return st === "running" || st === "ready";
    }
    return (u.stepIds ?? []).some((sid) => {
      const st = steps[sid].state.state;
      return st === "running" || st === "ready";
    });
  }
  return isFromActive(from) && isToActive(to);
}

interface RenderStepArgs {
  info: StepInfo;
  x: number;
  y: number;
  w: number;
  h: number;
  theme: "dark" | "light";
  isSelected: boolean;
  onClick: () => void;
  compact?: boolean;
}

function renderStepNode({
  info,
  x,
  y,
  w,
  h,
  theme,
  isSelected,
  onClick,
  compact,
}: RenderStepArgs) {
  const ks = kindStyle(info.kind, theme);
  const ov = stateOverlay(info, theme);
  const fill = hexWithAlpha(ks.baseFill, ov.fillAlpha);
  const stroke = ov.strokeColor ?? ks.baseStroke;
  const progress =
    info.state.state === "running"
      ? (info.state.progress ?? 0)
      : info.state.state === "done"
      ? 1
      : 0;
  const fontSize = compact ? 11 : 12;
  const kindFont = compact ? 9 : 10;
  return (
    <g
      key={info.id}
      transform={`translate(${x}, ${y})`}
      onClick={onClick}
      className="cursor-pointer"
      style={{ opacity: ov.ghost ? 0.65 : 1 }}
    >
      <rect
        width={w}
        height={h}
        rx={9}
        ry={9}
        fill={fill}
        stroke={stroke}
        strokeWidth={isSelected ? 2.8 : ov.pulse ? 2.2 : 1.6}
        className={ov.pulse ? "pulse" : ""}
        style={{ color: stroke }}
      />
      <rect width={4} height={h} rx={2} ry={2} fill={ks.baseStroke} />
      <text x={14} y={h / 2 - 6} fontFamily="ui-monospace, monospace" fontSize={fontSize + 1} fill={ks.baseStroke}>
        {ks.glyph}
      </text>
      <text
        x={32}
        y={h / 2 - 6}
        fontFamily="ui-monospace, monospace"
        fontSize={fontSize}
        fill={ks.textPrimary}
        fontWeight={600}
      >
        {info.id.length > 22 ? info.id.slice(0, 21) + "…" : info.id}
      </text>
      <text x={32} y={h / 2 + 10} fontFamily="ui-monospace, monospace" fontSize={kindFont} fill={ks.textSecondary}>
        {info.kind}
      </text>
      <text
        x={w - 10}
        y={h / 2 - 6}
        fontFamily="ui-monospace, monospace"
        fontSize={kindFont}
        fill={ks.textPrimary}
        textAnchor="end"
      >
        {statusLabel(info)}
      </text>
      {info.output_table && (
        <text
          x={w - 10}
          y={h / 2 + 10}
          fontFamily="ui-monospace, monospace"
          fontSize={9}
          fill={ks.textSecondary}
          textAnchor="end"
        >
          → {truncate(info.output_table, compact ? 14 : 18)}
        </text>
      )}
      {progress > 0 && (
        <rect
          x={8}
          y={h - 8}
          width={(w - 16) * progress}
          height={3}
          rx={1.5}
          fill={info.state.state === "running" ? "#fbbf24" : "#22c55e"}
        />
      )}
    </g>
  );
}

interface GroupSummary {
  dominant: "running" | "failed" | "done" | "skipped" | "pending";
  done: number;
  total: number;
  running: number;
  failed: number;
  rowsDone: number;
  totalDurMs: number;
  overallProgress: number;
}

interface RenderGroupArgs {
  u: Unit;
  color: { fill: string; stroke: string };
  summary: GroupSummary;
  theme: "dark" | "light";
  description: string | null;
  onClick: () => void;
}

function renderGroupCollapsed({
  u,
  color,
  summary,
  theme,
  description,
  onClick,
}: RenderGroupArgs) {
  const fill = theme === "light" ? color.fill : hexWithAlpha(color.fill, 0.5);
  const stroke = color.stroke;
  let stateStroke = stroke;
  let pulse = false;
  if (summary.dominant === "running") {
    stateStroke = theme === "light" ? "#b45309" : "#fbbf24";
    pulse = true;
  } else if (summary.dominant === "failed") {
    stateStroke = theme === "light" ? "#b91c1c" : "#ef4444";
  } else if (summary.dominant === "done") {
    stateStroke = theme === "light" ? "#047857" : "#10b981";
  }
  const textPrimary = theme === "light" ? "#0f172a" : "#e2e8f0";
  return (
    <g
      key={u.id}
      transform={`translate(${u.x}, ${u.y})`}
      onClick={onClick}
      className="cursor-pointer"
    >
      <rect
        width={u.w}
        height={u.h}
        rx={10}
        ry={10}
        fill={fill}
        stroke={stateStroke}
        strokeWidth={pulse ? 2.4 : 1.8}
        className={pulse ? "pulse" : ""}
        style={{ color: stateStroke }}
      />
      <rect width={6} height={u.h} rx={3} ry={3} fill={stroke} />
      <text x={16} y={20} fontFamily="ui-monospace" fontSize={13} fill={stroke} fontWeight={700}>
        ▸ {u.groupName}
      </text>
      <text x={16} y={36} fontFamily="ui-monospace" fontSize={10} fill={textPrimary}>
        {summary.done}/{summary.total} pasos · {Math.round(summary.overallProgress * 100)}%
      </text>
      {summary.failed > 0 && (
        <text x={16} y={52} fontFamily="ui-monospace" fontSize={10} fill={theme === "light" ? "#b91c1c" : "#fca5a5"}>
          ✗ {summary.failed} failed
        </text>
      )}
      {summary.running > 0 && summary.failed === 0 && (
        <text x={16} y={52} fontFamily="ui-monospace" fontSize={10} fill={theme === "light" ? "#b45309" : "#fcd34d"}>
          ⟳ {summary.running} en ejecución
        </text>
      )}
      {summary.failed === 0 && summary.running === 0 && summary.done === summary.total && summary.total > 0 && (
        <text x={16} y={52} fontFamily="ui-monospace" fontSize={10} fill={theme === "light" ? "#065f46" : "#86efac"}>
          ✓ {summary.rowsDone.toLocaleString()} filas · {summary.totalDurMs}ms
        </text>
      )}
      {description && (
        <text
          x={u.w - 10}
          y={u.h - 10}
          fontFamily="ui-sans-serif"
          fontSize={9}
          fill={textPrimary}
          textAnchor="end"
          opacity={0.55}
        >
          {truncate(description, 28)}
        </text>
      )}
      {/* progress bar */}
      <rect
        x={8}
        y={u.h - 6}
        width={(u.w - 16) * summary.overallProgress}
        height={3}
        rx={1.5}
        fill={summary.dominant === "running" ? "#fbbf24" : summary.dominant === "done" ? "#22c55e" : "#94a3b8"}
      />
    </g>
  );
}

function Legend({
  kinds,
  theme,
}: {
  kinds: string[];
  theme: "dark" | "light";
}) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {kinds.map((k) => {
        const ks = kindStyle(k, theme);
        return (
          <span
            key={k}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border"
            style={{
              borderColor: ks.baseStroke,
              backgroundColor:
                theme === "light" ? ks.baseFill : hexWithAlpha(ks.baseFill, 0.35),
              color: ks.textPrimary,
            }}
          >
            <span style={{ color: ks.baseStroke }}>{ks.glyph}</span>
            <span className="font-mono">{k}</span>
          </span>
        );
      })}
    </div>
  );
}

function ToggleButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 rounded border border-surface-strong bg-surface-2 hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

function statusLabel(info: StepInfo): string {
  const s = info.state;
  switch (s.state) {
    case "running":
      return `${Math.round((s.progress ?? 0) * 100)}%`;
    case "done":
      return `${s.duration_ms}ms`;
    case "failed":
      return "✗";
    case "cancelled":
      return "cancel";
    case "skipped":
      return "skip";
    case "ready":
      return "ready";
    default:
      return "·";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
