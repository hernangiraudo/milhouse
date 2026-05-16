use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EtlConfig {
    pub name: String,
    #[serde(default = "default_version")]
    pub version: u32,
    /// Deprecated: las conexiones se definen en `configs/connections.json`.
    /// Si está presente, se ignora con un warning en el log.
    #[serde(default)]
    pub duckdb_path: Option<String>,
    /// Metadata opcional para los grupos referenciados por `Step.group`.
    /// Cada grupo se infiere del set de valores `group` en los steps; esta
    /// sección permite agregar `description` o `color` por grupo.
    #[serde(default)]
    pub groups: Vec<GroupMeta>,
    /// Parámetros del proyecto. Se usan como `:nombre` en SQL/expresiones y
    /// se resuelven al ejecutar (UI prompt + presets guardados).
    #[serde(default)]
    pub parameters: Vec<ParamSpec>,
    /// Respuestas pre-guardadas a uno o varios parámetros. Una preset puede
    /// resolver más de un parámetro a la vez (ej. "Year to Date" setea
    /// FechaDesde y FechaHasta).
    #[serde(default)]
    pub presets: Vec<ParamPreset>,
    /// Configuración para exponer el proyecto como API REST pública.
    #[serde(default)]
    pub api: ApiConfig,
    /// Parámetros generales de ejecución del proyecto.
    #[serde(default)]
    pub settings: ProjectSettings,
    pub steps: Vec<Step>,
}

/// Parámetros generales que afectan cómo corre el scheduler para este
/// proyecto. Pensado para crecer (timeouts, retries, etc).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectSettings {
    /// Cantidad máxima de pasos que pueden correr en paralelo dentro de
    /// un job de este proyecto. `None` → sin límite (lanza todos los
    /// ready). Útil cuando el SQL Server pega contra throughput o cuando
    /// el operador quiere bajar la carga.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel_steps: Option<usize>,
}

/// Configuración para exponer el proyecto vía `/api/public/projects/:slug`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiConfig {
    /// Si false (default), los endpoints públicos rechazan este proyecto.
    #[serde(default)]
    pub exposed: bool,
    /// Token opcional. Si está presente, los requests deben mandarlo en el
    /// header `X-API-Token` (o `Authorization: Bearer ...`). Si está
    /// ausente, el endpoint es público sin auth (asume que el operador
    /// pone Milhouse detrás de un proxy autenticado).
    #[serde(default)]
    pub token: Option<String>,
    /// step_ids cuyos datasets se devuelven en la respuesta de
    /// /api/public/jobs/:id cuando el job termina ok. Si vacío, no se
    /// devuelven datasets (solo status).
    #[serde(default)]
    pub export_datasets: Vec<String>,
    /// Si true (default), el endpoint /run espera parámetros en el body.
    /// Si false, ignora `parameters` del body.
    #[serde(default = "default_true")]
    pub accept_parameters: bool,
}

fn default_true() -> bool {
    true
}

/// Tipo de parámetro. Determina cómo se renderiza en la UI y cómo se
/// sustituye en los textos.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParamKind {
    /// Fecha simple. UI: date picker. Sustitución: 'YYYY-MM-DD' con quotes.
    Date,
    /// Número. UI: input number. Sustitución: literal sin quotes.
    Number,
    /// Texto libre. UI: input. Sustitución: 'valor escapado'.
    Text,
    /// Lista de números. UI: textarea + carga desde Excel. Sustitución:
    /// dentro de `IN (...)` se expande a `IN (1, 2, 3)`; fuera es coma-separada.
    ListNumber,
    /// Lista de strings.
    ListText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSpec {
    pub name: String,
    pub kind: ParamKind,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// Valor resuelto de un parámetro. Lo que se sustituye en el SQL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Single(String),
    List(Vec<String>),
}

impl ParamValue {
    /// Renderiza el valor para sustitución en SQL. `quote` indica si los
    /// strings se rodean con comillas simples (true para Date/Text, false
    /// para Number).
    pub fn render_sql(&self, quote: bool, in_list_context: bool) -> String {
        match self {
            ParamValue::Single(v) => {
                if quote {
                    format!("'{}'", v.replace('\'', "''"))
                } else {
                    v.clone()
                }
            }
            ParamValue::List(items) => {
                let rendered: Vec<String> = items
                    .iter()
                    .map(|v| {
                        if quote {
                            format!("'{}'", v.replace('\'', "''"))
                        } else {
                            v.clone()
                        }
                    })
                    .collect();
                if in_list_context {
                    // Lo de adentro de un IN(...) — sin paréntesis extras.
                    rendered.join(", ")
                } else {
                    rendered.join(", ")
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamPreset {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Valores resueltos por nombre de parámetro.
    pub values: HashMap<String, ParamValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMeta {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Color hex sugerido (opcional). Si no, la UI elige.
    #[serde(default)]
    pub color: Option<String>,
    /// Grupo padre (anidado). Si está presente, el lienzo dibuja el padre
    /// abarcando todos los nodos y sub-grupos.
    #[serde(default)]
    pub parent_group: Option<String>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// Identidad estable de máquina. Se asigna automáticamente al cargar el
    /// config la primera vez (si no está presente) y se persiste en el JSON.
    /// Las dependencias en runtime se resuelven por uid: si el `id` legible
    /// cambia, las referencias a sus runs históricos siguen funcionando.
    #[serde(default)]
    pub step_uid: Option<u32>,
    /// Nombre legible (puede cambiar; el uid es la identidad estable).
    pub id: String,
    /// Lista de dependencias declaradas por `id` legible (lo que el usuario
    /// escribe en el JSON). En runtime se resuelven al `step_uid` correspondiente.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Etiqueta de agrupación opcional. Steps con el mismo `group` se muestran
    /// juntos en la UI (colapsables en el DAG, subsección en el Kanban).
    #[serde(default)]
    pub group: Option<String>,
    /// Nivel de log con el que se emiten TODOS los mensajes informativos
    /// de este step (default: info). Los errores reales del motor quedan
    /// siempre en `error`, independientemente de este valor.
    #[serde(default)]
    pub log_level: LogLevel,
    /// Nombre "de fantasía" del dataset persistido cuando se ejecuta en debug.
    /// Solo es etiqueta para la UI; el nombre real de la tabla en la DB de
    /// runs sigue siendo `log_<job>_<step_uid>`. Si no se especifica, se usa
    /// el `output_table` del step.
    #[serde(default)]
    pub dataset_name: Option<String>,
    #[serde(flatten)]
    pub spec: StepSpec,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    #[default]
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepSpec {
    SqlQuery {
        query: String,
        /// Nombre de la conexión declarada en `connections.json`.
        /// Si se omite, se usa la conexión `default`.
        #[serde(default)]
        connection: Option<String>,
        output_table: String,
        /// Nombres de columnas que deben **mantener** la hora.
        /// Por default, todas las columnas datetime se truncan a fecha
        /// (es lo que sirve en la enorme mayoría de los casos). Si una
        /// columna necesita HH:MM:SS, listala acá. Match case-insensitive.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        keep_time_columns: Vec<String>,
    },
    /// Ejecuta SQL DML/DDL contra la base sin traer resultados a Milhouse.
    /// Soporta múltiples sentencias separadas por `;` (ejecutadas en orden).
    /// Útil para CREATE TABLE ... AS SELECT, INSERT INTO ... SELECT, UPDATE,
    /// DELETE, CREATE INDEX, etc. — efectos que viven en la DB.
    SqlExec {
        query: String,
        #[serde(default)]
        connection: Option<String>,
    },
    Join {
        left: String,
        right: String,
        left_on: Vec<String>,
        right_on: Vec<String>,
        #[serde(default = "default_join_how")]
        how: JoinHow,
        output_table: String,
    },
    Lookup {
        input: String,
        master: String,
        key: String,
        master_key: String,
        #[serde(default)]
        select: Vec<LookupSelect>,
        /// Si se omite, el resultado modifica la tabla `input` (in-place
        /// lógico: sobreescribe la entrada en el TableStore y permite
        /// liberar la versión anterior).
        #[serde(default)]
        output_table: Option<String>,
    },
    Transform {
        input: String,
        operations: Vec<TransformOp>,
        /// Si se omite, el resultado modifica la tabla `input`.
        #[serde(default)]
        output_table: Option<String>,
    },
    FilterAndSubset {
        input: String,
        #[serde(default)]
        filter: Option<String>,
        #[serde(default)]
        select: Vec<String>,
        /// Si se omite, el resultado modifica la tabla `input`.
        #[serde(default)]
        output_table: Option<String>,
    },
    Sort {
        input: String,
        by: Vec<SortBy>,
        output_table: String,
    },
    Export {
        input: String,
        target: ExportTarget,
    },
    Procedural {
        input: String,
        engine: ProceduralEngine,
        #[serde(default)]
        script: Option<String>,
        #[serde(default)]
        fn_name: Option<String>,
        #[serde(default)]
        params: serde_json::Value,
        #[serde(default)]
        state_init: serde_json::Value,
        /// Si se omite, el resultado modifica la tabla `input`.
        #[serde(default)]
        output_table: Option<String>,
    },
    /// Apila N datasets (vstack). Esquema final = unión de columnas; donde
    /// un dataset no tiene una columna, se completa con NULL. Útil para
    /// juntar particiones con shape similar.
    Union {
        inputs: Vec<String>,
        output_table: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JoinHow {
    Inner,
    Left,
    Right,
    Full,
}

fn default_join_how() -> JoinHow {
    JoinHow::Inner
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupSelect {
    pub from: String,
    #[serde(rename = "as", default)]
    pub alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TransformOp {
    ToDate {
        column: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(rename = "as", default)]
        alias: Option<String>,
    },
    Cast {
        column: String,
        to: String,
        #[serde(rename = "as", default)]
        alias: Option<String>,
    },
    Uppercase {
        column: String,
        #[serde(rename = "as", default)]
        alias: Option<String>,
    },
    Lowercase {
        column: String,
        #[serde(rename = "as", default)]
        alias: Option<String>,
    },
    Rename {
        column: String,
        to: String,
    },
    AddConstant {
        column: String,
        value: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortBy {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportTarget {
    File {
        format: ExportFormat,
        path: String,
    },
    Duckdb {
        table: String,
        #[serde(default)]
        replace: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Parquet,
    Json,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProceduralEngine {
    Rhai,
    Rust,
}

impl Step {
    pub fn kind_str(&self) -> &'static str {
        match &self.spec {
            StepSpec::SqlQuery { .. } => "sql_query",
            StepSpec::SqlExec { .. } => "sql_exec",
            StepSpec::Join { .. } => "join",
            StepSpec::Lookup { .. } => "lookup",
            StepSpec::Transform { .. } => "transform",
            StepSpec::FilterAndSubset { .. } => "filter_and_subset",
            StepSpec::Sort { .. } => "sort",
            StepSpec::Export { .. } => "export",
            StepSpec::Procedural { .. } => "procedural",
            StepSpec::Union { .. } => "union",
        }
    }

    pub fn output_table(&self) -> Option<&str> {
        match &self.spec {
            StepSpec::SqlQuery { output_table, .. }
            | StepSpec::Join { output_table, .. }
            | StepSpec::Sort { output_table, .. }
            | StepSpec::Union { output_table, .. } => Some(output_table.as_str()),
            // Para los kinds que aceptan modificar in-place: si el usuario no
            // dio output_table, el resultado va a la misma tabla input.
            StepSpec::Lookup {
                input,
                output_table,
                ..
            }
            | StepSpec::Transform {
                input,
                output_table,
                ..
            }
            | StepSpec::FilterAndSubset {
                input,
                output_table,
                ..
            }
            | StepSpec::Procedural {
                input,
                output_table,
                ..
            } => Some(output_table.as_deref().unwrap_or(input.as_str())),
            StepSpec::Export { .. } | StepSpec::SqlExec { .. } => None,
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("duplicated step id: {0}")]
    DuplicateStepId(String),
    #[error("step {step} depends on unknown step {dep}")]
    UnknownDependency { step: String, dep: String },
    #[error("DAG contains a cycle")]
    Cycle,
    #[error("procedural step {0} with engine=rhai must provide `script`")]
    MissingScript(String),
    #[error("procedural step {0} with engine=rust must provide `fn_name`")]
    MissingFnName(String),
}

impl EtlConfig {
    pub fn from_json_str(s: &str) -> Result<Self, ConfigError> {
        let cfg: Self = serde_json::from_str(s)?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Asigna `step_uid` a cada step que no tenga uno, usando como base
    /// max(existing) + 1. Devuelve `true` si al menos uno fue asignado
    /// (es decir, el archivo en disco debería re-escribirse).
    pub fn ensure_step_uids(&mut self) -> bool {
        let mut max_uid: u32 = self
            .steps
            .iter()
            .filter_map(|s| s.step_uid)
            .max()
            .unwrap_or(0);
        let mut changed = false;
        for s in &mut self.steps {
            if s.step_uid.is_none() {
                max_uid = max_uid.saturating_add(1);
                s.step_uid = Some(max_uid);
                changed = true;
            }
        }
        changed
    }

    /// Mapa id legible → step_uid. Requiere `ensure_step_uids` antes.
    pub fn id_to_uid(&self) -> std::collections::HashMap<String, u32> {
        self.steps
            .iter()
            .filter_map(|s| s.step_uid.map(|u| (s.id.clone(), u)))
            .collect()
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        // ids únicos
        let mut seen: HashSet<&str> = HashSet::new();
        for s in &self.steps {
            if !seen.insert(s.id.as_str()) {
                return Err(ConfigError::DuplicateStepId(s.id.clone()));
            }
        }
        // deps existen
        for s in &self.steps {
            for d in &s.depends_on {
                if !seen.contains(d.as_str()) {
                    return Err(ConfigError::UnknownDependency {
                        step: s.id.clone(),
                        dep: d.clone(),
                    });
                }
            }
            // procedural: script o fn_name según engine
            if let StepSpec::Procedural {
                engine,
                script,
                fn_name,
                ..
            } = &s.spec
            {
                match engine {
                    ProceduralEngine::Rhai if script.is_none() => {
                        return Err(ConfigError::MissingScript(s.id.clone()));
                    }
                    ProceduralEngine::Rust if fn_name.is_none() => {
                        return Err(ConfigError::MissingFnName(s.id.clone()));
                    }
                    _ => {}
                }
            }
        }
        // sin ciclos: DFS coloring
        let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
        for s in &self.steps {
            graph.insert(
                s.id.as_str(),
                s.depends_on.iter().map(String::as_str).collect(),
            );
        }
        let mut color: HashMap<&str, u8> = HashMap::new(); // 0=white,1=gray,2=black
        for s in &self.steps {
            if !dfs_no_cycle(s.id.as_str(), &graph, &mut color) {
                return Err(ConfigError::Cycle);
            }
        }
        Ok(())
    }
}

fn dfs_no_cycle<'a>(
    node: &'a str,
    graph: &HashMap<&'a str, Vec<&'a str>>,
    color: &mut HashMap<&'a str, u8>,
) -> bool {
    match color.get(node).copied().unwrap_or(0) {
        2 => return true,
        1 => return false,
        _ => {}
    }
    color.insert(node, 1);
    if let Some(deps) = graph.get(node) {
        for d in deps {
            if !dfs_no_cycle(d, graph, color) {
                return false;
            }
        }
    }
    color.insert(node, 2);
    true
}
