"use client";

import { useEffect, useMemo, useState } from "react";
import {
  listConnections,
  listConnectionTables,
  listTableColumns,
  type ColumnInfo,
  type TableInfo,
} from "@/lib/api";
import type { ConnectionsResponse } from "@/lib/types";
import { SqlEditor } from "../SqlEditor";

interface SqlQueryStep {
  id: string;
  kind: "sql_query";
  connection?: string | null;
  query?: string;
  output_table?: string;
  [k: string]: unknown;
}

interface OrderBy {
  column: string;
  desc: boolean;
}

type WhereCond =
  | {
      kind: "simple";
      column: string;
      op: string;
      value: string;
      logic: "AND" | "OR";
    }
  | {
      kind: "raw";
      expression: string;
      logic: "AND" | "OR";
    };

export function SqlQueryVisual({
  step,
  onChange,
}: {
  step: SqlQueryStep;
  onChange: (next: SqlQueryStep) => void;
}) {
  const [connections, setConnections] = useState<ConnectionsResponse | null>(
    null,
  );
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const conn = (step.connection as string) ?? "";
  const [table, setTable] = useState<string>("");
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());
  const [whereConds, setWhereConds] = useState<WhereCond[]>([]);
  const [orderBy, setOrderBy] = useState<OrderBy[]>([]);
  // Modo: "visual" sincroniza step.query desde los controles; "manual" deja
  // editar/pegar SQL libremente y los controles visuales quedan informativos.
  const [mode, setMode] = useState<"visual" | "manual">("visual");

  // Cargar conexiones.
  useEffect(() => {
    listConnections().then(setConnections).catch((e) => setErr(String(e)));
  }, []);

  // Al montar: si ya hay un query custom (no se autogeneró desde controles),
  // arrancamos en modo manual para no pisarlo.
  useEffect(() => {
    const q = (step.query ?? "").trim();
    if (q && !table) {
      // Hay SQL pero no tenemos tabla seleccionada → query manual heredada.
      setMode("manual");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cuando cambia la conexión, listar sus tablas.
  useEffect(() => {
    setTables([]);
    setColumns([]);
    setTable("");
    setSelectedCols(new Set());
    if (!conn) return;
    listConnectionTables(conn)
      .then(setTables)
      .catch((e) => setErr(String(e)));
  }, [conn]);

  // Cuando se elige tabla, traer columnas.
  useEffect(() => {
    setColumns([]);
    setSelectedCols(new Set());
    if (!conn || !table) return;
    const t = tables.find((x) => qualifiedTable(x) === table) ?? tables.find((x) => x.name === table);
    listTableColumns(conn, t?.name ?? table, t?.schema ?? null)
      .then((cs) => {
        setColumns(cs);
        setSelectedCols(new Set(cs.map((c) => c.name))); // por default todas
      })
      .catch((e) => setErr(String(e)));
  }, [conn, table, tables]);

  // Generar SQL desde los controles visuales.
  const generatedSql = useMemo(() => {
    if (!table) return step.query ?? "";
    const colsList =
      selectedCols.size === 0
        ? "*"
        : columns
            .map((c) => c.name)
            .filter((n) => selectedCols.has(n))
            .map((n) => `  "${n}"`)
            .join(",\n");
    let sql = `SELECT\n${colsList}\nFROM ${table}`;
    const validWheres = whereConds.filter(isWhereCondValid);
    if (validWheres.length > 0) {
      sql += "\nWHERE " + joinWhereWithLogic(validWheres);
    }
    if (orderBy.length > 0) {
      sql +=
        "\nORDER BY " +
        orderBy
          .map((o) => `"${o.column}" ${o.desc ? "DESC" : "ASC"}`)
          .join(", ");
    }
    return sql;
  }, [table, columns, selectedCols, whereConds, orderBy, step.query]);

  // Sincronizar con el step SÓLO en modo visual. En manual el editor SQL es
  // la fuente de verdad y nunca lo pisamos.
  useEffect(() => {
    if (mode !== "visual") return;
    if (!table) return;
    onChange({
      ...step,
      query: generatedSql,
      output_table: step.output_table ?? "out",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedSql, table, mode]);

  function toggleCol(name: string) {
    const next = new Set(selectedCols);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedCols(next);
  }
  function selectAllCols() {
    setSelectedCols(new Set(columns.map((c) => c.name)));
  }
  function clearCols() {
    setSelectedCols(new Set());
  }

  function addWhere() {
    const first = columns[0]?.name ?? "";
    setWhereConds([
      ...whereConds,
      { kind: "simple", column: first, op: "=", value: "", logic: "AND" },
    ]);
  }
  function addRawWhere() {
    setWhereConds([
      ...whereConds,
      { kind: "raw", expression: "", logic: "AND" },
    ]);
  }
  function updateWhere(i: number, next: WhereCond) {
    const arr = [...whereConds];
    arr[i] = next;
    setWhereConds(arr);
  }
  function deleteWhere(i: number) {
    setWhereConds(whereConds.filter((_, j) => j !== i));
  }
  function moveWhere(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= whereConds.length) return;
    const arr = [...whereConds];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setWhereConds(arr);
  }

  function addOrder() {
    const first = columns[0]?.name ?? "";
    setOrderBy([...orderBy, { column: first, desc: false }]);
  }
  function updateOrder(i: number, patch: Partial<OrderBy>) {
    const arr = [...orderBy];
    arr[i] = { ...arr[i], ...patch };
    setOrderBy(arr);
  }
  function deleteOrder(i: number) {
    setOrderBy(orderBy.filter((_, j) => j !== i));
  }

  return (
    <div className="space-y-3">
      {err && <div className="text-red-400 text-sm">{err}</div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Conexión">
          <select
            value={conn}
            onChange={(e) =>
              onChange({
                ...step,
                connection: e.target.value || null,
              })
            }
            className="w-full milhouse-field"
          >
            <option value="">(default)</option>
            {connections?.connections
              .filter((c) => c.implemented)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} · {c.type}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Tabla">
          <select
            value={table}
            onChange={(e) => setTable(e.target.value)}
            className="w-full milhouse-field"
            disabled={!conn || tables.length === 0}
          >
            <option value="">{conn ? "(elegí una)" : "(elegí conexión primero)"}</option>
            {tables.map((t) => {
              const qt = qualifiedTable(t);
              return (
                <option key={qt} value={qt}>
                  {qt}
                  {t.kind === "view" ? " · view" : ""}
                </option>
              );
            })}
          </select>
        </Field>
      </div>

      <Field label="output_table">
        <input
          value={(step.output_table as string) ?? ""}
          onChange={(e) => onChange({ ...step, output_table: e.target.value })}
          className="w-full milhouse-field font-mono"
          placeholder="ej. tx_raw"
        />
      </Field>

      {/* Columnas */}
      {columns.length > 0 && (
        <div className="bg-surface-2 border border-surface rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <h5 className="text-xs uppercase tracking-wider text-muted">
              Columnas ({selectedCols.size}/{columns.length})
            </h5>
            <div className="flex gap-1 text-xs">
              <button
                type="button"
                onClick={selectAllCols}
                className="px-2 py-0.5 rounded border border-surface-strong bg-surface"
              >
                Todas
              </button>
              <button
                type="button"
                onClick={clearCols}
                className="px-2 py-0.5 rounded border border-surface-strong bg-surface"
              >
                Ninguna
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 max-h-48 overflow-auto">
            {columns.map((c) => (
              <label
                key={c.name}
                className="flex items-center gap-2 text-sm cursor-pointer text-app"
                title={`${c.data_type}${c.is_primary_key ? " · primary key" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedCols.has(c.name)}
                  onChange={() => toggleCol(c.name)}
                />
                {c.is_primary_key ? (
                  <span
                    className="inline-block text-[10px] font-bold"
                    style={{ color: "var(--accent)" }}
                    title="Primary key"
                  >
                    🔑
                  </span>
                ) : (
                  <span className="inline-block w-[14px]" aria-hidden />
                )}
                <code
                  className="font-mono text-xs"
                  style={c.is_primary_key ? { fontWeight: 700 } : undefined}
                >
                  {c.name}
                </code>
                <span className="text-[10px] text-dim truncate">
                  {c.data_type}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* WHERE */}
      {columns.length > 0 && (
        <div className="bg-surface-2 border border-surface rounded p-3">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
            <h5 className="text-xs uppercase tracking-wider text-muted">
              WHERE ({whereConds.length})
            </h5>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={addWhere}
                className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
              >
                + Condición
              </button>
              <button
                type="button"
                onClick={addRawWhere}
                title="Expresión SQL libre (ej. amount * rate > 1000)"
                className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
              >
                + Avanzado
              </button>
            </div>
          </div>
          {whereConds.length === 0 ? (
            <div className="text-xs text-dim">Sin filtros.</div>
          ) : (
            <div className="space-y-1">
              {whereConds.map((w, i) => (
                <div key={i}>
                  <div className="flex items-stretch gap-1">
                    <div className="flex flex-col gap-0.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => moveWhere(i, -1)}
                        disabled={i === 0}
                        title="Mover arriba"
                        className="text-[10px] text-dim disabled:opacity-20 leading-none"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => moveWhere(i, 1)}
                        disabled={i === whereConds.length - 1}
                        title="Mover abajo"
                        className="text-[10px] text-dim disabled:opacity-20 leading-none"
                      >
                        ▼
                      </button>
                    </div>
                    {w.kind === "simple" ? (
                      <div className="grid grid-cols-[1fr_90px_1fr_30px] gap-2 flex-1">
                        <select
                          value={w.column}
                          onChange={(e) =>
                            updateWhere(i, { ...w, column: e.target.value })
                          }
                          className="milhouse-field font-mono text-xs py-1"
                        >
                          {columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={w.op}
                          onChange={(e) =>
                            updateWhere(i, { ...w, op: e.target.value })
                          }
                          className="milhouse-field text-xs py-1"
                        >
                          {[
                            "=",
                            "!=",
                            "<",
                            "<=",
                            ">",
                            ">=",
                            "LIKE",
                            "IN",
                            "IS NULL",
                            "IS NOT NULL",
                          ].map((op) => (
                            <option key={op} value={op}>
                              {op}
                            </option>
                          ))}
                        </select>
                        <input
                          value={w.value}
                          onChange={(e) =>
                            updateWhere(i, { ...w, value: e.target.value })
                          }
                          disabled={w.op === "IS NULL" || w.op === "IS NOT NULL"}
                          placeholder="valor"
                          className="milhouse-field text-xs py-1 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => deleteWhere(i)}
                          className="text-red-400"
                          title="Eliminar"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[1fr_30px] gap-2 flex-1">
                        <input
                          value={w.expression}
                          onChange={(e) =>
                            updateWhere(i, { ...w, expression: e.target.value })
                          }
                          placeholder="expresión SQL · ej. amount * rate > 1000"
                          className="milhouse-field text-xs py-1 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => deleteWhere(i)}
                          className="text-red-400"
                          title="Eliminar"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                  {i < whereConds.length - 1 && (
                    <div className="flex justify-center my-1">
                      <select
                        value={w.logic}
                        onChange={(e) =>
                          updateWhere(i, {
                            ...w,
                            logic: e.target.value as "AND" | "OR",
                          })
                        }
                        className="milhouse-field text-[10px] py-0 px-2 w-20"
                      >
                        <option value="AND">AND</option>
                        <option value="OR">OR</option>
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ORDER BY */}
      {columns.length > 0 && (
        <div className="bg-surface-2 border border-surface rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <h5 className="text-xs uppercase tracking-wider text-muted">
              ORDER BY ({orderBy.length})
            </h5>
            <button
              type="button"
              onClick={addOrder}
              className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
            >
              + Orden
            </button>
          </div>
          {orderBy.length === 0 ? (
            <div className="text-xs text-dim">Sin ordenamiento.</div>
          ) : (
            <div className="space-y-1">
              {orderBy.map((o, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_100px_30px] gap-2"
                >
                  <select
                    value={o.column}
                    onChange={(e) => updateOrder(i, { column: e.target.value })}
                    className="milhouse-field font-mono text-xs py-1"
                  >
                    {columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={o.desc ? "desc" : "asc"}
                    onChange={(e) =>
                      updateOrder(i, { desc: e.target.value === "desc" })
                    }
                    className="milhouse-field text-xs py-1"
                  >
                    <option value="asc">↑ ASC</option>
                    <option value="desc">↓ DESC</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => deleteOrder(i)}
                    className="text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SQL: editor + toggle visual/manual */}
      <div className="bg-surface-2 border border-surface rounded p-3 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h5 className="text-xs uppercase tracking-wider text-muted">
            SQL {mode === "manual" ? "(manual)" : "(generado)"}
          </h5>
          <div className="flex gap-1 text-xs">
            <button
              type="button"
              onClick={() => setMode("visual")}
              className={`px-2 py-0.5 rounded border ${
                mode === "visual"
                  ? "bg-accent-token border-transparent"
                  : "bg-surface border-surface-strong"
              }`}
              title="Sincroniza el SQL desde los controles de arriba"
            >
              🪄 Visual
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={`px-2 py-0.5 rounded border ${
                mode === "manual"
                  ? "bg-accent-token border-transparent"
                  : "bg-surface border-surface-strong"
              }`}
              title="Editar SQL libre — los controles no lo pisan (ideal para pegar un SELECT)"
            >
              ✎ SQL manual
            </button>
          </div>
        </div>
        <SqlEditor
          value={step.query ?? ""}
          onChange={(v) => {
            // Si el usuario tipea en el editor, lo interpretamos como
            // "quiero modo manual" para no perder lo escrito al próximo render.
            if (mode === "visual") setMode("manual");
            onChange({ ...step, query: v });
          }}
          height="220px"
          connection={conn || null}
        />
        <p className="text-[11px] text-dim">
          {mode === "manual"
            ? "Modo manual: pegá o editá el SELECT libremente. Los controles visuales quedan informativos."
            : "Modo visual: el SQL se reconstruye desde los controles de arriba. Si pegás algo a mano, cambia automáticamente a manual."}
        </p>
      </div>
    </div>
  );
}

function qualifiedTable(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

function isWhereCondValid(w: WhereCond): boolean {
  if (w.kind === "raw") return w.expression.trim().length > 0;
  if (!w.column || !w.op) return false;
  if (w.op === "IS NULL" || w.op === "IS NOT NULL") return true;
  return w.value !== "";
}

function formatWhereCond(w: WhereCond): string {
  if (w.kind === "raw") {
    // Si tiene operadores lógicos sueltos, lo envolvemos en paréntesis.
    const e = w.expression.trim();
    return /\b(AND|OR)\b/i.test(e) ? `(${e})` : e;
  }
  if (w.op === "IS NULL" || w.op === "IS NOT NULL") {
    return `"${w.column}" ${w.op}`;
  }
  // Valor entre comillas si no es numérico ni una expresión obvia.
  const v = w.value.trim();
  const isNum = /^-?\d+(\.\d+)?$/.test(v);
  const isList = w.op === "IN" && v.startsWith("(");
  if (isNum || isList) return `"${w.column}" ${w.op} ${v}`;
  return `"${w.column}" ${w.op} '${v.replace(/'/g, "''")}'`;
}

/** Junta las condiciones intercalando AND/OR según el `logic` de la
 *  condición previa (operador hacia la siguiente). */
function joinWhereWithLogic(conds: WhereCond[]): string {
  if (conds.length === 0) return "";
  const parts: string[] = [formatWhereCond(conds[0])];
  for (let i = 1; i < conds.length; i++) {
    const prev = conds[i - 1];
    parts.push(prev.logic, formatWhereCond(conds[i]));
  }
  return parts.join(" ");
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
