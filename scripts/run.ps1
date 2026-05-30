# Arranca backend y frontend desacoplados de la sesión actual.
# Los procesos siguen corriendo si cerrás la terminal o se cae la conexión SSH.
# Logs en data\run\backend.log y data\run\frontend.log.
# PIDs en data\run\backend.pid y data\run\frontend.pid.
# Para frenar: .\scripts\stop.ps1
#
#   .\scripts\run.ps1
#
# Flags:
#   -Force        no preguntar antes de matar procesos previos en :8090/:3000
#   -NoBrowser    no abrir el browser al final

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

function Wait-For-Url([string]$url, [int]$timeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# ---------------------------------------------------------------------
# 0) Validar artefactos
# ---------------------------------------------------------------------
$backend = $null
foreach ($candidate in @(
    (Join-Path $root "install\bin\milhouse.exe"),
    (Join-Path $root "target\release\milhouse.exe"),
    (Join-Path $root "target\debug\milhouse.exe")
)) {
    if (Test-Path $candidate) { $backend = $candidate; break }
}
if (-not $backend) {
    Write-Host "Backend no compilado. Corré primero: .\scripts\setup.ps1 o .\scripts\install_offline.ps1" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $root "web\node_modules"))) {
    Write-Host "Frontend sin deps. Corré primero: .\scripts\setup.ps1" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Path "data\run" -Force | Out-Null

# ---------------------------------------------------------------------
# 1) Matar procesos previos
# ---------------------------------------------------------------------
if (-not (Stop-PortOwners $BACKEND_PORT  "backend"  -Force:$Force)) { exit 1 }
if (-not (Stop-PortOwners $FRONTEND_PORT "frontend" -Force:$Force)) { exit 1 }

# ---------------------------------------------------------------------
# 2) Arrancar backend + frontend (WindowStyle Hidden: sobreviven al cierre)
# ---------------------------------------------------------------------
Write-Host "==> Backend en http://localhost:$BACKEND_PORT" -ForegroundColor Cyan
$backProc = Start-Process -FilePath $backend `
    -WorkingDirectory $root `
    -RedirectStandardOutput "data\run\backend.log" `
    -RedirectStandardError  "data\run\backend_err.log" `
    -WindowStyle Hidden `
    -PassThru
$backProc.Id | Out-File "data\run\backend.pid" -Encoding utf8 -NoNewline
Write-Host ("    PID: {0} · logs: data\run\backend.log" -f $backProc.Id) -ForegroundColor DarkGray

Start-Sleep -Seconds 2

Write-Host "==> Frontend en http://localhost:$FRONTEND_PORT" -ForegroundColor Cyan
$frontProc = Start-Process -FilePath "powershell.exe" `
    -WorkingDirectory (Join-Path $root "web") `
    -ArgumentList "-NoProfile", "-NonInteractive", "-Command", "corepack pnpm dev" `
    -RedirectStandardOutput "$root\data\run\frontend.log" `
    -RedirectStandardError  "$root\data\run\frontend_err.log" `
    -WindowStyle Hidden `
    -PassThru
$frontProc.Id | Out-File "data\run\frontend.pid" -Encoding utf8 -NoNewline
Write-Host ("    PID: {0} · logs: data\run\frontend.log" -f $frontProc.Id) -ForegroundColor DarkGray

Write-Host ""
Write-Host "    Para frenar: .\scripts\stop.ps1" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------
# 3) Esperar al frontend y abrir el navegador
# ---------------------------------------------------------------------
$frontUrl = "http://localhost:$FRONTEND_PORT"
if (-not $NoBrowser) {
    Write-Host "==> Esperando a que el frontend responda..." -ForegroundColor Cyan
    if (Wait-For-Url $frontUrl 60) {
        Write-Host "==> Abriendo $frontUrl en el navegador" -ForegroundColor Green
        Start-Process $frontUrl
    } else {
        Write-Host "El frontend no respondió en 60s — abrí $frontUrl a mano cuando termine de compilar." -ForegroundColor Yellow
    }
} else {
    Write-Host "Listo. Abrí $frontUrl en tu navegador." -ForegroundColor Green
}
