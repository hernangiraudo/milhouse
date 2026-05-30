"use client";

import { useState } from "react";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { UsersPanel } from "@/components/UsersPanel";
import { RunEtlPanel } from "@/components/RunEtlPanel";
import { RunsReviewPanel } from "@/components/RunsReviewPanel";
import { CasesPanel } from "@/components/CasesPanel";
import { SchedulesPanel } from "@/components/SchedulesPanel";
import { DesignPanel } from "@/components/DesignPanel";
import { ExecParamsPanel } from "@/components/ExecParamsPanel";
import { ConstantsPanel } from "@/components/ConstantsPanel";
import { RoadmapPanel } from "@/components/RoadmapPanel";
import { SqlMonitorPanel } from "@/components/SqlMonitorPanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserChip } from "@/components/LoginGate";
import {
  Pencil,
  SlidersHorizontal,
  Ruler,
  Play,
  CalendarClock,
  ScrollText,
  FolderOpen,
  Plug,
  Activity,
  Users,
  Map as MapIcon,
  type LucideIcon,
} from "lucide-react";

type Section =
  | "design"
  | "exec_params"
  | "constants"
  | "run"
  | "schedules"
  | "review"
  | "cases"
  | "connections"
  | "users"
  | "roadmap"
  | "sql_monitor";

const SECTIONS: Array<{ id: Section; label: string; Icon: LucideIcon }> = [
  { id: "design",       label: "Diseño",            Icon: Pencil },
  { id: "exec_params",  label: "Parámetros",        Icon: SlidersHorizontal },
  { id: "constants",    label: "Constantes",        Icon: Ruler },
  { id: "run",          label: "Ejecutar proyecto", Icon: Play },
  { id: "schedules",    label: "Planificación",     Icon: CalendarClock },
  { id: "review",       label: "Revisión de logs",  Icon: ScrollText },
  { id: "cases",        label: "Casos",             Icon: FolderOpen },
  { id: "connections",  label: "Conexiones",        Icon: Plug },
  { id: "sql_monitor",  label: "Monitor SQL",       Icon: Activity },
  { id: "users",        label: "Usuarios",          Icon: Users },
  { id: "roadmap",      label: "Roadmap",           Icon: MapIcon },
];

export default function Home() {
  const [section, setSection] = useState<Section>("run");

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-60 border-r border-surface bg-surface flex flex-col">
        <div className="px-5 py-5 border-b border-surface">
          <h1 className="text-xl font-bold tracking-tight">
            Milhouse <span className="text-accent">·</span>
          </h1>
          <p className="text-xs text-dim mt-0.5">ETL Manager</p>
        </div>
        <nav className="flex-1 py-3">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full text-left px-5 py-2.5 text-sm border-l-2 transition-colors flex items-center gap-2.5 ${
                section === s.id
                  ? "border-accent bg-surface-2 font-semibold"
                  : "border-transparent text-muted hover:bg-surface-2 hover:text-app"
              }`}
              style={
                section === s.id ? { borderLeftColor: "var(--accent)" } : {}
              }
            >
              <s.Icon size={16} strokeWidth={2} />
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-surface text-xs text-dim">
          <code>localhost:8090</code>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-surface bg-surface px-8 py-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wider">
            {SECTIONS.find((s) => s.id === section)?.label}
          </h2>
          <div className="flex items-center gap-4">
            <UserChip />
            <ThemeToggle />
          </div>
        </header>
        <div className="flex-1 overflow-auto p-8 max-w-7xl w-full mx-auto">
          {section === "design" && <DesignPanel />}
          {section === "exec_params" && <ExecParamsPanel />}
          {section === "constants" && <ConstantsPanel />}
          {section === "run" && <RunEtlPanel />}
          {section === "schedules" && <SchedulesPanel />}
          {section === "review" && <RunsReviewPanel />}
          {section === "cases" && <CasesPanel />}
          {section === "connections" && <ConnectionsPanel />}
          {section === "users" && <UsersPanel />}
          {section === "roadmap" && <RoadmapPanel />}
          {section === "sql_monitor" && <SqlMonitorPanel />}
        </div>
      </main>
    </div>
  );
}
