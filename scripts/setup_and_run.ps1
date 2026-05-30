# Setup + run en un solo paso (Windows / PowerShell).
#
#   cd C:\path\to\milhouse
#   .\scripts\setup_and_run.ps1
#
# Lo que hace:
#   1. Llama a scripts\stop.ps1 para detener backend y frontend si
#      están corriendo (por PID file o por puerto). Esto evita que
#      cargo build falle por "Access is denied" cuando milhouse.exe
#      lockea su propio binario en target\debug.
#   2. Llama a scripts\setup.ps1 (toolchains, cargo build, seed, deps
#      del front). Idempotente.
#   3. Si el setup terminó OK, llama a scripts\run.ps1: arranca back
#      en :8090 y front en :3000 en background (sin ventanas), espera
#      al front y abre el navegador.
#
# Parámetros:
#   -Rows N        cantidad de transacciones del demo (default 50000)
#   -ForceSeed     regenera demo.duckdb aunque exista
#   -Force         no preguntar antes de matar procesos previos
#   -NoBrowser     no abrir el browser al final
#
# Para frenar todo: .\scripts\stop.ps1

param(
    [int]$Rows = 50000,
    [switch]$ForceSeed,
    [switch]$Force,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Milhouse · setup + run" -ForegroundColor Cyan
Write-Host ""

# 0) Detener servicios previos antes de cualquier cosa: si el binario
#    está corriendo, cargo build no puede sobreescribir milhouse.exe
#    (Access denied). stop.ps1 cubre PID files y puerto.
Write-Host "==> Deteniendo servicios previos si están corriendo" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "stop.ps1")
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

# 2) Run
Write-Host ""
Write-Host "==> Arrancando servidores..." -ForegroundColor Cyan
$runArgs = @()
if ($Force)     { $runArgs += "-Force" }
if ($NoBrowser) { $runArgs += "-NoBrowser" }
& (Join-Path $PSScriptRoot "run.ps1") @runArgs
