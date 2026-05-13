"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

/**
 * Hook reactivo al atributo `data-theme` de `<html>`. Cualquier componente
 * que dependa del tema (ej. el SVG del DAG que usa hex inline) lo usa para
 * re-renderizar cuando el usuario lo cambia.
 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const read = () => {
      const t = root.getAttribute("data-theme");
      setTheme(t === "light" ? "light" : "dark");
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return theme;
}
