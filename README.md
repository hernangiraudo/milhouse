# Milhouse — Gestor de ETLs config-driven

MVP de un orquestador de ETLs ultraeficiente, definido por archivo JSON,
con backend en Rust (axum + polars + duckdb + rhai) y frontend Next.js.

## Setup automático

**Windows (PowerShell)**
```powershell
.\scripts\setup.ps1     # instala todo
.\scripts\start.ps1     # arranca backend + frontend
```

**Mac / Linux**
```bash
./scripts/setup.sh      # instala todo
./scripts/start.sh      # arranca backend + frontend
```

El script `setup` verifica que tengas Rust y Node, habilita pnpm via corepack,
compila el backend, genera la base demo (`data/demo.duckdb`) y baja las
dependencias del frontend. Es idempotente: se puede correr varias veces.

Luego abrí <http://localhost:3000>, elegí un usuario y dale Run.

## Setup manual

```bash
corepack prepare pnpm@latest --activate

cargo build --bin milhouse --bin seed
cargo run --bin seed -- --rows 50000

cargo run --bin milhouse        # http://localhost:8090
# en otra terminal:
cd web
corepack pnpm install
corepack pnpm dev               # http://localhost:3000
```
