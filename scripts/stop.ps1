# Frena el backend y frontend lanzados por run.ps1.
# Lee los PIDs de data\run\backend.pid y data\run\frontend.pid.
# Si no hay archivos de PID, cae a matar por puerto (:8090 y :3000).
#
#   .\scripts\stop.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

. (Join-Path $PSScriptRoot "lib_ports.ps1")

function Stop-Service([string]$Label, [string]$PidFile, [int]$Port) {
    if (Test-Path $PidFile) {
        $procId = [int](Get-Content $PidFile -Raw)
        try {
            $null = Get-Process -Id $procId -ErrorAction Stop
            Write-Host "==> Frenando $Label (PID $procId)" -ForegroundColor Cyan
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Write-Host "    $Label detenido." -ForegroundColor Green
        } catch {
            Write-Host "==> $Label (PID $procId) ya no está corriendo." -ForegroundColor DarkGray
        }
        Remove-Item $PidFile -ErrorAction SilentlyContinue
    } else {
        # Fallback: matar por puerto
        $owners = Get-PortOwners $Port
        if ($owners.Count -gt 0) {
            Write-Host "==> Frenando $Label por puerto :$Port" -ForegroundColor Cyan
            foreach ($o in $owners) {
                Stop-Process -Id $o.Pid -Force -ErrorAction SilentlyContinue
                Write-Host ("    matado PID {0} · {1}" -f $o.Pid, $o.Name) -ForegroundColor DarkGray
            }
            Write-Host "    $Label detenido." -ForegroundColor Green
        } else {
            Write-Host "==> $Label no encontrado (ni PID file ni proceso en :$Port)." -ForegroundColor DarkGray
        }
    }
}

Stop-Service "backend"  (Join-Path $root "data\run\backend.pid")  8090
Stop-Service "frontend" (Join-Path $root "data\run\frontend.pid") 3000

Write-Host ""
Write-Host "Listo." -ForegroundColor Green
