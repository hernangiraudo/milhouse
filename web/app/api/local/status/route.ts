/**
 * GET /api/local/status
 *
 * Devuelve el estado de los artefactos locales del proyecto:
 *   - backend_built: bool — si existe target/debug/milhouse(.exe)
 *   - frontend_deps: bool — si existe web/node_modules
 *   - platform: "win32" | "darwin" | "linux"
 *
 * Esto solo corre en el server de Next.js (no en el browser), así que tiene
 * acceso al filesystem del repo.
 */

import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

function repoRoot(): string {
  // El proceso de Next corre en web/, el repo está un nivel arriba.
  return path.resolve(process.cwd(), "..");
}

export async function GET() {
  const root = repoRoot();
  const isWin = process.platform === "win32";
  const backendBin = path.join(
    root,
    "target",
    "debug",
    isWin ? "milhouse.exe" : "milhouse",
  );
  const nodeModules = path.join(root, "web", "node_modules");

  return NextResponse.json({
    platform: process.platform,
    repo_root: root,
    backend_built: fs.existsSync(backendBin),
    frontend_deps: fs.existsSync(nodeModules),
  });
}
