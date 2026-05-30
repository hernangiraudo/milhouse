"use client";

import { useEffect, useState } from "react";
import {
  API_BASE,
  createConnection,
  deleteConnection,
  listConnections,
  reloadConnections,
  testConnection,
  updateConnection,
  type ConnectionPayload,
  type TestConnectionResult,
} from "@/lib/api";
import type { ConnectionsResponse, ConnectionSummary } from "@/lib/types";
import { useDialog } from "./Dialog";
import {
  Pencil,
  Copy,
  Trash2,
  RefreshCw,
  Plus,
  ChevronDown,
  Star,
} from "lucide-react";

type TypeKey =
  | "duckdb"
  | "duckdb_memory"
  | "sql_server"
  | "mysql"
  | "odbc"
  | "postgres"
  | "sqlite";

const TYPE_STYLES: Record<
  string,
  { color: string; label: string; short: string }
> = {
  duckdb:        { color: "#10b981", label: "DuckDB (archivo)",   short: "DuckDB" },
  duckdb_memory: { color: "#06b6d4", label: "DuckDB (memoria)",   short: "DuckDB :mem:" },
  sql_server:    { color: "#ef4444", label: "SQL Server (nativo)", short: "SQL Server" },
  mysql:         { color: "#0ea5e9", label: "MySQL (nativo)",     short: "MySQL" },
  odbc:          { color: "#f97316", label: "ODBC",               short: "ODBC" },
  postgres:      { color: "#3b82f6", label: "Postgres",           short: "Postgres" },
  sqlite:        { color: "#a855f7", label: "SQLite",             short: "SQLite" },
};

type LightStatus = "ok" | "running" | "error" | "idle";

export function ConnectionsPanel() {
  const dialog = useDialog();
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ConnectionSummary | null>(null);
  const [creating, setCreating] = useState(false);
  // resultado de test por conexión.
  const [testResult, setTestResult] = useState<
    Record<string, TestConnectionResult & { running?: boolean }>
  >({});

  async function load() {
    try {
      const d = await listConnections();
      setData(d);
      setErr(null);
      return d;
    } catch (e) {
      setErr(String(e));
      return null;
    }
  }

  /** Testea una sola conexión actualizando su estado en testResult. */
  async function testOne(name: string, implemented: boolean) {
    if (!implemented) {
      // Las placeholder no se testean — quedan en "idle".
      setTestResult((p) => {
        const next = { ...p };
        delete next[name];
        return next;
      });
      return;
    }
    setTestResult((p) => ({ ...p, [name]: { ok: false, running: true } }));
    try {
      const r = await testConnection(name);
      setTestResult((p) => ({ ...p, [name]: r }));
    } catch (e) {
      setTestResult((p) => ({
        ...p,
        [name]: { ok: false, error: String(e) },
      }));
    }
  }

  /** Testea todas las conexiones implementadas en paralelo. */
  async function testAll(conns: ConnectionSummary[]) {
    const targets = conns.filter((c) => c.implemented);
    if (targets.length === 0) return;
    setTestResult((p) => {
      const next = { ...p };
      for (const c of targets) {
        next[c.name] = { ok: false, running: true };
      }
      return next;
    });
    await Promise.all(targets.map((c) => testOne(c.name, c.implemented)));
  }

  // Al entrar a la sección: cargar y disparar test de todas.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d = await load();
      if (cancelled || !d) return;
      await testAll(d.connections);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onReload() {
    setBusy(true);
    setErr(null);
    try {
      await reloadConnections();
      const d = await load();
      if (d) await testAll(d.connections);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRetestAll() {
    if (!data) return;
    await testAll(data.connections);
  }

  async function onDelete(name: string) {
    const ok = await dialog.confirm(`¿Eliminar la conexión "${name}"?`, {
      title: "Eliminar conexión",
      variant: "danger",
      ok: "Eliminar",
    });
    if (!ok) return;
    try {
      await deleteConnection(name);
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onDuplicate(c: ConnectionSummary) {
    const existing = new Set(data?.connections.map((x) => x.name) ?? []);
    const base = `${c.name} (copia)`;
    let defaultName = base;
    let n = 2;
    while (existing.has(defaultName)) {
      defaultName = `${c.name} (copia ${n})`;
      n += 1;
    }
    const newName = await dialog.prompt(
      `Nombre para la copia de "${c.name}":`,
      {
        title: "Duplicar conexión",
        defaultValue: defaultName,
        validate: (v) => {
          const t = v.trim();
          if (!t) return "obligatorio";
          if (existing.has(t)) return "ya existe una conexión con ese nombre";
          return null;
        },
      },
    );
    if (!newName?.trim()) return;
    try {
      const r = await fetch(
        `${API_BASE}/api/connections/${encodeURIComponent(c.name)}/duplicate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ new_name: newName.trim() }),
        },
      );
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e) {
      await dialog.alert(`No se pudo duplicar: ${e}`, { variant: "danger" });
    }
  }

  function statusOf(c: ConnectionSummary): LightStatus {
    if (!c.implemented) return "idle";
    const r = testResult[c.name];
    if (!r) return "idle";
    if (r.running) return "running";
    return r.ok ? "ok" : "error";
  }

  const counts = (() => {
    const out = { ok: 0, error: 0, running: 0, idle: 0, total: 0 };
    if (!data) return out;
    for (const c of data.connections) {
      out.total++;
      out[statusOf(c)]++;
    }
    return out;
  })();

  return (
    <section className="space-y-4">
      <div className="bg-panel rounded-xl p-5 border border-surface">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="font-semibold text-lg">Conexiones</h2>
            <p className="text-sm text-muted">
              Bases de datos y orígenes ODBC disponibles para los proyectos.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {data && (
              <div
                className="flex items-center gap-3 text-xs px-3 py-1.5 rounded border border-surface bg-surface-2"
                title="Estado de las conexiones tras el último test"
              >
                <span className="flex items-center gap-1.5">
                  <StatusLight status="ok" size={8} />
                  <span className="text-app font-medium">{counts.ok}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <StatusLight status="running" size={8} />
                  <span className="text-app font-medium">{counts.running}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <StatusLight status="error" size={8} />
                  <span className="text-app font-medium">{counts.error}</span>
                </span>
                {counts.idle > 0 && (
                  <span className="flex items-center gap-1.5">
                    <StatusLight status="idle" size={8} />
                    <span className="text-app font-medium">{counts.idle}</span>
                  </span>
                )}
              </div>
            )}
            <button
              onClick={onRetestAll}
              disabled={!data || counts.running > 0}
              className="text-xs px-2.5 py-1.5 rounded border border-surface-strong bg-surface-2 hover:bg-surface text-app flex items-center gap-1.5 disabled:opacity-50"
              title="Volver a testear todas las conexiones"
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                className={counts.running > 0 ? "animate-spin" : ""}
              />
              Re-testear
            </button>
            <button
              onClick={onReload}
              disabled={busy}
              className="text-xs px-2.5 py-1.5 rounded border border-surface-strong bg-surface-2 hover:bg-surface text-app disabled:opacity-50"
              title="Recargar configs/connections.json desde disco"
            >
              {busy ? "Recargando…" : "Recargar archivo"}
            </button>
            <button
              onClick={() => setCreating(true)}
              className="text-xs font-semibold px-3 py-1.5 rounded flex items-center gap-1"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              <Plus size={13} strokeWidth={2.5} />
              Agregar
            </button>
          </div>
        </div>
        {err && <div className="text-red-400 text-sm mt-3">{err}</div>}
      </div>

      {!data && !err && (
        <div className="text-muted text-sm">Cargando…</div>
      )}
      {data && data.connections.length === 0 && (
        <div className="bg-panel border border-surface rounded-xl p-6 text-muted text-sm">
          No hay conexiones definidas. Click en "+ Agregar".
        </div>
      )}
      {data && data.connections.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.connections.map((c) => (
            <ConnectionCard
              key={c.name}
              c={c}
              testResult={testResult[c.name]}
              status={statusOf(c)}
              onEdit={() => setEditing(c)}
              onDelete={() => onDelete(c.name)}
              onTest={() => testOne(c.name, c.implemented)}
              onDuplicate={() => onDuplicate(c)}
            />
          ))}
        </div>
      )}

      {creating && (
        <ConnectionDialog
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            const d = await load();
            if (d) await testAll(d.connections);
          }}
        />
      )}
      {editing && (
        <ConnectionDialog
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            const name = editing.name;
            setEditing(null);
            const d = await load();
            if (d) {
              const fresh = d.connections.find((x) => x.name === name);
              if (fresh) await testOne(fresh.name, fresh.implemented);
            }
          }}
        />
      )}
    </section>
  );
}

/** Luz tipo semáforo: ok=verde, running=amarillo pulsante, error=rojo, idle=gris. */
function StatusLight({
  status,
  size = 10,
}: {
  status: LightStatus;
  size?: number;
}) {
  const color =
    status === "ok"
      ? "#10b981"
      : status === "running"
      ? "#f59e0b"
      : status === "error"
      ? "#ef4444"
      : "#64748b";
  return (
    <span
      className={`inline-block rounded-full ${
        status === "running" ? "animate-pulse" : ""
      }`}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow:
          status === "ok"
            ? "0 0 6px rgba(16,185,129,0.6)"
            : status === "running"
            ? "0 0 6px rgba(245,158,11,0.6)"
            : status === "error"
            ? "0 0 6px rgba(239,68,68,0.6)"
            : "none",
      }}
    />
  );
}

function ConnectionCard({
  c,
  testResult,
  status,
  onEdit,
  onDelete,
  onTest,
  onDuplicate,
}: {
  c: ConnectionSummary;
  testResult?: TestConnectionResult & { running?: boolean };
  status: LightStatus;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onDuplicate: () => void;
}) {
  const t =
    TYPE_STYLES[c.type] ?? { color: "#94a3b8", label: c.type, short: c.type };

  // Resumen del endpoint para mostrar arriba sin abrir detalles. Para los
  // motores con host/port mostramos host:port, para archivo el path.
  const endpoint = (() => {
    const s = c.spec;
    if (typeof s?.host === "string") {
      const port = s.port != null ? `:${s.port}` : "";
      return `${s.host}${port}`;
    }
    if (typeof s?.path === "string") return s.path as string;
    if (typeof s?.connection_string === "string") {
      const cs = s.connection_string as string;
      return cs.length > 40 ? cs.slice(0, 40) + "…" : cs;
    }
    return null;
  })();

  return (
    <div
      className="rounded-lg border bg-surface-2 p-3 relative flex flex-col gap-2"
      style={{
        borderColor: status === "error" ? "#b91c1c" : "var(--surface-strong, #334155)",
      }}
    >
      {/* Header: semáforo + nombre + acciones rápidas */}
      <div className="flex items-center gap-2">
        <button
          onClick={onTest}
          disabled={!c.implemented || testResult?.running}
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full hover:bg-surface disabled:cursor-not-allowed"
          title={
            status === "ok"
              ? `OK · ${testResult?.latency_ms ?? "?"} ms — click para re-testear`
              : status === "running"
              ? "Testeando…"
              : status === "error"
              ? `Falló: ${testResult?.error ?? ""} — click para reintentar`
              : c.implemented
              ? "Aún no testeada — click para testear"
              : "Placeholder, no se testea"
          }
        >
          <StatusLight status={status} size={11} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <code className="font-semibold text-app truncate">{c.name}</code>
            {c.is_default && (
              <span
                title="Conexión default del proyecto"
                className="shrink-0"
                style={{ color: "var(--accent)" }}
              >
                <Star size={12} strokeWidth={2.5} fill="currentColor" />
              </span>
            )}
          </div>
          <div className="text-[11px] flex items-center gap-1.5" style={{ color: t.color }}>
            <span className="font-medium">{t.short}</span>
            {!c.implemented && (
              <span
                className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-700"
                title="Declarada en el archivo pero no implementada en este MVP"
              >
                placeholder
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onEdit}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface text-dim hover:text-app"
            title="Editar"
          >
            <Pencil size={14} strokeWidth={2} />
          </button>
          <button
            onClick={onDuplicate}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface text-dim hover:text-app"
            title="Duplicar (incluye password)"
          >
            <Copy size={14} strokeWidth={2} />
          </button>
          <button
            onClick={onDelete}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-500/20 text-dim hover:text-red-400"
            title="Eliminar"
          >
            <Trash2 size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Endpoint compacto */}
      {endpoint && (
        <div
          className="text-[11px] font-mono text-muted truncate"
          title={endpoint}
        >
          {endpoint}
        </div>
      )}

      {/* Descripción si la hay */}
      {c.description && (
        <div className="text-[11px] text-muted leading-snug">
          {c.description}
        </div>
      )}

      {/* Estado del último test cuando hubo error: visible sin abrir detalles */}
      {status === "error" && testResult?.error && (
        <div
          className="text-[10px] rounded px-2 py-1 bg-red-500/10 text-red-300 border border-red-700 line-clamp-2"
          title={testResult.error}
        >
          {testResult.error}
        </div>
      )}

      {/* Detalles colapsables: spec completa + info de test */}
      <details className="text-[11px] text-dim">
        <summary className="cursor-pointer flex items-center gap-1 hover:text-app select-none">
          <ChevronDown size={12} strokeWidth={2} className="transition-transform [details[open]_&]:rotate-180" />
          Detalles
        </summary>
        <div className="mt-1.5 pl-1 space-y-1">
          {status === "ok" && testResult && (
            <div className="text-[10px] text-emerald-300">
              ✓ OK · {testResult.latency_ms ?? "?"} ms
              {testResult.info ? ` · ${testResult.info}` : ""}
            </div>
          )}
          <SpecLines spec={c.spec} />
        </div>
      </details>
    </div>
  );
}

function SpecLines({ spec }: { spec: Record<string, unknown> }) {
  const fields: Array<[string, unknown]> = [];
  const SKIP = new Set(["name", "description", "type", "password"]);
  for (const k of Object.keys(spec)) {
    if (SKIP.has(k)) continue;
    fields.push([k, spec[k]]);
  }
  if (fields.length === 0) return null;
  return (
    <div className="text-[11px] font-mono space-y-0.5">
      {fields.map(([k, v]) => (
        <div key={k}>
          <span className="text-dim">{k}:</span>{" "}
          <span className="text-app">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Modal de crear/editar conexión
// ---------------------------------------------------------------------

function ConnectionDialog({
  mode,
  existing,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  existing?: ConnectionSummary;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const initialType: TypeKey =
    (existing?.type as TypeKey | undefined) ?? "duckdb";
  const [type, setTypeRaw] = useState<TypeKey>(initialType);
  function setType(t: TypeKey) {
    setTypeRaw(t);
    // Si el usuario no toqueteó el puerto, lo movemos al default del motor.
    const defaults: Partial<Record<TypeKey, number>> = {
      postgres: 5432,
      sql_server: 1433,
      mysql: 3306,
    };
    if (defaults[t] != null) setPgPort(defaults[t] as number);
  }
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  // Campos por tipo
  const initialSpec = existing?.spec ?? {};
  const [duckdbPath, setDuckdbPath] = useState(
    (initialSpec.path as string | undefined) ?? "data/mi_db.duckdb",
  );
  const [odbcConn, setOdbcConn] = useState(
    (initialSpec.connection_string as string | undefined) ??
      "DSN=mi_dsn;UID=user;PWD=pass",
  );
  const [pgHost, setPgHost] = useState(
    (initialSpec.host as string | undefined) ?? "localhost",
  );
  const [pgPort, setPgPort] = useState(
    Number(initialSpec.port ?? 5432),
  );
  const [pgUser, setPgUser] = useState(
    (initialSpec.user as string | undefined) ?? "",
  );
  const [pgPass, setPgPass] = useState("");
  const [pgDb, setPgDb] = useState(
    (initialSpec.database as string | undefined) ?? "",
  );
  const [sqlitePath, setSqlitePath] = useState(
    (initialSpec.path as string | undefined) ?? "data/local.sqlite",
  );
  // SQL Server específico
  const [mssqlEncrypt, setMssqlEncrypt] = useState<string>(
    (initialSpec.encrypt as string | undefined) ?? "on",
  );
  const [mssqlTrust, setMssqlTrust] = useState<boolean>(
    !!(initialSpec.trust_server_certificate as boolean | undefined),
  );
  // MySQL específico
  const [mysqlSsl, setMysqlSsl] = useState<boolean>(
    !!(initialSpec.ssl as boolean | undefined),
  );
  const [makeDefault, setMakeDefault] = useState(!!existing?.is_default);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testRes, setTestRes] = useState<TestConnectionResult | null>(null);

  /** Devuelve el campo password adecuado:
   *  - En modo create, manda lo que el usuario tipeó (o null si vacío).
   *  - En modo edit, si el usuario NO tocó el campo (sigue vacío), omitimos
   *    el campo del JSON para que el backend conserve la password previa.
   *    Si el usuario tipeó algo nuevo, lo enviamos. */
  function passwordField(): { password?: string | null } {
    if (mode === "edit" && pgPass === "") return {};
    return { password: pgPass || null };
  }

  function buildSpec(): Record<string, unknown> {
    switch (type) {
      case "duckdb":
        return { type: "duckdb", path: duckdbPath };
      case "duckdb_memory":
        return { type: "duckdb_memory" };
      case "odbc":
        return { type: "odbc", connection_string: odbcConn };
      case "postgres":
        return {
          type: "postgres",
          host: pgHost,
          port: pgPort,
          user: pgUser,
          ...passwordField(),
          database: pgDb,
        };
      case "sqlite":
        return { type: "sqlite", path: sqlitePath };
      case "sql_server":
        return {
          type: "sql_server",
          host: pgHost,
          port: pgPort,
          user: pgUser,
          ...passwordField(),
          database: pgDb,
          encrypt: mssqlEncrypt,
          trust_server_certificate: mssqlTrust,
        };
      case "mysql":
        return {
          type: "mysql",
          host: pgHost,
          port: pgPort,
          user: pgUser,
          ...passwordField(),
          database: pgDb,
          ssl: mysqlSsl,
        };
    }
  }

  function buildPayload(): ConnectionPayload {
    return {
      name: name.trim(),
      description: description.trim() || null,
      spec: buildSpec(),
      make_default: makeDefault,
    };
  }

  async function onTest() {
    setTestRes(null);
    setBusy(true);
    setErr(null);
    try {
      const r = await testConnection(name || "__new__", buildPayload());
      setTestRes(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === "create") {
        await createConnection(buildPayload());
      } else {
        await updateConnection(existing!.name, buildPayload());
      }
      await onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={onSubmit}
        className="bg-surface border border-surface-strong rounded-xl p-6 w-full max-w-2xl space-y-3 max-h-[90vh] overflow-auto"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <h3 className="text-lg font-bold">
          {mode === "create" ? "Nueva conexión" : `Editar "${existing!.name}"`}
        </h3>

        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <Field label="Nombre">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ej. mi_warehouse"
              className="w-full milhouse-field"
            />
          </Field>
          <Field label="Tipo">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as TypeKey)}
              className="w-full milhouse-field"
            >
              <option value="duckdb">DuckDB (archivo)</option>
              <option value="duckdb_memory">DuckDB (memoria)</option>
              <option value="sql_server">SQL Server (nativo)</option>
              <option value="mysql">MySQL / MariaDB (nativo)</option>
              <option value="odbc">ODBC</option>
              <option value="postgres">Postgres (placeholder)</option>
              <option value="sqlite">SQLite (placeholder)</option>
            </select>
          </Field>
        </div>

        <Field label="Descripción">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="opcional"
            className="w-full milhouse-field"
          />
        </Field>

        <div className="border-t border-surface pt-3">
          <h4 className="text-xs uppercase tracking-wider text-muted mb-2">
            Parámetros del tipo
          </h4>

          {type === "duckdb" && (
            <Field label="Path al archivo .duckdb">
              <input
                value={duckdbPath}
                onChange={(e) => setDuckdbPath(e.target.value)}
                placeholder="data/mi_db.duckdb"
                className="w-full milhouse-field font-mono text-xs"
              />
            </Field>
          )}

          {type === "duckdb_memory" && (
            <div className="text-xs text-muted">
              DuckDB en memoria. No requiere parámetros. Los datos se pierden al
              reiniciar el server.
            </div>
          )}

          {type === "odbc" && (
            <Field label="Connection string">
              <textarea
                value={odbcConn}
                onChange={(e) => setOdbcConn(e.target.value)}
                rows={3}
                placeholder="DSN=mi_dsn;UID=user;PWD=pass"
                className="w-full milhouse-field font-mono text-xs"
              />
              <div className="text-[11px] text-dim mt-1">
                Ejemplos:{" "}
                <code className="milhouse-chip">DSN=mi_dsn;UID=user;PWD=pass</code>
                {" · "}
                <code className="milhouse-chip">
                  Driver={"{"}ODBC Driver 17 for SQL Server{"}"};Server=...;Database=...
                </code>
              </div>
            </Field>
          )}

          {(type === "postgres" ||
            type === "sql_server" ||
            type === "mysql") && (
            <>
              <div className="grid grid-cols-[2fr_1fr] gap-3">
                <Field label="Host">
                  <input
                    value={pgHost}
                    onChange={(e) => setPgHost(e.target.value)}
                    className="w-full milhouse-field"
                  />
                </Field>
                <Field label="Puerto">
                  <input
                    type="number"
                    value={pgPort}
                    onChange={(e) => setPgPort(Number(e.target.value))}
                    className="w-full milhouse-field"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Usuario">
                  <input
                    value={pgUser}
                    onChange={(e) => setPgUser(e.target.value)}
                    className="w-full milhouse-field"
                  />
                </Field>
                <Field label="Password">
                  <input
                    type="password"
                    value={pgPass}
                    onChange={(e) => setPgPass(e.target.value)}
                    className="w-full milhouse-field"
                    placeholder={
                      mode === "edit"
                        ? "••••••••  (dejá vacío para conservar la actual)"
                        : "ingresá la password"
                    }
                  />
                </Field>
              </div>
              <Field label="Base de datos">
                <input
                  value={pgDb}
                  onChange={(e) => setPgDb(e.target.value)}
                  className="w-full milhouse-field"
                />
              </Field>

              {type === "sql_server" && (
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <Field label="Encriptación">
                    <select
                      value={mssqlEncrypt}
                      onChange={(e) => setMssqlEncrypt(e.target.value)}
                      className="w-full milhouse-field"
                    >
                      <option value="off">Off</option>
                      <option value="on">On (recomendado)</option>
                      <option value="required">Required</option>
                    </select>
                  </Field>
                  <label className="flex items-end gap-2 text-sm text-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mssqlTrust}
                      onChange={(e) => setMssqlTrust(e.target.checked)}
                    />
                    <span>Confiar en certificado del servidor</span>
                  </label>
                </div>
              )}

              {type === "mysql" && (
                <label className="flex items-center gap-2 text-sm text-muted cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    checked={mysqlSsl}
                    onChange={(e) => setMysqlSsl(e.target.checked)}
                  />
                  <span>Usar SSL/TLS</span>
                </label>
              )}

              {type === "postgres" && (
                <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-700 rounded px-2 py-1 mt-2">
                  ⚠ Postgres nativo todavía no está implementado. Por ahora
                  conectate usando ODBC con un driver de Postgres.
                </div>
              )}
            </>
          )}

          {type === "sqlite" && (
            <>
              <Field label="Path al archivo .sqlite">
                <input
                  value={sqlitePath}
                  onChange={(e) => setSqlitePath(e.target.value)}
                  className="w-full milhouse-field font-mono text-xs"
                />
              </Field>
              <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-700 rounded px-2 py-1 mt-2">
                ⚠ SQLite nativo está como placeholder. Usá ODBC con SQLite ODBC
                driver.
              </div>
            </>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={makeDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
          />
          <span>Marcar como conexión <code>default</code></span>
        </label>

        {testRes && (
          <div
            className={`text-xs rounded px-3 py-2 ${
              testRes.ok
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-700"
                : "bg-red-500/20 text-red-300 border border-red-700"
            }`}
          >
            {testRes.ok
              ? `✓ Conexión OK · ${testRes.latency_ms ?? "?"} ms · ${testRes.info ?? ""}`
              : `✗ ${testRes.error ?? "falló"}`}
          </div>
        )}
        {err && <div className="text-red-400 text-sm">{err}</div>}

        <div className="flex gap-2 justify-end pt-2 border-t border-surface">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-2 rounded milhouse-btn-secondary"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={busy || !name.trim()}
            className="text-sm px-3 py-2 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/40 disabled:opacity-50"
          >
            Test
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="text-sm px-3 py-2 rounded font-semibold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {mode === "create" ? "Crear" : "Guardar"}
          </button>
        </div>
      </form>
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
