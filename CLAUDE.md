# Milhouse · contexto para Claude Code

Este archivo es lo primero que tenés que leer al abrir el proyecto. Resume
arquitectura, decisiones tomadas, trampas conocidas y cómo trabajar con el
usuario. Si vas a hacer cambios sustanciales, actualizalo al cierre de la
sesión.

> Convención de proyecto: pensado para colaborar con Claude Code (CLI).
> Si encontrás divergencias entre este archivo y el código real, **confía
> en el código** y actualizá este archivo.

---

## El usuario

- **Castellano rioplatense**. Le hablás en castellano, podés mezclar términos
  técnicos en inglés (lo hace naturalmente).
- **Técnico**: pide cambios concretos, espera respuestas concisas.
- **Valora eficiencia + flexibilidad** > simplicidad. Prefiere arquitecturas
  desacopladas (DBs configurables, configs JSON) y feature-rich (DAG visual,
  ETA por mediana, badges por tipo, tema claro/oscuro, etc).
- **UI**: pide interfaces expresivas, no minimalistas funcionales. Le
  importan los detalles: colores por tipo de paso, badges por nivel, tooltips,
  empty states con buen mensaje.
- **Confía pero verifica**: cuando algo no funciona ("no se ve bien") es
  específico, no vago. Tomalo literal y resolvé el caso concreto.
- **Autorización amplia**: ya autorizó instalar dependencias y arrancar
  servidores locales (cargo build, pnpm install, dev servers). No pidas
  permiso de vuelta para eso. Para destructivos (rm -rf, drop tablas reales)
  sí confirmar.

## Stack y arquitectura

```
backend Rust (un solo crate)        frontend Next.js 14 App Router
├─ axum 0.7 HTTP + WebSocket        ├─ TailwindCSS (sin shadcn)
├─ polars 0.49 (tablas en memoria)  ├─ pnpm via corepack (`corepack pnpm`)
├─ duckdb 1.1 (bundled+polars)      ├─ Tema claro/oscuro con tokens
├─ rhai 1.20 (procedural)              CSS + hook useTheme()
├─ petgraph implícito (DAG)         └─ Sin codegen front/back: tipos a
├─ rust_xlsxwriter (export Excel)      mano en web/lib/types.ts mirror
├─ tokio (full)                        de los DTOs Rust
└─ tracing
```

DuckDB embebido, 2 archivos: `data/demo.duckdb` (base operativa demo) y
`data/milhouse_runs.duckdb` (historial de ejecuciones).
**No usamos Postgres** — está declarado como tipo de conexión placeholder
pero no implementado.

### Layout

```
src/
  main.rs                 bin server
  lib.rs
  bin/seed.rs             bin: genera demo.duckdb
  config/
    schema.rs             EtlConfig, Step, StepSpec (todos los kinds)
    connections.rs        ConnectionsFile (connections.json)
    users.rs              UsersFile (users.json)
  engine/
    context.rs            TableStore, ConnectionPool, StepContext
    sql_query.rs sql_exec.rs join.rs lookup.rs transform.rs
    filter_subset.rs sort.rs export.rs procedural.rs
    mod.rs                execute_step dispatcher
  scripting/
    rhai_runner.rs        runner Rhai fila-por-fila
    rust_registry.rs      registry de fns Rust nativas (fraud_scoring_v1, ...)
    mod.rs                ProcCtx, trait ProceduralFn
  orchestrator/
    state.rs              JobState, StepInfo, StepRuntimeState
    progress.rs           ProgressEvent, ProgressReporter, StepUpdate
    dag.rs                successors + in_degree
    scheduler.rs          NÚCLEO: supervisor + tokio JoinSet + cancellation
  runs/
    mod.rs                RunStore: persistencia jobs/steps/logs/datasets
                          + DatasetPreview + Casos + Schedules
    worker.rs             worker que cada 60s dispara schedules
  api/
    routes.rs ws.rs dto.rs mod.rs

configs/
  demo_finance.json       16 steps demo con todos los kinds
  esco_consulta.json novedades.json novedades_cartera_propia.json
  observaciones.json rend_especie_ajuste.json rend_especie_calculo.json
  rend_especie_cc.json rend_especie_informe.json rend_trimestral.json
  warehouse_carga.json    10 proyectos adicionales (stubs ejecutables)
  connections.json        conexiones DB (main + runs + 3 placeholders)
  users.json              lista de usuarios

scripts/
  setup.ps1 setup.sh      instala dependencias + compila + seed
  start.ps1 start.sh      arranca backend + frontend

web/
  app/page.tsx            home con sidebar de 6 secciones
  app/jobs/[id]/page.tsx  vista en vivo de un job (DAG, kanban, logs, sample)
  components/             RunEtlPanel SchedulesPanel RunsReviewPanel
                          CasesPanel CaseDialogs ConnectionsPanel UsersPanel
                          DagView StepColumns StepCard LogsPanel SamplePanel
                          StepDetails EtaBadge LoginGate ThemeToggle AppShell
  lib/api.ts              fetch helpers tipados
  lib/types.ts            mirror manual de DTOs Rust
  lib/session.ts          useUser + writeUser localStorage
  lib/useTheme.ts         hook para tema reactivo
```

### Schema config (JSON ETL)

Cada step tiene identidad dual:
- `id`: nombre legible, lo escribís en `depends_on`. Puede cambiar.
- `step_uid`: u32, **asignado automáticamente** al cargar y persistido en el
  JSON. Identidad estable para la DB de runs. Si renombrás el `id`, el
  `step_uid` no cambia → los runs históricos siguen apuntando al mismo step.

Step fields:
- `id, step_uid, depends_on[], group?, log_level?, dataset_name?, kind, ...`
- `log_level`: info|warn|error (default info). Aplica a todos los mensajes
  emitidos por el step. Errores reales siempre son `error`.
- `dataset_name`: nombre legible para el dataset persistido (cuando debug).

Kinds: `sql_query`, `sql_exec`, `join`, `lookup`, `transform`,
`filter_and_subset`, `sort`, `export`, `procedural` (rhai|rust).

### Schema DB de runs

```
runs            (job_id PK, config_name, config_display_name, user_name,
                 debug, status, started_at, finished_at, duration_ms,
                 total_steps)
step_runs       (job_id, step_uid PK, step_id, kind, group_name, status,
                 started_at, finished_at, duration_ms, row_count, error)
step_logs       (job_id, step_uid, ts, level, line)
step_datasets   (job_id, step_uid PK, name, level, table_name, row_count,
                 size_bytes, created_at)
cases           (id PK seq, title, description, severity, assignee, creator,
                 status, created_at, closed_at, closed_by)
case_datasets   (case_id, job_id, step_uid PK, added_at, added_by)
case_comments   (id PK seq, case_id, author, body, created_at)
schedules       (id PK seq, name, config_name, enabled, spec_json,
                 created_by, created_at, last_fired_at)
```

Datasets persistidos: tabla física `log_<job_short>_<uid>` con CREATE TABLE
+ insert por filas. El nombre real lo gestiona el RunStore.

### Endpoints REST principales

```
GET    /api/health
GET    /api/configs                                lista proyectos
GET    /api/configs/:name                          JSON del proyecto
POST   /api/jobs                                   {config_name, user, debug}
GET    /api/jobs                                   in-memory recientes
GET    /api/jobs/:id
POST   /api/jobs/:id/cancel
GET    /api/jobs/:id/ws                            WebSocket eventos vivos

GET    /api/connections                            con `default` y `is_default`
POST   /api/connections/reload

GET    /api/users
POST   /api/users
DELETE /api/users/:name
POST   /api/users/reload

GET    /api/runs                                   histórico desde DB
DELETE /api/runs/:id                               bloquea si hay casos abiertos
GET    /api/runs/:id/steps
GET    /api/runs/:id/steps/:uid/logs
GET    /api/runs/:id/datasets
GET    /api/runs/:id/datasets/:uid/preview         {columns, rows, total, ...}
GET    /api/runs/:id/datasets/:uid/export?format=csv|xlsx

GET    /api/cases
POST   /api/cases                                  {title, description,
                                                    severity, assignee,
                                                    creator, attach[]}
GET    /api/cases/:id                              {header, comments, datasets}
POST   /api/cases/:id/close
POST   /api/cases/:id/comments                     {body, author}
POST   /api/cases/:id/datasets                     {job_id, step_uid, added_by}

GET    /api/schedules
POST   /api/schedules                              {name, config_name, spec,
                                                    enabled, created_by}
PATCH  /api/schedules/:id                          {enabled}
DELETE /api/schedules/:id
```

### Eventos WebSocket (tagged union, serde tag="type")

```
job_started, step_state_changed, step_progress, step_log, step_completed,
job_eta, job_finished
```

## Features implementadas (al día de la sesión)

- DAG visual con grupos colapsables (heurística Sugiyama por baricentro),
  colores por kind + tema claro/oscuro.
- Kanban Pending/Running/Done/Failed con sub-secciones por grupo.
- 8 kinds de step incluyendo procedural dual (Rhai script + Rust nativo
  con `fn_name` resuelto en registry).
- Login con dropdown de usuarios + "+ otro usuario".
- Theme switcher (claro/oscuro) con tokens CSS + hook reactivo.
- Tab "Detalle" del step con descripción humana por kind (no JSON crudo).
- Persistencia automática en DB de runs (todos los jobs con debug=true).
- Revisión: drill-down runs → steps → logs, filtros por nivel + búsqueda,
  preview de datasets persistidos.
- Casos: CRUD, comentarios, severidad, responsable (assignee),
  datasets adjuntos, cierre.
- Eliminar run bloqueado por casos abiertos (HTTP 409 + lista).
- Export dataset a CSV/Excel completo desde server.
- Planificación: at|window|cron con worker tokio cada 60s.
- 11 proyectos (demo_finance + 10 nuevos: Esco Consulta, Warehouse,
  Rendimiento Especie x4, Rendimiento Trimestral, Novedades x2,
  Observaciones).
- Scripts setup + start cross-platform.

## Decisiones de diseño clave

1. **TableStore = `Arc<RwLock<HashMap<String, Arc<DataFrame>>>>`**. Lectura
   clona el Arc y suelta lock; escritura solo en insert. Inmutable por
   convención: cada step declara `output_table`.

2. **Pool compartido**: el `ConnectionPool` y el `RunStore` viven en
   `AppState`. Los jobs NO crean su propio pool — comparten el del server.
   Esto evita que dos conexiones DuckDB peleen por el mismo archivo.

3. **Identidad estable de steps**: `step_uid` u32. Asignado al primer load,
   persistido en el JSON re-escrito. Permite renombrar el `id` legible sin
   romper referencias históricas.

4. **Job IDs**: UUIDv4 estándar. No se repite jamás. 128 bits aleatorios
   serializados en hex.

5. **Procedural dual** (Rhai + Rust nativo): el JSON dice
   `engine: "rhai" | "rust"`. Rhai usa `script` inline; Rust referencia
   `fn_name` en el registry de `scripting::rust_registry`. ~50× diferencia
   de performance entre los dos engines.

6. **DuckDB single connection** por nombre (Arc<Mutex<Connection>>). El
   `ConnectionPool` cachea por nombre, lazy. Serializa SQL pero el grueso
   va por Polars fuera de DuckDB. Acceptable para MVP.

7. **Worker de schedules**: tokio task que cada 60s lee schedules, evalúa
   `should_fire(spec, now, last_fired_at)`, dispara los que coinciden.
   Deduplicación por minuto truncado. Jobs disparados quedan registrados
   con `user = "scheduler#<id>"`.

8. **Bloqueo de delete con casos abiertos**: `DELETE /api/runs/:id` valida
   `open_cases_for_run` antes; responde **HTTP 409** con
   `{ error: "open_cases_block_delete", open_cases: [ids] }`. El front
   captura `OpenCasesBlockError` y muestra alert.

9. **Tema claro/oscuro**: tokens CSS `--bg --panel --text --accent ...`
   con `data-theme` en `<html>`. Inline script en `<head>` aplica antes
   del primer paint (evita flash). Overrides agresivos para clases
   Tailwind hardcodeadas. Clase utilitaria `.milhouse-field` para inputs
   semánticos. Clase `.milhouse-codeblock` para code blocks que siempre
   son oscuros (mejor contraste para SQL/scripts).

## Trampas conocidas (NO repetir)

### Build/runtime
- **`lto = "thin"` + `codegen-units = 1`** en release CUELGA los rustc en
  Windows >9000s sin output. Actual `Cargo.toml` tiene `lto = false`,
  `codegen-units = 16`. NO TOCAR.
- **Profile dev**: `opt-level = 2` para dependencias (`[profile.dev.package."*"]`).
  Permite que polars+duckdb compilen razonable en debug.
- **Binario `milhouse` resuelve paths relativos al cwd**, no a su ubicación.
  Hay que arrancarlo desde la raíz del repo. Los scripts `start.*` lo hacen.

### Schema DB
- **`at` es reserved en DuckDB** — usar `ts` para timestamp en `step_logs`.
- **DuckDB `Connection::execute` requiere statement preparado** primero
  con `query()` antes de pedir `column_count`/`column_name`. Ver
  `RunStore::query` que tiene la versión correcta.
- **`Value::Timestamp(unit, micros)`** hay que parsear según `TimeUnit`.
- **Cuando cambiamos schema de DuckDB**: borrar `data/milhouse_runs.duckdb`
  y dejar que el `SCHEMA_SQL` lo recree. No hay migraciones.

### Toolchain Windows + nvm
- `corepack enable` falla con EPERM sobre nvm. Workaround:
  `corepack prepare pnpm@latest --activate` (no toca permisos globales).
  Invocar siempre `corepack pnpm <cmd>`, NO `pnpm <cmd>` directo.

### Polars 0.49
- `Series::estimated_size()` es private. Estimar bytes a mano con `len * sizeof(dtype)`.
- `CsvWriter::new()` requiere `use polars::prelude::SerWriter` para `.finish()`.
- `query_polars` devuelve `Iterator<Item = DataFrame>` (chunks). Hay que
  `vstack_mut` para acumular.

### Frontend
- **Comentarios `//!` en Rust van ANTES de cualquier `pub mod`** — no podés
  meter un `pub mod` entre el `//!` y el primer item.
- **Casos a evitar para evitar 404 fantasma**: si modificás routes en
  `main.rs`, asegurate de **realmente recompilar** antes de probar. Un
  binario viejo corriendo te tira 404 sin pista clara.
- **`bg-black/30` y `bg-black/60`** se overridean para tema claro como
  panel-2 / oscuro tipo consola. Para code blocks usar `.milhouse-codeblock`
  (siempre oscuro), para logs `.milhouse-logs`.

## Cómo arrancar todo (sanity check)

```powershell
# Windows
.\scripts\setup.ps1
.\scripts\start.ps1
```

```bash
# Mac/Linux
./scripts/setup.sh
./scripts/start.sh
```

Si falla algo, intentar manual:
```bash
cargo build --bin milhouse --bin seed
cargo run --bin seed --release -- --rows 50000   # solo primera vez
cargo run --bin milhouse                          # http://localhost:8090
cd web && corepack pnpm install && corepack pnpm dev   # http://localhost:3000
```

## Sesión: estado al cierre

Última cosa que se hizo:
- Bulk delete con checkboxes en "Ejecuciones recientes" (sección
  Ejecutar proyecto). Patrón replica el de Revisión de logs: checkbox-all
  en header respeta filtro visible, botón "Eliminar N seleccionado(s)" rojo
  cuando hay >0, bloqueo granular cuando hay casos abiertos.

Pendientes mencionados pero NO implementados (preguntá antes de empezarlos):
- **Sección Debug**: navegador read-only sobre runs históricas con
  datasets intermedios y crear/asignar caso desde ahí. Se discutió pero
  se canceló a favor de otras prioridades; los hooks ya existen
  (preview de dataset + endpoints). El usuario lo va a pedir.
- **Step-by-step debugger**: pausa entre steps + botón "siguiente" +
  breakpoints. Requiere cambios profundos en el orquestador
  (estado `paused/waiting`, endpoint `POST /api/jobs/:id/advance`).
  Postergado.
- **Multi-dataset por step** (un step podría emitir varios datasets,
  ej. "normales" + "excepciones"). El nivel pasaría a ser propiedad del
  dataset, no del step. Estructura preparada en `step_datasets`
  (cambiar PK a `(job_id, step_uid, name)`), pero no implementado en el
  engine ni el ProcCtx.
- **Auth real con password**: por ahora login solo es nombre +
  localStorage. Se acordó dejar password para después.
- Persistencia del registry de jobs en memoria — los jobs corriendo se
  pierden si reinicia el server (igual queda persistido el final state en
  la DB de runs).

## Cómo trabajar con este usuario

1. **Ante decisiones de scope**: usar `AskUserQuestion` con 2-4 opciones
   con "Recommended" en la primera. Le gusta entender el trade-off, no
   que se le presenten alternativas sin contexto.
2. **No invoques agentes (Agent tool) salvo que él pida explícitamente**
   o que sea claramente una exploración multi-archivo. Trabajar inline.
3. **Plan mode**: usalo cuando el cambio es genuinamente arquitectónico
   (algo que toca múltiples crates/módulos). Para cambios chicos, ir
   directo.
4. **TaskCreate**: crear tareas concretas, cortas, marcar completed al
   terminar cada una. El usuario ve la progresión y le da contexto.
5. **Update CLAUDE.md (este archivo)** al final si tocaste algo importante.

## Archivos clave para revisar primero

- `Cargo.toml` (perfiles, deps)
- `src/main.rs` (routing, worker spawn)
- `src/orchestrator/scheduler.rs` (núcleo del orquestador)
- `src/runs/mod.rs` (RunStore + DatasetPreview + casos + schedules)
- `src/api/routes.rs` (todos los endpoints)
- `web/app/page.tsx` (sidebar + secciones)
- `web/components/` (los componentes vivos)
