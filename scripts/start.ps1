# Arranca backend (puerto 8090) y frontend (puerto 3000) en ventanas separadas.
#
#   .\scripts\start.ps1
#
# Lo que hace:
#   1. Si hay algo escuchando en :8090 o :3000, lista los procesos y los
#      mata (pide confirmación a menos que -Force).
#   2. Lanza backend y frontend en ventanas powershell separadas.
#   3. Espera a que el frontend responda y abre el navegador.
#
# Para frenar todo, cerrá ambas ventanas o presioná Ctrl+C en cada una.

param(
    [switch]$Force,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

. (Join-Path $PSScriptRoot "lib_ports.ps1")

$BACKEND_PORT  = 8090
$FRONTEND_PORT = 3000

function Wait-For-Url([string]$url, [int]$timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch {
            # todavía no responde
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# ---------------------------------------------------------------------
# 0) Validar artefactos
# ---------------------------------------------------------------------
$backend = Join-Path $root "target\debug\milhouse.exe"
if (-not (Test-Path $backend)) {
    Write-Host "Backend no compilado. Corré primero: .\scripts\setup.ps1" -ForegroundColor Yellow
    exit 1
}
$webNodeModules = Join-Path $root "web\node_modules"
if (-not (Test-Path $webNodeModules)) {
    Write-Host "Frontend sin deps. Corré primero: .\scripts\setup.ps1" -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------------
# 1) Matar procesos previos en los puertos
# ---------------------------------------------------------------------
if (-not (Stop-PortOwners $BACKEND_PORT  "backend"  -Force:$Force)) { exit 1 }
if (-not (Stop-PortOwners $FRONTEND_PORT "frontend" -Force:$Force)) { exit 1 }

# ---------------------------------------------------------------------
# 2) Arrancar backend + frontend
# ---------------------------------------------------------------------
Write-Host "==> Arrancando backend en http://localhost:$BACKEND_PORT" -ForegroundColor Cyan
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoExit", "-Command", "cd '$root'; .\target\debug\milhouse.exe"

Start-Sleep -Seconds 2

Write-Host "==> Arrancando frontend en http://localhost:$FRONTEND_PORT" -ForegroundColor Cyan
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoExit", "-Command", "cd '$root\web'; corepack pnpm dev"

# ---------------------------------------------------------------------
# 3) Esperar al frontend y abrir el navegador
# ---------------------------------------------------------------------
if (-not $NoBrowser) {
    $frontUrl = "http://localhost:$FRONTEND_PORT"
    Write-Host "==> Esperando a que el frontend responda..." -ForegroundColor Cyan
    if (Wait-For-Url $frontUrl 60) {
        Write-Host "==> Abriendo $frontUrl en el navegador" -ForegroundColor Green
        Start-Process $frontUrl
    } else {
        Write-Host "El frontend no respondió en 60s — abrí $frontUrl a mano cuando termine de compilar." -ForegroundColor Yellow
    }
} else {
    Write-Host "Listo. Abrí http://localhost:$FRONTEND_PORT en tu navegador." -ForegroundColor Green
}

Write-Host ""
Write-Host "  Backend logs : ventana 1 (powershell)"
Write-Host "  Frontend logs: ventana 2 (powershell)"
Write-Host "  Para frenar  : cerrá ambas ventanas."
