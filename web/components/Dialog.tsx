"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

// =====================================================================
// Sistema de diálogos temáticos para reemplazar window.alert/confirm/prompt.
// Respeta tokens CSS (bg-surface, border-surface, etc.) — se ve igual en
// tema claro y oscuro.
// =====================================================================

type Variant = "info" | "warning" | "danger";

export interface ChoiceOption<V extends string = string> {
  /** Valor que resuelve la promesa cuando se elige esta opción. */
  value: V;
  label: string;
  /** Estilo visual del botón. `primary` = botón resaltado (color accent),
   *  `secondary` = botón neutro, `danger` = botón rojo. Default secondary. */
  variant?: "primary" | "secondary" | "danger";
}

type DialogSpec =
  | { kind: "alert"; title?: string; message: string; variant?: Variant; ok?: string }
  | {
      kind: "confirm";
      title?: string;
      message: string;
      variant?: Variant;
      ok?: string;
      cancel?: string;
    }
  | {
      kind: "prompt";
      title?: string;
      message: string;
      variant?: Variant;
      placeholder?: string;
      defaultValue?: string;
      ok?: string;
      cancel?: string;
      validate?: (v: string) => string | null;
    }
  | {
      kind: "choose";
      title?: string;
      message: string;
      variant?: Variant;
      options: ChoiceOption[];
    };

type DialogResolver = (result: unknown) => void;

interface DialogContextShape {
  alert: (
    msg: string,
    opts?: { title?: string; variant?: Variant; ok?: string },
  ) => Promise<void>;
  confirm: (
    msg: string,
    opts?: {
      title?: string;
      variant?: Variant;
      ok?: string;
      cancel?: string;
    },
  ) => Promise<boolean>;
  prompt: (
    msg: string,
    opts?: {
      title?: string;
      variant?: Variant;
      defaultValue?: string;
      placeholder?: string;
      ok?: string;
      cancel?: string;
      validate?: (v: string) => string | null;
    },
  ) => Promise<string | null>;
  /** Diálogo con N opciones explícitas. Resuelve con el `value` de la
   *  opción elegida, o `null` si el usuario cierra (Esc / click afuera). */
  choose: <V extends string>(
    msg: string,
    options: ChoiceOption<V>[],
    opts?: { title?: string; variant?: Variant },
  ) => Promise<V | null>;
}

const DialogContext = createContext<DialogContextShape | null>(null);

export function useDialog(): DialogContextShape {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    // Fallback: si alguien lo usa fuera del provider, degrada a los nativos
    // (para no romper la app, aunque visualmente queden mal).
    return {
      alert: async (m) => {
        window.alert(m);
      },
      confirm: async (m) => window.confirm(m),
      prompt: async (m, opts) => window.prompt(m, opts?.defaultValue ?? "") ?? null,
      choose: async (m, options) => {
        const labels = options.map((o, i) => `${i + 1}) ${o.label}`).join("\n");
        const raw = window.prompt(`${m}\n\n${labels}\n\nIngresá el número:`);
        const n = raw ? parseInt(raw, 10) - 1 : -1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (options[n]?.value ?? null) as any;
      },
    };
  }
  return ctx;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [spec, setSpec] = useState<DialogSpec | null>(null);
  const [resolver, setResolver] = useState<DialogResolver | null>(null);

  const show = useCallback(<T,>(s: DialogSpec): Promise<T> => {
    return new Promise<T>((resolve) => {
      setSpec(s);
      setResolver(() => (v: unknown) => resolve(v as T));
    });
  }, []);

  const api: DialogContextShape = {
    alert: (message, opts) =>
      show<void>({
        kind: "alert",
        message,
        title: opts?.title,
        variant: opts?.variant,
        ok: opts?.ok,
      }),
    confirm: (message, opts) =>
      show<boolean>({
        kind: "confirm",
        message,
        title: opts?.title,
        variant: opts?.variant,
        ok: opts?.ok,
        cancel: opts?.cancel,
      }),
    prompt: (message, opts) =>
      show<string | null>({
        kind: "prompt",
        message,
        title: opts?.title,
        variant: opts?.variant,
        defaultValue: opts?.defaultValue,
        placeholder: opts?.placeholder,
        ok: opts?.ok,
        cancel: opts?.cancel,
        validate: opts?.validate,
      }),
    choose: <V extends string>(
      message: string,
      options: ChoiceOption<V>[],
      opts?: { title?: string; variant?: Variant },
    ) =>
      show<V | null>({
        kind: "choose",
        message,
        title: opts?.title,
        variant: opts?.variant,
        options: options as ChoiceOption[],
      }),
  };

  function finish(result: unknown) {
    resolver?.(result);
    setSpec(null);
    setResolver(null);
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {spec && <DialogRenderer spec={spec} onFinish={finish} />}
    </DialogContext.Provider>
  );
}

function DialogRenderer({
  spec,
  onFinish,
}: {
  spec: DialogSpec;
  onFinish: (result: unknown) => void;
}) {
  const [value, setValue] = useState<string>(
    spec.kind === "prompt" ? spec.defaultValue ?? "" : "",
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        if (spec.kind === "prompt") {
          // En prompt el Enter de un textarea inserta línea; solo en input
          const tag = (e.target as HTMLElement | null)?.tagName;
          if (tag === "TEXTAREA") return;
        }
        e.preventDefault();
        ok();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, value]);

  function cancel() {
    if (spec.kind === "alert") onFinish(undefined);
    else if (spec.kind === "confirm") onFinish(false);
    else onFinish(null);
  }
  function ok() {
    if (spec.kind === "alert") return onFinish(undefined);
    if (spec.kind === "confirm") return onFinish(true);
    if (spec.kind === "choose") return; // choose se confirma desde cada botón
    // prompt
    const err = spec.validate?.(value) ?? null;
    if (err) {
      setErr(err);
      return;
    }
    onFinish(value);
  }

  const variant: Variant = spec.variant ?? (spec.kind === "alert" ? "info" : "warning");
  const accent =
    variant === "danger"
      ? { bg: "rgb(220 38 38)", ink: "#ffffff", icon: "⚠", border: "rgb(220 38 38)" }
      : variant === "warning"
      ? { bg: "var(--accent)", ink: "var(--accent-ink)", icon: "⚠", border: "rgb(217 119 6)" }
      : { bg: "var(--accent)", ink: "var(--accent-ink)", icon: "ℹ", border: "rgb(14 116 144)" };

  const defaultTitle =
    spec.title ??
    (spec.kind === "alert"
      ? variant === "danger"
        ? "Error"
        : "Aviso"
      : spec.kind === "confirm"
      ? "Confirmar"
      : spec.kind === "choose"
      ? "Elegir una opción"
      : "Entrada");

  const defaultOk =
    spec.kind === "alert"
      ? "OK"
      : spec.kind === "confirm"
      ? variant === "danger"
        ? "Eliminar"
        : "Aceptar"
      : "Aceptar";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(2px)",
      }}
      onClick={cancel}
    >
      <div
        className="bg-surface border border-surface-strong rounded-xl p-5 w-full max-w-md"
        style={{ boxShadow: "var(--shadow, 0 10px 40px rgba(0,0,0,0.4))" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3">
          <span
            className="flex-none w-8 h-8 rounded-full flex items-center justify-center text-base font-bold"
            style={{
              background: accent.bg,
              color: accent.ink,
            }}
          >
            {accent.icon}
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-base leading-tight">{defaultTitle}</h3>
            <p className="text-sm text-muted mt-1 whitespace-pre-wrap break-words">
              {spec.message}
            </p>
          </div>
        </div>

        {spec.kind === "prompt" && (
          <div className="mt-3">
            <input
              autoFocus
              type="text"
              value={value}
              placeholder={spec.placeholder}
              onChange={(e) => {
                setValue(e.target.value);
                if (err) setErr(null);
              }}
              className="w-full milhouse-field"
            />
            {err && <div className="text-xs text-red-400 mt-1">{err}</div>}
          </div>
        )}

        <div className="flex gap-2 justify-end mt-4 flex-wrap">
          {spec.kind === "choose" ? (
            <>
              <button
                onClick={cancel}
                className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary"
              >
                Cancelar
              </button>
              {spec.options.map((opt) => {
                const v = opt.variant ?? "secondary";
                if (v === "primary") {
                  return (
                    <button
                      key={opt.value}
                      onClick={() => onFinish(opt.value)}
                      className="text-sm font-semibold px-3 py-1.5 rounded"
                      style={{
                        background: accent.bg,
                        color: accent.ink,
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                }
                if (v === "danger") {
                  return (
                    <button
                      key={opt.value}
                      onClick={() => onFinish(opt.value)}
                      className="text-sm font-semibold px-3 py-1.5 rounded text-white"
                      style={{ background: "rgb(220 38 38)" }}
                    >
                      {opt.label}
                    </button>
                  );
                }
                return (
                  <button
                    key={opt.value}
                    onClick={() => onFinish(opt.value)}
                    className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary"
                  >
                    {opt.label}
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {spec.kind !== "alert" && (
                <button
                  onClick={cancel}
                  className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary"
                >
                  {("cancel" in spec && spec.cancel) || "Cancelar"}
                </button>
              )}
              <button
                autoFocus={spec.kind !== "prompt"}
                onClick={ok}
                className="text-sm font-semibold px-3 py-1.5 rounded"
                style={{
                  background: accent.bg,
                  color: accent.ink,
                }}
              >
                {("ok" in spec && spec.ok) || defaultOk}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
