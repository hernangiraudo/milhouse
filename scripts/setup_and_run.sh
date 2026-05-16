#!/usr/bin/env bash
# Setup + run en un solo paso (Mac/Linux).
#
#   cd /path/to/milhouse
#   ./scripts/setup_and_run.sh
#
# Lo que hace:
#   1. Corre ./scripts/setup.sh (verifica toolchains, compila el backend,
#      genera la base demo, instala deps del frontend). Idempotente.
#   2. Si el setup terminó OK, corre ./scripts/start.sh que arranca backend
#      en :8090 y frontend en :3000 en terminales separadas (o forks
#      según el SO).
#
# Variables (se reenvían al setup):
#   ROWS=50000      cantidad de transacciones del demo
#   FORCE_SEED=1    regenera demo.duckdb aunque exista
#
# Para frenar todo: cerrá las terminales que abrió start.sh
# (o Ctrl+C en cada una si quedó en foreground).

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

c_cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }

c_cyan "==> Milhouse · setup + run"
echo

# 1) Setup (hereda env vars como ROWS y FORCE_SEED)
if ! bash "$SCRIPT_DIR/setup.sh"; then
    echo
    c_red "Setup falló — no arranco los servidores."
    exit 1
fi

# 2) Start
echo
c_cyan "==> Arrancando servidores..."
bash "$SCRIPT_DIR/start.sh"
