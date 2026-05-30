#!/usr/bin/env bash
# Setup local de Milhouse (Mac/Linux).
# Idempotente.
#
#   cd /path/to/milhouse
#   ./scripts/setup.sh
#
# Variables:
#   ROWS=50000   cantidad de transacciones a generar en demo.duckdb
#   FORCE_SEED=1 regenera la base aunque exista
#
# NO arranca servidores. Usá ./scripts/run.sh.

set -euo pipefail

# Cd a la raíz del repo.
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

ROWS="${ROWS:-50000}"
FORCE_SEED="${FORCE_SEED:-0}"

c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel()   { printf '\033[33m%s\033[0m\n' "$*"; }
c_cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }

c_cyan "==> Milhouse · setup"
echo "    repo root: $ROOT"
echo

# ---------- 1. Toolchains ----------
check_tool() {
    local name="$1" cmd="$2"
    if v=$(eval "$cmd" 2>&1 | head -n1); then
        echo "  [OK]   $name: $v"
        return 0
    else
        c_red "  [FAIL] $name no encontrado"
        return 1
    fi
}

echo "==> 1/5 Verificando toolchains"
check_tool "cargo"    "cargo --version"    || { c_yel "Instalá Rust desde https://rustup.rs"; exit 1; }
check_tool "node"     "node --version"     || { c_yel "Instalá Node.js 18+ desde https://nodejs.org"; exit 1; }
check_tool "corepack" "corepack --version" || { c_yel "Actualizá Node a 16.10+ (incluye corepack)"; exit 1; }

# Linux: chequear headers de unixODBC (los necesita la crate odbc-api al compilar).
if [ "$(uname -s)" = "Linux" ]; then
    if [ -f /usr/include/sql.h ] || [ -f /usr/local/include/sql.h ]; then
        echo "  [OK]   unixodbc-dev (sql.h encontrado)"
    else
        c_red "  [FAIL] unixodbc-dev no instalado (falta sql.h)"
        c_yel "         La crate odbc-api lo necesita para compilar."
        if   command -v apt-get >/dev/null 2>&1; then c_yel "         sudo apt-get install -y unixodbc-dev"
        elif command -v dnf     >/dev/null 2>&1; then c_yel "         sudo dnf install -y unixODBC-devel"
        elif command -v yum     >/dev/null 2>&1; then c_yel "         sudo yum install -y unixODBC-devel"
        elif command -v pacman  >/dev/null 2>&1; then c_yel "         sudo pacman -S unixodbc"
        elif command -v zypper  >/dev/null 2>&1; then c_yel "         sudo zypper install unixODBC-devel"
        else                                          c_yel "         Instalá el paquete de headers de unixODBC con tu gestor de paquetes."
        fi
        exit 1
    fi
fi

# ---------- 2. pnpm via corepack ----------
echo
echo "==> 2/5 Habilitando pnpm (via corepack)"
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
if pnpm_ver=$(corepack pnpm --version 2>&1); then
    echo "  [OK]   pnpm $pnpm_ver (a través de corepack)"
else
    c_red "  [FAIL] no pude habilitar pnpm"
    exit 1
fi

# ---------- 3. Build backend ----------
echo
echo "==> 3/5 Compilando backend (cargo build)"
echo "    Esto puede tardar varios minutos la primera vez."
cargo build --bin milhouse --bin seed
echo "  [OK]   backend compilado"

# ---------- 4. Base demo ----------
echo
echo "==> 4/5 Generando base demo"
DEMO="$ROOT/data/demo.duckdb"
if [ -f "$DEMO" ] && [ "$FORCE_SEED" != "1" ]; then
    size_mb=$(du -m "$DEMO" | cut -f1)
    echo "  [SKIP] $DEMO ya existe (${size_mb} MB). Usá FORCE_SEED=1 para regenerar."
else
    mkdir -p data
    # Detectar el ejecutable según el OS (target/debug/seed o seed.exe en WSL).
    if [ -x "$ROOT/target/debug/seed" ]; then
        "$ROOT/target/debug/seed" --rows "$ROWS"
    elif [ -x "$ROOT/target/debug/seed.exe" ]; then
        "$ROOT/target/debug/seed.exe" --rows "$ROWS"
    else
        c_red "  [FAIL] no encontré el binario seed"; exit 1
    fi
fi
echo "  [OK]   base demo lista"

# ---------- 5. Frontend deps ----------
echo
echo "==> 5/5 Instalando dependencias del frontend (pnpm install)"
(cd web && corepack pnpm install)
echo "  [OK]   dependencias del frontend instaladas"

# ---------- Summary ----------
echo
c_grn "=================================="
c_grn "Setup completo."
c_grn "=================================="
echo
echo "Para arrancar Milhouse:"
echo "    ./scripts/run.sh"
echo
echo "O manualmente:"
echo "    1. cargo run --bin milhouse        (en una terminal)"
echo "    2. cd web && corepack pnpm dev     (en otra terminal)"
echo "    3. abrir http://localhost:3000"
