"use client";

import { useEffect, useState } from "react";
import { runsHealth, runsReset, type RunsHealth } from "@/lib/api";
import { useDialog } from "./Dialog";
import { Database } from "lucide-react";

/** Banner que aparece cuando la DB de runs no está disponible por un
 *  error recuperable (archivo lockeado, IO error). Ofrece un botón
 *  para resetear (renombrar el archivo a `.bak.<ts>` y crear uno
 *  nuevo). Si la razón es "not_configured" no aparece — eso ya está
 *  cubierto por el banner del SchedulesPanel. */
export function RunsHealthBar() {
  const dialog = useDialog();
  const [health, setHealth] = useState<RunsHealth | null>(null);
  const [busy, setBusy] = useState(false);

  async function poll() {
    try {
      const h = await runsHealth();
      setHealth(h);
    } catch {
      // Si el endpoint en sí falla, asumimos backend caído — eso lo
      // muestra el BackendStatusBar; acá no decimos nada.
      setHealth(null);
    }
  }

  useEffect(() => {
    poll();
    const id = setInterval(poll, 20_000);
    return () => clearInterval(id);
  }, []);

  // No mostrar si no hay info, si está OK, o si simplemente no está
  // configurada (eso es feature, no error).
  if (!health || health.available) return null;
  if (health.reason === "not_configured" || health.reason === "transient") {
    return null;
  }

  const isLocked = health.reason === "file_locked";

  async function onReset() {
    const title = "Resetear base de runs";
    const msg = isLocked
      ? "El archivo de la DB de runs está siendo usado por otro proceso " +
        "(probablemente otra instancia de milhouse.exe). Voy a renombrarlo a " +
        ".bak.<timestamp> y crear uno nuevo vacío. Las corridas históricas " +
        "quedan en el archivo backup; podés moverlo a otra máquina si necesitás " +
        "consultarlas.\n\n¿Continuar?"
      : "Voy a renombrar el archivo actual de la DB de runs a .bak.<timestamp> " +
        "y crear uno nuevo vacío. Las corridas históricas se preservan en el " +
        "backup.\n\n¿Continuar?";
    const ok = await dialog.confirm(msg, {
      title,
      variant: "warning",
      ok: "Sí, crear base nueva",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await runsReset();
      await dialog.alert(
        r.backup_path
          ? `✓ Base de runs reseteada.\n\nBackup: ${r.backup_path}`
          : "✓ Base de runs creada (no había archivo previo).",
        { title: "Listo", variant: "info" },
      );
      await poll();
    } catch (e) {
      await dialog.alert(String(e), {
        title: "No se pudo resetear",
        variant: "danger",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="border-b border-amber-700 bg-amber-200 text-amber-950 px-4 py-2 text-sm flex items-center gap-3 flex-wrap"
      role="alert"
    >
      <Database size={16} strokeWidth={2} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <strong>Base de runs no disponible.</strong>{" "}
        {isLocked
          ? "El archivo está siendo usado por otro proceso. Mientras tanto no se persisten corridas, schedules ni casos."
          : "Hubo un problema abriendo el archivo. Mientras tanto no se persisten corridas, schedules ni casos."}
        {health.path && (
          <code className="ml-1 text-[11px] opacity-75">{health.path}</code>
        )}
      </div>
      <button
        onClick={onReset}
        disabled={busy}
        className="text-xs font-semibold px-3 py-1.5 rounded bg-amber-950 text-amber-50 hover:bg-amber-900 disabled:opacity-50"
      >
        {busy ? "Reseteando…" : "Crear base nueva"}
      </button>
      <details className="text-[11px] cursor-pointer">
        <summary>Detalle</summary>
        <div className="mt-1 font-mono text-[10px] max-w-xl whitespace-pre-wrap">
          {health.error ?? "(sin info adicional)"}
        </div>
      </details>
    </div>
  );
}
