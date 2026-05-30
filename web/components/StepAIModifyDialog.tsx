"use client";

import { useEffect, useState } from "react";
import { aiAvailable, aiModifyStep, listConnections } from "@/lib/api";

interface Props {
  currentStep: Record<string, unknown>;
  /** Error del último run de este paso, si falló. */
  lastError?: string | null;
  existingStepIds: string[];
  existingTables: Record<string, string>;
  onClose: () => void;
  onApply: (step: Record<string, unknown>) => void;
}

export function StepAIModifyDialog({
  currentStep,
  lastError,
  existingStepIds,
  existingTables,
  onClose,
  onApply,
}: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<
    Array<{ name: string; type: string }>
  >([]);
  const [instruction, setInstruction] = useState(() => {
    if (lastError) {
      return `El paso falló con este error:\n${lastError}\n\nAnalizá la causa y corregí el paso.`;
    }
    return "";
  });
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

  // Esc cierra.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!instruction.trim()) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await aiModifyStep({
        current_step: currentStep,
        instruction: instruction.trim(),
        last_error: lastError ?? null,
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

  const stepId = (currentStep.id as string) ?? "paso";
  const stepKind = (currentStep.kind as string) ?? "";

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
        <h3 className="text-lg font-bold flex items-center gap-2 text-app">
          ✨ Milhouse-AI · Modificar paso
          <code className="text-xs font-normal px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-700">
            {stepKind}
          </code>
          <code className="text-xs font-normal font-mono text-muted">
            {stepId}
          </code>
        </h3>

        {available === false && (
          <div className="milhouse-alert-warn text-sm rounded p-3">
            <span className="font-semibold">⚠ </span>
            <code className="font-mono">ANTHROPIC_API_KEY</code> no está
            configurada en el server.
          </div>
        )}

        {lastError && (
          <div className="bg-red-500/10 border border-red-700 rounded p-3 space-y-1">
            <div className="text-xs font-semibold text-red-400 flex items-center gap-1">
              <span>✗</span> El paso falló en el último run
            </div>
            <pre className="text-xs text-red-300 whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {lastError}
            </pre>
          </div>
        )}

        <div>
          <span className="text-[11px] uppercase tracking-wider text-dim block mb-1">
            Instrucción para el AI
          </span>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={5}
            placeholder={
              lastError
                ? "Describí qué querés cambiar (o dejá el error para que el AI lo corrija solo)"
                : 'ej. "Agregá un filtro WHERE status = \'activo\'" o "Renombrá la columna monto a importe"'
            }
            className="w-full milhouse-field"
            autoFocus
          />
        </div>

        <details className="text-xs text-dim">
          <summary className="cursor-pointer select-none hover:text-app">
            Ver paso actual (JSON)
          </summary>
          <pre className="milhouse-codeblock text-xs mt-2 max-h-48 overflow-auto">
            {JSON.stringify(currentStep, null, 2)}
          </pre>
        </details>

        {err && (
          <div className="text-red-400 text-sm bg-red-500/10 border border-red-700 rounded p-2 whitespace-pre-wrap">
            {err}
          </div>
        )}

        {result && (
          <div className="bg-surface-2 border border-surface rounded p-3 space-y-2">
            <h5 className="text-xs uppercase tracking-wider text-muted">
              Paso modificado
            </h5>
            <pre className="milhouse-codeblock text-xs max-h-64 overflow-auto">
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
            disabled={busy || !instruction.trim() || available === false}
            className="text-sm px-3 py-2 rounded border border-emerald-700 bg-emerald-500/20 text-emerald-300 disabled:opacity-40"
          >
            {busy ? "Generando…" : result ? "Re-generar" : "Generar cambios"}
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
