#!/usr/bin/env bash
# Configura la ANTHROPIC_API_KEY en el archivo .env local.
# Idempotente: si ya existe la key la reemplaza; si no existe el .env lo crea.
#
#   cd /path/to/milhouse
#   ./scripts/setup_apikey.sh
#
# También aceptás la key como variable (útil en CI o SSH):
#   ANTHROPIC_API_KEY="sk-ant-..." ./scripts/setup_apikey.sh

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "$ROOT"

c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel()  { printf '\033[33m%s\033[0m\n' "$*"; }
c_cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n'  "$*"; }

c_cyan "==> Milhouse · configurar ANTHROPIC_API_KEY"
echo ""

# Si ya viene en el entorno, usarla directamente.
KEY="${ANTHROPIC_API_KEY:-}"

if [ -z "$KEY" ]; then
    echo "  Ingresá tu Anthropic API key (console.anthropic.com/settings/keys)."
    c_dim "  Empieza con 'sk-ant-...'. Se guarda en .env (ignorado por git)."
    echo ""
    read -rp "  API Key: " KEY
fi

KEY="${KEY// /}"  # trim espacios

if [ -z "$KEY" ]; then
    c_yel "  [!] No ingresaste una key. Saliendo sin cambios."
    exit 1
fi

if [[ "$KEY" != sk-ant-* ]]; then
    c_yel "  [!] La key no empieza con 'sk-ant-'. Verificá que sea correcta."
    read -rp "  Guardar de todos modos? (s/N): " confirm
    case "$confirm" in
        s|S|si|Si|SI|y|Y|yes) ;;
        *) echo "  Cancelado."; exit 1 ;;
    esac
fi

ENV_FILE="$ROOT/.env"

# Crear .env desde .env.example si no existe.
if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ROOT/.env.example" ]; then
        cp "$ROOT/.env.example" "$ENV_FILE"
        c_dim "  Creado .env desde .env.example"
    else
        echo "# Milhouse - variables de entorno locales" > "$ENV_FILE"
        c_dim "  Creado .env vacío"
    fi
fi

NEW_LINE="ANTHROPIC_API_KEY=$KEY"

if grep -qE '^#?\s*ANTHROPIC_API_KEY\s*=' "$ENV_FILE"; then
    # Reemplazar línea existente (comentada o no). Compatible con macOS y Linux.
    if sed --version 2>/dev/null | grep -q GNU; then
        sed -i "s|^#\?\s*ANTHROPIC_API_KEY\s*=.*|$NEW_LINE|" "$ENV_FILE"
    else
        # macOS sed requiere extensión vacía explícita.
        sed -i '' "s|^#\?[[:space:]]*ANTHROPIC_API_KEY[[:space:]]*=.*|$NEW_LINE|" "$ENV_FILE"
    fi
    c_grn "  API key actualizada en .env"
else
    # Agregar al final.
    echo "" >> "$ENV_FILE"
    echo "$NEW_LINE" >> "$ENV_FILE"
    c_grn "  API key agregada a .env"
fi

echo ""
c_cyan "  Listo. Reiniciá el backend para que tome la key:"
echo "    ./scripts/run.sh"
echo ""
