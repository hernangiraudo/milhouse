#!/usr/bin/env bash
# Setup + run en un solo paso (Mac/Linux).
#
#   cd /path/to/milhouse
#   ./scripts/setup_and_run.sh
#
# Lo que hace:
#   1. Si hay procesos previos escuchando en :8090 o :3000, los mata
#      (pide confirmación a menos que se pase --force). Esto evita que
#      el cargo build falle por "Access is denied" si el binario está
#      corriendo y lockea el .exe.
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

# Parsear flags reenviables al run.sh
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
    esac
done

# shellcheck source=scripts/lib_ports.sh
source "$SCRIPT_DIR/lib_ports.sh"

c_cyan "==> Milhouse · setup + run"
echo

# 0) Liberar puertos antes de cualquier cosa: si el binario está corriendo,
#    cargo build no puede sobreescribir milhouse.exe (Access denied).
c_cyan "==> Verificando puertos :8090 y :3000"
if ! stop_port_owners 8090 "backend" "$FORCE"; then exit 1; fi
if ! stop_port_owners 3000 "frontend" "$FORCE"; then exit 1; fi
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
