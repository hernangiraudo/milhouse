"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteConfig,
  getConfig,
  listConfigs,
  slugifyFilename,
  createConfig,
} from "@/lib/api";
import type { ConfigSummary } from "@/lib/types";
import { useDialog } from "./Dialog";

export function DesignPanel() {
  const router = useRouter();
  const dialog = useDialog();
  const [list, setList] = useState<ConfigSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    try {
      const c = await listConfigs();
      setList(c);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  useEffect(() => {
    reload();
  }, []);

  function openNew() {
    router.push("/design/new");
  }
  function openExisting(name: string) {
    router.push(`/design/${encodeURIComponent(name)}`);
  }

  async function onDelete(name: string, displayName: string) {
    const ok = await dialog.confirm(
      `¿Eliminar el proyecto "${displayName}"?\nSe borra el archivo ${name}.`,
      { title: "Eliminar proyecto", variant: "danger", ok: "Eliminar" },
    );
    if (!ok) return;
    try {
      await deleteConfig(name);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function onDuplicate(c: ConfigSummary) {
    try {
      const cfg = (await getConfig(c.name)) as Record<string, unknown> & {
        name: string;
        steps?: Array<Record<string, unknown>>;
      };
      const dupName = `${c.display_name} (copia)`;
      const filename = await slugifyFilename(dupName);
      const cleanedSteps =
        cfg.steps?.map((s) => {
          const copy = { ...s } as Record<string, unknown>;
          delete copy.step_uid;
          return copy;
        }) ?? [];
      const cleaned = { ...cfg, name: dupName, steps: cleanedSteps };
      await createConfig(filename, cleaned);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-lg">Diseño de proyectos</h2>
          <p className="text-sm text-muted">
            Crear, editar y eliminar definiciones ETL. Cada proyecto se edita
            en su propia pantalla.
          </p>
        </div>
        <button
          onClick={openNew}
          className="text-sm font-semibold px-3 py-1 rounded"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          + Nuevo proyecto
        </button>
      </header>

      {err && <div className="text-red-400 text-sm">{err}</div>}

      <div className="bg-panel border border-slate-800 rounded-xl overflow-hidden">
        <header className="px-4 py-2 bg-panel2 text-xs uppercase tracking-wider text-muted">
          Proyectos · {list.length}
        </header>
        <table className="w-full text-sm">
          <thead className="text-muted">
            <tr>
              <th className="text-left px-3 py-2">Nombre</th>
              <th className="text-left px-3 py-2">Archivo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-dim text-center">
                  No hay proyectos. Creá uno con "+ Nuevo".
                </td>
              </tr>
            )}
            {list.map((c) => (
              <tr
                key={c.name}
                className="border-t border-surface cursor-pointer hover:bg-slate-800/30"
                onClick={() => openExisting(c.name)}
              >
                <td className="px-3 py-2">{c.display_name}</td>
                <td className="px-3 py-2 font-mono text-xs text-dim">
                  {c.name}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicate(c);
                    }}
                    className="text-xs text-accent hover:underline mr-3"
                  >
                    Duplicar
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c.name, c.display_name);
                    }}
                    className="text-xs text-red-400 hover:underline"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
