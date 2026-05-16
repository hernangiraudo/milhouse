# Setup + run en un solo paso (Windows / PowerShell).
#
#   cd C:\path\to\milhouse
#   .\scripts\setup_and_run.ps1
#
# Lo que hace:
#   1. Si hay procesos previos en :8090 o :3000, los mata (pide
#      confirmación a menos que -Force). Evita que cargo build falle
#      por "Access is denied" si milhouse.exe está corriendo y
#      lockeando el binario en target\debug.
#   2. Llama a scripts\setup.ps1 (toolchains, cargo build, seed, deps
#      del front). Idempotente.
#   3. Si el setup terminó OK, llama a scripts\start.ps1: arranca back
#      en :8090 y front en :3000 en ventanas separadas, espera al
#      front y abre el navegador.
#
# Parámetros:
#   -Rows N        cantidad de transacciones del demo (default 50000)
#   -ForceSeed     regenera demo.duckdb aunque exista
#   -Force         no preguntar antes de matar procesos previos
#   -NoBrowser     no abrir el browser al final
#
# Para frenar todo: cerrá ambas ventanas que abrió start.ps1.

param(
    [int]$Rows = 50000,
    [switch]$ForceSeed,
    [switch]$Force,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

. (Join-Path $PSScriptRoot "lib_ports.ps1")

Write-Host "==> Milhouse · setup + run" -ForegroundColor Cyan
Write-Host ""

# 0) Liberar puertos antes de cualquier cosa: si el binario está corriendo,
#    cargo build no puede sobreescribir milhouse.exe (Access denied).
Write-Host "==> Verificando puertos 8090 y 3000" -ForegroundColor Cyan
if (-not (Stop-PortOwners 8090 "backend"  -Force:$Force)) { exit 1 }
if (-not (Stop-PortOwners 3000 "frontend" -Force:$Force)) { exit 1 }
Write-Host ""

# 1) Setup
$setupArgs = @()
if ($Rows -ne 50000) { $setupArgs += "-Rows", $Rows }
if ($ForceSeed)      { $setupArgs += "-ForceSeed" }

& (Join-Path $PSScriptRoot "setup.ps1") @setupArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Setup falló — no arranco los servidores." -ForegroundColor Red
    exit $LASTEXITCODE
}

# 2) Start
Write-Host ""
Write-Host "==> Arrancando servidores..." -ForegroundColor Cyan
$startArgs = @()
if ($Force)     { $startArgs += "-Force" }
if ($NoBrowser) { $startArgs += "-NoBrowser" }
& (Join-Path $PSScriptRoot "start.ps1") @startArgs
