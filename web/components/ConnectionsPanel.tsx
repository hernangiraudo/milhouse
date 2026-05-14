"use client";

import { useEffect, useState } from "react";
import {
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
  { color: string; glyph: string; label: string }
> = {
  duckdb: { color: "#10b981", glyph: "🦆", label: "DuckDB (archivo)" },
  duckdb_memory: { color: "#06b6d4", glyph: "⚡", label: "DuckDB (memoria)" },
  sql_server: { color: "#ef4444", glyph: "🟦", label: "SQL Server (nativo)" },
  mysql: { color: "#0ea5e9", glyph: "🐬", label: "MySQL (nativo)" },
  odbc: { color: "#f97316", glyph: "🔌", label: "ODBC" },
  postgres: { color: "#3b82f6", glyph: "🐘", label: "Postgres" },
  sqlite: { color: "#a855f7", glyph: "📦", label: "SQLite" },
};

export function ConnectionsPanel() {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ConnectionSummary | null>(null);
  const [creating, setCreating] = useState(false);
  // resultado de test por conexión.
  const [testResult, setTestResult] = useState<Record<string, TestConnectionResult & { running?: boolean }>>({});

  async function load() {
    try {
      const d = await listConnections();
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function onReload() {
    setBusy(true);
    setErr(null);
    try {
      await reloadConnections();
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(name: string) {
    if (!confirm(`¿Eliminar la conexión "${name}"?`)) return;
    try {
      await deleteConnection(name);
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onTest(c: ConnectionSummary) {
    setTestResult((p) => ({
      ...p,
      [c.name]: { ok: false, running: true },
    }));
    try {
      const r = await testConnection(c.name);
      setTestResult((p) => ({ ...p, [c.name]: r }));
    } catch (e) {
      setTestResult((p) => ({
        ...p,
        [c.name]: { ok: false, error: String(e) },
      }));
    }
  }

  return (
    <section className="space-y-4">
      <div className="bg-panel rounded-xl p-6 border border-slate-800">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-semibold text-lg">Conexiones</h2>
            <p className="text-sm text-muted">
              Bases de datos y orígenes ODBC disponibles para los proyectos.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs text-dim">configs/connections.json</code>
            <button
              onClick={onReload}
              disabled={busy}
              className="text-xs px-2 py-1 rounded border border-surface-strong bg-surface-2 hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "Recargando…" : "Recargar"}
            </button>
            <button
              onClick={() => setCreating(true)}
              className="text-xs font-semibold px-3 py-1 rounded"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              + Agregar
            </button>
          </div>
        </div>
        {err && <div className="text-red-400 text-sm mt-3">{err}</div>}
      </div>

      {!data && !err && (
        <div className="text-slate-500 text-sm">Cargando…</div>
      )}
      {data && data.connections.length === 0 && (
        <div className="bg-panel border border-slate-800 rounded-xl p-6 text-slate-500 text-sm">
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
              onEdit={() => setEditing(c)}
              onDelete={() => onDelete(c.name)}
              onTest={() => onTest(c)}
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
            await load();
          }}
        />
      )}
      {editing && (
        <ConnectionDialog
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

function ConnectionCard({
  c,
  testResult,
  onEdit,
  onDelete,
  onTest,
}: {
  c: ConnectionSummary;
  testResult?: TestConnectionResult & { running?: boolean };
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const t =
    TYPE_STYLES[c.type] ?? { color: "#94a3b8", glyph: "?", label: c.type };
  return (
    <div
      className="rounded-lg border bg-surface-2 p-3 relative"
      style={{ borderColor: c.implemented ? t.color : "#475569" }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span style={{ color: t.color }}>{t.glyph}</span>
          <code className="font-semibold text-slate-100">{c.name}</code>
        </div>
        <div className="flex items-center gap-1">
          {c.is_default && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-700">
              default
            </span>
          )}
          {!c.implemented && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-700"
              title="Declarada en el archivo pero no implementada en este MVP"
            >
              placeholder
            </span>
          )}
        </div>
      </div>
      <div className="text-xs mt-1" style={{ color: t.color }}>
        {t.label}
      </div>
      {c.description && (
        <div className="text-xs text-muted mt-2 leading-snug">
          {c.description}
        </div>
      )}
      <SpecLines spec={c.spec} />

      {/* Resultado del último test, si lo hubo */}
      {testResult && (
        <div
          className={`mt-2 text-[11px] rounded px-2 py-1 ${
            testResult.running
              ? "bg-slate-500/20 text-slate-300"
              : testResult.ok
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-700"
              : "bg-red-500/20 text-red-300 border border-red-700"
          }`}
        >
          {testResult.running
            ? "Testeando…"
            : testResult.ok
            ? `✓ OK · ${testResult.latency_ms ?? "?"} ms · ${testResult.info ?? ""}`
            : `✗ ${testResult.error ?? "falló"}`}
        </div>
      )}

      <div className="flex gap-2 mt-3 text-xs">
        <button
          onClick={onTest}
          disabled={!c.implemented || testResult?.running}
          className="px-2 py-1 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/40 disabled:opacity-30"
        >
          Test
        </button>
        <button
          onClick={onEdit}
          className="px-2 py-1 rounded border border-surface-strong bg-surface-2 hover:bg-slate-800"
        >
          Editar
        </button>
        <button
          onClick={onDelete}
          className="ml-auto px-2 py-1 rounded border border-red-700 bg-red-500/10 text-red-300 hover:bg-red-500/30"
        >
          Eliminar
        </button>
      </div>
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
    <div className="mt-2 text-[11px] font-mono space-y-0.5">
      {fields.map(([k, v]) => (
        <div key={k} className="text-slate-500">
          <span className="text-slate-400">{k}:</span>{" "}
          <span className="text-slate-300">{String(v)}</span>
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
          password: pgPass || null,
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
          password: pgPass || null,
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
          password: pgPass || null,
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
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        className="bg-surface border border-surface-strong rounded-xl p-6 w-full max-w-2xl space-y-3 max-h-[90vh] overflow-auto"
        style={{ boxShadow: "var(--shadow)" }}
        onClick={(e) => e.stopPropagation()}
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
                    placeholder="(no se persiste si vacío y mode=edit)"
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
            className="text-sm px-3 py-2 rounded border border-surface-strong bg-surface-2 hover:bg-slate-800"
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
