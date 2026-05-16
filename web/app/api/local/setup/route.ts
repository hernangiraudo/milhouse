/**
 * POST /api/local/setup
 *
 * Corre el script de setup (`scripts/setup.ps1` en Windows, `scripts/setup.sh`
 * en Mac/Linux). Es lento (compila el binario, instala deps de pnpm). Lo
 * lanzamos detached y reportamos progreso por SSE (event-stream).
 *
 * El cliente queda escuchando la response como stream y muestra cada línea.
 * Cuando el proceso termina, manda un evento `done` con el exit code.
 */

import { spawn } from "child_process";
import path from "path";

function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

export const dynamic = "force-dynamic";

export async function POST() {
  const root = repoRoot();
  const isWin = process.platform === "win32";
  const script = isWin
    ? path.join(root, "scripts", "setup.ps1")
    : path.join(root, "scripts", "setup.sh");

  const child = isWin
    ? spawn(
        "powershell.exe",
        ["-ExecutionPolicy", "Bypass", "-File", script],
        { cwd: root },
      )
    : spawn("bash", [script], { cwd: root });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      function emit(event: string, data: unknown) {
        const payload =
          `event: ${event}\n` +
          `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      }
      emit("start", { script });
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) emit("log", { level: "info", line });
        }
      });
      child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) emit("log", { level: "warn", line });
        }
      });
      child.on("close", (code) => {
        emit("done", { exit_code: code });
        controller.close();
      });
      child.on("error", (e) => {
        emit("log", { level: "error", line: `spawn error: ${e.message}` });
        emit("done", { exit_code: -1 });
        controller.close();
      });
    },
    cancel() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
