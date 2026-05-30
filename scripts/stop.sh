#!/usr/bin/env bash
# Frena el backend y frontend lanzados por run.sh.
# Lee los PIDs de data/run/backend.pid y data/run/frontend.pid.
# Si no hay archivos de PID, cae a matar por puerto (:8090 y :3000).
#
#   ./scripts/stop.sh

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

c_cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_dim()    { printf '\033[90m%s\033[0m\n' "$*"; }

# shellcheck source=scripts/lib_ports.sh
source "$SCRIPT_DIR/lib_ports.sh"

kill_pid() {
    local label="$1" pid="$2"
    if ! kill -0 "$pid" 2>/dev/null; then
        c_dim "    $label (PID $pid) ya no está corriendo."
        return 0
    fi
    kill "$pid" 2>/dev/null || true
    local i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do
        sleep 0.5
        i=$((i+1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        c_yellow "    No terminó con SIGTERM, usando SIGKILL..."
        kill -9 "$pid" 2>/dev/null || true
    fi
    c_green "    $label detenido."
}

stop_service() {
    local label="$1" pidfile="$2" port="$3"

    if [ -f "$pidfile" ]; then
        local pid
        pid=$(cat "$pidfile")
        c_cyan "==> Frenando $label (PID $pid)"
        kill_pid "$label" "$pid"
        rm -f "$pidfile"
    else
        # Fallback: matar por puerto
        local pids
        pids="$(port_pids "$port")"
        if [ -n "$pids" ]; then
            c_cyan "==> Frenando $label por puerto :$port"
            while IFS= read -r pid; do
                [ -z "$pid" ] && continue
                kill_pid "$label" "$pid"
            done <<< "$pids"
        else
            c_dim "==> $label no encontrado (ni PID file ni proceso en :$port)."
        fi
    fi
}

stop_service "backend"  "$ROOT/data/run/backend.pid"  8090
stop_service "frontend" "$ROOT/data/run/frontend.pid" 3000

echo
c_green "Listo."
