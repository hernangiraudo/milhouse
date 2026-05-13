"use client";

import { useMemo } from "react";
import type { StepInfo } from "@/lib/types";
import { useTheme } from "@/lib/useTheme";

const NODE_W = 200;
const NODE_H = 60;
const LEVEL_GAP_X = 90;
const ROW_GAP_Y = 20;
const PAD = 24;

interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  info: StepInfo;
}

interface Layout {
  nodes: LaidOutNode[];
  edges: Array<{ from: string; to: string }>;
  width: number;
  height: number;
}

// =====================================================================
// Layout: niveles topológicos + reordenamiento por baricentro
// (heurística Sugiyama simplificada para minimizar cruces).
// =====================================================================
function computeLayout(
  steps: Record<string, StepInfo>,
  order: string[],
): Layout {
  const ids = order.filter((id) => steps[id]);
  const succ: Record<string, string[]> = {};
  const preds: Record<string, string[]> = {};
  const inDeg: Record<string, number> = {};
  for (const id of ids) {
    inDeg[id] = steps[id].depends_on.length;
    preds[id] = [...steps[id].depends_on];
    succ[id] = succ[id] ?? [];
    for (const d of steps[id].depends_on) {
      succ[d] = succ[d] ?? [];
      succ[d].push(id);
    }
  }

  // ---- 1. Asignación de niveles (longest path desde raíz) ----
  const level: Record<string, number> = {};
  const ready: string[] = ids.filter((id) => inDeg[id] === 0);
  for (const id of ready) level[id] = 0;
  const remaining = { ...inDeg };
  const queue = [...ready];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of succ[cur] ?? []) {
      remaining[next] -= 1;
      level[next] = Math.max(level[next] ?? 0, (level[cur] ?? 0) + 1);
      if (remaining[next] === 0) queue.push(next);
    }
  }

  // ---- 2. Agrupar por nivel ----
  let maxLevel = 0;
  for (const id of ids) maxLevel = Math.max(maxLevel, level[id] ?? 0);
  const byLevel: string[][] = [];
  for (let l = 0; l <= maxLevel; l++) byLevel.push([]);
  for (const id of ids) byLevel[level[id] ?? 0].push(id);

  // ---- 3. Reordenar por baricentro (varias pasadas) ----
  // Inicialmente, mantener el orden del config (es estable).
  // Pasada hacia adelante: nivel L se ordena por avg(pos en L-1 de sus preds).
  // Pasada hacia atrás: nivel L se ordena por avg(pos en L+1 de sus succ).
  const posInLevel = (id: string, levelIds: string[]): number =>
    levelIds.indexOf(id);

  for (let iter = 0; iter < 6; iter++) {
    const forward = iter % 2 === 0;
    if (forward) {
      for (let l = 1; l <= maxLevel; l++) {
        const cur = byLevel[l];
        const prev = byLevel[l - 1];
        cur.sort((a, b) => baricentro(a, prev, preds) - baricentro(b, prev, preds));
      }
    } else {
      for (let l = maxLevel - 1; l >= 0; l--) {
        const cur = byLevel[l];
        const next = byLevel[l + 1];
        cur.sort((a, b) => baricentro(a, next, succ) - baricentro(b, next, succ));
      }
    }
  }

  // ---- 4. Asignar coordenadas ----
  let maxRows = 0;
  for (let l = 0; l <= maxLevel; l++) {
    maxRows = Math.max(maxRows, byLevel[l].length);
  }
  const totalHeight = maxRows * (NODE_H + ROW_GAP_Y) - ROW_GAP_Y + PAD * 2;
  const nodes: LaidOutNode[] = [];
  for (let l = 0; l <= maxLevel; l++) {
    const colIds = byLevel[l];
    const count = colIds.length;
    const colHeight = count * (NODE_H + ROW_GAP_Y) - ROW_GAP_Y;
    const startY = (totalHeight - colHeight) / 2;
    colIds.forEach((id, i) => {
      nodes.push({
        id,
        x: PAD + l * (NODE_W + LEVEL_GAP_X),
        y: startY + i * (NODE_H + ROW_GAP_Y),
        info: steps[id],
      });
    });
  }
  const totalWidth = PAD * 2 + (maxLevel + 1) * NODE_W + maxLevel * LEVEL_GAP_X;
  const edges: Layout["edges"] = [];
  for (const id of ids) {
    for (const d of steps[id].depends_on) {
      edges.push({ from: d, to: id });
    }
  }
  return { nodes, edges, width: totalWidth, height: totalHeight };
}

function baricentro(
  id: string,
  neighborLevel: string[],
  neighbors: Record<string, string[]>,
): number {
  const ns = neighbors[id] ?? [];
  if (ns.length === 0) return Number.POSITIVE_INFINITY; // nodos sin vecinos al final
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

// =====================================================================
// Estilos por tipo de paso
// =====================================================================

type KindStyle = {
  baseFill: string; // fondo del nodo
  baseStroke: string; // borde del nodo + acento
  textPrimary: string; // texto principal (id del paso)
  textSecondary: string; // texto secundario (kind, status)
  glyph: string;
};

// Paleta oscura: fills oscuros, borde brillante, texto claro.
const KIND_STYLES_DARK: Record<string, KindStyle> = {
  sql_query: {
    baseFill: "#0c4a6e",
    baseStroke: "#38bdf8",
    textPrimary: "#e0f2fe",
    textSecondary: "#7dd3fc",
    glyph: "▼",
  },
  sql_exec: {
    baseFill: "#1e3a8a", // blue-900
    baseStroke: "#60a5fa", // blue-400
    textPrimary: "#dbeafe",
    textSecondary: "#93c5fd",
    glyph: "⚙",
  },
  join: {
    baseFill: "#4c1d95",
    baseStroke: "#a78bfa",
    textPrimary: "#ede9fe",
    textSecondary: "#c4b5fd",
    glyph: "⋈",
  },
  lookup: {
    baseFill: "#701a75",
    baseStroke: "#e879f9",
    textPrimary: "#fae8ff",
    textSecondary: "#f0abfc",
    glyph: "🔎",
  },
  transform: {
    baseFill: "#78350f",
    baseStroke: "#fbbf24",
    textPrimary: "#fef3c7",
    textSecondary: "#fcd34d",
    glyph: "ƒ",
  },
  filter_and_subset: {
    baseFill: "#164e63",
    baseStroke: "#22d3ee",
    textPrimary: "#cffafe",
    textSecondary: "#67e8f9",
    glyph: "▾",
  },
  sort: {
    baseFill: "#134e4a",
    baseStroke: "#2dd4bf",
    textPrimary: "#ccfbf1",
    textSecondary: "#5eead4",
    glyph: "↕",
  },
  procedural: {
    baseFill: "#881337",
    baseStroke: "#fb7185",
    textPrimary: "#ffe4e6",
    textSecondary: "#fda4af",
    glyph: "λ",
  },
  export: {
    baseFill: "#365314",
    baseStroke: "#a3e635",
    textPrimary: "#ecfccb",
    textSecondary: "#bef264",
    glyph: "⇧",
  },
};

// Paleta clara: fills pastel claros, borde profundo (saturated 700-800),
// texto profundo (slate-900 / kind-900) para máximo contraste sobre blanco.
const KIND_STYLES_LIGHT: Record<string, KindStyle> = {
  sql_query: {
    baseFill: "#dbeafe", // sky-100
    baseStroke: "#0369a1", // sky-700
    textPrimary: "#0c4a6e", // sky-900
    textSecondary: "#075985", // sky-800
    glyph: "▼",
  },
  sql_exec: {
    baseFill: "#dbeafe", // blue-100
    baseStroke: "#1d4ed8", // blue-700
    textPrimary: "#1e3a8a", // blue-900
    textSecondary: "#1e40af", // blue-800
    glyph: "⚙",
  },
  join: {
    baseFill: "#ede9fe", // violet-100
    baseStroke: "#6d28d9", // violet-700
    textPrimary: "#4c1d95",
    textSecondary: "#5b21b6",
    glyph: "⋈",
  },
  lookup: {
    baseFill: "#fae8ff", // fuchsia-100
    baseStroke: "#a21caf", // fuchsia-700
    textPrimary: "#701a75",
    textSecondary: "#86198f",
    glyph: "🔎",
  },
  transform: {
    baseFill: "#fef3c7", // amber-100
    baseStroke: "#b45309", // amber-700
    textPrimary: "#78350f",
    textSecondary: "#92400e",
    glyph: "ƒ",
  },
  filter_and_subset: {
    baseFill: "#cffafe", // cyan-100
    baseStroke: "#0e7490", // cyan-700
    textPrimary: "#164e63",
    textSecondary: "#155e75",
    glyph: "▾",
  },
  sort: {
    baseFill: "#ccfbf1", // teal-100
    baseStroke: "#0f766e", // teal-700
    textPrimary: "#134e4a",
    textSecondary: "#115e59",
    glyph: "↕",
  },
  procedural: {
    baseFill: "#ffe4e6", // rose-100
    baseStroke: "#be123c", // rose-700
    textPrimary: "#881337",
    textSecondary: "#9f1239",
    glyph: "λ",
  },
  export: {
    baseFill: "#ecfccb", // lime-100
    baseStroke: "#4d7c0f", // lime-700
    textPrimary: "#365314",
    textSecondary: "#3f6212",
    glyph: "⇧",
  },
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

function stateOverlay(
  info: StepInfo,
  theme: "dark" | "light",
): {
  fillAlpha: number;
  strokeColor: string | null;
  pulse: boolean;
  ghost: boolean;
} {
  const s = info.state.state;
  if (theme === "light") {
    // En light, los fills ya son claros — no los apagamos con alpha bajo
    // (eso pierde contraste). Marcamos estado con borde y opacidad del grupo.
    switch (s) {
      case "running":
        return { fillAlpha: 1, strokeColor: "#b45309", pulse: true, ghost: false };
      case "done":
        return { fillAlpha: 1, strokeColor: null, pulse: false, ghost: false };
      case "failed":
        return { fillAlpha: 1, strokeColor: "#b91c1c", pulse: false, ghost: false };
      case "cancelled":
      case "skipped":
        return { fillAlpha: 0.5, strokeColor: "#94a3b8", pulse: false, ghost: true };
      case "ready":
        return { fillAlpha: 0.85, strokeColor: "#0e7490", pulse: false, ghost: false };
      default: // pending
        return { fillAlpha: 0.55, strokeColor: null, pulse: false, ghost: true };
    }
  }
  // Dark
  switch (s) {
    case "running":
      return { fillAlpha: 0.55, strokeColor: "#fbbf24", pulse: true, ghost: false };
    case "done":
      return { fillAlpha: 0.45, strokeColor: null, pulse: false, ghost: false };
    case "failed":
      return { fillAlpha: 0.5, strokeColor: "#ef4444", pulse: false, ghost: false };
    case "cancelled":
    case "skipped":
      return { fillAlpha: 0.15, strokeColor: "#475569", pulse: false, ghost: true };
    case "ready":
      return { fillAlpha: 0.25, strokeColor: "#22d3ee", pulse: false, ghost: false };
    default: // pending
      return { fillAlpha: 0.18, strokeColor: null, pulse: false, ghost: true };
  }
}

function hexWithAlpha(hex: string, alpha: number): string {
  // hex like "#0c4a6e"
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// =====================================================================
// Componente
// =====================================================================

export function DagView({
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
  const theme = useTheme();
  const layout = useMemo(() => computeLayout(steps, order), [steps, order]);
  const nodeMap = useMemo(() => {
    const m: Record<string, LaidOutNode> = {};
    for (const n of layout.nodes) m[n.id] = n;
    return m;
  }, [layout]);

  const kindsPresent = useMemo(() => {
    const set = new Set<string>();
    for (const n of layout.nodes) set.add(n.info.kind);
    return Array.from(set);
  }, [layout]);

  const edgeBase = theme === "light" ? "#475569" : "#475569"; // slate-600
  const edgeActive = theme === "light" ? "#0e7490" : "#22d3ee"; // cyan-700 / cyan-400
  const arrowBaseFill = theme === "light" ? "#475569" : "#64748b";
  const arrowActiveFill = theme === "light" ? "#0e7490" : "#22d3ee";

  return (
    <div className="space-y-3">
      <Legend kinds={kindsPresent} theme={theme} />
      <div className="overflow-auto border border-slate-800 rounded-xl bg-panel p-2">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ minWidth: layout.width, minHeight: layout.height }}
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
              <path d="M0,0 L10,5 L0,10 Z" fill={arrowBaseFill} />
            </marker>
            <marker
              id="arrow-active"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
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

          {/* edges (debajo de los nodos) */}
          {layout.edges.map((e, i) => {
            const a = nodeMap[e.from];
            const b = nodeMap[e.to];
            if (!a || !b) return null;
            const ax = a.x + NODE_W;
            const ay = a.y + NODE_H / 2;
            const bx = b.x;
            const by = b.y + NODE_H / 2;
            const midX = (ax + bx) / 2;
            const d = `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
            const aDone = a.info.state.state === "done";
            const aRunning = a.info.state.state === "running";
            const bRunning = b.info.state.state === "running";
            const bReady = b.info.state.state === "ready";
            const isActive = (aDone || aRunning) && (bRunning || bReady);
            const dim =
              selectedId &&
              a.info.id !== selectedId &&
              b.info.id !== selectedId;
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={isActive ? edgeActive : edgeBase}
                strokeWidth={isActive ? 2.4 : 1.6}
                strokeDasharray={
                  b.info.state.state === "skipped" ||
                  b.info.state.state === "cancelled"
                    ? "4 3"
                    : undefined
                }
                markerEnd={`url(#${isActive ? "arrow-active" : "arrow"})`}
                opacity={dim ? 0.3 : 1}
              />
            );
          })}

          {/* nodes */}
          {layout.nodes.map((n) => {
            const ks = kindStyle(n.info.kind, theme);
            const ov = stateOverlay(n.info, theme);
            const isSelected = n.id === selectedId;
            const fill = hexWithAlpha(ks.baseFill, ov.fillAlpha);
            const stroke = ov.strokeColor ?? ks.baseStroke;
            const progress =
              n.info.state.state === "running"
                ? (n.info.state.progress ?? 0)
                : n.info.state.state === "done"
                ? 1
                : 0;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                onClick={() => onSelect(n.id)}
                className="cursor-pointer"
                style={{
                  color: stroke,
                  opacity: ov.ghost ? 0.65 : 1,
                }}
              >
                {/* nodo */}
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={9}
                  ry={9}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={isSelected ? 2.8 : ov.pulse ? 2.2 : 1.6}
                  className={ov.pulse ? "pulse" : ""}
                />
                {/* franja de color del tipo en el borde izquierdo */}
                <rect
                  width={4}
                  height={NODE_H}
                  rx={2}
                  ry={2}
                  fill={ks.baseStroke}
                />
                {/* glyph */}
                <text
                  x={14}
                  y={22}
                  fontFamily="ui-monospace, monospace"
                  fontSize={13}
                  fill={ks.baseStroke}
                >
                  {ks.glyph}
                </text>
                {/* id */}
                <text
                  x={32}
                  y={22}
                  fontFamily="ui-monospace, monospace"
                  fontSize={12}
                  fill={ks.textPrimary}
                  fontWeight={600}
                >
                  {n.id.length > 22 ? n.id.slice(0, 21) + "…" : n.id}
                </text>
                {/* kind */}
                <text
                  x={32}
                  y={38}
                  fontFamily="ui-monospace, monospace"
                  fontSize={10}
                  fill={ks.textSecondary}
                >
                  {n.info.kind}
                </text>
                {/* status label */}
                <text
                  x={NODE_W - 10}
                  y={22}
                  fontFamily="ui-monospace, monospace"
                  fontSize={10}
                  fill={ks.textPrimary}
                  textAnchor="end"
                >
                  {statusLabel(n.info)}
                </text>
                {/* output table */}
                {n.info.output_table && (
                  <text
                    x={NODE_W - 10}
                    y={38}
                    fontFamily="ui-monospace, monospace"
                    fontSize={9}
                    fill={ks.textSecondary}
                    textAnchor="end"
                  >
                    → {truncate(n.info.output_table, 18)}
                  </text>
                )}
                {/* progress bar */}
                {progress > 0 && (
                  <rect
                    x={8}
                    y={NODE_H - 8}
                    width={(NODE_W - 16) * progress}
                    height={3}
                    rx={1.5}
                    fill={
                      n.info.state.state === "running" ? "#fbbf24" : "#22c55e"
                    }
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
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
