"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addComment,
  closeCase,
  getCase,
  listCases,
  type CaseDetail,
  type QueryRows,
} from "@/lib/api";
import { useUser } from "@/lib/session";
import { useDialog } from "./Dialog";

type StatusFilter = "all" | "open" | "closed";
type SortCol = "severity" | "assignee" | "created_at";
type SortDir = "asc" | "desc";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

export function CasesPanel() {
  const me = useUser();
  const dialog = useDialog();
  const [list, setList] = useState<QueryRows | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [onlyMine, setOnlyMine] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [comment, setComment] = useState("");

  async function reload() {
    try {
      const r = await listCases();
      setList(r);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function reloadDetail(id: number) {
    try {
      const d = await getCase(id);
      setDetail(d);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    reloadDetail(selectedId);
  }, [selectedId]);

  const filtered = useMemo(() => {
    if (!list) return null;
    const ciStatus = list.columns.indexOf("status");
    const ciAssign = list.columns.indexOf("assignee");
    const ciSort = list.columns.indexOf(sortCol);
    let rows = list.rows.filter((r) => {
      if (statusFilter !== "all" && String(r[ciStatus]) !== statusFilter)
        return false;
      if (onlyMine) {
        const a = (r[ciAssign] as string | null) ?? "";
        if (!me || a !== me) return false;
      }
      return true;
    });
    rows = [...rows].sort((a, b) => {
      const av = a[ciSort];
      const bv = b[ciSort];
      if (sortCol === "severity") {
        const ai = SEVERITY_ORDER[String(av ?? "")] ?? -1;
        const bi = SEVERITY_ORDER[String(bv ?? "")] ?? -1;
        return sortDir === "asc" ? ai - bi : bi - ai;
      }
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return { ...list, rows };
  }, [list, statusFilter, onlyMine, me, sortCol, sortDir]);

  function toggleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir(col === "created_at" || col === "severity" ? "desc" : "asc");
    }
  }

  async function onClose() {
    if (selectedId == null) return;
    const ok = await dialog.confirm(`¿Cerrar el caso #${selectedId}?`, {
      title: "Cerrar caso",
      variant: "warning",
      ok: "Cerrar caso",
    });
    if (!ok) return;
    try {
      await closeCase(selectedId, me);
      await reload();
      await reloadDetail(selectedId);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onComment(e: React.FormEvent) {
    e.preventDefault();
    if (selectedId == null) return;
    const body = comment.trim();
    if (!body) return;
    try {
      await addComment(selectedId, body, me);
      setComment("");
      await reloadDetail(selectedId);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-lg">Casos</h2>
          <p className="text-sm text-muted">
            Investigaciones creadas a partir de datasets persistidos.
          </p>
        </div>
        <div className="flex gap-2 text-xs flex-wrap items-center">
          <div className="flex gap-1">
            {(
              [
                ["open", "Abiertos"],
                ["closed", "Cerrados"],
                ["all", "Todos"],
              ] as const
            ).map(([s, label]) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2 py-1 rounded border ${
                  statusFilter === s
                    ? "bg-accent-token border-transparent"
                    : "bg-surface-2 border-surface-strong"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label
            className={`flex items-center gap-1.5 px-2 py-1 rounded border cursor-pointer select-none ${
              onlyMine
                ? "bg-accent-token border-transparent"
                : "bg-surface-2 border-surface-strong"
            }`}
            title={
              me ? `Solo casos donde sos responsable (${me})` : "Iniciá sesión"
            }
          >
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(e) => setOnlyMine(e.target.checked)}
              disabled={!me}
            />
            Mis casos
          </label>
          <button
            onClick={reload}
            className="px-2 py-1 rounded border border-surface-strong bg-surface-2 hover:bg-slate-800"
          >
            Refrescar
          </button>
        </div>
      </header>

      {err && <div className="text-red-400 text-sm">{err}</div>}

      <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
        <header className="px-4 py-2 bg-panel2 text-xs uppercase tracking-wider text-muted">
          {filtered?.rows.length ?? 0} caso(s)
          {onlyMine && me && (
            <span className="ml-2 text-dim">· responsable: {me}</span>
          )}
        </header>
        <div className="max-h-80 overflow-auto">
          <CasesTable
            data={filtered}
            selectedId={selectedId}
            onSelect={setSelectedId}
            sortCol={sortCol}
            sortDir={sortDir}
            onSort={toggleSort}
          />
        </div>
      </div>

      {detail && (
        <div className="bg-panel border border-slate-800 rounded-xl p-5 space-y-4">
          <CaseHeader
            detail={detail}
            onClose={onClose}
          />
          <Section title={`Datasets adjuntos (${detail.datasets.rows.length})`}>
            <DatasetsAttached data={detail.datasets} />
          </Section>
          <Section title={`Comentarios (${detail.comments.rows.length})`}>
            <Comments data={detail.comments} />
            <form onSubmit={onComment} className="mt-3 flex gap-2">
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Agregar comentario…"
                className="flex-1 milhouse-field"
              />
              <button
                type="submit"
                disabled={!comment.trim()}
                className="bg-accent text-ink font-semibold px-3 py-2 rounded-md disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
              >
                Comentar
              </button>
            </form>
          </Section>
        </div>
      )}
    </section>
  );
}

function CasesTable({
  data,
  selectedId,
  onSelect,
  sortCol,
  sortDir,
  onSort,
}: {
  data: QueryRows | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
}) {
  if (!data) return <div className="px-4 py-6 text-dim text-sm text-center">cargando…</div>;
  if (data.rows.length === 0)
    return <div className="px-4 py-6 text-dim text-sm text-center">sin casos.</div>;
  const ci = (n: string) => data.columns.indexOf(n);
  return (
    <table className="w-full text-sm">
      <thead className="text-muted">
        <tr>
          <Th>#</Th>
          <Th>Título</Th>
          <SortableTh col="severity" sortCol={sortCol} sortDir={sortDir} onSort={onSort}>
            Severidad
          </SortableTh>
          <Th>Estado</Th>
          <SortableTh col="assignee" sortCol={sortCol} sortDir={sortDir} onSort={onSort}>
            Responsable
          </SortableTh>
          <Th>Creador</Th>
          <Th>Datasets</Th>
          <Th>Comentarios</Th>
          <SortableTh col="created_at" sortCol={sortCol} sortDir={sortDir} onSort={onSort}>
            Creado
          </SortableTh>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => {
          const id = Number(r[ci("id")]);
          const isSel = id === selectedId;
          return (
            <tr
              key={i}
              onClick={() => onSelect(id)}
              className={`border-t border-surface cursor-pointer ${
                isSel ? "bg-cyan-500/10" : "hover:bg-slate-800/30"
              }`}
            >
              <Td mono>#{id}</Td>
              <Td>{String(r[ci("title")])}</Td>
              <Td>
                <SeverityBadge severity={String(r[ci("severity")])} />
              </Td>
              <Td>
                <StatusBadge status={String(r[ci("status")])} />
              </Td>
              <Td mono>{(r[ci("assignee")] as string | null) ?? "—"}</Td>
              <Td mono>{(r[ci("creator")] as string | null) ?? "—"}</Td>
              <Td>{String(r[ci("datasets_count")] ?? 0)}</Td>
              <Td>{String(r[ci("comments_count")] ?? 0)}</Td>
              <Td>{formatDate(r[ci("created_at")])}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SortableTh({
  children,
  col,
  sortCol,
  sortDir,
  onSort,
}: {
  children: React.ReactNode;
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
}) {
  const active = sortCol === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`text-left px-3 py-2 font-medium cursor-pointer select-none hover:text-app ${
        active ? "text-app" : ""
      }`}
    >
      {children}
      <span className="ml-1 text-dim">
        {active ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
      </span>
    </th>
  );
}

function CaseHeader({
  detail,
  onClose,
}: {
  detail: CaseDetail;
  onClose: () => void;
}) {
  const h = detail.header;
  const ci = (n: string) => h.columns.indexOf(n);
  const row = h.rows[0];
  if (!row) return null;
  const id = Number(row[ci("id")]);
  const title = String(row[ci("title")]);
  const description = row[ci("description")] as string | null;
  const severity = String(row[ci("severity")]);
  const status = String(row[ci("status")]);
  const assignee = (row[ci("assignee")] as string | null) ?? "—";
  const creator = (row[ci("creator")] as string | null) ?? "—";
  const closedAt = row[ci("closed_at")] as string | null;
  const closedBy = row[ci("closed_by")] as string | null;
  return (
    <div>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-xl font-bold">
            <span className="text-dim font-mono">#{id}</span> {title}
          </h3>
          <div className="flex items-center gap-2 mt-2 flex-wrap text-xs">
            <SeverityBadge severity={severity} />
            <StatusBadge status={status} />
            <span className="text-muted">
              Responsable:{" "}
              <code className="milhouse-chip" style={{ fontSize: "0.7rem" }}>
                {assignee}
              </code>
            </span>
            <span className="text-muted">
              Creador:{" "}
              <code className="milhouse-chip" style={{ fontSize: "0.7rem" }}>
                {creator}
              </code>
            </span>
            <span className="text-muted">
              creado: {formatDate(row[ci("created_at")])}
            </span>
            {closedAt && (
              <span className="text-muted">
                cerrado {formatDate(closedAt)} por{" "}
                <code className="milhouse-chip" style={{ fontSize: "0.7rem" }}>
                  {closedBy ?? "—"}
                </code>
              </span>
            )}
          </div>
        </div>
        {status === "open" && (
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/40"
          >
            ✓ Cerrar caso
          </button>
        )}
      </div>
      {description && (
        <p className="text-sm text-app mt-3 whitespace-pre-wrap border-l-2 border-surface-strong pl-3">
          {description}
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-xs uppercase tracking-wider text-muted mb-2">
        {title}
      </h4>
      <div>{children}</div>
    </div>
  );
}

function DatasetsAttached({ data }: { data: QueryRows }) {
  if (data.rows.length === 0)
    return <div className="text-dim text-sm">— sin datasets —</div>;
  const ci = (n: string) => data.columns.indexOf(n);
  return (
    <div className="bg-surface-2 border border-surface rounded-md overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-muted">
          <tr>
            <Th>Run</Th>
            <Th>Step UID</Th>
            <Th>Nombre</Th>
            <Th>Nivel</Th>
            <Th>Filas</Th>
            <Th>Tamaño</Th>
            <Th>Agregado</Th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => {
            const jobId = String(r[ci("job_id")]);
            const uid = Number(r[ci("step_uid")]);
            const cfg =
              (r[ci("config_display_name")] as string | null) ??
              (r[ci("config_name")] as string | null) ??
              "—";
            return (
              <tr key={i} className="border-t border-surface">
                <Td>
                  <span className="font-mono text-xs">{jobId.slice(0, 8)}</span>
                  <span className="text-dim"> · {cfg}</span>
                </Td>
                <Td mono>{uid}</Td>
                <Td mono>{String(r[ci("dataset_name")] ?? "—")}</Td>
                <Td>
                  <LevelBadge level={String(r[ci("level")] ?? "info")} />
                </Td>
                <Td>
                  {r[ci("row_count")] != null
                    ? Number(r[ci("row_count")]).toLocaleString()
                    : "—"}
                </Td>
                <Td>{formatBytes(r[ci("size_bytes")])}</Td>
                <Td>{formatDate(r[ci("added_at")])}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Comments({ data }: { data: QueryRows }) {
  if (data.rows.length === 0)
    return <div className="text-dim text-sm">— sin comentarios —</div>;
  const ci = (n: string) => data.columns.indexOf(n);
  return (
    <ul className="space-y-2">
      {data.rows.map((r, i) => (
        <li
          key={i}
          className="bg-surface-2 border border-surface rounded-md p-3"
        >
          <div className="flex items-center gap-2 text-xs text-muted mb-1">
            <code className="milhouse-chip" style={{ fontSize: "0.7rem" }}>
              {(r[ci("author")] as string | null) ?? "anon"}
            </code>
            <span>{formatDate(r[ci("created_at")])}</span>
          </div>
          <div className="text-sm whitespace-pre-wrap">
            {String(r[ci("body")])}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    low: "bg-slate-500/20 text-slate-300 border-slate-700",
    medium: "bg-amber-500/20 text-amber-300 border-amber-700",
    high: "bg-orange-500/20 text-orange-300 border-orange-700",
    critical: "bg-red-500/20 text-red-300 border-red-700",
  };
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono ${
        map[severity] ?? map.medium
      }`}
    >
      {severity}
    </span>
  );
}
function LevelBadge({ level }: { level: string }) {
  const map: Record<string, string> = {
    info: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
    warn: "bg-yellow-500/20 text-yellow-300 border-yellow-700",
    error: "bg-red-500/20 text-red-300 border-red-700",
  };
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono ${
        map[level] ?? map.info
      }`}
    >
      {level}
    </span>
  );
}
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    open: {
      cls: "bg-yellow-500/20 text-yellow-300 border-yellow-700",
      label: "abierto",
    },
    closed: {
      cls: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
      label: "cerrado",
    },
  };
  const v = map[status] ?? {
    cls: "bg-slate-500/20 text-slate-300 border-slate-700",
    label: status,
  };
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono ${v.cls}`}
    >
      {v.label}
    </span>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left px-3 py-2 font-medium">{children}</th>;
}
function Td({
  children,
  mono,
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <td className={`px-3 py-1.5 ${mono ? "font-mono text-xs" : ""}`}>
      {children}
    </td>
  );
}
function formatBytes(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function formatDate(v: unknown): string {
  if (v == null) return "—";
  const s = String(v);
  try {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  } catch {}
  return s;
}
