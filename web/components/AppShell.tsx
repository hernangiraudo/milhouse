"use client";

import { LoginGate } from "./LoginGate";
import { DialogProvider } from "./Dialog";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DialogProvider>
      <LoginGate>{children}</LoginGate>
    </DialogProvider>
  );
}
