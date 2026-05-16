"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TableInfo } from "@/lib/api";

interface Props {
  tables: TableInfo[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Combobox de tablas: el usuario tipea y se filtran las coincidencias en vivo.
 * Match case-insensitive contra `schema.name` (substring). Navegación con
 * flechas, Enter para elegir, Escape para cerrar. Si el valor escrito no
 * coincide exactamente con ninguna tabla, igualmente se guarda como string
 * libre — útil para tablas que no aparecen en el listado (vistas dinámicas,
 * permisos, etc.).
 */
export function TableCombobox({
  tables,
  value,
  onChange,
  disabled,
  placeholder,
}: Props) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Sincronizar cuando el valor externo cambia (ej. cambio de conexión).
  useEffect(() => {
    setText(value);
  }, [value]);

  // Cerrar al clickear afuera.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const all = tables.map((t) => ({
      t,
      qt: qualifiedTable(t),
    }));
    if (!q) return all.slice(0, 200);
    const scored: { t: TableInfo; qt: string; score: number }[] = [];
    for (const { t, qt } of all) {
      const lower = qt.toLowerCase();
      const nameLower = t.name.toLowerCase();
      let score = -1;
      if (lower === q) score = 0;
      else if (nameLower === q) score = 1;
      else if (lower.startsWith(q)) score = 2;
      else if (nameLower.startsWith(q)) score = 3;
      else if (lower.includes(q)) score = 4;
      if (score >= 0) scored.push({ t, qt, score });
    }
    scored.sort((a, b) => a.score - b.score || a.qt.localeCompare(b.qt));
    return scored.slice(0, 200);
  }, [tables, text]);

  useEffect(() => {
    if (hover >= matches.length) setHover(0);
  }, [matches, hover]);

  function commit(next: string) {
    setText(next);
    onChange(next);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHover((h) => Math.min(h + 1, matches.length - 1));
      scrollHoverIntoView(listRef, hover + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((h) => Math.max(h - 1, 0));
      scrollHoverIntoView(listRef, hover - 1);
    } else if (e.key === "Enter") {
      if (open && matches[hover]) {
        e.preventDefault();
        commit(matches[hover].qt);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setHover(0);
          // Si limpia el campo, también limpiamos el valor en el step.
          if (e.target.value === "") onChange("");
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Damos margen para que el click sobre la lista se procese.
          setTimeout(() => {
            // Si el texto difiere del value, igual lo persistimos como string libre.
            if (text !== value) onChange(text);
          }, 120);
        }}
        onKeyDown={onKey}
        disabled={disabled}
        placeholder={placeholder ?? "tipeá para buscar tabla"}
        className="w-full milhouse-field font-mono text-sm"
        spellCheck={false}
        autoComplete="off"
      />
      {open && !disabled && matches.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-auto rounded-md border shadow-lg"
          style={{
            background: "var(--panel-2)",
            borderColor: "var(--border)",
          }}
        >
          {matches.map((m, i) => {
            const active = i === hover;
            return (
              <li
                key={m.qt + "|" + (m.t.kind ?? "table")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(m.qt);
                }}
                onMouseEnter={() => setHover(i)}
                className="px-3 py-1.5 cursor-pointer text-xs flex items-center gap-2"
                style={{
                  background: active ? "var(--accent-soft, rgba(56,189,248,0.18))" : "transparent",
                  color: "var(--text)",
                }}
              >
                <code className="font-mono">
                  {highlight(m.qt, text)}
                </code>
                {m.t.kind === "view" && (
                  <span className="text-[10px] text-dim ml-auto">view</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && !disabled && matches.length === 0 && text.trim() && (
        <div
          className="absolute z-30 left-0 right-0 mt-1 rounded-md border px-3 py-2 text-xs text-dim"
          style={{
            background: "var(--panel-2)",
            borderColor: "var(--border)",
          }}
        >
          Sin coincidencias. <span className="text-app">Enter</span> para usar
          “<code className="font-mono">{text}</code>” igual.
        </div>
      )}
    </div>
  );
}

function qualifiedTable(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

function scrollHoverIntoView(
  ref: React.RefObject<HTMLUListElement>,
  idx: number,
) {
  const ul = ref.current;
  if (!ul) return;
  const li = ul.children[idx] as HTMLElement | undefined;
  if (li) li.scrollIntoView({ block: "nearest" });
}

/**
 * Resalta en negrita la subcadena que matchea `q` dentro de `s`,
 * case-insensitive.
 */
function highlight(s: string, q: string): React.ReactNode {
  const qq = q.trim();
  if (!qq) return s;
  const lower = s.toLowerCase();
  const i = lower.indexOf(qq.toLowerCase());
  if (i < 0) return s;
  return (
    <>
      {s.slice(0, i)}
      <span style={{ color: "var(--accent)", fontWeight: 700 }}>
        {s.slice(i, i + qq.length)}
      </span>
      {s.slice(i + qq.length)}
    </>
  );
}
