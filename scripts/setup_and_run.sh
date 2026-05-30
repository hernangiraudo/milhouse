#!/usr/bin/env bash
# Setup + run en un solo paso (Mac/Linux).
#
#   cd /path/to/milhouse
#   ./scripts/setup_and_run.sh
#
# Lo que hace:
#   1. Llama a ./scripts/stop.sh para detener backend y frontend si
#      están corriendo (por PID file o por puerto). Esto evita que el
#      cargo build falle por "Access is denied" si el binario está
#      lockeando milhouse.exe en target/debug.
#   2. Corre ./scripts/setup.sh (verifica toolchains, compila el backend,
#      genera la base demo, instala deps del frontend). Idempotente.
#   3. Si el setup terminó OK, corre ./scripts/run.sh: arranca backend
#      y frontend desacoplados de la sesión SSH, espera al frontend y
#      abre el navegador.
#
# Variables (se reenvían al setup):
#   ROWS=50000      cantidad de transacciones del demo
#   FORCE_SEED=1    regenera demo.duckdb aunque exista
#
# Flags (se reenvían al run):
#   --force         no preguntar antes de matar procesos previos
#   --no-browser    no abrir el browser al final
#
# Para frenar todo: ./scripts/stop.sh

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

c_cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_dim()    { printf '\033[90m%s\033[0m\n' "$*"; }

c_cyan "==> Milhouse · setup + run"
echo

# 0) Detener servicios previos antes de cualquier cosa: si el binario
#    está corriendo, cargo build no puede sobreescribir milhouse.exe
#    (Access denied). stop.sh cubre PID files y puerto.
c_cyan "==> Deteniendo servicios previos si están corriendo"
bash "$SCRIPT_DIR/stop.sh"
echo

# 1) Setup (hereda env vars como ROWS y FORCE_SEED)
if ! bash "$SCRIPT_DIR/setup.sh"; then
    echo
    c_red "Setup falló — no arranco los servidores."
    exit 1
fi

# 2) Run (reenvía cualquier flag tipo --force / --no-browser)
echo
c_cyan "==> Arrancando servidores..."
bash "$SCRIPT_DIR/run.sh" "$@"
