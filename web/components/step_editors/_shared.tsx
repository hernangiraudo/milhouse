"use client";

export interface AvailableTable {
  output_table: string;
  step_id: string;
}

export function Field({
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

export function TableSelect({
  value,
  available,
  onChange,
  placeholder = "(elegir tabla)",
}: {
  value: string;
  available: AvailableTable[];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className="w-full milhouse-field font-mono text-sm"
    >
      <option value="">{placeholder}</option>
      {available.map((a) => (
        <option key={a.output_table} value={a.output_table}>
          {a.output_table}  · de {a.step_id}
        </option>
      ))}
    </select>
  );
}

/**
 * Selector "modificar tabla existente / crear nueva tabla" para los kinds
 * que admiten output_table opcional (lookup, transform, filter_and_subset,
 * procedural). Si el modo es "in-place", devuelve `null` al onChange (el
 * backend interpreta como: usar `input` como output_table). Si es "nueva",
 * pide un nombre.
 */
export function InPlaceOrNewTable({
  value,
  inputTable,
  onChange,
  placeholder = "ej. tx_enriched",
}: {
  value: string | null | undefined;
  inputTable?: string;
  onChange: (next: string | null) => void;
  placeholder?: string;
}) {
  const isInPlace =
    value == null ||
    value === "" ||
    (inputTable != null && value === inputTable);
  return (
    <div className="bg-surface-2 border border-surface rounded p-3 space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-dim">
        Salida del paso
      </div>
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="radio"
          checked={isInPlace}
          onChange={() => onChange(null)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Modificar tabla existente</span>
          {inputTable && (
            <>
              {" "}
              <code className="font-mono text-xs text-dim">({inputTable})</code>
            </>
          )}
          <div className="text-[11px] text-dim">
            Reemplaza la tabla de entrada. Más eficiente en memoria; los pasos
            siguientes ven los cambios sin renombrar nada.
          </div>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="radio"
          checked={!isInPlace}
          onChange={() =>
            onChange(value && value !== inputTable ? value : "nuevo_dataset")
          }
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="font-medium">Crear nueva tabla</span>
          <div className="text-[11px] text-dim mb-1">
            Conserva la tabla de entrada y guarda el resultado aparte.
          </div>
          {!isInPlace && (
            <input
              value={value ?? ""}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className="w-full milhouse-field font-mono text-sm"
            />
          )}
        </span>
      </label>
    </div>
  );
}
