# Arranca backend (puerto 8090) y frontend (puerto 3000) en ventanas separadas.
#
#   .\scripts\start.ps1
#
# Para frenar todo, cerrá ambas ventanas o presioná Ctrl+C en cada una.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Chequear que existan los artefactos.
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

Write-Host "==> Arrancando backend en http://localhost:8090" -ForegroundColor Cyan
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoExit", "-Command", "cd '$root'; .\target\debug\milhouse.exe"

Start-Sleep -Seconds 2

Write-Host "==> Arrancando frontend en http://localhost:3000" -ForegroundColor Cyan
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoExit", "-Command", "cd '$root\web'; corepack pnpm dev"

Start-Sleep -Seconds 3
Write-Host ""
Write-Host "Listo. Abrí http://localhost:3000 en tu navegador." -ForegroundColor Green
Write-Host ""
Write-Host "  Backend logs : ventana 1 (powershell)"
Write-Host "  Frontend logs: ventana 2 (powershell)"
Write-Host "  Para frenar  : cerrá ambas ventanas."
