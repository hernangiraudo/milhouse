"use client";

import { useState } from "react";
import { useUser, writeUser } from "@/lib/session";

/**
 * Si no hay usuario en sesión, muestra un overlay de login simple.
 * Si hay, renderiza los `children`.
 */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const user = useUser();
  if (user) return <>{children}</>;
  return <LoginPanel />;
}

function LoginPanel() {
  const [name, setName] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 backdrop-blur-sm">
      <form
        className="bg-surface border border-surface-strong rounded-xl p-6 w-full max-w-sm"
        style={{ boxShadow: "var(--shadow)" }}
        onSubmit={(e) => {
          e.preventDefault();
          const v = name.trim();
          if (v.length > 0) writeUser(v);
        }}
      >
        <h2 className="text-2xl font-bold mb-1">Milhouse</h2>
        <p className="text-muted text-sm mb-5">
          Identificate para auditar tus ejecuciones.
        </p>
        <label className="block text-xs uppercase tracking-wider text-dim mb-1">
          Nombre
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ej. hgiraudo"
          className="w-full bg-surface-2 border border-surface-strong rounded-md px-3 py-2 mb-4 outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={name.trim().length === 0}
          className="w-full bg-accent text-ink font-semibold px-4 py-2 rounded-md disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          Entrar
        </button>
        <p className="text-dim text-xs mt-3 leading-relaxed">
          Sin password — el nombre se guarda en este navegador (localStorage) y
          se adjunta a cada job que ejecutes.
        </p>
      </form>
    </div>
  );
}

/** Botón pequeño para cerrar sesión (limpia localStorage). */
export function UserChip() {
  const user = useUser();
  if (!user) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">
        usuario:{" "}
        <code className="milhouse-chip" style={{ fontSize: "0.7rem" }}>
          {user}
        </code>
      </span>
      <button
        onClick={() => writeUser(null)}
        className="text-xs text-dim hover:text-accent underline-offset-2 hover:underline"
        title="Cerrar sesión"
      >
        salir
      </button>
    </div>
  );
}
