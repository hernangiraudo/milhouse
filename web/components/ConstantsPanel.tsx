"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "@/lib/api";
import { useDialog } from "./Dialog";

type ConstantKind = "number" | "text" | "raw_sql";

const KIND_LABEL: Record<ConstantKind, string> = {
  number: "número",
  text: "texto",
  raw_sql: "SQL crudo",
};
const KIND_PLACEHOLDER: Record<ConstantKind, string> = {
  number: "0",
  text: "texto",
  raw_sql: "(columna = 3004)",
};
const KIND_HINT: Record<ConstantKind, string> = {
  number: "se sustituye sin quotes",
  text: "se sustituye con quotes simples (y escape de ')",
  raw_sql: "se sustituye tal cual — útil para filtros y predicados",
};

interface ConstantSpec {
  name: string;
  group?: string | null;
  kind: ConstantKind;
  value: string;
  description?: string | null;
}

interface ConstantGroup {
  name: string;
  description?: string | null;
}

interface ConstantsFile {
  groups: ConstantGroup[];
  constants: ConstantSpec[];
}

/**
 * Editor de constantes globales (compartidas entre todos los proyectos).
 * Se referencian en SQL/expresiones como `:Grupo.Nombre` (o `:Nombre`
 * si la constante no tiene grupo).
 */
export function ConstantsPanel() {
  const dialog = useDialog();
  const [data, setData] = useState<ConstantsFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savingMsg, setSavingMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // Grupos colapsados visualmente.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const r = await fetch(`${API_BASE}/api/constants`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as Partial<ConstantsFile>;
      setData({
        groups: j.groups ?? [],
        constants: j.constants ?? [],
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
      const r = await fetch(`${API_BASE}/api/constants`, {
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

  function update(next: ConstantsFile) {
    setData(next);
    setDirty(true);
  }

  function addConstant(group?: string) {
    if (!data) return;
    const existing = new Set(
      data.constants
        .filter((c) => (c.group ?? null) === (group ?? null))
        .map((c) => c.name.toLowerCase()),
    );
    let base = "NuevaConstante";
    let name = base;
    let n = 2;
    while (existing.has(name.toLowerCase())) {
      name = `${base}${n}`;
      n += 1;
    }
    update({
      ...data,
      constants: [
        ...data.constants,
        {
          name,
          group: group ?? null,
          kind: "number",
          value: "0",
        },
      ],
    });
  }

  async function addGroup() {
    if (!data) return;
    const name = await dialog.prompt("Nombre del grupo:", {
      title: "Nuevo grupo de constantes",
      placeholder: "ej. MovimientoTipoCuenta",
      validate: (v) => {
        const t = v.trim();
        if (!t) return "obligatorio";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
          return "solo letras, dígitos y _ (sin espacios ni puntos)";
        }
        if (data.groups.some((g) => g.name === t)) {
          return "ya existe un grupo con ese nombre";
        }
        return null;
      },
    });
    if (!name?.trim()) return;
    update({
      ...data,
      groups: [...data.groups, { name: name.trim() }],
    });
  }

  async function renameGroup(oldName: string) {
    if (!data) return;
    const next = await dialog.prompt(`Nuevo nombre para "${oldName}":`, {
      title: "Renombrar grupo",
      defaultValue: oldName,
      validate: (v) => {
        const t = v.trim();
        if (!t) return "obligatorio";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
          return "solo letras, dígitos y _";
        }
        if (t !== oldName && data.groups.some((g) => g.name === t)) {
          return "ya existe un grupo con ese nombre";
        }
        return null;
      },
    });
    if (!next?.trim() || next === oldName) return;
    update({
      ...data,
      groups: data.groups.map((g) =>
        g.name === oldName ? { ...g, name: next.trim() } : g,
      ),
      constants: data.constants.map((c) =>
        c.group === oldName ? { ...c, group: next.trim() } : c,
      ),
    });
  }

  async function deleteGroup(name: string) {
    if (!data) return;
    const inUse = data.constants.filter((c) => c.group === name);
    const ok = await dialog.confirm(
      inUse.length === 0
        ? `¿Eliminar el grupo "${name}"?`
        : `El grupo "${name}" tiene ${inUse.length} constante(s). Eliminar el grupo deja a esas constantes sin grupo (referenciables como :Nombre).`,
      { title: "Eliminar grupo", variant: "warning", ok: "Eliminar" },
    );
    if (!ok) return;
    update({
      ...data,
      groups: data.groups.filter((g) => g.name !== name),
      constants: data.constants.map((c) =>
        c.group === name ? { ...c, group: null } : c,
      ),
    });
  }

  function updateConstant(idx: number, next: ConstantSpec) {
    if (!data) return;
    const arr = [...data.constants];
    arr[idx] = next;
    update({ ...data, constants: arr });
  }

  function deleteConstant(idx: number) {
    if (!data) return;
    update({
      ...data,
      constants: data.constants.filter((_, i) => i !== idx),
    });
  }

  function toggleGroup(name: string) {
    const next = new Set(collapsed);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setCollapsed(next);
  }

  // Agrupar para render. Bucket "" = sin grupo.
  const grouped = useMemo(() => {
    if (!data) return null;
    const byGroup: Record<string, { idx: number; c: ConstantSpec }[]> = {};
    data.constants.forEach((c, idx) => {
      const key = c.group ?? "";
      if (!byGroup[key]) byGroup[key] = [];
      byGroup[key].push({ idx, c });
    });
    return byGroup;
  }, [data]);

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold text-lg">Constantes globales</h2>
          <p className="text-sm text-muted">
            Códigos canónicos compartidos entre todos los proyectos. Se
            referencian en SQL como <code className="milhouse-chip">:Grupo.Nombre</code>
            {" "}o <code className="milhouse-chip">:Nombre</code> si no tienen
            grupo. Tipos: <code className="milhouse-chip">número</code> (sin
            quotes), <code className="milhouse-chip">texto</code> (con quotes)
            y <code className="milhouse-chip">SQL crudo</code> (para filtros
            o predicados reutilizables, ej.{" "}
            <code className="milhouse-chip">(GrupoID = 3004)</code>). Si un
            parámetro de proyecto se llama igual, el parámetro gana.
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
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </header>

      {err && <div className="text-red-400 text-sm whitespace-pre-wrap">{err}</div>}

      {data == null ? (
        <div className="text-dim text-sm">Cargando…</div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button
              onClick={addGroup}
              className="text-xs px-3 py-1 rounded border border-surface-strong bg-surface-2"
            >
              + Nuevo grupo
            </button>
            <button
              onClick={() => addConstant()}
              className="text-xs px-3 py-1 rounded border border-surface-strong bg-surface-2"
            >
              + Constante sin grupo
            </button>
          </div>

          {/* Grupos declarados (incluye los vacíos para que se vean) */}
          {data.groups.map((g) => (
            <GroupSection
              key={g.name}
              groupName={g.name}
              items={grouped?.[g.name] ?? []}
              collapsed={collapsed.has(g.name)}
              onToggle={() => toggleGroup(g.name)}
              onAdd={() => addConstant(g.name)}
              onRename={() => renameGroup(g.name)}
              onDelete={() => deleteGroup(g.name)}
              onUpdate={updateConstant}
              onDeleteConstant={deleteConstant}
              availableGroups={data.groups.map((x) => x.name)}
            />
          ))}

          {/* Constantes sin grupo (si hay alguna) */}
          {grouped?.[""] && grouped[""].length > 0 && (
            <GroupSection
              groupName=""
              items={grouped[""]}
              collapsed={collapsed.has("")}
              onToggle={() => toggleGroup("")}
              onAdd={() => addConstant()}
              onUpdate={updateConstant}
              onDeleteConstant={deleteConstant}
              availableGroups={data.groups.map((x) => x.name)}
            />
          )}

          {data.constants.length === 0 && data.groups.length === 0 && (
            <div className="text-sm text-dim bg-surface-2 border border-surface rounded-xl p-6 text-center">
              No hay constantes ni grupos. Empezá con "+ Nuevo grupo" o
              "+ Constante sin grupo".
            </div>
          )}
        </>
      )}
    </section>
  );
}

function GroupSection({
  groupName,
  items,
  collapsed,
  onToggle,
  onAdd,
  onRename,
  onDelete,
  onUpdate,
  onDeleteConstant,
  availableGroups,
}: {
  groupName: string;
  items: { idx: number; c: ConstantSpec }[];
  collapsed: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onUpdate: (idx: number, next: ConstantSpec) => void;
  onDeleteConstant: (idx: number) => void;
  availableGroups: string[];
}) {
  const label = groupName === "" ? "(sin grupo)" : groupName;
  return (
    <div className="bg-panel border border-surface rounded-xl">
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface">
        <button
          onClick={onToggle}
          className="flex items-center gap-2 text-left flex-1"
        >
          <span className="text-dim">{collapsed ? "▸" : "▾"}</span>
          <code className="font-mono font-semibold">{label}</code>
          <span className="text-[11px] text-dim">
            · {items.length} constante{items.length === 1 ? "" : "s"}
          </span>
        </button>
        <div className="flex items-center gap-1 text-xs">
          <button
            onClick={onAdd}
            className="px-2 py-0.5 rounded border border-surface-strong bg-surface-2"
            title={
              groupName === ""
                ? "Agregar constante sin grupo"
                : `Agregar constante en grupo "${groupName}"`
            }
          >
            +
          </button>
          {onRename && (
            <button
              onClick={onRename}
              className="px-2 py-0.5 rounded border border-surface-strong bg-surface-2"
              title="Renombrar grupo"
            >
              ✎
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="px-2 py-0.5 rounded border border-red-700 bg-red-500/10 text-red-300"
              title="Eliminar grupo"
            >
              🗑
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="p-3 space-y-2">
          {items.length === 0 ? (
            <div className="text-xs text-dim">
              Sin constantes en este grupo. Click "+" para agregar.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-2 py-1 font-medium">Nombre</th>
                  <th className="text-left px-2 py-1 font-medium">Tipo</th>
                  <th className="text-left px-2 py-1 font-medium">Valor</th>
                  <th className="text-left px-2 py-1 font-medium">Descripción</th>
                  <th className="text-left px-2 py-1 font-medium">
                    Referencia
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map(({ idx, c }) => {
                  const ref =
                    (c.group ? `${c.group}.` : "") + (c.name || "(sin nombre)");
                  return (
                    <tr key={idx} className="border-t border-surface">
                      <td className="px-2 py-1">
                        <input
                          value={c.name}
                          onChange={(e) =>
                            onUpdate(idx, { ...c, name: e.target.value })
                          }
                          className="w-full milhouse-field font-mono text-xs"
                          placeholder="Nombre"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <select
                          value={c.kind}
                          onChange={(e) =>
                            onUpdate(idx, {
                              ...c,
                              kind: e.target.value as ConstantKind,
                            })
                          }
                          className="milhouse-field text-xs"
                          title={KIND_HINT[c.kind]}
                        >
                          <option value="number">{KIND_LABEL.number}</option>
                          <option value="text">{KIND_LABEL.text}</option>
                          <option value="raw_sql">{KIND_LABEL.raw_sql}</option>
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          value={c.value}
                          onChange={(e) =>
                            onUpdate(idx, { ...c, value: e.target.value })
                          }
                          className={`w-full milhouse-field text-xs ${
                            c.kind === "raw_sql" ? "" : "font-mono"
                          }`}
                          placeholder={KIND_PLACEHOLDER[c.kind]}
                          title={KIND_HINT[c.kind]}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          value={c.description ?? ""}
                          onChange={(e) =>
                            onUpdate(idx, {
                              ...c,
                              description: e.target.value || null,
                            })
                          }
                          className="w-full milhouse-field text-xs"
                          placeholder="opcional"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1">
                          <code className="text-[11px] text-dim font-mono">
                            :{ref}
                          </code>
                          {/* Mover a otro grupo */}
                          <select
                            value={c.group ?? ""}
                            onChange={(e) =>
                              onUpdate(idx, {
                                ...c,
                                group: e.target.value || null,
                              })
                            }
                            className="milhouse-field text-[10px] py-0 px-1"
                            title="Mover a otro grupo"
                          >
                            <option value="">(sin grupo)</option>
                            {availableGroups.map((g) => (
                              <option key={g} value={g}>
                                {g}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          onClick={() => onDeleteConstant(idx)}
                          className="text-red-400 hover:text-red-200 text-xs"
                          title="Eliminar constante"
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
