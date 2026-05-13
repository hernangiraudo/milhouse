"use client";

import type { TableSample } from "@/lib/types";

export function SamplePanel({ sample }: { sample: TableSample | null | undefined }) {
  if (!sample) {
    return (
      <div className="text-slate-500 text-sm">
        (no hay sample disponible todavía)
      </div>
    );
  }
  return (
    <div>
      <div className="text-xs text-slate-400 mb-2 tabular-nums">
        {sample.sampled_rows.toLocaleString()} de{" "}
        {sample.total_rows.toLocaleString()} filas · {sample.columns.length}{" "}
        cols
      </div>
      <div className="overflow-auto max-h-[28rem] border border-slate-800 rounded-md">
        <table className="text-xs min-w-full">
          <thead className="bg-panel2 sticky top-0">
            <tr>
              {sample.columns.map((c) => (
                <th
                  key={c.name}
                  className="px-2 py-1 text-left font-mono text-slate-300 border-b border-slate-800"
                >
                  <div>{c.name}</div>
                  <div className="text-[10px] text-slate-500">{c.dtype}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.map((r, i) => (
              <tr key={i} className="even:bg-slate-900/40">
                {r.map((v, j) => (
                  <td
                    key={j}
                    className="px-2 py-1 font-mono whitespace-nowrap text-slate-300 border-b border-slate-800/60"
                  >
                    {fmt(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toString() : v.toFixed(4);
  return String(v);
}
