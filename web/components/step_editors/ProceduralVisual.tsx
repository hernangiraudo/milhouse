"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { listRegistryProcedural } from "@/lib/api";
import { useTheme } from "@/lib/useTheme";
import {
  AvailableTable,
  Field,
  InPlaceOrNewTable,
  TableSelect,
} from "./_shared";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface ProceduralStep {
  id: string;
  kind: "procedural";
  input?: string;
  engine?: "rhai" | "rust";
  script?: string | null;
  fn_name?: string | null;
  params?: Record<string, unknown> | null;
  state_init?: Record<string, unknown> | null;
  output_table?: string | null;
  depends_on?: string[];
  [k: string]: unknown;
}

export function ProceduralVisual({
  step,
  available,
  onChange,
}: {
  step: ProceduralStep;
  available: AvailableTable[];
  onChange: (next: ProceduralStep) => void;
}) {
  const theme = useTheme();
  const [registry, setRegistry] = useState<string[]>([]);
  const [paramsText, setParamsText] = useState(() =>
    JSON.stringify(step.params ?? {}, null, 2),
  );
  const [paramsErr, setParamsErr] = useState<string | null>(null);
  const [stateInitText, setStateInitText] = useState(() =>
    JSON.stringify(step.state_init ?? {}, null, 2),
  );
  const [stateInitErr, setStateInitErr] = useState<string | null>(null);

  useEffect(() => {
    listRegistryProcedural().then(setRegistry).catch(() => {});
  }, []);

  function setInput(tbl: string) {
    const stepId = available.find((a) => a.output_table === tbl)?.step_id;
    const deps = new Set<string>();
    if (stepId) deps.add(stepId);
    onChange({ ...step, input: tbl, depends_on: Array.from(deps) });
  }

  function setEngine(eng: "rhai" | "rust") {
    onChange({ ...step, engine: eng });
  }

  function applyParams() {
    try {
      onChange({ ...step, params: JSON.parse(paramsText) });
      setParamsErr(null);
    } catch (e) {
      setParamsErr(String(e));
    }
  }
  function applyStateInit() {
    try {
      onChange({ ...step, state_init: JSON.parse(stateInitText) });
      setStateInitErr(null);
    } catch (e) {
      setStateInitErr(String(e));
    }
  }

  const engine = step.engine ?? "rhai";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Motor">
          <div className="flex gap-1 text-xs">
            <button
              type="button"
              onClick={() => setEngine("rhai")}
              className={`px-3 py-1 rounded border flex-1 ${
                engine === "rhai"
                  ? "bg-accent-token border-transparent"
                  : "bg-surface-2 border-surface-strong"
              }`}
              title="Script Rhai en el JSON (interpretado, flexible)"
            >
              🪄 Rhai
            </button>
            <button
              type="button"
              onClick={() => setEngine("rust")}
              className={`px-3 py-1 rounded border flex-1 ${
                engine === "rust"
                  ? "bg-accent-token border-transparent"
                  : "bg-surface-2 border-surface-strong"
              }`}
              title="Función Rust nativa registrada en el binario (50× más rápido)"
            >
              🦀 Rust
            </button>
          </div>
        </Field>
        <Field label="Tabla input">
          <TableSelect
            value={step.input ?? ""}
            available={available}
            onChange={setInput}
          />
        </Field>
      </div>

      {engine === "rust" ? (
        <>
          <Field label="Función registrada">
            <select
              value={step.fn_name ?? ""}
              onChange={(e) =>
                onChange({ ...step, fn_name: e.target.value || null })
              }
              className="w-full milhouse-field font-mono text-sm"
            >
              <option value="">(elegir)</option>
              {registry.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-dim mt-1">
              Estas funciones están compiladas en el backend. Para agregar
              nuevas, editá <code>src/scripting/rust_registry.rs</code> y
              recompilá.
            </p>
          </Field>
          <Field label="Parámetros (JSON)">
            <textarea
              value={paramsText}
              onChange={(e) => setParamsText(e.target.value)}
              onBlur={applyParams}
              rows={4}
              className="w-full milhouse-codeblock"
              spellCheck={false}
            />
            {paramsErr && (
              <p className="text-red-400 text-xs mt-1">{paramsErr}</p>
            )}
          </Field>
        </>
      ) : (
        <>
          <Field label="Estado inicial (JSON, persiste entre filas)">
            <textarea
              value={stateInitText}
              onChange={(e) => setStateInitText(e.target.value)}
              onBlur={applyStateInit}
              rows={3}
              className="w-full milhouse-codeblock"
              spellCheck={false}
            />
            {stateInitErr && (
              <p className="text-red-400 text-xs mt-1">{stateInitErr}</p>
            )}
          </Field>
          <Field label="Script Rhai">
            <div className="border border-surface rounded-md overflow-hidden">
              <Editor
                height="280px"
                defaultLanguage="rust"
                value={step.script ?? ""}
                onChange={(v) => onChange({ ...step, script: v ?? "" })}
                theme={theme === "light" ? "vs" : "vs-dark"}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  tabSize: 2,
                  wordWrap: "on",
                  automaticLayout: true,
                }}
              />
            </div>
            <p className="text-[11px] text-dim mt-1">
              Acceso a <code>row</code> (Map mutable con los campos de la
              fila) y <code>state</code> (Map persistente entre filas).
              Devolvé <code>row</code> para incluirla en el output. Ejemplo:
              <code> state.flagged += 1; row.score = 0.9; row</code>
            </p>
          </Field>
        </>
      )}

      <InPlaceOrNewTable
        value={step.output_table ?? null}
        inputTable={step.input}
        onChange={(v) => onChange({ ...step, output_table: v })}
        placeholder="ej. tx_scored"
      />
    </div>
  );
}
