"use client";

import { LoginGate } from "./LoginGate";

export function AppShell({ children }: { children: React.ReactNode }) {
  return <LoginGate>{children}</LoginGate>;
}
