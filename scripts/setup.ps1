# Setup local de Milhouse (Windows / PowerShell).
# Idempotente: se puede correr varias veces.
#
#   cd C:\path\to\milhouse
#   .\scripts\setup.ps1
#
# Lo que hace:
#   1. Verifica que Rust (cargo) y Node estén instalados.
#   2. Habilita pnpm via corepack (sin requerir permisos de admin).
#   3. cargo build (compila el backend y el binario seed).
#   4. Genera la base demo en data/demo.duckdb (si no existe).
#   5. pnpm install en web/.
#
# NO levanta servidores. Para eso usá scripts/start.ps1.

param(
    [int]$Rows = 50000,
    [switch]$ForceSeed
)

$ErrorActionPreference = "Stop"

# Cd a la raíz del repo (un nivel arriba de scripts/).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Milhouse · setup" -ForegroundColor Cyan
Write-Host "    repo root: $root"
Write-Host ""

# ---------- 1. Toolchains ----------
function Test-Tool {
    param([string]$Name, [string]$Cmd)
    try {
        $v = & $Cmd 2>&1 | Select-Object -First 1
        Write-Host "  [OK]   $Name`: $v"
        return $true
    } catch {
        Write-Host "  [FAIL] $Name no encontrado" -ForegroundColor Red
        return $false
    }
}

Write-Host "==> 1/5 Verificando toolchains"
$rustOk = Test-Tool "cargo" "cargo --version"
$nodeOk = Test-Tool "node"  "node --version"
$corepackOk = Test-Tool "corepack" "corepack --version"

if (-not $rustOk) {
    Write-Host ""
    Write-Host "Instalá Rust desde https://rustup.rs y volvé a correr este script." -ForegroundColor Yellow
    exit 1
}
if (-not $nodeOk) {
    Write-Host ""
    Write-Host "Instalá Node.js 18+ desde https://nodejs.org y volvé a correr este script." -ForegroundColor Yellow
    exit 1
}
if (-not $corepackOk) {
    Write-Host ""
    Write-Host "Tu Node no incluye corepack. Actualizá a Node 16.10+." -ForegroundColor Yellow
    exit 1
}

# ---------- 2. pnpm vía corepack ----------
Write-Host ""
Write-Host "==> 2/5 Habilitando pnpm (via corepack)"
try {
    corepack prepare pnpm@latest --activate 2>&1 | Out-Null
    $pnpmVer = corepack pnpm --version
    Write-Host "  [OK]   pnpm $pnpmVer (a través de corepack)"
} catch {
    Write-Host "  [FAIL] no pude habilitar pnpm: $_" -ForegroundColor Red
    exit 1
}

# ---------- 3. Build backend ----------
Write-Host ""
Write-Host "==> 3/5 Compilando backend (cargo build)"
Write-Host "    Esto puede tardar varios minutos la primera vez."
cargo build --bin milhouse --bin seed
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [FAIL] cargo build falló" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK]   backend compilado"

# ---------- 4. Base demo ----------
Write-Host ""
Write-Host "==> 4/5 Generando base demo"
$demo = Join-Path $root "data\demo.duckdb"
if ((Test-Path $demo) -and (-not $ForceSeed)) {
    $size = (Get-Item $demo).Length / 1MB
    $sizeS = "{0:N1}" -f $size
    Write-Host "  [SKIP] $demo ya existe ($sizeS MB). Usá -ForceSeed para regenerar."
} else {
    if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" | Out-Null }
    & ".\target\debug\seed.exe" --rows $Rows
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] seed binary falló" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  [OK]   base demo lista"

# ---------- 5. Frontend deps ----------
Write-Host ""
Write-Host "==> 5/5 Instalando dependencias del frontend (pnpm install)"
Push-Location web
try {
    corepack pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] pnpm install falló" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}
Write-Host "  [OK]   dependencias del frontend instaladas"

# ---------- Summary ----------
Write-Host ""
Write-Host "==================================" -ForegroundColor Green
Write-Host "Setup completo." -ForegroundColor Green
Write-Host "==================================" -ForegroundColor Green
Write-Host ""
Write-Host "Para arrancar Milhouse:"
Write-Host "    .\scripts\start.ps1"
Write-Host ""
Write-Host "O manualmente:"
Write-Host "    1. cargo run --bin milhouse        (en una terminal)"
Write-Host "    2. cd web; corepack pnpm dev       (en otra terminal)"
Write-Host "    3. abrir http://localhost:3000"
