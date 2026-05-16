"use client";

import { useEffect, useState } from "react";
import {
  attachDataset,
  createCase,
  listCases,
  listUsers,
  type QueryRows,
  type UserDef,
} from "@/lib/api";
import { useUser } from "@/lib/session";

interface DatasetRef {
  jobId: string;
  stepUid: number;
  hintName: string;
}

export function CreateCaseDialog({
  dataset,
  onClose,
  onCreated,
}: {
  dataset: DatasetRef;
  onClose: () => void;
  onCreated: (caseId: number) => void;
}) {
  const me = useUser();
  const [title, setTitle] = useState(`Investigar ${dataset.hintName}`);
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [assignee, setAssignee] = useState<string>("");
  const [users, setUsers] = useState<UserDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listUsers().then((r) => setUsers(r.users)).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { id } = await createCase({
        title: title.trim(),
        description: description.trim() || null,
        severity,
        assignee: assignee || null,
        creator: me,
        attach: [{ job_id: dataset.jobId, step_uid: dataset.stepUid }],
      });
      onCreated(id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <h3 className="text-lg font-bold">Crear caso</h3>
        <p className="text-xs text-muted">
          Se adjuntará el dataset{" "}
          <code className="milhouse-chip" style={{ fontSize: "0.7rem" }}>
            {dataset.hintName}
          </code>{" "}
          (run {dataset.jobId.slice(0, 8)} · step {dataset.stepUid}).
        </p>
        <Field label="Título">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full milhouse-field"
          />
        </Field>
        <Field label="Descripción">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full milhouse-field"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Severidad">
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="w-full milhouse-field"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
          </Field>
          <Field label="Responsable">
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="w-full milhouse-field"
            >
              <option value="">(sin asignar)</option>
              {users.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name}
                  {u.role ? ` · ${u.role}` : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-2 rounded milhouse-btn-secondary"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!title.trim() || busy}
            className="text-sm px-3 py-2 rounded font-semibold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {busy ? "Creando…" : "Crear caso"}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

export function AttachToCaseDialog({
  dataset,
  onClose,
  onAttached,
}: {
  dataset: DatasetRef;
  onClose: () => void;
  onAttached: (caseId: number) => void;
}) {
  const me = useUser();
  const [cases, setCases] = useState<QueryRows | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listCases()
      .then((r) => {
        // filtrar solo open
        const ci = r.columns.indexOf("status");
        const open = {
          ...r,
          rows: r.rows.filter((row) => String(row[ci]) === "open"),
        };
        setCases(open);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  async function submit() {
    if (selectedId == null) return;
    setBusy(true);
    setErr(null);
    try {
      await attachDataset(selectedId, dataset.jobId, dataset.stepUid, me);
      onAttached(selectedId);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="space-y-3">
        <h3 className="text-lg font-bold">Asignar a caso existente</h3>
        <p className="text-xs text-muted">
          Solo se listan casos en estado open.
        </p>
        <div className="bg-surface-2 border border-surface rounded-md max-h-72 overflow-auto">
          {!cases && (
            <div className="px-4 py-6 text-dim text-sm">cargando…</div>
          )}
          {cases && cases.rows.length === 0 && (
            <div className="px-4 py-6 text-dim text-sm">
              no hay casos abiertos.
            </div>
          )}
          {cases && cases.rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-muted">
                <tr>
                  <Th />
                  <Th>#</Th>
                  <Th>Título</Th>
                  <Th>Severidad</Th>
                  <Th>Responsable</Th>
                </tr>
              </thead>
              <tbody>
                {cases.rows.map((r, i) => {
                  const ci = (n: string) => cases.columns.indexOf(n);
                  const id = Number(r[ci("id")]);
                  return (
                    <tr
                      key={i}
                      className={`border-t border-surface cursor-pointer ${
                        id === selectedId
                          ? "bg-cyan-500/10"
                          : "hover:bg-slate-800/30"
                      }`}
                      onClick={() => setSelectedId(id)}
                    >
                      <td className="px-3 py-1.5">
                        <input
                          type="radio"
                          checked={id === selectedId}
                          onChange={() => setSelectedId(id)}
                        />
                      </td>
                      <td className="px-3 py-1.5 font-mono">#{id}</td>
                      <td className="px-3 py-1.5">{String(r[ci("title")])}</td>
                      <td className="px-3 py-1.5 font-mono text-xs uppercase">
                        {String(r[ci("severity")])}
                      </td>
                      <td className="px-3 py-1.5 font-mono">
                        {(r[ci("assignee")] as string | null) ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="text-sm px-3 py-2 rounded milhouse-btn-secondary"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={selectedId == null || busy}
            className="text-sm px-3 py-2 rounded font-semibold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {busy ? "Asignando…" : "Asignar"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-surface-strong rounded-xl p-6 w-full max-w-lg"
        style={{ boxShadow: "var(--shadow)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2 font-medium text-xs uppercase tracking-wider">
      {children}
    </th>
  );
}
