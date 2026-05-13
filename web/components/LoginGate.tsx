"use client";

import { useEffect, useState } from "react";
import { useUser, writeUser } from "@/lib/session";
import { listUsers, type UserDef } from "@/lib/api";

/**
 * Si no hay usuario en sesión, muestra un overlay de login.
 * Si hay, renderiza los `children`.
 */
export function LoginGate({ children }: { children: React.ReactNode }) {
  const user = useUser();
  if (user) return <>{children}</>;
  return <LoginPanel />;
}

const OTHER = "__other__";

function LoginPanel() {
  const [users, setUsers] = useState<UserDef[] | null>(null);
  const [usersErr, setUsersErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [customName, setCustomName] = useState("");

  useEffect(() => {
    listUsers()
      .then((r) => {
        setUsers(r.users);
        if (r.users.length > 0) setSelected(r.users[0].name);
      })
      .catch((e) => {
        setUsersErr(String(e));
        setUsers([]);
        setSelected(OTHER);
      });
  }, []);

  const finalName =
    selected === OTHER ? customName.trim() : selected.trim();
  const canSubmit = finalName.length > 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canSubmit) writeUser(finalName);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 backdrop-blur-sm">
      <form
        onSubmit={onSubmit}
        className="bg-surface border border-surface-strong rounded-xl p-6 w-full max-w-sm"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <h2 className="text-2xl font-bold mb-1">Milhouse</h2>
        <p className="text-muted text-sm mb-5">
          Identificate para auditar tus ejecuciones.
        </p>

        {users === null ? (
          <div className="text-dim text-sm mb-4">Cargando usuarios…</div>
        ) : (
          <>
            <label className="block text-xs uppercase tracking-wider text-dim mb-1">
              Usuario
            </label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full milhouse-field mb-3"
              autoFocus
            >
              {users.length === 0 && usersErr && (
                <option value={OTHER}>(servidor no disponible)</option>
              )}
              {users.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name}
                  {u.role ? ` · ${u.role}` : ""}
                </option>
              ))}
              <option value={OTHER}>+ Otro usuario…</option>
            </select>
            {selected === OTHER && (
              <>
                <label className="block text-xs uppercase tracking-wider text-dim mb-1">
                  Nombre
                </label>
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="ej. jdoe"
                  className="w-full milhouse-field mb-4"
                />
              </>
            )}
            {usersErr && (
              <p className="text-amber-400 text-xs mb-3">
                No pude cargar la lista de usuarios. Continuá con un nombre
                libre.
              </p>
            )}
          </>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full font-semibold px-4 py-2 rounded-md disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          Entrar
        </button>
        <p className="text-dim text-xs mt-3 leading-relaxed">
          Sin password — el nombre se guarda en este navegador (localStorage)
          y se adjunta a cada job que ejecutes.
        </p>
      </form>
    </div>
  );
}

/** Chip pequeño con el usuario actual + botón salir. */
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
