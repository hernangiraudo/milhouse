"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";
import { ParametersPanel, type PresetGroup } from "./ParametersPanel";
import type { ParamPreset, ParamSpec } from "./DesignEditor";
import { useDialog } from "./Dialog";

interface GlobalParamsFile {
  parameters: ParamSpec[];
  presets: ParamPreset[];
  preset_groups: PresetGroup[];
}

export function ExecParamsPanel() {
  const dialog = useDialog();
  const [data, setData] = useState<GlobalParamsFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savingMsg, setSavingMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await fetch(`${API_BASE}/api/parameters`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as Partial<GlobalParamsFile>;
      setData({
        parameters: j.parameters ?? [],
        presets: j.presets ?? [],
        preset_groups: j.preset_groups ?? [],
      });
      setDirty(false);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!data) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API_BASE}/api/parameters`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(await r.text());
      setDirty(false);
      setSavingMsg("✓ Guardado");
      setTimeout(() => setSavingMsg(null), 2500);
    } catch (e) {
      await dialog.alert(`No se pudo guardar: ${e}`, { variant: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-lg">Parámetros de Ejecución</h2>
          <p className="text-sm text-muted">
            Parámetros y respuestas guardadas <strong>globales</strong>
            compartidas entre todos los proyectos. Cada proyecto puede
            agregar los suyos en su sección Diseño · Propiedades; en caso de
            colisión por nombre, el del proyecto pisa al global.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {savingMsg && (
            <span className="text-xs text-emerald-300">{savingMsg}</span>
          )}
          {dirty && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-700">
              sin guardar
            </span>
          )}
          <button
            onClick={save}
            disabled={!dirty || busy}
            className="text-sm font-semibold px-4 py-1.5 rounded disabled:opacity-50"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
            }}
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </header>

      {err && (
        <div className="text-red-400 text-sm whitespace-pre-wrap">{err}</div>
      )}

      {data == null ? (
        <div className="text-dim text-sm">Cargando…</div>
      ) : (
        <ParametersPanel
          parameters={data.parameters}
          presets={data.presets}
          presetGroups={data.preset_groups}
          onChange={(next) => {
            setData({
              parameters: next.parameters,
              presets: next.presets,
              preset_groups: data.preset_groups,
            });
            setDirty(true);
          }}
          onChangeGroups={(next) => {
            setData({
              parameters: data.parameters,
              presets: data.presets,
              preset_groups: next,
            });
            setDirty(true);
          }}
        />
      )}
    </section>
  );
}
