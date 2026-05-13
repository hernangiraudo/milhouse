"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";
const KEY = "milhouse-theme";

function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" ? "light" : "dark";
}

function applyTheme(t: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // ignore
    }
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  // Sync con el atributo del <html> (que ya fue seteado por el script inline).
  useEffect(() => {
    setTheme(readTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  return (
    <button
      onClick={toggle}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-surface-strong bg-surface hover:bg-surface-2"
      aria-label={`Cambiar a tema ${theme === "dark" ? "claro" : "oscuro"}`}
      title={`Cambiar a tema ${theme === "dark" ? "claro" : "oscuro"}`}
    >
      <span aria-hidden>{theme === "dark" ? "☀️" : "🌙"}</span>
      <span>{theme === "dark" ? "Claro" : "Oscuro"}</span>
    </button>
  );
}
