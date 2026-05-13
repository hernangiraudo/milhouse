"use client";

import { useEffect, useState } from "react";
import {
  createUser,
  deleteUser,
  listUsers,
  type UserDef,
} from "@/lib/api";

export function UsersPanel() {
  const [users, setUsers] = useState<UserDef[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("");

  async function load() {
    try {
      const r = await listUsers();
      setUsers(r.users);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createUser({
        name: newName.trim(),
        email: newEmail.trim() || null,
        role: newRole.trim() || null,
      });
      setNewName("");
      setNewEmail("");
      setNewRole("");
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(name: string) {
    if (!confirm(`¿Eliminar usuario "${name}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteUser(name);
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-panel rounded-xl border border-slate-800 p-6 space-y-4">
      <header>
        <h2 className="font-semibold text-lg">Usuarios</h2>
        <p className="text-sm text-muted">
          Lista de usuarios autorizados. Cada job se registra con uno de estos
          nombres.{" "}
          <code className="text-xs text-dim">configs/users.json</code>
        </p>
      </header>

      <form
        onSubmit={onAdd}
        className="grid grid-cols-[1fr_1fr_120px_auto] gap-2 items-end"
      >
        <Input
          label="Nombre"
          value={newName}
          onChange={setNewName}
          placeholder="ej. jdoe"
        />
        <Input
          label="Email"
          value={newEmail}
          onChange={setNewEmail}
          placeholder="opcional"
        />
        <Input
          label="Rol"
          value={newRole}
          onChange={setNewRole}
          placeholder="opcional"
        />
        <button
          type="submit"
          disabled={busy || !newName.trim()}
          className="bg-accent text-ink font-semibold px-3 py-2 rounded-md disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          + Agregar
        </button>
      </form>

      {err && <div className="text-red-400 text-sm">{err}</div>}

      <div className="bg-surface-2 border border-surface rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-muted">
            <tr>
              <th className="text-left px-3 py-2">Nombre</th>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Rol</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-dim text-center">
                  Sin usuarios definidos.
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.name} className="border-t border-surface">
                <td className="px-3 py-2 font-mono">{u.name}</td>
                <td className="px-3 py-2">{u.email ?? "—"}</td>
                <td className="px-3 py-2">{u.role ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onDelete(u.name)}
                    disabled={busy}
                    className="text-xs text-red-400 hover:underline"
                  >
                    eliminar
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

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wider text-dim mb-1">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="milhouse-field"
      />
    </label>
  );
}
