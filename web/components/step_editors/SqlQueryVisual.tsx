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

interface WhereCond {
  column: string;
  op: string;
  value: string;
}

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

  // Cargar conexiones.
  useEffect(() => {
    listConnections().then(setConnections).catch((e) => setErr(String(e)));
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

  // Generar SQL cada vez que cambian las selecciones; reflejar en el step.
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
    const validWheres = whereConds.filter(
      (w) => w.column && w.op && w.value !== "",
    );
    if (validWheres.length > 0) {
      sql +=
        "\nWHERE " +
        validWheres
          .map((w) => formatWhereCond(w))
          .join(" AND ");
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

  // Sincronizar con step (sólo si cambió y el usuario está en modo visual).
  useEffect(() => {
    if (!table) return;
    onChange({
      ...step,
      query: generatedSql,
      output_table: step.output_table ?? "out",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedSql, table]);

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
    setWhereConds([...whereConds, { column: first, op: "=", value: "" }]);
  }
  function updateWhere(i: number, patch: Partial<WhereCond>) {
    const arr = [...whereConds];
    arr[i] = { ...arr[i], ...patch };
    setWhereConds(arr);
  }
  function deleteWhere(i: number) {
    setWhereConds(whereConds.filter((_, j) => j !== i));
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
          <div className="flex items-center justify-between mb-2">
            <h5 className="text-xs uppercase tracking-wider text-muted">
              WHERE ({whereConds.length})
            </h5>
            <button
              type="button"
              onClick={addWhere}
              className="text-xs px-2 py-0.5 rounded border border-surface-strong bg-surface"
            >
              + Condición
            </button>
          </div>
          {whereConds.length === 0 ? (
            <div className="text-xs text-dim">Sin filtros.</div>
          ) : (
            <div className="space-y-1">
              {whereConds.map((w, i) => (
                <div key={i} className="grid grid-cols-[1fr_80px_1fr_30px] gap-2">
                  <select
                    value={w.column}
                    onChange={(e) => updateWhere(i, { column: e.target.value })}
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
                    onChange={(e) => updateWhere(i, { op: e.target.value })}
                    className="milhouse-field text-xs py-1"
                  >
                    {["=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL", "IS NOT NULL"].map(
                      (op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ),
                    )}
                  </select>
                  <input
                    value={w.value}
                    onChange={(e) => updateWhere(i, { value: e.target.value })}
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

      {/* SQL generado (read-only) + editor */}
      <Field label="SQL generado">
        <SqlEditor
          value={step.query ?? ""}
          onChange={(v) => onChange({ ...step, query: v })}
          height="220px"
        />
        <p className="text-[11px] text-dim mt-1">
          Podés editarlo a mano. Si editás manual, los controles visuales no
          se vuelven a aplicar hasta que cambies tabla/columnas.
        </p>
      </Field>
    </div>
  );
}

function qualifiedTable(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}
function formatWhereCond(w: WhereCond): string {
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
