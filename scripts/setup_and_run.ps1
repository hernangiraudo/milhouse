# Setup + run en un solo paso (Windows / PowerShell).
#
#   cd C:\path\to\milhouse
#   .\scripts\setup_and_run.ps1
#
# Lo que hace:
#   1. Llama a scripts\setup.ps1 (verifica toolchains, compila el backend,
#      genera la base demo, instala deps del frontend). Idempotente.
#   2. Si el setup terminó OK, llama a scripts\start.ps1 que arranca backend
#      en :8090 y frontend en :3000 en ventanas separadas.
#
# Parámetros (todos opcionales, se reenvían al setup):
#   -Rows N        cantidad de transacciones del demo (default 50000)
#   -ForceSeed     regenera demo.duckdb aunque exista
#
# Para frenar todo: cerrá ambas ventanas que abrió start.ps1.

param(
    [int]$Rows = 50000,
    [switch]$ForceSeed
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Milhouse · setup + run" -ForegroundColor Cyan
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
& (Join-Path $PSScriptRoot "start.ps1")
