"use client";

import { useEffect, useState } from "react";
import { aiAvailable, aiBuildStep, listConnections } from "@/lib/api";

interface Props {
  /** Steps ids existentes (para que el AI los use en depends_on). */
  existingStepIds: string[];
  /** Mapa stepId → output_table. */
  existingTables: Record<string, string>;
  onClose: () => void;
  onApply: (step: Record<string, unknown>) => void;
}

export function MilhouseAIDialog({
  existingStepIds,
  existingTables,
  onClose,
  onApply,
}: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<
    Array<{ name: string; type: string }>
  >([]);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    step: Record<string, unknown>;
    raw: string;
  } | null>(null);

  useEffect(() => {
    aiAvailable().then(setAvailable);
    listConnections()
      .then((r) =>
        setConnections(
          r.connections
            .filter((c) => c.implemented)
            .map((c) => ({ name: c.name, type: c.type })),
        ),
      )
      .catch(() => {});
  }, []);

  async function submit() {
    if (!description.trim()) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await aiBuildStep({
        description: description.trim(),
        existing_step_ids: existingStepIds,
        existing_tables: existingTables,
        connections,
      });
      setResult(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-surface-strong rounded-xl p-6 w-full max-w-3xl max-h-[90vh] overflow-auto space-y-3"
        style={{ boxShadow: "var(--shadow)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold flex items-center gap-2">
          ✨ Milhouse-AI
          <span className="text-xs font-normal text-dim">
            usa Claude para construir un paso a partir de una descripción
          </span>
        </h3>

        {available === false && (
          <div className="milhouse-alert-warn text-sm rounded p-3 space-y-2">
            <div className="font-semibold flex items-center gap-2">
              <span>⚠</span>
              <span>
                <code className="font-mono">ANTHROPIC_API_KEY</code> no está
                configurada en el server
              </span>
            </div>
            <p className="text-xs leading-relaxed">
              Milhouse-AI usa la API de Anthropic (Claude) para generar el
              paso. Para habilitarlo:
            </p>
            <ol className="text-xs leading-relaxed list-decimal ml-5 space-y-1">
              <li>
                Conseguí una API key en{" "}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="underline font-semibold"
                >
                  console.anthropic.com/settings/keys
                </a>{" "}
                (creá una cuenta si no tenés, hay free credits para empezar).
              </li>
              <li>
                <strong>Forma recomendada:</strong> copiá{" "}
                <code className="font-mono">.env.example</code> a{" "}
                <code className="font-mono">.env</code> en la raiz del repo
                y descomentá la línea de{" "}
                <code className="font-mono">ANTHROPIC_API_KEY</code>:
                <div className="mt-1 milhouse-codeblock text-[11px] px-2 py-1.5 rounded">
                  <div>ANTHROPIC_API_KEY=sk-ant-...</div>
                </div>
                El archivo <code className="font-mono">.env</code> está
                ignorado por git, así que tu key no se sube al repo.
              </li>
              <li>
                Alternativa: setear la variable de entorno a mano antes de
                arrancar el backend:
                <div className="mt-1 milhouse-codeblock text-[11px] px-2 py-1.5 rounded">
                  <div># PowerShell</div>
                  <div>
                    <span className="text-dim">$env:</span>
                    ANTHROPIC_API_KEY = <span>"sk-ant-..."</span>
                  </div>
                  <div className="mt-1"># Mac/Linux/git bash</div>
                  <div>
                    export ANTHROPIC_API_KEY=<span>"sk-ant-..."</span>
                  </div>
                </div>
              </li>
              <li>
                Reiniciá el backend (<code className="font-mono">cargo run</code>{" "}
                o <code className="font-mono">scripts/start</code>) para
                que tome la key nueva.
              </li>
            </ol>
          </div>
        )}

        <Field label="Descripción en lenguaje natural">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder='ej. "filtra las transacciones de tx_typed con amount mayor a 5000 y dejame solo tx_id, account_id y amount"'
            className="w-full milhouse-field"
          />
        </Field>

        <div className="text-[11px] text-dim">
          Contexto enviado al AI:{" "}
          {existingStepIds.length === 0
            ? "sin pasos previos"
            : `${existingStepIds.length} step(s) previos`}{" "}
          · {connections.length} conexión(es) disponible(s).
        </div>

        {err && (
          <div className="text-red-400 text-sm bg-red-500/10 border border-red-700 rounded p-2 whitespace-pre-wrap">
            {err}
          </div>
        )}

        {result && (
          <div className="bg-surface-2 border border-surface rounded p-3">
            <h5 className="text-xs uppercase tracking-wider text-muted mb-2">
              Step generado
            </h5>
            <pre className="milhouse-codeblock text-xs">
              {JSON.stringify(result.step, null, 2)}
            </pre>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2 border-t border-surface">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-2 rounded milhouse-btn-secondary"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !description.trim() || available === false}
            className="text-sm px-3 py-2 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 disabled:opacity-40"
          >
            {busy ? "Generando…" : result ? "Re-generar" : "Generar"}
          </button>
          {result && (
            <button
              type="button"
              onClick={() => onApply(result.step)}
              className="text-sm px-3 py-2 rounded font-semibold"
              style={{
                background: "var(--accent)",
                color: "var(--accent-ink)",
              }}
            >
              Aplicar
            </button>
          )}
        </div>
      </div>
    </div>
  );
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
