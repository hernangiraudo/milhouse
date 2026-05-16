"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";
import { useDialog } from "./Dialog";

type Status =
  | { kind: "checking" }
  | { kind: "online" }
  | { kind: "offline"; backendBuilt: boolean; frontendDeps: boolean };

const POLL_INTERVAL_OFFLINE_MS = 3000;
const POLL_INTERVAL_ONLINE_MS = 15000;
const FETCH_TIMEOUT_MS = 2500;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function checkHealth(): Promise<boolean> {
  try {
    const r = await fetchWithTimeout(`${API_BASE}/api/health`, FETCH_TIMEOUT_MS);
    return r.ok;
  } catch {
    return false;
  }
}

async function fetchLocalStatus(): Promise<{
  backend_built: boolean;
  frontend_deps: boolean;
}> {
  try {
    const r = await fetch("/api/local/status", { cache: "no-store" });
    if (!r.ok) return { backend_built: false, frontend_deps: false };
    return await r.json();
  } catch {
    return { backend_built: false, frontend_deps: false };
  }
}

export function BackendStatusBar() {
  const dialog = useDialog();
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const [busy, setBusy] = useState<null | "start" | "setup">(null);
  const [logs, setLogs] = useState<Array<{ level: string; line: string }>>([]);
  const showLogs = busy === "setup";
  const cancelRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      if (!alive) return;
      const online = await checkHealth();
      if (!alive) return;
      if (online) {
        setStatus({ kind: "online" });
      } else {
        const local = await fetchLocalStatus();
        if (!alive) return;
        setStatus({
          kind: "offline",
          backendBuilt: local.backend_built,
          frontendDeps: local.frontend_deps,
        });
      }
    }
    tick();
    const interval = setInterval(
      tick,
      status.kind === "online"
        ? POLL_INTERVAL_ONLINE_MS
        : POLL_INTERVAL_OFFLINE_MS,
    );
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [status.kind]);

  async function onStart() {
    setBusy("start");
    try {
      const r = await fetch("/api/local/start", { method: "POST" });
      const j = (await r.json()) as { ok: boolean; error?: string; pid?: number };
      if (!j.ok) {
        await dialog.alert(j.error ?? "No se pudo iniciar el backend.", {
          title: "Error al iniciar",
          variant: "danger",
        });
        setBusy(null);
        return;
      }
      // Polleamos health durante unos segundos esperando que levante.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await checkHealth()) {
          setStatus({ kind: "online" });
          setBusy(null);
          return;
        }
      }
      await dialog.alert(
        `Lancé el backend (pid ${j.pid}) pero no respondió en 30s. Mirá la consola.`,
        { title: "Sin respuesta", variant: "warning" },
      );
    } catch (e) {
      await dialog.alert(String(e), { variant: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function onSetupAndStart() {
    const ok = await dialog.confirm(
      "Esto va a compilar el backend (cargo build) e instalar dependencias del frontend (pnpm install). Puede tardar varios minutos. ¿Continuar?",
      { title: "Setup completo", variant: "warning", ok: "Sí, correr setup" },
    );
    if (!ok) return;
    setBusy("setup");
    setLogs([]);
    try {
      const ctl = new AbortController();
      cancelRef.current = ctl;
      const r = await fetch("/api/local/setup", {
        method: "POST",
        signal: ctl.signal,
      });
      if (!r.body) throw new Error("respuesta sin body");
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let exitCode: number | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events separados por blank line
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          try {
            const parsed = JSON.parse(data);
            if (event === "log") {
              setLogs((p) => [
                ...p.slice(-500),
                { level: parsed.level ?? "info", line: parsed.line ?? "" },
              ]);
            } else if (event === "done") {
              exitCode = parsed.exit_code;
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (exitCode === 0) {
        setLogs((p) => [
          ...p,
          { level: "info", line: "✓ Setup terminó OK. Iniciando backend…" },
        ]);
        // El binario ya debería existir → arrancarlo.
        await onStart();
      } else {
        await dialog.alert(
          `Setup terminó con código ${exitCode}. Revisá los logs.`,
          { title: "Setup falló", variant: "danger" },
        );
      }
    } catch (e) {
      await dialog.alert(String(e), { variant: "danger" });
    } finally {
      setBusy(null);
      cancelRef.current = null;
    }
  }

  if (status.kind === "online" || status.kind === "checking") return null;

  // Offline: render del banner
  const canJustStart = status.backendBuilt && status.frontendDeps;
  return (
    <div
      className="sticky top-0 z-30 px-4 py-3 border-b border-red-700"
      style={{ background: "rgba(220, 38, 38, 0.12)" }}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className="inline-flex items-center gap-2 font-semibold"
            style={{ color: "rgb(220, 38, 38)" }}
          >
            <span
              aria-hidden
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: "rgb(220, 38, 38)" }}
            />
            Backend caído
          </span>
          <span className="text-xs text-muted">
            No responde {API_BASE}/api/health.{" "}
            {canJustStart
              ? "Podés relanzarlo desde acá."
              : !status.backendBuilt
              ? "Falta compilar el binario."
              : "Faltan dependencias del frontend."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={!canJustStart || busy !== null}
            className="text-sm font-semibold px-3 py-1.5 rounded disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {busy === "start" ? "Iniciando…" : "▶ Start"}
          </button>
          <button
            type="button"
            onClick={onSetupAndStart}
            disabled={busy !== null}
            className="text-sm px-3 py-1.5 rounded milhouse-btn-secondary disabled:opacity-50"
            title="Compila el backend + instala dependencias del frontend, después arranca el server"
          >
            {busy === "setup" ? "Corriendo setup…" : "⚙ Setup + Start"}
          </button>
        </div>
      </div>
      {showLogs && logs.length > 0 && (
        <div className="max-w-7xl mx-auto mt-3">
          <div className="milhouse-logs max-h-40 overflow-auto text-xs">
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                <span
                  className={
                    l.level === "error"
                      ? "milhouse-logs-error"
                      : l.level === "warn"
                      ? "milhouse-logs-warn"
                      : "milhouse-logs-info"
                  }
                >
                  {l.line}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
