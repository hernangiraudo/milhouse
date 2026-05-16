"use client";

import type { ColumnMeta, TableSample } from "@/lib/types";

/**
 * Tabla de resultados con estética temática:
 * - Header sticky con dtype debajo del nombre.
 * - Banding alternativo sutil (token --panel-2 vs --panel).
 * - Columnas numéricas alineadas a la derecha en tabular-nums.
 * - Números formateados con separador de miles + 2 decimales si son
 *   decimales; enteros sin decimales pero con separador de miles.
 * - Strings con un poco más de aire; null como `—` dim.
 */
export function SamplePanel({ sample }: { sample: TableSample | null | undefined }) {
  if (!sample) {
    return (
      <div className="text-dim text-sm">(no hay sample disponible todavía)</div>
    );
  }
  const colKinds = sample.columns.map(columnKind);
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted tabular-nums">
        Mostrando{" "}
        <span className="font-semibold text-app">
          {sample.sampled_rows.toLocaleString("es-AR")}
        </span>{" "}
        de{" "}
        <span className="font-semibold text-app">
          {sample.total_rows.toLocaleString("es-AR")}
        </span>{" "}
        filas · {sample.columns.length} columnas
      </div>
      <div
        className="overflow-auto max-h-[28rem] rounded-md border"
        style={{ borderColor: "var(--border)" }}
      >
        <table className="milhouse-data-table text-xs min-w-full">
          <thead>
            <tr>
              {sample.columns.map((c, idx) => (
                <th
                  key={c.name}
                  className={
                    "px-3 py-1.5 font-medium align-bottom whitespace-nowrap " +
                    (isNumericKind(colKinds[idx]) ? "text-right" : "text-left")
                  }
                >
                  <div className="text-app">{c.name}</div>
                  <div className="text-[10px] text-dim font-mono font-normal">
                    {c.dtype}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => {
                  const kind = colKinds[j];
                  const numeric = isNumericKind(kind);
                  return (
                    <td
                      key={j}
                      className={
                        "px-3 py-1 font-mono whitespace-nowrap " +
                        (numeric
                          ? "text-right tabular-nums "
                          : "") +
                        (v == null ? "text-dim italic" : "text-app")
                      }
                    >
                      {fmt(v, kind)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ColKind = "int" | "float" | "bool" | "string" | "date" | "datetime" | "time" | "other";

function columnKind(c: ColumnMeta): ColKind {
  const dt = (c.dtype ?? "").toLowerCase();
  if (
    dt.startsWith("int") ||
    dt.startsWith("uint") ||
    dt === "i8" ||
    dt === "i16" ||
    dt === "i32" ||
    dt === "i64" ||
    dt === "u8" ||
    dt === "u16" ||
    dt === "u32" ||
    dt === "u64" ||
    dt === "bigint" ||
    dt === "integer"
  ) {
    return "int";
  }
  if (
    dt.startsWith("float") ||
    dt === "f32" ||
    dt === "f64" ||
    dt === "double" ||
    dt === "real" ||
    dt.startsWith("decimal") ||
    dt === "numeric"
  ) {
    return "float";
  }
  if (dt === "bool" || dt === "boolean") return "bool";
  // El orden importa: "datetime" empieza con "date", así que primero.
  if (dt.startsWith("datetime") || dt.includes("timestamp")) return "datetime";
  if (dt.startsWith("date")) return "date";
  if (dt.startsWith("time")) return "time";
  if (dt.startsWith("str") || dt === "utf8" || dt === "varchar" || dt === "text") {
    return "string";
  }
  return "other";
}

function isNumericKind(k: ColKind): boolean {
  return k === "int" || k === "float";
}

const NF_INT = new Intl.NumberFormat("es-AR", {
  maximumFractionDigits: 0,
});
const NF_DEC = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmt(v: unknown, kind: ColKind): string {
  if (v == null) return "—";
  if (kind === "int") {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return NF_INT.format(n);
    return String(v);
  }
  if (kind === "float") {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return NF_DEC.format(n);
    return String(v);
  }
  if (kind === "date") return fmtDate(v);
  if (kind === "datetime") return fmtDateTime(v);
  if (kind === "time") return String(v); // ya viene "HH:MM:SS"
  if (typeof v === "number") {
    if (Number.isInteger(v)) return NF_INT.format(v);
    return NF_DEC.format(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * Parsea un ISO date (`YYYY-MM-DD`) o ISO datetime y devuelve el componente
 * fecha como `dd/mm/yyyy`. Si no parsea, devuelve el valor tal cual.
 */
function fmtDate(v: unknown): string {
  const s = String(v);
  // Patrón: 1990-12-31 (más opcionalmente Thh:mm:ss...).
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Parsea un ISO datetime y devuelve `dd/mm/yyyy HH:MM:SS`. Si la hora es
 * 00:00:00 (default cuando el origen era una fecha sin hora), oculta la
 * parte horaria para no contaminar visualmente.
 */
function fmtDateTime(v: unknown): string {
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return fmtDate(v);
  const datePart = `${m[3]}/${m[2]}/${m[1]}`;
  const hms = `${m[4]}:${m[5]}:${m[6]}`;
  return hms === "00:00:00" ? datePart : `${datePart} ${hms}`;
}
