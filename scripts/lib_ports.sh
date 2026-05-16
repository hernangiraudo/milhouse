#!/usr/bin/env bash
# Helpers compartidos por setup_and_run.sh y start.sh para liberar los
# puertos del backend/frontend antes de compilar/arrancar. Source-only
# (no se ejecuta directo). Define:
#   port_pids <port>            imprime PIDs LISTEN
#   stop_port_owners <port> <label> [--force]
#                               muestra dueños, pide confirmación, mata
# Requiere las funciones de color c_yellow/c_red/c_dim del caller, o cae a
# echo si no existen.

if ! declare -f c_yellow >/dev/null 2>&1; then c_yellow() { echo "$*"; }; fi
if ! declare -f c_red    >/dev/null 2>&1; then c_red()    { echo "$*"; }; fi
if ! declare -f c_dim    >/dev/null 2>&1; then c_dim()    { echo "$*"; }; fi

port_pids() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    elif command -v fuser >/dev/null 2>&1; then
        fuser "$port"/tcp 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
    elif command -v netstat >/dev/null 2>&1; then
        # MINGW / git-bash: parsear netstat -ano (Windows). Devuelve PIDs únicos.
        netstat -ano 2>/dev/null \
            | awk -v p=":$port" 'tolower($1) ~ /^tcp/ && $2 ~ p"$" && tolower($4) == "listening" { print $5 }' \
            | sort -u
    else
        echo ""
    fi
}

stop_port_owners() {
    local port="$1" label="$2" force="${3:-0}"
    local pids
    pids="$(port_pids "$port")"
    if [ -z "$pids" ]; then return 0; fi

    c_yellow "==> Puerto $port ($label) ocupado por:"
    while IFS= read -r processId; do
        [ -z "$processId" ] && continue
        local cmd
        # Intentamos PowerShell primero en MINGW para resolver el nombre del proceso de Windows.
        if command -v powershell.exe >/dev/null 2>&1; then
            cmd="$(powershell.exe -NoProfile -Command "(Get-Process -Id $processId -ErrorAction SilentlyContinue).ProcessName" 2>/dev/null | tr -d '\r' || echo "?")"
        else
            cmd="$(ps -p "$processId" -o comm= 2>/dev/null || echo "?")"
        fi
        printf '    PID %s · %s\n' "$processId" "${cmd:-?}"
    done <<< "$pids"

    if [ "$force" -ne 1 ]; then
        read -r -p "Matar estos procesos? [Y/n] " resp
        case "${resp:-y}" in
            y|Y|yes|YES|s|S|si|SI) ;;
            *) c_red "Cancelado por el usuario."; return 1 ;;
        esac
    fi

    while IFS= read -r processId; do
        [ -z "$processId" ] && continue
        if command -v powershell.exe >/dev/null 2>&1 \
            && powershell.exe -NoProfile -Command "Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1; then
            c_dim "    matado PID $processId"
        elif kill "$processId" 2>/dev/null; then
            c_dim "    matado PID $processId"
        else
            c_red "    no se pudo matar PID $processId"
        fi
    done <<< "$pids"

    sleep 1
    local remaining
    remaining="$(port_pids "$port")"
    if [ -n "$remaining" ]; then
        while IFS= read -r processId; do
            [ -z "$processId" ] && continue
            kill -9 "$processId" 2>/dev/null || \
                powershell.exe -NoProfile -Command "Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
        done <<< "$remaining"
        sleep 1
    fi
}
