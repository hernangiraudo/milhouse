"use client";

import { useEffect, useState } from "react";

const KEY = "milhouse-user";

export function readUser(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeUser(name: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
    // Avisar a otros tabs/componentes
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  } catch {
    // ignore
  }
}

/** Hook reactivo al valor de `milhouse-user` en localStorage. */
export function useUser(): string | null {
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    setUser(readUser());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setUser(readUser());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return user;
}
