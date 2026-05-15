"use client";

import { useEffect, useState } from "react";

/**
 * Hook genérico: dado un nombre de tabla (lo que produce un step previo),
 * devuelve la lista de columnas (inferidas) si las podemos detectar.
 *
 * Para tablas que vienen de un step previo (output_table en memoria) NO
 * podemos introspectar — no están en una DB. Por ahora devolvemos lista vacía
 * y el usuario tipea libremente. Cuando agreguemos "schema inference" de
 * outputs, esto se llena automáticamente.
 *
 * Sí podemos sugerir columnas conocidas a partir de `hints` (ej. step que
 * generó la tabla declaró output columns explícitamente).
 */
export function useTableColumns(tableName: string | undefined | null) {
  const [columns, setColumns] = useState<string[]>([]);
  useEffect(() => {
    // TODO: cuando el orquestador conozca el output schema de cada step,
    //       traerlo acá. Hoy quedamos como lista vacía.
    setColumns([]);
  }, [tableName]);
  return columns;
}
