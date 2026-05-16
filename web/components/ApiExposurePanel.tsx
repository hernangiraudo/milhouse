"use client";

import { useMemo } from "react";
import { useDialog } from "./Dialog";
import type { Step } from "./StepEditor";
import { API_BASE } from "@/lib/api";

export interface ApiConfig {
  exposed?: boolean;
  token?: string | null;
  export_datasets?: string[];
  accept_parameters?: boolean;
}

export function ApiExposurePanel({
  projectFilename,
  api,
  steps,
  onChange,
}: {
  projectFilename: string | null;
  api: ApiConfig;
  steps: Step[];
  onChange: (next: ApiConfig) => void;
}) {
  const dialog = useDialog();

  // Pasos candidatos a exportar: los que tienen output_table.
  const candidates = useMemo(
    () =>
      steps
        .map((s) => ({
          id: s.id,
          output_table: (s as { output_table?: string }).output_table,
        }))
        .filter((s) => s.output_table),
    [steps],
  );

  const slug = projectFilename
    ? projectFilename.replace(/\.json$/, "")
    : "{slug}";
  const runUrl = `${API_BASE}/api/public/projects/${encodeURIComponent(slug)}/run`;

  const exportSet = new Set(api.export_datasets ?? []);

  function set<K extends keyof ApiConfig>(k: K, v: ApiConfig[K]) {
    onChange({ ...api, [k]: v });
  }

  function toggleExport(stepId: string) {
    const next = new Set(exportSet);
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    set("export_datasets", Array.from(next));
  }

  async function generateToken() {
    const buf = new Uint8Array(24);
    crypto.getRandomValues(buf);
    const token = Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    set("token", token);
  }

  async function clearToken() {
    const ok = await dialog.confirm(
      "¿Quitar el token? La API quedará accesible sin autenticación.",
      { variant: "warning", ok: "Quitar token" },
    );
    if (!ok) return;
    set("token", null);
  }

  const curlExample = buildCurlExample(runUrl, api.token, api.accept_parameters);
  const exposed = !!api.exposed;

  return (
    <div className="bg-panel border border-surface rounded-xl p-3 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h4 className="text-xs uppercase tracking-wider text-muted">
          API REST · exponer proyecto
        </h4>
        <label className="text-xs flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={exposed}
            onChange={(e) => set("exposed", e.target.checked)}
          />
          <span>{exposed ? "Expuesto" : "No expuesto"}</span>
        </label>
      </div>

      {!exposed ? (
        <p className="text-xs text-dim">
          Activá "Expuesto" para que este proyecto se pueda disparar via
          <code className="ml-1">POST /api/public/projects/{slug}/run</code>.
        </p>
      ) : (
        <>
          {/* Endpoint URL */}
          <div className="bg-surface-2 border border-surface rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-dim">
              Endpoint
            </div>
            <code className="text-xs font-mono break-all">{runUrl}</code>
          </div>

          {/* Token */}
          <div className="bg-surface-2 border border-surface rounded p-2 space-y-1">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-dim">
                Token de autenticación (opcional)
              </div>
              <div className="flex gap-1">
                <button
                  onClick={generateToken}
                  className="text-[11px] px-2 py-0.5 rounded milhouse-btn-secondary"
                >
                  Generar
                </button>
                {api.token && (
                  <button
                    onClick={clearToken}
                    className="text-[11px] px-2 py-0.5 rounded milhouse-btn-secondary text-red-400"
                  >
                    Quitar
                  </button>
                )}
              </div>
            </div>
            <input
              type="text"
              value={api.token ?? ""}
              onChange={(e) => set("token", e.target.value || null)}
              placeholder="(sin token — endpoint público)"
              className="w-full milhouse-field text-xs font-mono"
            />
            <p className="text-[11px] text-dim">
              {api.token
                ? "Los clientes deben mandar el token en `X-API-Token` o `Authorization: Bearer ...`."
                : "Sin token, cualquiera con acceso de red al endpoint puede dispararlo. Usalo detrás de un proxy autenticado."}
            </p>
          </div>

          {/* Aceptar parámetros */}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={api.accept_parameters !== false}
              onChange={(e) => set("accept_parameters", e.target.checked)}
            />
            <span>Aceptar parámetros en el body del request</span>
          </label>

          {/* Datasets a exportar */}
          <div className="bg-surface-2 border border-surface rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-dim mb-1">
              Datasets a devolver al consumidor cuando termina OK
            </div>
            {candidates.length === 0 ? (
              <p className="text-xs text-dim">
                No hay pasos con <code>output_table</code>.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {candidates.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={exportSet.has(c.id)}
                      onChange={() => toggleExport(c.id)}
                    />
                    <code className="font-mono">{c.id}</code>
                    <span className="text-dim">→ {c.output_table}</span>
                  </label>
                ))}
              </div>
            )}
            {(api.export_datasets ?? []).length === 0 && (
              <p className="text-[11px] text-amber-300 mt-1">
                Sin selección, la API solo devuelve status (sin datos).
              </p>
            )}
          </div>

          {/* Ejemplo curl */}
          <details className="bg-surface-2 border border-surface rounded p-2">
            <summary className="cursor-pointer text-xs text-muted">
              Ver ejemplo de uso (curl)
            </summary>
            <pre className="milhouse-codeblock text-xs whitespace-pre-wrap mt-2">
              {curlExample}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

function buildCurlExample(
  runUrl: string,
  token: string | null | undefined,
  acceptParams: boolean | undefined,
): string {
  const headers: string[] = [];
  headers.push("-H 'Content-Type: application/json'");
  if (token) headers.push(`-H 'X-API-Token: ${token}'`);
  const body =
    acceptParams !== false
      ? `'{"parameters":{"FechaDesde":"2025-12-31","FechaHasta":"2026-05-15"}}'`
      : `'{}'`;
  const pollUrl = runUrl.replace(/\/projects\/[^/]+\/run$/, "/jobs/<JOB_ID>");
  const tokenHeader = token ? ` -H 'X-API-Token: ${token}'` : "";
  return [
    "# 1) Disparar ejecución (responde inmediato con job_id)",
    `curl -X POST ${runUrl} \\`,
    `  ${headers.join(" \\\n  ")} \\`,
    `  -d ${body}`,
    "",
    "# 2) Consultar estado (poll hasta status=ok o failed)",
    `curl ${pollUrl}${tokenHeader}`,
  ].join("\n");
}
