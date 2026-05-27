#!/usr/bin/env bash
# Compila Milhouse offline usando los crates en install/vendor/ y deja
# el servidor listo para correr.
#
# Pre-requisitos (en el servidor):
#   - Rust (rustup) instalado
#   - Node 18+ con corepack
#   - El repo completo copiado (incluyendo install/vendor/)
#
# Uso:
#   ./scripts/install_offline.sh [opciones]
#
# Opciones:
#   --rows N      filas para la base demo (default: 50000)
#   --force-seed  regenera la base demo aunque ya exista
#   --release     build release (default)
#   --debug       build debug (más rápido, sin optimizaciones)
#   --service     instala milhouse como servicio systemd
#   --port P      puerto del backend (default: 8090; aplica solo con --service)
#   --user U      usuario para el servicio systemd (default: $USER)

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

# ---------- defaults ----------
ROWS=50000
FORCE_SEED=0
BUILD_PROFILE="release"
INSTALL_SERVICE=0
BACKEND_PORT=8090
SERVICE_USER="${USER:-milhouse}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rows=*)       ROWS="${1#*=}" ;;
        --rows)         ROWS="${2:?--rows requiere un valor}"; shift ;;
        --force-seed)   FORCE_SEED=1 ;;
        --debug)        BUILD_PROFILE="debug" ;;
        --release)      BUILD_PROFILE="release" ;;
        --service)      INSTALL_SERVICE=1 ;;
        --port=*)       BACKEND_PORT="${1#*=}" ;;
        --port)         BACKEND_PORT="${2:?--port requiere un valor}"; shift ;;
        --user=*)       SERVICE_USER="${1#*=}" ;;
        --user)         SERVICE_USER="${2:?--user requiere un valor}"; shift ;;
        *) printf '\033[31mArgumento desconocido: %s\033[0m\n' "$1" >&2; exit 2 ;;
    esac
    shift
done

VENDOR_DIR="$ROOT/install/vendor"
CARGO_CONFIG="$ROOT/.cargo/config.toml"

c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel()   { printf '\033[33m%s\033[0m\n' "$*"; }
c_cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }

c_cyan "==> Milhouse · instalacion offline"
echo "    repo root:    $ROOT"
echo "    vendor dir:   $VENDOR_DIR"
echo "    build:        $BUILD_PROFILE"
echo "    base demo:    $ROWS filas"
[ "$INSTALL_SERVICE" -eq 1 ] && echo "    systemd:      si (puerto $BACKEND_PORT, usuario $SERVICE_USER)"
echo

# ---------- 1. Toolchains ----------
echo "==> 1/5 Verificando toolchains"

check_tool() {
    local name="$1" cmd="$2"
    if v=$(eval "$cmd" 2>&1 | head -n1); then
        echo "  [OK]   $name: $v"
    else
        c_red "  [FAIL] $name no encontrado"
        return 1
    fi
}

check_tool "cargo" "cargo --version"    || { c_yel "  Instala Rust: curl https://sh.rustup.rs -sSf | sh"; exit 1; }
check_tool "node"  "node --version"     || { c_yel "  Instala Node 18+ desde https://nodejs.org"; exit 1; }
check_tool "corepack" "corepack --version" || { c_yel "  Actualiza Node a 16.10+ (incluye corepack)"; exit 1; }

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
        else                                          c_yel "         Instala el paquete de headers de unixODBC con tu gestor de paquetes."
        fi
        exit 1
    fi
fi

# ---------- 2. Vendor dir ----------
echo
echo "==> 2/5 Verificando crates vendorizados"
if [ ! -d "$VENDOR_DIR" ]; then
    c_red "  [FAIL] no existe $VENDOR_DIR"
    c_yel "  Copia install/vendor/ al servidor antes de correr este script."
    c_yel "  En la maquina con internet: .\\scripts\\download_crates.ps1"
    exit 1
fi
crate_count=$(find "$VENDOR_DIR" -maxdepth 1 -mindepth 1 -type d | wc -l)
echo "  [OK]   $crate_count crates en $VENDOR_DIR"

# Escribir .cargo/config.toml apuntando al vendor dir con path absoluto.
mkdir -p "$ROOT/.cargo"
cat > "$CARGO_CONFIG" <<EOF
# Generado por scripts/install_offline.sh
# Permite compilar sin internet usando los crates en install/vendor/.

[source.crates-io]
replace-with = "milhouse-offline"

[source.milhouse-offline]
directory = "$VENDOR_DIR"
EOF
echo "  [OK]   $CARGO_CONFIG generado"

# ---------- 3. Compilar backend ----------
echo
echo "==> 3/5 Compilando backend (cargo build --$BUILD_PROFILE --offline)"
echo "    Puede tardar varios minutos la primera vez."

if [ "$BUILD_PROFILE" = "release" ]; then
    cargo build --release --offline --bin milhouse --bin seed
    BIN_DIR="$ROOT/target/release"
else
    cargo build --offline --bin milhouse --bin seed
    BIN_DIR="$ROOT/target/debug"
fi

# Copiar binarios a install/bin/ para tenerlos en un lugar fijo.
mkdir -p "$ROOT/install/bin"
cp "$BIN_DIR/milhouse" "$ROOT/install/bin/milhouse"
cp "$BIN_DIR/seed"     "$ROOT/install/bin/seed"
chmod +x "$ROOT/install/bin/milhouse" "$ROOT/install/bin/seed"
echo "  [OK]   binarios en $ROOT/install/bin/"

# ---------- 4. Base demo ----------
echo
echo "==> 4/5 Generando base demo"
DEMO="$ROOT/data/demo.duckdb"
mkdir -p "$ROOT/data"
if [ -f "$DEMO" ] && [ "$FORCE_SEED" -ne 1 ]; then
    size_mb=$(du -m "$DEMO" | cut -f1)
    echo "  [SKIP] $DEMO ya existe (${size_mb} MB). Usa --force-seed para regenerar."
else
    "$ROOT/install/bin/seed" --rows "$ROWS"
    echo "  [OK]   base demo generada"
fi

# ---------- 5. Frontend ----------
echo
echo "==> 5/5 Instalando dependencias del frontend"

# pnpm via corepack (puede necesitar internet la primera vez)
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true

if corepack pnpm --version >/dev/null 2>&1; then
    echo "  pnpm disponible — ejecutando pnpm install"
    if (cd "$ROOT/web" && corepack pnpm install --frozen-lockfile 2>&1); then
        echo "  [OK]   dependencias del frontend instaladas"
    else
        c_yel "  [WARN] pnpm install fallo (¿sin internet?)."
        c_yel "         Si el servidor no tiene acceso a npm, copia web/node_modules/"
        c_yel "         desde la maquina de desarrollo o construye el frontend alli."
    fi
else
    c_yel "  [SKIP] pnpm no disponible; el frontend necesita instalarse manualmente."
fi

# ---------- Servicio systemd (opcional) ----------
if [ "$INSTALL_SERVICE" -eq 1 ]; then
    echo
    echo "==> Instalando servicio systemd"

    if ! command -v systemctl >/dev/null 2>&1; then
        c_yel "  [SKIP] systemd no disponible en este sistema."
    else
        SERVICE_FILE="/etc/systemd/system/milhouse.service"
        cat > /tmp/milhouse.service <<EOF
[Unit]
Description=Milhouse ETL server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT
ExecStart=$ROOT/install/bin/milhouse
Restart=on-failure
RestartSec=5
Environment=MILHOUSE_BIND=0.0.0.0:$BACKEND_PORT

[Install]
WantedBy=multi-user.target
EOF
        if [ "$(id -u)" -eq 0 ]; then
            mv /tmp/milhouse.service "$SERVICE_FILE"
            systemctl daemon-reload
            systemctl enable milhouse
            echo "  [OK]   servicio instalado y habilitado: systemctl start milhouse"
        else
            c_yel "  [WARN] no sos root — copiá el archivo de servicio manualmente:"
            c_yel "         sudo cp /tmp/milhouse.service $SERVICE_FILE"
            c_yel "         sudo systemctl daemon-reload && sudo systemctl enable milhouse"
            echo "  Se dejó la unidad en /tmp/milhouse.service para revisar."
        fi
    fi
fi

# ---------- Resumen ----------
echo
c_grn "=================================="
c_grn "Instalacion completa."
c_grn "=================================="
echo
echo "Para arrancar Milhouse:"
echo
if [ "$INSTALL_SERVICE" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
    echo "  sudo systemctl start milhouse"
    echo "  sudo journalctl -u milhouse -f          # logs en tiempo real"
else
    echo "  Backend:   $ROOT/install/bin/milhouse"
    echo "  Frontend:  cd $ROOT/web && corepack pnpm dev"
    echo "  O todo junto: ./scripts/start.sh"
fi
echo
echo "Puerto backend: $BACKEND_PORT  →  http://localhost:$BACKEND_PORT"
echo "Puerto frontend (dev): 3000   →  http://localhost:3000"
echo
echo "Variables de entorno opcionales (.env o export):"
echo "  MILHOUSE_BIND=0.0.0.0:$BACKEND_PORT   expone en todas las interfaces"
echo "  ANTHROPIC_API_KEY=sk-...               habilita Milhouse-AI"
