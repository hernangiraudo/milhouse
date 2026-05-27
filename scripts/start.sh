#!/usr/bin/env bash
# Arranca backend y frontend en background. Logs en data/run/*.log.
# Frena con Ctrl+C (mata ambos).
#
#   ./scripts/start.sh
#
# Flags:
#   --force        no preguntar antes de matar procesos previos en :8090/:3000
#   --no-browser   no abrir el browser al final

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

BACKEND_PORT=8090
FRONTEND_PORT=3000

FORCE=0
OPEN_BROWSER=1
for arg in "$@"; do
    case "$arg" in
        --force)      FORCE=1 ;;
        --no-browser) OPEN_BROWSER=0 ;;
        *) echo "argumento desconocido: $arg" >&2; exit 2 ;;
    esac
done

c_cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_dim()    { printf '\033[90m%s\033[0m\n' "$*"; }

# shellcheck source=scripts/lib_ports.sh
source "$SCRIPT_DIR/lib_ports.sh"

wait_for_url() {
    local url="$1" timeout="${2:-60}"
    local deadline=$(( $(date +%s) + timeout ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

open_browser() {
    local url="$1"
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
        open "$url" >/dev/null 2>&1 &
    elif command -v cmd.exe >/dev/null 2>&1; then
        # WSL
        cmd.exe /c start "" "$url" >/dev/null 2>&1 &
    else
        c_yellow "No encontré un comando para abrir el navegador. Abrí $url a mano."
    fi
}

# ---------------------------------------------------------------------
# 0) Validar artefactos
# ---------------------------------------------------------------------
if [ -x "$ROOT/install/bin/milhouse" ]; then
    BACKEND="$ROOT/install/bin/milhouse"
elif [ -x "$ROOT/target/release/milhouse" ]; then
    BACKEND="$ROOT/target/release/milhouse"
elif [ -x "$ROOT/target/debug/milhouse" ]; then
    BACKEND="$ROOT/target/debug/milhouse"
elif [ -x "$ROOT/target/debug/milhouse.exe" ]; then
    BACKEND="$ROOT/target/debug/milhouse.exe"
else
    c_red "Backend no compilado. Corré primero: ./scripts/setup.sh o ./scripts/install_offline.sh"
    exit 1
fi

if [ ! -d "$ROOT/web/node_modules" ]; then
    c_red "Frontend sin deps. Corré primero: ./scripts/setup.sh"
    exit 1
fi

mkdir -p data/run

# ---------------------------------------------------------------------
# 1) Matar procesos previos
# ---------------------------------------------------------------------
if ! stop_port_owners "$BACKEND_PORT"  "backend"  "$FORCE"; then exit 1; fi
if ! stop_port_owners "$FRONTEND_PORT" "frontend" "$FORCE"; then exit 1; fi

# ---------------------------------------------------------------------
# 2) Arrancar backend + frontend
# ---------------------------------------------------------------------
c_cyan "==> Backend en http://localhost:$BACKEND_PORT"
"$BACKEND" > data/run/backend.log 2>&1 &
BACKEND_PID=$!
echo "    PID: $BACKEND_PID · logs: data/run/backend.log"

sleep 2

c_cyan "==> Frontend en http://localhost:$FRONTEND_PORT"
(cd web && corepack pnpm dev > "$ROOT/data/run/frontend.log" 2>&1) &
FRONTEND_PID=$!
echo "    PID: $FRONTEND_PID · logs: data/run/frontend.log"

cleanup() {
    echo
    c_cyan "==> Frenando..."
    kill "$BACKEND_PID" 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    echo "Listo."
}
trap cleanup INT TERM

# ---------------------------------------------------------------------
# 3) Esperar al frontend y abrir el navegador
# ---------------------------------------------------------------------
FRONT_URL="http://localhost:$FRONTEND_PORT"
if [ "$OPEN_BROWSER" -eq 1 ]; then
    c_cyan "==> Esperando a que el frontend responda..."
    if wait_for_url "$FRONT_URL" 60; then
        c_green "==> Abriendo $FRONT_URL"
        open_browser "$FRONT_URL"
    else
        c_yellow "El frontend no respondió en 60s — abrí $FRONT_URL a mano cuando termine de compilar."
    fi
else
    echo
    echo "Listo. Abrí $FRONT_URL en tu navegador."
fi

echo
echo "Ctrl+C para frenar ambos."
echo

# Esperar a que termine cualquiera de los dos.
wait
