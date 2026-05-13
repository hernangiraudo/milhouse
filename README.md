# Milhouse — Gestor de ETLs config-driven

MVP de un orquestador de ETLs ultraeficiente, definido por archivo JSON,
con backend en Rust (axum + polars + duckdb + rhai) y frontend Next.js.

## Cómo correrlo

```powershell
# 1) (una vez) habilitar pnpm via corepack
corepack enable
corepack prepare pnpm@latest --activate

# 2) generar la base demo
cargo run --bin seed --release -- --rows 50000

# 3) levantar el backend en :8080
cargo run --release

# 4) en otra terminal, levantar el front en :3000
cd web
pnpm install
pnpm dev
```

Abrir <http://localhost:3000>, elegir `demo_finance.json` y darle Run.
