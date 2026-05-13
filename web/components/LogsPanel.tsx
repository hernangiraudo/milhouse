"use client";

import { useEffect, useRef } from "react";
import type { LogLine } from "@/lib/types";

export function LogsPanel({ logs }: { logs: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs.length]);

  return (
    <div ref={ref} className="milhouse-logs">
      {logs.length === 0 && (
        <div className="milhouse-logs-empty">(sin logs todavía)</div>
      )}
      {logs.map((l, i) => (
        <div key={i} className="whitespace-pre-wrap">
          <span className="milhouse-logs-time">
            {new Date(l.at).toLocaleTimeString()}{" "}
          </span>
          <span
            className={
              l.level === "error"
                ? "milhouse-logs-error"
                : l.level === "warn"
                ? "milhouse-logs-warn"
                : "milhouse-logs-info"
            }
          >
            {l.line}
          </span>
        </div>
      ))}
    </div>
  );
}
