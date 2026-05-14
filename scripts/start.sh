#!/usr/bin/env bash
# Arranca backend y frontend en background. Logs en data/run/*.log.
# Frena con Ctrl+C (mata ambos).
#
#   ./scripts/start.sh

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

# Detectar binario (Unix vs WSL).
if [ -x "$ROOT/target/debug/milhouse" ]; then
    BACKEND="$ROOT/target/debug/milhouse"
elif [ -x "$ROOT/target/debug/milhouse.exe" ]; then
    BACKEND="$ROOT/target/debug/milhouse.exe"
else
    echo "Backend no compilado. Corré primero: ./scripts/setup.sh"
    exit 1
fi

if [ ! -d "$ROOT/web/node_modules" ]; then
    echo "Frontend sin deps. Corré primero: ./scripts/setup.sh"
    exit 1
fi

mkdir -p data/run

echo "==> Backend en http://localhost:8090"
"$BACKEND" > data/run/backend.log 2>&1 &
BACKEND_PID=$!
echo "    PID: $BACKEND_PID · logs: data/run/backend.log"

sleep 2

echo "==> Frontend en http://localhost:3000"
(cd web && corepack pnpm dev > "$ROOT/data/run/frontend.log" 2>&1) &
FRONTEND_PID=$!
echo "    PID: $FRONTEND_PID · logs: data/run/frontend.log"

cleanup() {
    echo
    echo "==> Frenando..."
    kill "$BACKEND_PID" 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    echo "Listo."
}
trap cleanup INT TERM

echo
echo "Listo. Abrí http://localhost:3000"
echo "Ctrl+C para frenar ambos."
echo

# Esperar a que termine cualquiera de los dos.
wait
