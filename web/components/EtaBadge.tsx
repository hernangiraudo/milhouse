"use client";

export function EtaBadge({
  jobPct,
  etaSeconds,
  stepsDone,
  stepsTotal,
}: {
  jobPct: number;
  etaSeconds: number | null;
  stepsDone: number;
  stepsTotal: number;
}) {
  const pct = Math.round(jobPct * 100);
  const eta = etaSeconds == null ? "?" : formatSeconds(etaSeconds);
  return (
    <div className="flex items-center gap-3">
      <div className="w-64 bg-slate-800 rounded-full h-3 overflow-hidden border border-slate-700">
        <div
          className="bg-accent h-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-sm text-slate-300 tabular-nums">
        {pct}% · {stepsDone}/{stepsTotal} steps · ETA {eta}
      </div>
    </div>
  );
}

function formatSeconds(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
