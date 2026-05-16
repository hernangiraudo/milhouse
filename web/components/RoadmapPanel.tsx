"use client";

import { useEffect, useState } from "react";
import { useUser } from "@/lib/session";
import { useDialog } from "./Dialog";
import { API_BASE } from "@/lib/api";

type Severity = "low" | "normal" | "high";
type Status = "open" | "planned" | "done" | "rejected";

interface Item {
  id: number;
  title: string;
  description: string | null;
  severity: Severity;
  status: Status;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
  comments_count: number;
}

interface Comment {
  id: number;
  author: string | null;
  body: string;
  created_at: string;
}

const STATUS_LABEL: Record<Status, string> = {
  open: "Abierto",
  planned: "Planeado",
  done: "Hecho",
  rejected: "Rechazado",
};
const STATUS_COLOR: Record<Status, string> = {
  open: "bg-amber-500/20 text-amber-300 border-amber-700",
  planned: "bg-cyan-500/20 text-cyan-300 border-cyan-700",
  done: "bg-emerald-500/20 text-emerald-300 border-emerald-700",
  rejected: "bg-slate-500/20 text-slate-300 border-slate-700",
};
const SEVERITY_LABEL: Record<Severity, string> = {
  low: "Baja",
  normal: "Normal",
  high: "Alta",
};
const SEVERITY_COLOR: Record<Severity, string> = {
  low: "bg-slate-500/20 text-slate-300 border-slate-700",
  normal: "bg-cyan-500/20 text-cyan-300 border-cyan-700",
  high: "bg-red-500/20 text-red-300 border-red-700",
};

export function RoadmapPanel() {
  const me = useUser();
  const dialog = useDialog();
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Status>("open");

  // Form de creación
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("normal");
  const [busy, setBusy] = useState(false);

  // Detalle / comentarios
  const [openId, setOpenId] = useState<number | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentText, setCommentText] = useState("");

  async function reload() {
    try {
      const r = await fetch(`${API_BASE}/api/roadmap`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as {
        columns: string[];
        rows: unknown[][];
      };
      const ci = (n: string) => j.columns.indexOf(n);
      const arr: Item[] = j.rows.map((r) => ({
        id: Number(r[ci("id")]),
        title: String(r[ci("title")] ?? ""),
        description: (r[ci("description")] as string | null) ?? null,
        severity: (String(r[ci("severity")]) as Severity) || "normal",
        status: (String(r[ci("status")]) as Status) || "open",
        created_by: (r[ci("created_by")] as string | null) ?? null,
        created_at: String(r[ci("created_at")] ?? ""),
        updated_at: (r[ci("updated_at")] as string | null) ?? null,
        comments_count: Number(r[ci("comments_count")] ?? 0),
      }));
      setItems(arr);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  useEffect(() => {
    reload();
  }, []);

  async function reloadComments(id: number) {
    try {
      const r = await fetch(`${API_BASE}/api/roadmap/${id}/comments`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { columns: string[]; rows: unknown[][] };
      const ci = (n: string) => j.columns.indexOf(n);
      setComments(
        j.rows.map((r) => ({
          id: Number(r[ci("id")]),
          author: (r[ci("author")] as string | null) ?? null,
          body: String(r[ci("body")] ?? ""),
          created_at: String(r[ci("created_at")] ?? ""),
        })),
      );
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    if (openId == null) {
      setComments(null);
      return;
    }
    reloadComments(openId);
  }, [openId]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API_BASE}/api/roadmap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          severity,
          created_by: me,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      setTitle("");
      setDescription("");
      setSeverity("normal");
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: number, status: Status) {
    try {
      const r = await fetch(`${API_BASE}/api/roadmap/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onDelete(id: number) {
    const ok = await dialog.confirm(`¿Eliminar el pedido #${id}?`, {
      title: "Eliminar pedido",
      variant: "danger",
      ok: "Eliminar",
    });
    if (!ok) return;
    try {
      const r = await fetch(`${API_BASE}/api/roadmap/${id}`, {
        method: "DELETE",
      });
      if (!r.ok && r.status !== 204) throw new Error(await r.text());
      if (openId === id) setOpenId(null);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onAddComment(e: React.FormEvent) {
    e.preventDefault();
    if (openId == null) return;
    const body = commentText.trim();
    if (!body) return;
    try {
      const r = await fetch(`${API_BASE}/api/roadmap/${openId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, author: me }),
      });
      if (!r.ok) throw new Error(await r.text());
      setCommentText("");
      await reloadComments(openId);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  const filtered = (items ?? []).filter((i) =>
    filter === "all" ? true : i.status === filter,
  );

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-lg">Roadmap</h2>
          <p className="text-sm text-muted">
            Pedidos de mejora y feedback. Cualquier usuario puede sumar ideas y
            comentarios.
          </p>
        </div>
      </header>

      {err && <div className="text-red-400 text-sm">{err}</div>}

      {/* Nuevo pedido */}
      <form
        onSubmit={onCreate}
        className="bg-panel border border-surface rounded-xl p-4 space-y-3"
      >
        <h3 className="text-xs uppercase tracking-wider text-muted">
          Nuevo pedido
        </h3>
        <div className="grid grid-cols-[2fr_140px] gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
              Título
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="ej. agregar export a Google Sheets"
              className="w-full milhouse-field"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
              Prioridad
            </span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Severity)}
              className="w-full milhouse-field"
            >
              <option value="low">Baja</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
            Descripción
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="qué problema resuelve, ejemplos, casos de uso…"
            className="w-full milhouse-field"
          />
        </label>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!title.trim() || busy}
            className="text-sm font-semibold px-4 py-1.5 rounded disabled:opacity-50"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
            }}
          >
            {busy ? "Guardando…" : "Enviar pedido"}
          </button>
        </div>
      </form>

      {/* Filtros */}
      <div className="flex gap-1 text-xs flex-wrap">
        {(["all", "open", "planned", "done", "rejected"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded ${
              filter === s
                ? "bg-accent-token font-semibold"
                : "milhouse-btn-secondary"
            }`}
          >
            {s === "all" ? "Todos" : STATUS_LABEL[s]} ·{" "}
            {s === "all"
              ? (items?.length ?? 0)
              : (items ?? []).filter((i) => i.status === s).length}
          </button>
        ))}
      </div>

      {/* Lista */}
      <div className="space-y-2">
        {items == null ? (
          <div className="text-dim text-sm">Cargando…</div>
        ) : filtered.length === 0 ? (
          <div className="text-dim text-sm">No hay pedidos en este filtro.</div>
        ) : (
          filtered.map((it) => (
            <div
              key={it.id}
              className="bg-panel border border-surface rounded-lg p-3"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-[10px] font-mono text-dim">
                      #{it.id}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                        STATUS_COLOR[it.status]
                      }`}
                    >
                      {STATUS_LABEL[it.status]}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                        SEVERITY_COLOR[it.severity]
                      }`}
                    >
                      {SEVERITY_LABEL[it.severity]}
                    </span>
                    <span className="text-[11px] text-dim">
                      por {it.created_by ?? "anon"} ·{" "}
                      {new Date(it.created_at).toLocaleString()}
                    </span>
                  </div>
                  <h4 className="font-medium">{it.title}</h4>
                  {it.description && (
                    <p className="text-sm text-muted mt-1 whitespace-pre-wrap">
                      {it.description}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() =>
                        setOpenId(openId === it.id ? null : it.id)
                      }
                      className="text-xs underline text-accent"
                    >
                      {openId === it.id
                        ? "Ocultar comentarios"
                        : `Comentarios (${it.comments_count})`}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <select
                    value={it.status}
                    onChange={(e) => setStatus(it.id, e.target.value as Status)}
                    className="milhouse-field text-xs py-1"
                    title="Cambiar estado"
                  >
                    {(["open", "planned", "done", "rejected"] as Status[]).map(
                      (s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ),
                    )}
                  </select>
                  <button
                    onClick={() => onDelete(it.id)}
                    className="text-red-400 text-xs px-2 py-1"
                    title="Eliminar"
                  >
                    ✕
                  </button>
                </div>
              </div>
              {openId === it.id && (
                <div className="mt-3 pt-3 border-t border-surface space-y-2">
                  {comments == null ? (
                    <div className="text-dim text-xs">cargando…</div>
                  ) : comments.length === 0 ? (
                    <div className="text-dim text-xs">
                      Sé el primero en comentar.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {comments.map((c) => (
                        <li
                          key={c.id}
                          className="bg-surface-2 border border-surface rounded p-2 text-sm"
                        >
                          <div className="text-[10px] text-dim mb-1">
                            {c.author ?? "anon"} ·{" "}
                            {new Date(c.created_at).toLocaleString()}
                          </div>
                          <div className="whitespace-pre-wrap">{c.body}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form onSubmit={onAddComment} className="flex gap-2">
                    <input
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="agregar comentario…"
                      className="flex-1 milhouse-field text-sm"
                    />
                    <button
                      type="submit"
                      disabled={!commentText.trim()}
                      className="text-xs px-3 py-1 rounded disabled:opacity-50"
                      style={{
                        background: "var(--accent)",
                        color: "var(--accent-ink)",
                      }}
                    >
                      Enviar
                    </button>
                  </form>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
