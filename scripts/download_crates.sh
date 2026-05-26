#!/usr/bin/env bash
# Empaqueta todas las dependencias de cargo en install/registry/ para que
# una máquina Linux SIN internet pueda compilar Milhouse 100% offline.
#
# Usa `cargo-local-registry`: genera un mini-registry con los .crate
# gzipped (~5-10× más chico que `cargo vendor`, que copia source crudo).
# Para agregar un crate en el futuro, editás Cargo.toml en esta máquina,
# corrés `cargo update` y volvés a ejecutar este script — sólo descarga
# los .crate nuevos (sync incremental).
#
# Uso:
#   ./scripts/download_crates.sh
#
# Variables:
#   REGISTRY_DIR=install/registry   destino del bundle (override opcional)

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

REGISTRY_DIR="${REGISTRY_DIR:-install/registry}"

c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel()  { printf '\033[33m%s\033[0m\n' "$*"; }
c_cyan() { printf '\033[36m%s\033[0m\n' "$*"; }

c_cyan "==> Milhouse · descarga de crates (offline bundle)"
echo "    repo root:    $ROOT"
echo "    destino:      $REGISTRY_DIR"
echo

# ---------- 1. cargo presente ----------
echo "==> 1/4 Verificando cargo"
if ! cargo --version >/dev/null 2>&1; then
    c_red "  [FAIL] cargo no está en el PATH"
    c_yel "  Instalá Rust desde https://rustup.rs antes de correr esto."
    exit 1
fi
echo "  [OK]   $(cargo --version)"

# ---------- 2. cargo-local-registry instalado ----------
echo
echo "==> 2/4 Verificando cargo-local-registry"
if ! command -v cargo-local-registry >/dev/null 2>&1; then
    c_yel "  cargo-local-registry no está instalado — instalando ahora"
    echo "  (esto baja y compila una sola vez; tarda unos minutos)"
    cargo install cargo-local-registry
fi
echo "  [OK]   $(cargo local-registry --version 2>&1 | head -n1)"

# ---------- 3. Cargo.lock al día ----------
echo
echo "==> 3/4 Asegurando Cargo.lock actualizado"
if [ ! -f Cargo.lock ]; then
    c_yel "  Cargo.lock no existe — generándolo con cargo fetch"
    cargo fetch
else
    echo "  [OK]   Cargo.lock presente"
fi

# ---------- 4. Sync del registry local ----------
echo
echo "==> 4/4 Sincronizando $REGISTRY_DIR"
mkdir -p "$REGISTRY_DIR"
# --sync apunta al Cargo.lock; --git para incluir deps de git si las hubiera.
cargo local-registry --sync Cargo.lock --git "$REGISTRY_DIR"

count=$(find "$REGISTRY_DIR" -maxdepth 1 -name '*.crate' | wc -l | tr -d ' ')
size=$(du -sh "$REGISTRY_DIR" | cut -f1)
echo "  [OK]   $count crates · $size"

# ---------- Config snippet ----------
SNIPPET="$REGISTRY_DIR/cargo-config.toml"
cat > "$SNIPPET" <<'EOF'
# Pegá esto en .cargo/config.toml de la máquina offline (o en
# $CARGO_HOME/config.toml para activarlo global).
# El path debe ser ABSOLUTO o relativo al config.toml.

[source.crates-io]
replace-with = "milhouse-offline"

[source.milhouse-offline]
local-registry = "install/registry"
EOF
echo "  [OK]   snippet de .cargo/config.toml en $SNIPPET"

echo
c_grn "=================================="
c_grn "Bundle listo."
c_grn "=================================="
echo
echo "Para usarlo en la máquina offline (Linux):"
echo
echo "  1. Copiá el repo entero (incluyendo $REGISTRY_DIR/) a la máquina."
echo "  2. Creá .cargo/config.toml en la raíz del repo con el contenido de"
echo "     $SNIPPET (ajustá el path 'local-registry' si moviste el bundle)."
echo "  3. cargo build --bin milhouse --bin seed --offline"
echo
echo "Para agregar un crate más adelante:"
echo "  - Editá Cargo.toml en ESTA máquina (con internet)."
echo "  - cargo update -p <crate>     # o cargo build, para actualizar Cargo.lock"
echo "  - ./scripts/download_crates.sh # baja sólo los .crate nuevos al bundle"
