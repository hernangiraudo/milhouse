"use client";

import { useEffect, useMemo, useState } from "react";
import {
  datasetPreview,
  deleteRun,
  exportDatasetUrl,
  listRunDatasets,
  listRunHistory,
  listRunLogs,
  listRunSteps,
  OpenCasesBlockError,
  type DatasetPreview,
  type QueryRows,
} from "@/lib/api";
import { AttachToCaseDialog, CreateCaseDialog } from "./CaseDialogs";

type LogFilter = "all" | "info" | "warn" | "error";
type SortCol = "started_at" | "user_name" | "duration_ms";
type SortDir = "asc" | "desc";

export function RunsReviewPanel() {
  const [runs, setRuns] = useState<QueryRows | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [steps, setSteps] = useState<QueryRows | null>(null);
  const [datasets, setDatasets] = useState<QueryRows | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [logs, setLogs] = useState<QueryRows | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [search, setSearch] = useState("");

  // sorting + filtering + selection
  const [sortCol, setSortCol] = useState<SortCol>("started_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [configFilter, setConfigFilter] = useState<string>("__all__");
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // dataset preview
  const [selectedDatasetUid, setSelectedDatasetUid] = useState<number | null>(null);
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // diálogos
  const [showCreateCase, setShowCreateCase] = useState(false);
  const [showAttachCase, setShowAttachCase] = useState(false);

  async function reloadRuns() {
    try {
      const r = await listRunHistory();
      setRuns(r);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    reloadRuns();
  }, []);

  useEffect(() => {
    if (!selectedJob) {
      setSteps(null);
      setDatasets(null);
      setSelectedStep(null);
      setSelectedDatasetUid(null);
      setPreview(null);
      return;
    }
    listRunSteps(selectedJob).then(setSteps).catch((e) => setErr(String(e)));
    listRunDatasets(selectedJob).then(setDatasets).catch(() => {});
    setSelectedStep(null);
    setSelectedDatasetUid(null);
    setPreview(null);
  }, [selectedJob]);

  useEffect(() => {
    if (!selectedJob || selectedStep == null) {
      setLogs(null);
      return;
    }
    listRunLogs(selectedJob, selectedStep)
      .then(setLogs)
      .catch((e) => setErr(String(e)));
  }, [selectedJob, selectedStep]);

  useEffect(() => {
    if (!selectedJob || selectedDatasetUid == null) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    datasetPreview(selectedJob, selectedDatasetUid, 100)
      .then((p) => setPreview(p))
      .catch((e) => setErr(String(e)))
      .finally(() => setPreviewLoading(false));
  }, [selectedJob, selectedDatasetUid]);

  // ---- Lista de jobs: ordenar + filtrar ----
  // Para el filtro y la columna mostramos display_name (más amigable) pero
  // el value del filtro sigue siendo el `config_name` (filename) para evitar
  // colisiones si dos archivos comparten name interno.
  const configsAvailable = useMemo(() => {
    if (!runs) return [] as Array<{ value: string; label: string }>;
    const ciCfg = runs.columns.indexOf("config_name");
    const ciDisp = runs.columns.indexOf("config_display_name");
    const seen = new Map<string, string>();
    for (const r of runs.rows) {
      const v = String(r[ciCfg]);
      const label = (r[ciDisp] && String(r[ciDisp])) || v;
      if (!seen.has(v)) seen.set(v, label);
    }
    return Array.from(seen.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [runs]);

  const sortedFilteredRuns = useMemo(() => {
    if (!runs) return null;
    const ci = (n: string) => runs.columns.indexOf(n);
    const cfgCol = ci("config_name");
    let rows = runs.rows.filter(
      (r) =>
        configFilter === "__all__" || String(r[cfgCol]) === configFilter,
    );
    const col = ci(sortCol);
    rows = [...rows].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      // Fecha y nombre como string ordenable; duración como número.
      if (sortCol === "duration_ms") {
        const an = Number(av ?? 0);
        const bn = Number(bv ?? 0);
        return sortDir === "asc" ? an - bn : bn - an;
      }
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return { ...runs, rows };
  }, [runs, configFilter, sortCol, sortDir]);

  function toggleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir(col === "started_at" || col === "duration_ms" ? "desc" : "asc");
    }
  }

  function toggleCheck(jobId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }
  function checkAllFiltered() {
    if (!sortedFilteredRuns) return;
    const ci = sortedFilteredRuns.columns.indexOf("job_id");
    const ids = sortedFilteredRuns.rows.map((r) => String(r[ci]));
    const allChecked = ids.every((id) => checked.has(id));
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  async function onDeleteOne(jobId: string) {
    if (!confirm(`¿Eliminar el job ${jobId.slice(0, 8)} y sus datasets?`))
      return;
    try {
      await deleteRun(jobId);
      checked.delete(jobId);
      setChecked(new Set(checked));
      if (selectedJob === jobId) setSelectedJob(null);
      await reloadRuns();
    } catch (e) {
      if (e instanceof OpenCasesBlockError) {
        const list = e.cases.map((c) => `#${c}`).join(", ");
        alert(
          `⚠ No se puede eliminar el job ${jobId.slice(0, 8)}:\n\n` +
            `Tiene datasets adjuntos a los siguientes casos ABIERTOS: ${list}\n\n` +
            `Cerralos primero desde la sección "Casos" y volvé a intentar.`,
        );
        setErr(null);
      } else {
        setErr(String(e));
      }
    }
  }
  async function onDeleteSelected() {
    if (checked.size === 0) return;
    if (
      !confirm(
        `¿Eliminar ${checked.size} job(s) y todos sus datasets? Esta acción no se puede deshacer.`,
      )
    )
      return;
    const blocked: Array<{ jobId: string; cases: number[] }> = [];
    let deletedAny = false;
    for (const id of Array.from(checked)) {
      try {
        await deleteRun(id);
        deletedAny = true;
      } catch (e) {
        if (e instanceof OpenCasesBlockError) {
          blocked.push({ jobId: id, cases: e.cases });
        } else {
          setErr(String(e));
          break;
        }
      }
    }
    if (deletedAny) {
      setChecked(new Set());
      setSelectedJob(null);
    }
    await reloadRuns();
    if (blocked.length > 0) {
      const lines = blocked
        .map(
          (b) =>
            `  • ${b.jobId.slice(0, 8)} → casos abiertos: ${b.cases.map((c) => `#${c}`).join(", ")}`,
        )
        .join("\n");
      alert(
        `⚠ ${blocked.length} job(s) no se eliminaron porque tienen datasets adjuntos a casos abiertos:\n\n${lines}\n\nCerralos primero desde "Casos".`,
      );
    }
  }

  const filteredLogs = useMemo(() => {
    if (!logs) return null;
    const idxLevel = logs.columns.indexOf("level");
    const idxLine = logs.columns.indexOf("line");
    const sLower = search.trim().toLowerCase();
    const rows = logs.rows.filter((r) => {
      const lvl = String(r[idxLevel] ?? "");
      if (logFilter !== "all" && lvl !== logFilter) return false;
      if (sLower) {
        const line = String(r[idxLine] ?? "").toLowerCase();
        if (!line.includes(sLower)) return false;
      }
      return true;
    });
    return { ...logs, rows };
  }, [logs, logFilter, search]);

  const filteredVisibleIds = useMemo(() => {
    if (!sortedFilteredRuns) return [];
    const ci = sortedFilteredRuns.columns.indexOf("job_id");
    return sortedFilteredRuns.rows.map((r) => String(r[ci]));
  }, [sortedFilteredRuns]);
  const allChecked =
    filteredVisibleIds.length > 0 &&
    filteredVisibleIds.every((id) => checked.has(id));

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-semibold text-lg">Revisión de logs</h2>
          <p className="text-sm text-muted">
            Historial persistido en la DB de runs.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-muted flex items-center gap-2">
            Proyecto:
            <select
              value={configFilter}
              onChange={(e) => setConfigFilter(e.target.value)}
              className="bg-surface-2 border border-surface-strong rounded px-2 py-1 text-xs"
            >
              <option value="__all__">(todos)</option>
              {configsAvailable.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {checked.size > 0 && (
            <button
              onClick={onDeleteSelected}
              className="text-xs px-3 py-1 rounded border border-red-700 bg-red-500/20 text-red-300 hover:bg-red-500/40"
            >
              Eliminar {checked.size} seleccionado{checked.size > 1 ? "s" : ""}
            </button>
          )}
          <button
            onClick={reloadRuns}
            className="text-xs px-2 py-1 rounded border border-surface-strong bg-surface-2 hover:bg-slate-800"
          >
            Refrescar
          </button>
        </div>
      </header>

      {err && <div className="text-red-400 text-sm">{err}</div>}

      <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
        <header className="px-4 py-2 bg-panel2 text-xs uppercase tracking-wider text-muted">
          Ejecuciones · {sortedFilteredRuns?.rows.length ?? 0}
          {configFilter !== "__all__" && (
            <span className="ml-2 text-dim">
              filtradas por{" "}
              {configsAvailable.find((c) => c.value === configFilter)?.label ??
                configFilter}
            </span>
          )}
        </header>
        <div className="max-h-72 overflow-auto">
          <RunsTable
            data={sortedFilteredRuns}
            selectedJob={selectedJob}
            onSelect={setSelectedJob}
            sortCol={sortCol}
            sortDir={sortDir}
            onSort={toggleSort}
            checked={checked}
            onCheck={toggleCheck}
            allChecked={allChecked}
            onCheckAll={checkAllFiltered}
            onDelete={onDeleteOne}
          />
        </div>
      </div>

      {selectedJob && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
            <header className="px-4 py-2 bg-panel2 text-xs uppercase tracking-wider text-muted">
              Pasos del job{" "}
              <code className="ml-1">{selectedJob.slice(0, 8)}</code>
            </header>
            <div className="max-h-72 overflow-auto">
              <StepsTable
                data={steps}
                selectedStep={selectedStep}
                onSelect={setSelectedStep}
              />
            </div>
          </div>
          <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
            <header className="px-4 py-2 bg-panel2 text-xs uppercase tracking-wider text-muted">
              Datasets persistidos (modo debug)
            </header>
            <div className="max-h-72 overflow-auto">
              <DatasetsTable
                data={datasets}
                selectedUid={selectedDatasetUid}
                onSelect={(uid) => {
                  setSelectedDatasetUid(uid);
                  // ocultar logs al inspeccionar dataset
                  setSelectedStep(null);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {selectedJob && selectedStep != null && (
        <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
          <header className="px-4 py-2 bg-panel2 flex items-center gap-3 flex-wrap">
            <span className="text-xs uppercase tracking-wider text-muted">
              Logs · step_uid {selectedStep}
            </span>
            <div className="flex gap-1 text-xs">
              {(["all", "info", "warn", "error"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setLogFilter(f)}
                  className={`px-2 py-0.5 rounded border ${
                    logFilter === f
                      ? "bg-accent-token border-transparent"
                      : "bg-surface-2 border-surface-strong"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="buscar en logs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ml-auto bg-surface-2 border border-surface-strong rounded px-2 py-0.5 text-xs"
            />
          </header>
          <LogTable data={filteredLogs} />
        </div>
      )}

      {selectedJob && selectedDatasetUid != null && (
        <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
          <header className="px-4 py-2 bg-panel2 flex items-center gap-3 flex-wrap">
            <span className="text-xs uppercase tracking-wider text-muted">
              Dataset preview
            </span>
            {preview && (
              <>
                <span className="font-mono text-sm">{preview.name}</span>
                <LevelBadge level={preview.level} />
                <span className="text-xs text-dim">
                  {preview.row_count.toLocaleString()} filas ·{" "}
                  {formatBytes(preview.size_bytes)} · {preview.columns.length}{" "}
                  cols · mostrando primeras {preview.rows.length}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <a
                    href={exportDatasetUrl(
                      selectedJob,
                      selectedDatasetUid,
                      "xlsx",
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2 py-1 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/40"
                    title="Descargar dataset completo en formato Excel"
                  >
                    ⤓ Excel
                  </a>
                  <a
                    href={exportDatasetUrl(
                      selectedJob,
                      selectedDatasetUid,
                      "csv",
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2 py-1 rounded border border-cyan-700 bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/40"
                    title="Descargar dataset completo en formato CSV"
                  >
                    ⤓ CSV
                  </a>
                  <button
                    onClick={() => setShowCreateCase(true)}
                    className="text-xs px-2 py-1 rounded border border-amber-700 bg-amber-500/20 text-amber-300 hover:bg-amber-500/40"
                    title="Crear un caso nuevo con este dataset adjunto"
                  >
                    + Caso
                  </button>
                  <button
                    onClick={() => setShowAttachCase(true)}
                    className="text-xs px-2 py-1 rounded border border-violet-700 bg-violet-500/20 text-violet-300 hover:bg-violet-500/40"
                    title="Adjuntar este dataset a un caso existente"
                  >
                    ↳ Asignar a caso
                  </button>
                  <code className="text-[10px] text-dim ml-2">
                    {preview.table_name}
                  </code>
                </div>
              </>
            )}
          </header>
          {previewLoading && (
            <div className="px-4 py-6 text-dim text-sm">cargando…</div>
          )}
          {preview && <DatasetPreviewTable preview={preview} />}
        </div>
      )}

      {showCreateCase && preview && selectedJob && selectedDatasetUid != null && (
        <CreateCaseDialog
          dataset={{
            jobId: selectedJob,
            stepUid: selectedDatasetUid,
            hintName: preview.name,
          }}
          onClose={() => setShowCreateCase(false)}
          onCreated={(id) => {
            setShowCreateCase(false);
            alert(`✓ Caso #${id} creado y dataset adjunto.`);
          }}
        />
      )}
      {showAttachCase && preview && selectedJob && selectedDatasetUid != null && (
        <AttachToCaseDialog
          dataset={{
            jobId: selectedJob,
            stepUid: selectedDatasetUid,
            hintName: preview.name,
          }}
          onClose={() => setShowAttachCase(false)}
          onAttached={(id) => {
            setShowAttachCase(false);
            alert(`✓ Dataset adjunto al caso #${id}.`);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------

interface RunsTableProps {
  data: QueryRows | null;
  selectedJob: string | null;
  onSelect: (id: string) => void;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
  checked: Set<string>;
  onCheck: (id: string) => void;
  allChecked: boolean;
  onCheckAll: () => void;
  onDelete: (id: string) => void;
}

function RunsTable(p: RunsTableProps) {
  const { data, selectedJob, onSelect, sortCol, sortDir, onSort, checked, onCheck, allChecked, onCheckAll, onDelete } = p;
  if (!data) return <Empty>cargando…</Empty>;
  if (data.rows.length === 0) return <Empty>sin ejecuciones (revisá el filtro).</Empty>;
  const ci = (name: string) => data.columns.indexOf(name);
  return (
    <table className="w-full text-sm">
      <thead className="text-muted">
        <tr>
          <th className="px-3 py-2 w-8">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={onCheckAll}
              title="Seleccionar todos los visibles"
            />
          </th>
          <Th>Job ID</Th>
          <Th>Proyecto</Th>
          <SortableTh col="user_name" sortCol={sortCol} sortDir={sortDir} onSort={onSort}>
            Usuario
          </SortableTh>
          <Th>Status</Th>
          <Th>Pasos</Th>
          <SortableTh col="duration_ms" sortCol={sortCol} sortDir={sortDir} onSort={onSort}>
            Duración
          </SortableTh>
          <SortableTh col="started_at" sortCol={sortCol} sortDir={sortDir} onSort={onSort}>
            Inicio
          </SortableTh>
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => {
          const jobId = String(r[ci("job_id")]);
          const isSel = jobId === selectedJob;
          const isChecked = checked.has(jobId);
          return (
            <tr
              key={i}
              className={`border-t border-surface ${
                isSel ? "bg-cyan-500/10" : "hover:bg-slate-800/30"
              }`}
            >
              <td
                className="px-3 py-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onCheck(jobId)}
                />
              </td>
              <td onClick={() => onSelect(jobId)} className="px-3 py-1.5 cursor-pointer font-mono text-xs">
                {jobId.slice(0, 8)}
              </td>
              <td
                onClick={() => onSelect(jobId)}
                className="px-3 py-1.5 cursor-pointer"
                title={String(r[ci("config_name")])}
              >
                {String(
                  r[ci("config_display_name")] ?? r[ci("config_name")],
                )}
              </td>
              <td onClick={() => onSelect(jobId)} className="px-3 py-1.5 cursor-pointer font-mono">
                {String(r[ci("user_name")] ?? "—")}
              </td>
              <td onClick={() => onSelect(jobId)} className="px-3 py-1.5 cursor-pointer">
                <StatusBadge status={String(r[ci("status")])} />
              </td>
              <td onClick={() => onSelect(jobId)} className="px-3 py-1.5 cursor-pointer">
                {String(r[ci("total_steps")])}
              </td>
              <td onClick={() => onSelect(jobId)} className="px-3 py-1.5 cursor-pointer">
                {formatMs(r[ci("duration_ms")])}
              </td>
              <td onClick={() => onSelect(jobId)} className="px-3 py-1.5 cursor-pointer">
                {formatDate(r[ci("started_at")])}
              </td>
              <td className="px-3 py-1.5 text-right">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(jobId);
                  }}
                  title="Eliminar este job"
                  className="text-red-400 hover:text-red-200"
                >
                  🗑
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StepsTable({
  data,
  selectedStep,
  onSelect,
}: {
  data: QueryRows | null;
  selectedStep: number | null;
  onSelect: (uid: number) => void;
}) {
  if (!data) return <Empty>cargando…</Empty>;
  if (data.rows.length === 0) return <Empty>sin pasos.</Empty>;
  const ci = (name: string) => data.columns.indexOf(name);
  return (
    <table className="w-full text-sm">
      <thead className="text-muted">
        <tr>
          <Th>UID</Th>
          <Th>Step</Th>
          <Th>Kind</Th>
          <Th>Status</Th>
          <Th>Filas</Th>
          <Th>Duración</Th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => {
          const uid = Number(r[ci("step_uid")]);
          const isSel = uid === selectedStep;
          return (
            <tr
              key={i}
              onClick={() => onSelect(uid)}
              className={`border-t border-surface cursor-pointer ${
                isSel ? "bg-cyan-500/10" : "hover:bg-slate-800/30"
              }`}
            >
              <Td mono>{uid}</Td>
              <Td>{String(r[ci("step_id")])}</Td>
              <Td mono>{String(r[ci("kind")])}</Td>
              <Td>
                <StatusBadge status={String(r[ci("status")])} />
              </Td>
              <Td>{r[ci("row_count")] ?? "—"}</Td>
              <Td>{formatMs(r[ci("duration_ms")])}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DatasetsTable({
  data,
  selectedUid,
  onSelect,
}: {
  data: QueryRows | null;
  selectedUid: number | null;
  onSelect: (uid: number) => void;
}) {
  if (!data) return <Empty>cargando…</Empty>;
  if (data.rows.length === 0)
    return (
      <Empty>
        este job no corrió en modo debug, o no produjo datasets.
      </Empty>
    );
  const ci = (name: string) => data.columns.indexOf(name);
  return (
    <table className="w-full text-sm">
      <thead className="text-muted">
        <tr>
          <Th>UID</Th>
          <Th>Nombre</Th>
          <Th>Nivel</Th>
          <Th>Filas</Th>
          <Th>Tamaño</Th>
          <Th>Creada</Th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => {
          const uid = Number(r[ci("step_uid")]);
          const isSel = uid === selectedUid;
          return (
            <tr
              key={i}
              onClick={() => onSelect(uid)}
              className={`border-t border-surface cursor-pointer ${
                isSel ? "bg-cyan-500/10" : "hover:bg-slate-800/30"
              }`}
            >
              <Td mono>{uid}</Td>
              <Td mono>{String(r[ci("name")])}</Td>
              <Td>
                <LevelBadge level={String(r[ci("level")] ?? "info")} />
              </Td>
              <Td>{Number(r[ci("row_count")]).toLocaleString()}</Td>
              <Td>{formatBytes(r[ci("size_bytes")])}</Td>
              <Td>{formatDate(r[ci("created_at")])}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DatasetPreviewTable({ preview }: { preview: DatasetPreview }) {
  return (
    <div className="overflow-auto max-h-[28rem] border-t border-surface">
      <table className="text-xs min-w-full">
        <thead className="bg-panel2 sticky top-0">
          <tr>
            {preview.columns.map((c) => (
              <th
                key={c}
                className="px-2 py-1 text-left font-mono text-slate-300 border-b border-surface"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((r, i) => (
            <tr key={i} className="even:bg-slate-900/30">
              {r.map((v, j) => (
                <td
                  key={j}
                  className="px-2 py-1 font-mono whitespace-nowrap text-slate-300 border-b border-surface/60"
                >
                  {fmtCell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogTable({ data }: { data: QueryRows | null }) {
  if (!data) return <Empty>cargando…</Empty>;
  if (data.rows.length === 0)
    return <Empty>sin logs (o ninguno coincide con el filtro).</Empty>;
  const ci = (name: string) => data.columns.indexOf(name);
  return (
    <div className="milhouse-logs" style={{ height: "20rem" }}>
      {data.rows.map((r, i) => {
        const level = String(r[ci("level")]);
        const klass =
          level === "error"
            ? "milhouse-logs-error"
            : level === "warn"
            ? "milhouse-logs-warn"
            : "milhouse-logs-info";
        return (
          <div key={i} className="whitespace-pre-wrap">
            <span className="milhouse-logs-time">
              {formatDate(r[ci("ts")])}{" "}
            </span>
            <span style={{ marginRight: 4 }} className={klass}>
              [{level.toUpperCase()}]
            </span>
            <span className={klass}>{String(r[ci("line")])}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- helpers ----------

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
  const map: Record<string, string> = {
    running: "bg-yellow-500/20 text-yellow-300 border-yellow-700",
    ok: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
    done: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
    failed: "bg-red-500/20 text-red-300 border-red-700",
    cancelled: "bg-slate-500/20 text-slate-300 border-slate-700",
    skipped: "bg-slate-500/20 text-slate-300 border-slate-700",
    pending: "bg-slate-500/20 text-slate-300 border-slate-700",
  };
  return (
    <span
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${
        map[status] ?? "bg-slate-500/20 text-slate-300 border-slate-700"
      }`}
    >
      {status}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left px-3 py-2 font-medium">{children}</th>;
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
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-dim text-sm text-center">{children}</div>;
}
function formatMs(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  if (n < 1000) return `${n} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(2)} s`;
  return `${Math.floor(n / 60_000)}m ${(Math.floor(n / 1000) % 60)}s`;
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
  } catch {
    // ignore
  }
  return s;
}
function fmtCell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number")
    return Number.isInteger(v) ? v.toString() : v.toFixed(4);
  return String(v);
}
