# Configura la ANTHROPIC_API_KEY en el archivo .env local.
# Idempotente: si ya existe la key la reemplaza; si no existe el .env lo crea.
#
#   cd C:\path\to\milhouse
#   .\scripts\setup_apikey.ps1
#
# También aceptás la key como argumento (útil en CI o SSH):
#   .\scripts\setup_apikey.ps1 -Key "sk-ant-..."

param(
    [string]$Key = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Milhouse · configurar ANTHROPIC_API_KEY" -ForegroundColor Cyan
Write-Host ""

# Si no vino como arg, pedirla interactivamente.
if (-not $Key) {
    Write-Host "  Ingresá tu Anthropic API key (console.anthropic.com/settings/keys)."
    Write-Host "  Empieza con 'sk-ant-...'. Se guarda en .env (ignorado por git)." -ForegroundColor DarkGray
    Write-Host ""
    $Key = Read-Host "  API Key"
}

$Key = $Key.Trim()

if (-not $Key) {
    Write-Host "  [!] No ingresaste una key. Saliendo sin cambios." -ForegroundColor Yellow
    exit 1
}

if (-not $Key.StartsWith("sk-ant-")) {
    Write-Host "  [!] La key no empieza con 'sk-ant-'. Verificá que sea correcta." -ForegroundColor Yellow
    $confirm = Read-Host "  Guardar de todos modos? (s/N)"
    if ($confirm -notin @("s","S","si","Si","SI","y","Y","yes")) {
        Write-Host "  Cancelado." -ForegroundColor DarkGray
        exit 1
    }
}

$envFile = Join-Path $root ".env"

# Crear .env desde .env.example si no existe.
if (-not (Test-Path $envFile)) {
    $example = Join-Path $root ".env.example"
    if (Test-Path $example) {
        Copy-Item $example $envFile
        Write-Host "  Creado .env desde .env.example" -ForegroundColor DarkGray
    } else {
        # Si tampoco hay .env.example, arrancamos con un archivo mínimo.
        Set-Content $envFile "# Milhouse - variables de entorno locales`n" -Encoding UTF8
        Write-Host "  Creado .env vacío" -ForegroundColor DarkGray
    }
}

# Leer contenido actual.
$content = Get-Content $envFile -Raw -Encoding UTF8

$newLine = "ANTHROPIC_API_KEY=$Key"

if ($content -match '(?m)^#?\s*ANTHROPIC_API_KEY\s*=') {
    # Reemplazar la línea existente (comentada o no).
    $content = $content -replace '(?m)^#?\s*ANTHROPIC_API_KEY\s*=.*$', $newLine
    Write-Host "  API key actualizada en .env" -ForegroundColor Green
} else {
    # Agregar al final.
    $content = $content.TrimEnd() + "`n`n$newLine`n"
    Write-Host "  API key agregada a .env" -ForegroundColor Green
}

Set-Content $envFile $content -Encoding UTF8 -NoNewline

Write-Host ""
Write-Host "  Listo. Reinicia el backend para que tome la key:" -ForegroundColor Cyan
Write-Host "    .\scripts\run.ps1" -ForegroundColor White
Write-Host ""
