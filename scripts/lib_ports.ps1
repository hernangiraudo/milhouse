# Helpers compartidos por setup_and_run.ps1 y start.ps1 para liberar los
# puertos del backend/frontend antes de compilar/arrancar. Dot-source only
# (no se ejecuta directo). Define:
#   Get-PortOwners <port>                  devuelve [PSCustomObject]@{ Pid, Name, Path }
#   Stop-PortOwners <port> <label> [-Force] muestra dueños, pide confirmación, mata

function Get-PortOwners([int]$port) {
    try {
        $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    } catch {
        return @()
    }
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    $owners = @()
    foreach ($processId in $pids) {
        try {
            $p = Get-Process -Id $processId -ErrorAction Stop
            $owners += [PSCustomObject]@{
                Pid  = $processId
                Name = $p.ProcessName
                Path = $p.Path
            }
        } catch {
            # proceso ya muerto entre Get-NetTCPConnection y Get-Process
        }
    }
    return $owners
}

function Stop-PortOwners([int]$port, [string]$label, [switch]$Force) {
    $owners = Get-PortOwners $port
    if ($owners.Count -eq 0) { return $true }

    Write-Host "==> Puerto $port ($label) ocupado por:" -ForegroundColor Yellow
    foreach ($o in $owners) {
        Write-Host ("    PID {0} · {1}" -f $o.Pid, $o.Name)
    }

    if (-not $Force) {
        $resp = Read-Host "Matar estos procesos? [Y/n]"
        if ($resp -and $resp.Trim().ToLower() -notin @("", "y", "yes", "s", "si")) {
            Write-Host "Cancelado por el usuario." -ForegroundColor Red
            return $false
        }
    }

    foreach ($o in $owners) {
        try {
            Stop-Process -Id $o.Pid -Force -ErrorAction Stop
            Write-Host ("    matado PID {0}" -f $o.Pid) -ForegroundColor DarkGray
        } catch {
            Write-Host ("    no se pudo matar PID {0}: {1}" -f $o.Pid, $_.Exception.Message) -ForegroundColor Red
        }
    }
    Start-Sleep -Milliseconds 800
    return $true
}
