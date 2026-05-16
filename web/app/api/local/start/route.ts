/**
 * POST /api/local/start
 *
 * Lanza el binario `milhouse` en background (detached) desde el server de
 * Next.js. Pensado para cuando el back se cayó y el usuario quiere
 * relanzarlo desde la UI sin abrir una terminal.
 *
 * Devuelve {ok, pid} si lo lanzó, o {ok:false, error} si no encontró el
 * binario o falló el spawn.
 */

import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";

function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

export async function POST() {
  const root = repoRoot();
  const isWin = process.platform === "win32";
  const binPath = path.join(
    root,
    "target",
    "debug",
    isWin ? "milhouse.exe" : "milhouse",
  );
  if (!fs.existsSync(binPath)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Binario no encontrado en ${binPath}. Corré setup primero.`,
      },
      { status: 400 },
    );
  }

  try {
    // Detached + stdio ignore para que el proceso sobreviva a este request.
    // Logs se descartan; si el usuario quiere verlos, abre una terminal.
    const child = spawn(binPath, [], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return NextResponse.json({ ok: true, pid: child.pid });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500 },
    );
  }
}
