"use client";

import { LoginGate } from "./LoginGate";
import { DialogProvider } from "./Dialog";
import { BackendStatusBar } from "./BackendStatusBar";
import { RunsHealthBar } from "./RunsHealthBar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DialogProvider>
      <BackendStatusBar />
      <RunsHealthBar />
      <LoginGate>{children}</LoginGate>
    </DialogProvider>
  );
}
