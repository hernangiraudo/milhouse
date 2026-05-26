# Empaqueta todas las dependencias de cargo en install/vendor/ para que
# una maquina Linux SIN internet pueda compilar Milhouse 100% offline.
#
# Usa `cargo vendor` (built-in, sin dependencias externas): copia el source
# de cada crate en install/vendor/ y genera el snippet de config.
# Para agregar un crate en el futuro, editas Cargo.toml en esta maquina,
# corres `cargo update` y vuelves a ejecutar este script -- solo descarga
# los crates nuevos (sync incremental).
#
# Uso:
#   .\scripts\download_crates.ps1
#
# Parametro opcional:
#   -VendorDir "otro/path"   destino del bundle (default: install/vendor)

param(
    [string]$VendorDir = "install/vendor"
)

Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
Set-Location $root

function Write-Cyan   { param($msg) Write-Host $msg -ForegroundColor Cyan }
function Write-Green  { param($msg) Write-Host $msg -ForegroundColor Green }
function Write-Yellow { param($msg) Write-Host $msg -ForegroundColor Yellow }
function Write-Red    { param($msg) Write-Host $msg -ForegroundColor Red }

Write-Cyan "==> Milhouse - descarga de crates (offline bundle)"
Write-Host "    repo root: $root"
Write-Host "    destino:   $VendorDir"
Write-Host ""

# ---------- 1. cargo presente ----------
Write-Host "==> 1/3 Verificando cargo"
$cargoVer = cargo --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Red "  [FAIL] cargo no esta en el PATH"
    Write-Yellow "  Instala Rust desde https://rustup.rs antes de correr esto."
    exit 1
}
Write-Host "  [OK]   $cargoVer"

# ---------- 2. Cargo.lock al dia ----------
Write-Host ""
Write-Host "==> 2/3 Asegurando Cargo.lock actualizado"
if (-not (Test-Path "Cargo.lock")) {
    Write-Yellow "  Cargo.lock no existe -- generandolo con cargo fetch"
    cargo fetch
    if ($LASTEXITCODE -ne 0) { Write-Red "  [FAIL] cargo fetch fallo"; exit 1 }
} else {
    Write-Host "  [OK]   Cargo.lock presente"
}

# ---------- 3. Vendor ----------
Write-Host ""
Write-Host "==> 3/3 Ejecutando cargo vendor -> $VendorDir"
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

# cargo vendor imprime el snippet de config a stdout; el progreso va a stderr.
# Capturamos stdout para guardarlo como archivo de referencia.
$configSnippet = cargo vendor $VendorDir
if ($LASTEXITCODE -ne 0) {
    Write-Red "  [FAIL] cargo vendor termino con error"
    exit 1
}

$crateCount = (Get-ChildItem -Path $VendorDir -Directory | Measure-Object).Count
$sizeBytes  = (Get-ChildItem -Recurse -File -Path $VendorDir |
               Measure-Object -Property Length -Sum).Sum
$sizeMB     = [math]::Round($sizeBytes / 1MB, 1)
Write-Host "  [OK]   $crateCount crates - $sizeMB MB"

# ---------- Config snippet ----------
$snippetPath = "$VendorDir\cargo-config.toml"
$header = "# Pega esto en .cargo/config.toml de la maquina offline`n# (ajusta el path 'directory' si moviste el bundle)`n# Generado por scripts/download_crates.ps1`n"
Set-Content -Path $snippetPath -Value ($header + ($configSnippet -join "`n")) -Encoding utf8
Write-Host "  [OK]   snippet de .cargo/config.toml en $snippetPath"

Write-Host ""
Write-Green "=================================="
Write-Green "Bundle listo."
Write-Green "=================================="
Write-Host ""
Write-Host "Para usarlo en la maquina offline (Linux):"
Write-Host ""
Write-Host "  1. Copia el repo entero (incluyendo $VendorDir/) a la maquina."
Write-Host "  2. Crea .cargo/config.toml en la raiz del repo con el contenido"
Write-Host "     de $snippetPath (ajusta el path si moviste el bundle)."
Write-Host "  3. cargo build --bin milhouse --bin seed --offline"
Write-Host ""
Write-Host "Para agregar un crate mas adelante:"
Write-Host "  - Edita Cargo.toml en ESTA maquina (con internet)."
Write-Host "  - cargo update -p <crate>        # o cargo build"
Write-Host "  - .\scripts\download_crates.ps1  # sync incremental"
