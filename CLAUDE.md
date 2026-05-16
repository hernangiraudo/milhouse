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
├─ duckdb 1.1 (bundled+polars)      ├─ Monaco (@monaco-editor/react)
├─ tiberius 0.12 (SQL Server)       ├─ Tema claro/oscuro con tokens
├─ mysql_async 0.34                    CSS + hook useTheme()
├─ odbc-api 9                       └─ Sin codegen front/back: tipos a
├─ rhai 1.20 (procedural)              mano en web/lib/types.ts mirror
├─ petgraph implícito (DAG)            de los DTOs Rust
├─ rust_xlsxwriter (export Excel)
├─ calamine 0.26 (read Excel)
├─ zip 2 (bundles de runs)
├─ reqwest 0.12 (Claude API)
├─ tokio (full)
└─ tracing
```

DuckDB embebido. 2 archivos por default: `data/demo.duckdb` (base operativa
demo) y `data/milhouse_runs.duckdb` (historial de ejecuciones, conexión
lógica `runs`, **resuelta case-insensitive** así "Runs" también funciona).

Conexiones soportadas con **cliente nativo**: `duckdb`, `duckdb_memory`,
`sql_server` (tiberius), `mysql` (mysql_async), `odbc`. **Placeholders**
(declarables pero NO implementados): `postgres`, `sqlite`. Para Postgres y
SQLite se sugiere usar ODBC.

**Pool de SqlServer**: cada conexión lógica del config se materializa
como un `SqlServerPool` con hasta 8 clientes tiberius concurrentes
(`acquire().await` → `SqlServerLease` con RAII). Esto permite **ejecutar
varios pasos en paralelo sobre la misma conexión lógica** sin que se
serialicen.

### Layout

```
src/
  main.rs                 bin server (routing completo)
  lib.rs
  bin/seed.rs             bin: genera demo.duckdb
  ai/mod.rs               Milhouse-AI: build_step + review_sql (Anthropic)
  config/
    schema.rs             EtlConfig, Step, StepSpec, ParamSpec, ParamPreset,
                          ApiConfig (todo el modelo del proyecto)
    connections.rs        ConnectionsFile (connections.json)
    global_params.rs      GlobalParamsFile (configs/parameters.json):
                          parámetros y respuestas COMPARTIDOS entre
                          proyectos. Path env: MILHOUSE_GLOBAL_PARAMS_PATH.
    constants.rs          GlobalConstantsFile (configs/constants.json):
                          códigos canónicos compartidos entre proyectos
                          (kind number|text|raw_sql), referenciados como
                          `:Grupo.Nombre`. Path env:
                          MILHOUSE_GLOBAL_CONSTANTS_PATH.
    users.rs              UsersFile (users.json)
  engine/
    context.rs            TableStore, ConnectionPool, StepContext,
                          SqlServerPool/Lease (paralelismo MSSQL)
    params.rs             Sustitución :param en SQL (respeta strings,
                          comentarios, ::cast; expansion en IN(...))
    sql_query.rs sql_exec.rs join.rs lookup.rs transform.rs
    filter_subset.rs sort.rs export.rs procedural.rs union.rs
    introspect.rs         list_tables + list_columns (con is_primary_key)
    mod.rs                execute_step dispatcher (sustituye :param antes)
  scripting/
    rhai_runner.rs        runner Rhai fila-por-fila
    rust_registry.rs      registry fns Rust (fraud_scoring_v1, ...)
    mod.rs                ProcCtx, trait ProceduralFn
  orchestrator/
    state.rs              JobState, StepInfo, StepRuntimeState
    progress.rs           ProgressEvent, ProgressReporter, StepUpdate
    dag.rs                successors + in_degree + ancestors/descendants
    scheduler.rs          NÚCLEO: supervisor + tokio spawn + cancellation
                          JobOptions {target_steps, stop_on_failure,
                          use_preload, params}
  runs/
    mod.rs                RunStore: jobs/steps/logs/datasets + casos +
                          schedules + roadmap (case-insensitive lookup
                          de la conexión "runs")
    worker.rs             worker que cada 60s dispara schedules
    bundle.rs             export/import zip de datasets (parquet)
  api/
    routes.rs             handlers REST internos
    public.rs             API pública por proyecto (/api/public/...)
    ws.rs dto.rs mod.rs   AppState + Web Sockets

configs/
  demo_finance.json       16 steps demo (parametros + presets opcionales)
  esco_consulta.json novedades.json novedades_cartera_propia.json
  observaciones.json rend_especie_ajuste.json rend_especie_calculo.json
  rend_especie_cc.json rend_especie_informe.json rend_trimestral.json
  warehouse_carga.json
  connections.json        conexiones DB
  parameters.json         parámetros + presets GLOBALES (compartidos
                          entre proyectos). Editable por la API y desde
                          la sección "Parámetros de Ejecución".
  users.json              lista de usuarios

scripts/
  setup.ps1 setup.sh      instala dependencias + compila + seed
  start.ps1 start.sh      arranca backend + frontend
  setup_and_run.ps1/.sh   setup + start en un solo paso

web/
  app/
    layout.tsx page.tsx   home con sidebar de N secciones
    design/new design/[name]      editor de proyecto (ruta dedicada)
    jobs/[id]/page.tsx    vista en vivo de un job
    api/local/            routes Next: status, start, setup (para que
                          BackendStatusBar relance el back si está caído)
  components/
    AppShell.tsx          DialogProvider + BackendStatusBar + LoginGate
    Dialog.tsx            sistema de diálogos temático (alert/confirm/prompt)
    BackendStatusBar.tsx  detecta back caído y ofrece Start/Setup+Start
    DesignPanel.tsx       lista de proyectos en /design
    DesignEditor.tsx      editor de un proyecto (canvas + paneles)
    DesignCanvas.tsx      DAG visual (multi-select, marquee, grupos
                          anidados, badges de estado, menús contextuales)
    ParametersPanel.tsx           editor de parámetros + presets en Diseño
    ParameterPromptDialog.tsx     prompt al ejecutar (multi-preset merge)
    ApiExposurePanel.tsx          configurar API REST por proyecto
    SqlEditor.tsx                 Monaco + toolbar: Indentar / Check / AI
    SqlMonitorPanel.tsx           procesos activos en SQL Server + KILL
    RoadmapPanel.tsx              pedidos de mejora + comentarios
    RunEtlPanel.tsx               sección Ejecutar proyecto (jobs recientes)
    RunsReviewPanel.tsx           Revisión de logs (DB de runs)
    SchedulesPanel.tsx            Planificación
    CasesPanel.tsx CaseDialogs.tsx
    ConnectionsPanel.tsx UsersPanel.tsx
    LogsPanel.tsx SamplePanel.tsx StepDetails.tsx
    StepEditor.tsx + step_editors/ (visuales por kind)
    MilhouseAIDialog.tsx          construir step con NL
    ThemeToggle.tsx LoginGate.tsx
  lib/
    api.ts                fetch helpers tipados + createJob({parameters,...})
    types.ts              mirror manual de DTOs Rust
    session.ts            useUser + writeUser localStorage
    useTheme.ts           hook tema reactivo
    sqlFormat.ts          tokenizer + prettyFormatSql (clauses, AND/OR,
                          BETWEEN, comas en SELECT, etc)
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
`filter_and_subset`, `sort`, `export`, `procedural` (rhai|rust), `union`.

**`union`**: apila N datasets en vertical (vstack). Si los esquemas
difieren, el resultado expone la **unión** de columnas y completa con
`null` donde falta. Si una columna tiene dtypes distintos entre inputs,
promueve a `String` como denominador común. Editor visual:
`UnionVisual.tsx`.

**`output_table` opcional para in-place** (lookup / transform /
filter_and_subset / procedural): si se omite, el resultado se escribe
sobre la tabla `input` — útil para "enriquecer la misma tabla" sin
inventar nombres en cascada. Para los otros kinds (sql_query, join, sort)
sigue siendo obligatorio.

### Parámetros: globales y locales

Dos niveles de declaración:

1. **Globales** (`configs/parameters.json`, gestionados desde la sección
   "Parámetros de Ejecución" del sidebar):
   - Compartidos entre TODOS los proyectos.
   - Mismo shape `{parameters: [ParamSpec], presets: [ParamPreset]}`.
   - Endpoints `GET /api/parameters` y `PUT /api/parameters` (reemplazo
     completo).
   - Cargados al startup en `AppState.global_params`.

2. **Locales del proyecto** (`EtlConfig.parameters` y `EtlConfig.presets`):
   - Específicos del proyecto, viven en su JSON.
   - Editables desde "Propiedades del proyecto → Parámetros + respuestas".

**Merge** (hecho en `create_job` y en `public::run_project` antes de
spawnear): local pisa global por nombre. El motor de sustitución ve la
unión, así un proyecto puede usar `:FechaDesde` sin declararla si está
declarada globalmente.

`ParamSpec`: `{name, kind, label?, description?}` donde
kind = `date | number | text | list_number | list_text`.
`ParamPreset`: `{name, description?, values: {paramName: ParamValue}}`
para guardar respuestas (ej. "Year to Date" setea FechaDesde+FechaHasta).

Uso en SQL/expresiones: `:NombreDelParametro`. El motor sustituye **antes**
de despachar al backend SQL (en `engine/mod.rs`):
- `date / text` → quoted, `'2025-12-31'`.
- `number / list_number` → sin quotes.
- En contexto `IN (:Lista)` se expande a `IN (v1, v2, v3)` automáticamente
  (detección de IN scaneando hacia atrás en el output buffer).
- Respeta strings, comentarios y `::cast` de Postgres.

El **prompt de parámetros** (`ParameterPromptDialog`) aparece al apretar
Ejecutar si el subset de pasos a ejecutar referencia al menos un `:param`
(buscando en la unión local+global). Permite tildar uno o varios presets
(locales primero, después globales con prefijo "(global)" en la
descripción; se mergean en orden — el último gana) y overridear
manualmente. Carga listas desde Excel via
`POST /api/parameters/parse-excel` (lee 1ª columna de la 1ª hoja con
calamine, salta header si parece etiqueta).

### Exposición como API REST por proyecto

Sección "API REST · exponer proyecto" en el editor de Diseño. El config
admite:
```
api: {
  exposed: bool,                // default false
  token: Option<String>,        // header X-API-Token o Authorization: Bearer
  export_datasets: [step_id],   // datasets que devuelve cuando termina ok
  accept_parameters: bool,      // default true
}
```
Endpoints públicos: `POST /api/public/projects/:slug/run` (responde inmediato
con `{ok, job_id}`) y `GET /api/public/jobs/:id` (estado + progreso +
result con datasets si terminó ok). Slug = filename sin `.json`.

### Schema DB de runs

```
runs              (job_id PK, config_name, config_display_name, user_name,
                   debug, status, started_at, finished_at, duration_ms,
                   total_steps)
step_runs         (job_id, step_uid PK, step_id, kind, group_name, status,
                   started_at, finished_at, duration_ms, row_count, error)
step_logs         (job_id, step_uid, ts, level, line)
step_datasets     (job_id, step_uid PK, name, level, table_name, row_count,
                   size_bytes, created_at)
cases             (id PK seq, title, description, severity, assignee, creator,
                   status, created_at, closed_at, closed_by)
case_datasets     (case_id, job_id, step_uid PK, added_at, added_by)
case_comments    (id PK seq, case_id, author, body, created_at)
schedules         (id PK seq, name, config_name, enabled, spec_json,
                   created_by, created_at, last_fired_at)
roadmap_items     (id PK seq, title, description, severity, status,
                   created_by, created_at, updated_at)
roadmap_comments  (id PK seq, item_id, author, body, created_at)
```

Datasets persistidos: tabla física `log_<job_short>_<uid>` con CREATE TABLE
+ insert por filas. El nombre real lo gestiona el RunStore.

### Endpoints REST principales

```
GET    /api/health
GET    /api/configs                                lista proyectos
POST   /api/configs                                crear (filename + config)
GET    /api/configs/slug?from=...                  slugify para nuevo proyecto
GET    /api/configs/:name                          JSON del proyecto
PUT    /api/configs/:name                          update
DELETE /api/configs/:name

POST   /api/jobs                                   {config_name, user, debug,
                                                    target_steps, stop_on_failure,
                                                    use_preload, existing_job_id,
                                                    parameters}
GET    /api/jobs                                   in-memory recientes
GET    /api/jobs/:id
POST   /api/jobs/:id/cancel
POST   /api/jobs/:id/drain                         cancela Pending/Ready,
                                                    deja terminar Running
POST   /api/jobs/:id/cancel-step/:step_id          cancela uno; Running con
                                                    sql_session dispara KILL
GET    /api/jobs/:id/ws                            WebSocket eventos vivos

GET    /api/connections                            con `default` y `is_default`
POST   /api/connections                            crear
PUT    /api/connections/:name                      editar (conserva password
                                                    si el body NO la trae)
DELETE /api/connections/:name
POST   /api/connections/:name/test
POST   /api/connections/reload                     refresca el snapshot del pool
GET    /api/connections/:name/tables               introspección
GET    /api/connections/:name/tables/:table/columns (con is_primary_key)

POST   /api/sql/check                              valida sintaxis sin
                                                    ejecutar (DuckDB usa
                                                    prepare; SQL Server usa
                                                    SET NOEXEC ON/OFF)
GET    /api/parameters                              parámetros + presets globales
PUT    /api/parameters                              reemplaza todo + persiste
POST   /api/parameters/parse-excel                 lee 1ª columna del xlsx
GET    /api/constants                               constantes globales {groups, constants}
PUT    /api/constants                               reemplaza todo + persiste
POST   /api/ai/build-step                          NL → step JSON
POST   /api/ai/review-sql                          sugerencias sobre un SQL
GET    /api/ai/available                           {available: bool}

GET    /api/users  /  POST  /  DELETE :name  /  POST /reload

GET    /api/runs                                   histórico desde DB
DELETE /api/runs/:id                               bloquea si hay casos abiertos
GET    /api/runs/:id/steps
GET    /api/runs/:id/steps/:uid/logs
GET    /api/runs/:id/datasets
GET    /api/runs/:id/datasets/:uid/preview
GET    /api/runs/:id/datasets/:uid/export?format=csv|xlsx
GET    /api/runs/:id/bundle                        zip de todos los datasets

GET|POST|DELETE /api/configs/:name/preload         status / import zip / clear

GET    /api/cases / POST / :id close / comments / datasets ...

GET    /api/schedules / POST / PATCH :id / DELETE :id

GET|POST /api/roadmap                               listar / crear
PATCH    /api/roadmap/:id  /  DELETE
GET|POST /api/roadmap/:id/comments

GET    /api/sql-monitor/:connection                 procesos activos MSSQL
POST   /api/sql-monitor/:connection/kill/:session_id

# Public API (por proyecto, requiere api.exposed = true)
POST   /api/public/projects/:slug/run               {parameters, debug?}
GET    /api/public/jobs/:id                         {status, progress, result?}
```

### Eventos WebSocket (tagged union, serde tag="type")

```
job_started, step_state_changed, step_progress, step_log, step_completed,
step_sql_session, job_eta, job_finished
```

## Features implementadas (al día de la sesión)

### Modo Diseño (`/design`, `/design/new`, `/design/[name]`)
- **Layout**: lienzo arriba de todo (es lo primero que ve el usuario).
  Debajo: panel de logs/sample del paso seleccionado, StepEditor del
  paso, y un panel **"Propiedades del proyecto"** colapsable (cerrado
  por default) que contiene nombre/versión, grupos, parámetros locales
  + respuestas, y exposición API.
- DAG visual editable: multi-select (Ctrl/Shift + click o marquee),
  arrastrar puerto para crear deps, click derecho con context menus
  diferenciados (background / nodo / grupo).
- **Vista dual del lienzo**: dos íconos en la esquina superior derecha
  (`▢` = solo nodos / `▦` = nodos + tablas). En modo "nodos + tablas",
  cada paso muestra a su derecha un mini-card con el `output_table` que
  produce. Si hay datos persistidos del último run, el card queda
  clickeable y abre un modal con el preview (vía `datasetPreview`).
- 10 kinds de step con editores visuales: sql_query (con introspección
  de conexiones/tablas/columnas + check sintaxis + Milhouse-AI review),
  sql_exec, join, lookup, transform, filter_and_subset, sort, procedural
  (Rhai|Rust), export, **union**.
- **Grupos anidados** (`parent_group`): el padre engloba a los hijos
  automáticamente en el layout. Expand/collapse por grupo, "Crear grupo
  con N pasos seleccionados", "Eliminar grupo (preservar pasos)" o
  eliminar todo.
- **Parámetros** locales + globales: `:nombre` con sustitución automática.
  En "Propiedades del proyecto" hay un sub-bloque para parámetros locales
  y una nota explicando el merge con globales. El `ParametersPanel` está
  **separado en 2 tabs** (Parámetros · Respuestas guardadas). En la tab
  de Respuestas, cada preset muestra checkbox por parámetro del proyecto
  — sólo los tildados van al `values` del preset (omitir = se completa
  con otro preset o lo pide al usuario al ejecutar). Contador
  `X / N parámetros` visible. Backend ya lo soportaba (`HashMap`); UI lo
  hace evidente.
- **API REST por proyecto**: toggle `api.exposed`, token opcional, lista
  de datasets a exportar.
- Lienzo con badges de estado por paso (idle/ready/running pulsante/
  done/failed/skipped/cancelled), badge rojo `!` si paso SQL sin
  conexión asignada.
- Ejecución parcial: "Ejecutar este paso / hasta acá / desde acá / todo
  el grupo / todo el proyecto". Re-ejecutar parcial reusa el mismo
  `job_id` (corrida histórica), conserva badges previos.
- **"Ejecutar desde Datos Importados"** (cuando hay bundle): corre todo
  excepto los pasos preloadeados. Las tablas importadas alimentan los
  downstream sin reejecutar sus fuentes.
- Panel "Ejecución" debajo del lienzo con tabs Logs / Datos de salida
  para el paso seleccionado.
- **Cola de ejecución en vivo** (`RunQueuePanel`): aparece al lanzar y
  **persiste después de terminar** (no se auto-cierra). Buckets
  Ejecutando / Esperando / Terminadas / Fallidas / Canceladas /
  Salteadas. Cada item Running muestra clock vivo (`1.2 s` / `2m 30s`,
  tick 1s) y `SPID NN` en cyan si la query corre contra SQL Server.
  Cada item Done muestra `N filas · duración` (formato es-AR). Header
  con totales `· N filas · Σ duración`. Botones globales mientras está
  activo: **⏸ Drenar pendientes**, **⏹ Cancelar todo**. Botón ✕ por
  paso (Running con SPID dispara `KILL`). Cuando termina, el panel
  esconde los botones de cancelar y muestra **"✕ Limpiar y cerrar"**
  que borra el estado local — los datos persistidos siguen disponibles
  en Revisión.
- **Parámetros de ejecución del proyecto** (sub-bloque en Propiedades):
  `settings.max_parallel_steps` — input numérico. Vacío = sin límite;
  `1` = serial. El scheduler respeta este cap al spawnear; los ready
  que no caben quedan en cola con estado Ready.
- Cancelar job activo (botón ⏹ y opción en menú del nodo). DuckDB
  usa `interrupt_handle()`; SQL Server con `sql_session` capturado
  manda `KILL <SPID>` via lease paralelo del pool; MySQL/ODBC liberan
  el cliente (cancel suave).
- **Nodos importados de bundle**: badge "📦 IMPORTADO" con borde cyan
  punteado en el lienzo. Al importar, se lanza un job parcial que sólo
  "ejecuta" los preloadeados (refresca state visual + persiste datasets).
- Export/import zip de datasets de una corrida (offline dev). El botón
  "⬇ Exportar bundle" usa `activeJobId ?? lastJobId` así sigue habilitado
  después de que el job terminó. Si hay pasos `sql_query`/`sql_exec`
  raíz (sin `depends_on`) sin datos en la última corrida, dialog de
  confirmación listándolos: "El bundle se exporta igual, quien lo
  importe tendrá que ejecutar esos pasos contra una base".

### Editor SQL
- Modo visual (selects/where/order) **+ modo manual** que conserva el
  texto pegado. Toggle "🪄 Visual / ✎ SQL manual" + detecta paste y
  cambia solo. **Elegir una tabla en el combobox fuerza modo visual**:
  el SELECT se reconstruye desde los controles con todas las columnas.
- **Combobox de tabla con búsqueda incremental** (`TableCombobox.tsx`):
  el usuario tipea y filtra por substring case-insensitive sobre
  `schema.name`. Ranking: match exacto > prefijo de qualified > prefijo
  de name > substring. Navegación ↑↓, Enter para elegir, Esc cierra.
  Si el texto no matchea, Enter persiste el string libre (útil para
  vistas dinámicas o tablas con permisos restringidos).
- **Default de conexión en pasos SQL nuevos**: al agregar un
  `sql_query` o `sql_exec`, prefijamos `connection` con la última usada
  (persistida en `localStorage` con clave `milhouse.lastUsedConnection`).
  `DesignEditor.updateStep` la actualiza cada vez que el usuario asigna
  una conexión a un paso SQL.
- **Indentar**: tokenizer real (preserva strings/comentarios), rompe en
  cláusulas, columnas, AND/OR de top-level; BETWEEN no rompe en su AND.
- **Chequear sintaxis**: prepare en DuckDB; `SET NOEXEC ON/OFF` en
  SQL Server. Badge verde / rojo (con el error del parser) / gris si no
  se pudo chequear.
- **Sanity check local**: badge ⚠ ámbar en vivo si hay paréntesis o
  comillas desbalanceadas (sin llamar al backend).
- **✨ Revisar con Milhouse-AI**: review del SQL con sugerencias
  estructuradas (severity, title, detail, suggested_sql).
- **Fechas tipadas**: tiberius extrae `Date/DateTime/DateTime2/SmallDateTime/
  DateTimeOffset` via `FromSql` chrono → polars `Date`/`Datetime(µs)`.
  Por **default todas las columnas Datetime se truncan a `Date`**
  (normalize_temporal_columns). `sql_query.keep_time_columns: Vec<String>`
  permite preservar HH:MM:SS por nombre (match case-insensitive). En el
  editor visual aparece una sección "Columnas con hora" sólo si la tabla
  tiene columnas datetime; checkbox por columna.

### Ejecución y observabilidad
- Persistencia automática en DB de runs (debug=true).
- Logs por paso incluyen línea de "→ enviando SQL a `<conn>` <SQL>"
  con timestamp y SQL completo (truncado a 4000 chars).
- Mensaje de error mejorado en `tabla no encontrada`: lista tablas
  disponibles y sugiere revisar `depends_on`.
- Pasos en paralelo real (`tokio::spawn` por step ready). Para SQL Server,
  el pool con N clientes hace que pasos sobre la misma conexión lógica
  no se serialicen.
- Revisión: drill-down runs → steps → logs, filtros, preview.
- Bulk delete con checkboxes (bloqueado granular si hay casos abiertos).

### Otras secciones del sidebar
- **Parámetros de Ejecución**: editor de parámetros + presets GLOBALES
  (compartidos entre proyectos). Persiste en `configs/parameters.json`.
- **Constantes**: códigos canónicos globales (`configs/constants.json`).
  Agrupables. 3 kinds: `number` (sin quotes), `text` (con quotes y escape
  de `'`) y `raw_sql` (fragmento literal — útil para filtros reutilizables
  como `(GrupoID = 3004)`). Referencia en SQL: `:Grupo.Nombre`
  (`:Nombre` si está sin grupo). El motor agrega los constants al
  `ResolvedParams`; el parser de `engine/params.rs` acepta `:ident.ident`.
  Param de proyecto pisa a constante en caso de colisión por nombre.
- Casos: CRUD, comentarios, severidad, assignee, datasets adjuntos.
- Planificación: at|window|cron (worker tokio cada 60s).
- Conexiones: CRUD con test, default, propaga cambios al pool sin
  reiniciar (`pool.replace_file()` invalida cache si cambia la spec).
  Editar conserva password si el body no la trae explícita. **Test de
  conexión también reusa la password guardada** cuando el body manda
  spec sin password (o `null`/`""`): el endpoint la rellena desde el
  snapshot. Antes el botón Test fallaba cuando se editaba sin retipear.
- Monitor SQL: lista de procesos en una conexión SQL Server con badge
  `M` para sesiones de Milhouse (detectado por `application_name`),
  ver SQL completo, matar con `KILL`. **Filtros**: pills
  Todas/Solo Milhouse/Otras + caja de búsqueda free-text (busca en
  login/host/programa/db/status/cmd/SQL/SID). **Ordenamiento**:
  headers clickeables con ▲/▼ (default `elapsed_minutes` desc — más
  viejas arriba); CPU/min/SID arrancan en desc, texto en asc.
- Roadmap: pedidos de mejora con severidad / status / comentarios.
- Usuarios: CRUD simple.

### UX y robustez
- Sistema de diálogos temáticos (`DialogProvider` + `useDialog()`):
  reemplaza window.alert/confirm/prompt nativos, respeta light/dark.
- Validación en `/api/jobs`: rechaza si hay pasos SQL sin conexión o
  `:param` no resueltos (lista de nombres faltantes).
- `BackendStatusBar` arriba de toda la app: detecta back caído,
  ofrece Start (si el binario existe) o Setup + Start (compila + deps)
  vía route handlers Next.js (`/api/local/*`).
- Theme switcher (claro/oscuro), botón Cancelar con clase
  `.milhouse-btn-secondary` (contraste correcto en ambos temas). En
  tema claro usa **slate-300** sobre paneles blancos con borde
  slate-500 y texto slate-950 — slate-200 quedaba indistinguible
  del panel.
- **`.milhouse-btn-imported`**: clase del botón "Ejecutar desde Datos
  Importados". En light: cyan-700 con texto blanco y borde cyan-800
  (contraste fuerte sobre paneles blancos). En dark: cyan transparente
  con texto cyan-100 (sutil, no compite con el accent principal).
- **`SamplePanel`** (tabla de resultados): clase utilitaria
  `.milhouse-data-table` con header sticky, banding alterno usando
  tokens `--panel` / `--panel-2`, hover con accent sutil. Números
  formateados con `Intl.NumberFormat("es-AR")`: enteros sin decimales,
  decimales con 2 decimales fijos, ambos con separador de miles.
  La detección de "es columna numérica" usa el `dtype` del schema, no
  inspecciona valor por valor.
- Scripts: `setup`, `start`, `setup_and_run` (cross-platform).

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

6. **Pool por motor**: DuckDB sigue siendo single-connection (mutex)
   porque el driver no soporta queries concurrentes en una misma
   connection handle. SQL Server: pool con hasta 8 leases reusables
   (`SqlServerPool`/`SqlServerLease`). MySQL: `mysql_async::Pool`.
   ODBC: single-connection mutex. El `ConnectionPool` cachea por nombre,
   lazy; al hacer CRUD por API, invalida cache si la spec cambió.

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
   Tailwind hardcodeadas. Clases utilitarias: `.milhouse-field` para
   inputs, `.milhouse-codeblock` para code blocks oscuros,
   `.milhouse-btn-secondary` para botones neutros con contraste correcto
   en ambos temas (slate-200 en light, slate-800 en dark).

10. **Sustitución de parámetros** se hace **antes** de despachar al
    motor (en `engine/mod.rs`). Esto significa: el motor SQL recibe el
    texto ya con los valores embebidos, no usa parámetros nativos del
    driver. Ventaja: funciona idéntico contra los 4 backends. Ventaja:
    el SQL del log es exactamente lo que se ejecutó. Costo: hay que
    sanitizar/escapar bien (lo hacemos para strings simples; lista en
    `IN (...)` se expande).

11. **API pública por proyecto**: separada en `src/api/public.rs` para
    no contaminar el handler interno. Cada config decide qué expone.
    El endpoint `/run` responde inmediato; `/jobs/:id` poll-friendly.
    Si el job ya no está en memoria, recupera estado desde la DB de runs.

12. **case-insensitive lookup de la conexión `runs`**: `RunStore::open`
    busca cualquier conexión cuyo `name` coincida con "runs" sin importar
    case (admite "Runs", "RUNS", etc). Histórico de un fix porque el
    usuario la había renombrado a "Runs".

13. **Parámetros globales + locales**: el split se eligió para que
    parámetros usados en *muchos* proyectos (FechaDesde, FechaHasta,
    Comitente típicamente) se definan **una sola vez** y se compartan,
    pero que un proyecto pueda overridear si necesita semántica
    distinta. El merge se hace en el handler (`create_job`,
    `public::run_project`), no en el motor. Esto permite que el motor
    siga viendo un único `cfg.parameters` y `cfg.presets`, sin saber del
    origen. El usuario en la UI los distingue: locales se editan en
    "Propiedades del proyecto" del Diseño; globales en la sección
    "Parámetros de Ejecución" del sidebar.

14. **Cap de paralelismo por proyecto** (`cfg.settings.max_parallel_steps`):
    el supervisor mantiene una cola `to_launch` y antes de spawnear chequea
    `running_count < max`. Los que no caben quedan en la cola con state
    `Ready` (la UI los muestra como "Esperando"). Cuando termina un step,
    se reintenta drenar. `None` ⇒ sin cap.

15. **Control granular del job** (`JobControl { drain, cancel_step_ids,
    notify }`): el supervisor usa `tokio::select!` entre `rx.recv()`,
    `cancel.cancelled()` y `notify.notified()`. El frontend dispara
    `request_drain` o `request_cancel_step` y el supervisor despierta
    aunque no haya mensajes de step en vuelo. **Drain** marca todos los
    Pending/Ready como Cancelled. **Cancel-step** acepta también Running
    si el step tiene `sql_session`: lanza `KILL <SPID>` via lease paralelo
    del pool — el cliente que tiene la query libera el lease cuando
    detecta el error del servidor.

16. **Captura del SPID**: en `sql_query.rs`, antes del `simple_query` del
    usuario, se ejecuta `SELECT @@SPID` **en el mismo lease** (mismo
    cliente físico = misma sesión TDS). El SID se emite via
    `ProgressReporter::sql_session` y queda en `StepInfo.sql_session`.
    Se limpia al pasar el step a terminal. La UI lo muestra en la cola
    como badge cyan `SPID NN`.

17. **Default datetime → date**: tiberius con feature `chrono` extrae
    `NaiveDate`/`NaiveDateTime`. polars recibe columnas tipadas `Date` y
    `Datetime(µs)`. Después se llama `normalize_temporal_columns(df,
    keep_time_columns)` que castea Datetime → Date salvo las columnas
    listadas. Razón: la gran mayoría de los reportes usa solo fecha;
    forzar Datetime contamina la UI con `00:00:00` y trae problemas de
    huso. El usuario opt-in con `keep_time_columns: ["fecha_log", ...]`.

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

### Tiberius / SqlServer pool
- `tiberius::Client` no es `Sync`, hay que envolver en `Mutex`. Por eso
  el pool guarda `Vec<SqlServerClient>` con un solo Mutex global del Vec
  + `Semaphore` para concurrencia.
- `Semaphore` no es clonable: lo envolvemos en `Arc` y usamos
  `acquire_owned()` para que el permiso viva con el lease.
- `simple_query` reporta errores como items del stream, no como `Err`
  del Future. Hay que drenar `try_next()` para capturarlos.
- El stream del `simple_query` toma préstamo mutable de la conexión:
  para hacer dos queries seguidas sobre el mismo cliente hay que cerrar
  el primer stream antes (block scope o drop explícito).

### Zip / shadowing
- En `bundle.rs`, evitar variable local `let mut zip = ...` porque
  sombra al crate `zip`. Usamos `zw` o `archive`.

### Calamine 0.26
- En esa versión los datos son `Data::*` (no `DataType::*`).
  `DateTimeIso` / `DurationIso` son strings.

### Frontend
- **Comentarios `//!` en Rust van ANTES de cualquier `pub mod`** — no podés
  meter un `pub mod` entre el `//!` y el primer item.
- **Casos a evitar para evitar 404 fantasma**: si modificás routes en
  `main.rs`, asegurate de **realmente recompilar** antes de probar. Un
  binario viejo corriendo te tira 404 sin pista clara.
- **`bg-black/30` y `bg-black/60`** se overridean para tema claro como
  panel-2 / oscuro tipo consola. Para code blocks usar `.milhouse-codeblock`
  (siempre oscuro), para logs `.milhouse-logs`.
- **Live state vs snapshot**: el WS solo manda eventos POSTERIORES a la
  conexión, así que pasos muy rápidos pueden terminar antes de que el WS
  los reciba. El `DesignEditor` combina WS con un poll cada 1.5s del
  snapshot `/api/jobs/:id` para reconciliar.
- **`activeSubset` filtra updates**: en re-ejecución parcial, solo
  aplicamos updates de los pasos del subset; el resto conserva su badge
  previo (no pisar con "skipped" del nuevo run).

## Cómo arrancar todo (sanity check)

Modo más rápido (en uno solo):
```powershell
.\scripts\setup_and_run.ps1      # Windows
```
```bash
./scripts/setup_and_run.sh        # Mac/Linux
```

Separado:
```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```
```bash
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

Variables de entorno opcionales:
- `ANTHROPIC_API_KEY`: habilita Milhouse-AI (build-step y review-sql).
- `MILHOUSE_BIND`, `MILHOUSE_CONFIGS_DIR`, `MILHOUSE_CONNECTIONS_PATH`,
  `MILHOUSE_USERS_PATH`, `MILHOUSE_GLOBAL_PARAMS_PATH` para overridear
  paths/puertos del server.

## Sesión: estado al cierre

Última cosa que se hizo:
- **Constantes globales** (nueva sección "📐 Constantes" en el sidebar).
  `configs/constants.json` con `groups[]` + `constants[]{name, group?,
  kind, value, description?}`. 3 kinds: `number`, `text`, `raw_sql`
  (útil para filtros reutilizables tipo `(GrupoID = 3004)`).
  Referencia en SQL: `:Grupo.Nombre` (o `:Nombre` sin grupo). El
  parser de `engine/params.rs` acepta `:ident.ident`. `ResolvedParams`
  ahora también guarda constantes; render con prioridad
  param > constante en colisión. Endpoints `GET|PUT /api/constants`.
  AppState con `global_constants` (RwLock) + path env
  `MILHOUSE_GLOBAL_CONSTANTS_PATH`. `JobOptions.constants` snapshot
  en cada lanzamiento.
- **Alineación numérica en tablas**: `SamplePanel` corrige bug del
  `<th>` con `text-left` + `text-right` simultáneos (gana ahora el
  condicional). `RunsReviewPanel` recibe `align` en `Th`/`SortableTh`/
  `Td`; UID/Pasos/Filas/Duración/Tamaño van `text-right tabular-nums`.
  Filas con separador es-AR.
- **Flechas que pasan por la tabla**: en modo "nodos + tablas" del
  lienzo, la flecha de dependencia entre dos pasos sale del borde
  derecho del card de la tabla de salida (no del puerto del nodo) si
  el origen tiene `output_table`. En modo solo-nodos o si no hay
  tabla, sigue saliendo del nodo.
- **Cola de ejecución con métricas y persistencia** (tanda previa):
  clock vivo en Running, `N filas · duración` en Done, totales,
  no auto-cierre + botón "Limpiar y cerrar".
- **Exportar bundle siempre habilitado** (tanda previa): `activeJobId ??
  lastJobId`, aviso por pasos SQL raíz sin datos.
- **`.milhouse-btn-imported`** (tanda previa): contraste por tema.
- **Cap de paralelismo + cola en vivo + KILL real** (tanda previa).
- **Fechas tipadas + truncado a Date por default** (tanda previa).
- **Bundle offline funcional** (tanda previa).
- **Setup_and_run robusto** (tanda previa).

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
- **Cancel real de MySQL queries**: SQL Server ya está implementado
  (KILL del SPID al cancelar un step Running). MySQL todavía libera el
  cliente con `tokio::select!` pero la consulta sigue en el servidor.
- **review-sql con downstream context completo**: el dispatcher manda
  step_id y output_columns pero todavía no construye el grafo de
  columnas consumidas downstream. El AI hace lo que puede sin eso.

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

- `Cargo.toml` (perfiles, deps; **NO tocar lto / codegen-units**)
- `src/main.rs` (routing completo, AppState wiring)
- `src/orchestrator/scheduler.rs` (núcleo: spawn paralelo + JobOptions
  con target_steps, stop_on_failure, use_preload, params)
- `src/engine/context.rs` (ConnectionPool + SqlServerPool/Lease)
- `src/engine/params.rs` (sustitución `:nombre` con tests)
- `src/engine/mod.rs` (dispatcher; sustituye params antes de despachar)
- `src/api/routes.rs` (endpoints internos; scan_param_refs es público
  para reuso en `public.rs`)
- `src/api/public.rs` (API REST por proyecto)
- `src/runs/mod.rs` (RunStore + roadmap + bundle + case-insensitive lookup
  de la conexión `runs`)
- `src/config/schema.rs` (EtlConfig, ParamSpec/Preset/ApiConfig)
- `src/config/constants.rs` (GlobalConstantsFile, render_sql por kind,
  `:Grupo.Nombre` resolution)
- `src/config/global_params.rs` (GlobalParamsFile, read/write
  `configs/parameters.json`)
- `web/app/page.tsx` (sidebar)
- `web/components/DesignEditor.tsx` (el "cerebro" del modo Diseño)
- `web/components/DesignCanvas.tsx` (lienzo SVG)
- `web/lib/sqlFormat.ts` (tokenizer + prettyFormatSql)
