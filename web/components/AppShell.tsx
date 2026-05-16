"use client";

import { LoginGate } from "./LoginGate";
import { DialogProvider } from "./Dialog";
import { BackendStatusBar } from "./BackendStatusBar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DialogProvider>
      <BackendStatusBar />
      <LoginGate>{children}</LoginGate>
    </DialogProvider>
  );
}
