"use client";

import { useEffect, useMemo, useState } from "react";
import {
  excelImport,
  excelPreview,
  fileToBase64,
  type ExcelPreview,
} from "@/lib/api";
import { useDialog } from "./Dialog";

/**
 * Asistente para importar valores desde un Excel. El usuario elige:
 *  - hoja (combobox)
 *  - columna de ID (la que se usa para filtrar en SQL)
 *  - columnas descriptivas (metadata visible en la UI)
 *  - si la primera fila es encabezado (auto-detectado, overrideable)
 *
 * Devuelve `{values, descriptionTable}` listo para guardar en un preset.
 */
export function ExcelImportDialog({
  file,
  onCancel,
  onResolved,
}: {
  file: File;
  onCancel: () => void;
  onResolved: (args: {
    values: string[];
    descriptionTable: string[][];
  }) => void;
}) {
  const dialog = useDialog();
  const [preview, setPreview] = useState<ExcelPreview | null>(null);
  const [xlsxB64, setXlsxB64] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [skipHeader, setSkipHeader] = useState<boolean>(true);
  const [idCol, setIdCol] = useState<number>(0);
  const [descCols, setDescCols] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Cargar preview + base64 al montar.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pv, b64] = await Promise.all([
          excelPreview(file),
          fileToBase64(file),
        ]);
        if (cancelled) return;
        setPreview(pv);
        setXlsxB64(b64);
        if (pv.sheets.length > 0) setSheet(pv.sheets[0]);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Esc cierra.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const sheetPreview = useMemo(
    () => preview?.previews.find((p) => p.sheet === sheet) ?? null,
    [preview, sheet],
  );

  // Auto-detección de "primera fila es encabezado": si todas las celdas
  // de la 1ª fila son texto y al menos una de las siguientes es número,
  // probablemente sea header. Se ejecuta cuando cambia la hoja.
  useEffect(() => {
    if (!sheetPreview) return;
    const rows = sheetPreview.rows;
    if (rows.length < 2) return;
    const firstAllText = rows[0].every((c) => c.trim() && isNaN(Number(c)));
    const secondHasNum = rows[1].some((c) => !!c.trim() && !isNaN(Number(c)));
    setSkipHeader(firstAllText && secondHasNum);
  }, [sheetPreview]);

  // Resetear selección de columnas al cambiar de hoja.
  useEffect(() => {
    setIdCol(0);
    setDescCols(new Set());
  }, [sheet]);

  async function doImport() {
    if (!xlsxB64 || !sheet) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await excelImport({
        xlsx_base64: xlsxB64,
        sheet,
        id_column: idCol,
        description_columns: Array.from(descCols).sort((a, b) => a - b),
        skip_header: skipHeader,
      });
      if (r.values.length === 0) {
        await dialog.alert(
          "La columna elegida no tiene valores (todas las filas están vacías).",
          { variant: "warning" },
        );
        setBusy(false);
        return;
      }
      onResolved({
        values: r.values,
        descriptionTable: r.description_table,
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const totalCols = sheetPreview?.total_cols ?? 0;
  const headerRow = sheetPreview?.rows[0] ?? [];
  const dataRows = skipHeader
    ? (sheetPreview?.rows ?? []).slice(1)
    : (sheetPreview?.rows ?? []);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-6"
      style={{
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(2px)",
      }}
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-surface-strong rounded-xl p-5 w-full max-w-4xl max-h-[90vh] overflow-auto space-y-3"
        style={{ boxShadow: "var(--shadow)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-app">
            📂 Importar Excel
            <span className="ml-2 text-xs font-normal text-muted">
              {file.name}
            </span>
          </h3>
          <button
            onClick={onCancel}
            className="text-dim hover:text-app text-lg"
            title="Cerrar (Esc)"
          >
            ✕
          </button>
        </div>

        {err && (
          <div className="milhouse-alert-warn text-sm rounded p-2">{err}</div>
        )}

        {!preview ? (
          <div className="text-dim text-sm py-8 text-center">
            Cargando preview del Excel…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
                  Hoja
                </span>
                <select
                  value={sheet}
                  onChange={(e) => setSheet(e.target.value)}
                  className="w-full milhouse-field"
                >
                  {preview.sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
                  Columna de ID (la que se filtra en SQL)
                </span>
                <select
                  value={idCol}
                  onChange={(e) => setIdCol(Number(e.target.value))}
                  className="w-full milhouse-field font-mono text-xs"
                >
                  {Array.from({ length: totalCols }).map((_, i) => (
                    <option key={i} value={i}>
                      col {i + 1}
                      {skipHeader && headerRow[i]
                        ? ` · ${headerRow[i]}`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-dim mb-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipHeader}
                  onChange={(e) => setSkipHeader(e.target.checked)}
                />
                <span>1ª fila es encabezado</span>
              </label>
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-wider text-dim mb-1">
                Columnas descriptivas (opcionales)
              </div>
              <p className="text-[11px] text-dim mb-1.5">
                Tildá las columnas con texto que describe a cada ID. Se
                guardan como metadata visible — el SQL siempre usa el ID.
              </p>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: totalCols }).map((_, i) => {
                  if (i === idCol) return null;
                  const on = descCols.has(i);
                  const label =
                    skipHeader && headerRow[i]
                      ? `${headerRow[i]} (col ${i + 1})`
                      : `col ${i + 1}`;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        const next = new Set(descCols);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        setDescCols(next);
                      }}
                      className={`text-xs px-2 py-1 rounded border ${
                        on
                          ? "border-cyan-600"
                          : "milhouse-btn-secondary border-surface-strong"
                      }`}
                      style={
                        on
                          ? {
                              background: "var(--accent)",
                              color: "var(--accent-ink)",
                            }
                          : undefined
                      }
                    >
                      {on ? "✓ " : ""}
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {sheetPreview && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-dim mb-1">
                  Preview — {sheetPreview.total_rows.toLocaleString("es-AR")}{" "}
                  fila(s){skipHeader ? " + encabezado" : ""}
                </div>
                <div className="overflow-auto max-h-64 border border-surface rounded">
                  <table className="milhouse-data-table text-xs">
                    <thead>
                      <tr>
                        {Array.from({ length: totalCols }).map((_, i) => {
                          const isId = i === idCol;
                          const isDesc = descCols.has(i);
                          return (
                            <th
                              key={i}
                              className={`px-2 py-1 text-left font-mono align-bottom ${
                                isId
                                  ? "bg-cyan-500/20 text-cyan-300"
                                  : isDesc
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : ""
                              }`}
                            >
                              <div className="text-[10px]">
                                col {i + 1}
                                {isId && " · ID"}
                                {isDesc && " · desc"}
                              </div>
                              {skipHeader && headerRow[i] && (
                                <div className="text-[11px] text-app">
                                  {headerRow[i]}
                                </div>
                              )}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {dataRows.map((row, ri) => (
                        <tr key={ri}>
                          {Array.from({ length: totalCols }).map((_, ci) => {
                            const isId = ci === idCol;
                            const isDesc = descCols.has(ci);
                            return (
                              <td
                                key={ci}
                                className={`px-2 py-1 font-mono whitespace-nowrap ${
                                  isId
                                    ? "bg-cyan-500/5 text-cyan-200"
                                    : isDesc
                                      ? "bg-emerald-500/5"
                                      : ""
                                }`}
                              >
                                {row[ci] ?? ""}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-surface">
              <button
                onClick={onCancel}
                className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary"
              >
                Cancelar
              </button>
              <button
                onClick={doImport}
                disabled={busy || !sheetPreview || totalCols === 0}
                className="text-sm font-semibold px-3 py-1.5 rounded disabled:opacity-50"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-ink)",
                }}
              >
                {busy ? "Importando…" : "Importar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
