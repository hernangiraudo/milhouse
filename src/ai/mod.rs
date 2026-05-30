//! Milhouse-AI: usa la Claude API para traducir descripciones en lenguaje
//! natural a definiciones de step (JSON).

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SYSTEM_PROMPT: &str = r#"
Sos Milhouse-AI: ayudás a un usuario a construir el JSON de un PASO de ETL
en un sistema llamado Milhouse. Recibís una descripción en lenguaje natural y
devolvés ÚNICAMENTE un objeto JSON con el step. No agregues comentarios, no
expliques nada en prosa, no envuelvas en markdown.

El JSON debe tener estos campos:
- "id": string snake_case corto
- "kind": uno de "sql_query", "sql_exec", "join", "lookup", "transform",
   "filter_and_subset", "sort", "export", "procedural", "union"
- "depends_on": array de step ids previos (puede ser vacío)
- "group": string opcional (puede omitirse)
- campos específicos por kind:
  sql_query: { "query": "...", "connection": "...", "output_table": "..." }
  sql_exec:  { "query": "...", "connection": "..." }
  join:      { "left": "...", "right": "...", "left_on": ["..."],
                "right_on": ["..."], "how": "inner|left|right|full",
                "output_table": "..." }
  lookup:    { "input": "...", "master": "...", "key": "...",
                "master_key": "...", "select": [{"from":"...","as":"..."}],
                "output_table": "..." }
  transform: { "input": "...", "operations": [...], "output_table": "..." }
  filter_and_subset: { "input": "...", "filter": "expr", "select": [...],
                        "output_table": "..." }
  sort: { "input": "...", "by": [{"column":"...","desc":true|false}],
           "output_table": "..." }
  export: { "input": "...", "target": {"kind":"file","format":"csv|parquet|json","path":"..."}
            | {"kind":"duckdb","table":"...","replace":bool} }
  procedural: { "input": "...", "engine":"rhai"|"rust", "script": "..." (rhai)
                | "fn_name": "..." (rust), "state_init": {...}, "output_table": "..." }
  union: { "inputs": ["step1","step2",...], "output_table": "..." }

Reglas importantes:
- Usá nombres de tablas/conexiones que estén en el CONTEXTO si los hay.
- Si no se especifica conexión, dejala fuera o pon "default" como conexión.
- output_table debe ser único entre pasos.
- depends_on usa los step ids del contexto que correspondan.

NUNCA hagas:
- "input": null o cadena vacía. El campo `input` es OBLIGATORIO y debe
  ser el step_id (o nombre de tabla) que produce los datos a procesar.
  Aplica a: lookup, transform, filter_and_subset, sort, export, procedural.
- Steps procedural sin input. El procedural ITERA filas de una tabla; sin
  input no puede correr. Si no hay tabla de entrada, NO uses procedural.
- Scripts rhai que solo declaran variables locales sin retornar/escribir
  filas. El script de rhai en procedural se ejecuta una vez por fila y
  debe devolver la fila (eventualmente modificada) o null para descartar.

PARÁMETROS Y SUSTITUCIÓN DINÁMICA (importante)
==============================================
El motor sustituye `:nombre` por el valor del parámetro ANTES de despachar
el SQL. Lista de reglas:
- `:FechaDesde` → 'YYYY-MM-DD' con quotes si es date/text.
- `:Comitente` (number)  → literal sin quotes.
- `:Lista` (list_number) → expansion en IN(...): "WHERE c IN (:Lista)"
  se transforma a "WHERE c IN (1, 2, 3)" automáticamente. Fuera de IN
  se renderiza coma-separada.
- `:Grupo.Nombre` → constante global (sin quotes si number/raw_sql,
  con quotes si text). Las constantes raw_sql sirven para predicados
  reutilizables: `WHERE :Filtros.OpcionYFuturo` se expande a la
  expresión literal definida.

Por eso, para construir un WHERE con parámetro, NO uses procedural ni
sql_exec previo: poné el `:param` directamente en el sql_query. Ejemplos:

  Mal:
    procedural { script: "let w = ...; if params.Comitente != null { ... }" }
    + sql_query depende { query: "... WHERE " + w }
  Bien:
    sql_query { query: "SELECT * FROM tx WHERE ComitenteNumero IN (:Comitente)" }

Si la consulta debe variar entre "incluir filtro" y "no incluirlo" según
el valor del parámetro, no es problema del AI: el operador maneja eso con
otro parámetro booleano o con dos respuestas (presets) distintas.

Si la descripción del usuario es ambigua o pide algo que no encaja en
ningún kind, devolvé el step más razonable que SÍ ejecute (preferir
sql_query con `:param` antes que procedural).
"#;

#[derive(Debug, Deserialize)]
pub struct BuildStepReq {
    pub description: String,
    /// Step ids previos (para depends_on).
    #[serde(default)]
    pub existing_step_ids: Vec<String>,
    /// Map step_id → output_table (para que el AI use nombres reales).
    #[serde(default)]
    pub existing_tables: Value,
    /// Conexiones disponibles (nombre + tipo).
    #[serde(default)]
    pub connections: Value,
    /// Tablas conocidas en una conexión (opcional).
    #[serde(default)]
    pub known_tables: Value,
}

#[derive(Debug, Serialize)]
pub struct BuildStepResp {
    pub step: Value,
    /// El texto crudo devuelto por Claude por si la UI quiere mostrarlo.
    pub raw: String,
}

pub async fn build_step(req: BuildStepReq) -> Result<BuildStepResp> {
    let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
        anyhow!(
            "ANTHROPIC_API_KEY no está configurada en el server. \
             Setea la variable de entorno y reiniciá el backend."
        )
    })?;

    let user_msg = format!(
        "CONTEXTO\n========\nSteps existentes (ids): {}\n\
         Tablas existentes (step_id → output_table): {}\n\
         Conexiones disponibles: {}\n\
         Tablas conocidas: {}\n\n\
         DESCRIPCIÓN DEL USUARIO\n========================\n{}\n\n\
         Devolveme SOLO el JSON del step.",
        serde_json::to_string(&req.existing_step_ids).unwrap_or_else(|_| "[]".into()),
        serde_json::to_string(&req.existing_tables).unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(&req.connections).unwrap_or_else(|_| "[]".into()),
        serde_json::to_string(&req.known_tables).unwrap_or_else(|_| "[]".into()),
        req.description,
    );

    // Primer intento.
    let (step_value_1, raw_1) =
        call_anthropic_for_step(&api_key, SYSTEM_PROMPT, &user_msg, &[]).await?;
    let (step_value, raw) = match validate_step(&step_value_1) {
        Ok(()) => (step_value_1, raw_1),
        Err(validation_err) => {
            tracing::info!(
                "AI generó un step inválido ({validation_err}); reintentando con feedback"
            );
            // Retry: le mandamos el JSON inválido + el error para que corrija.
            let prior = vec![
                ("assistant".to_string(), raw_1.clone()),
                (
                    "user".to_string(),
                    format!(
                        "Ese JSON no es válido para Milhouse:\n  {validation_err}\n\n\
                         Corregilo y devolveme SOLO el JSON corregido (sin comentarios, \
                         sin markdown). Revisá especialmente:\n\
                         - el campo `input` no puede ser null ni vacío.\n\
                         - los nombres de campos respetan el shape declarado en el system prompt.\n\
                         - si el step no encaja en ningún kind, preferí sql_query con `:param`\n\
                           directamente en la query antes que procedural.",
                    ),
                ),
            ];
            let (step_value_2, raw_2) =
                call_anthropic_for_step(&api_key, SYSTEM_PROMPT, &user_msg, &prior).await?;
            match validate_step(&step_value_2) {
                Ok(()) => (step_value_2, raw_2),
                Err(e) => {
                    return Err(anyhow!(
                        "El AI no logró generar un step válido después de 2 intentos. \
                         Último error: {e}.\nÚltimo intento:\n{}",
                        raw_2.chars().take(800).collect::<String>()
                    ));
                }
            }
        }
    };

    Ok(BuildStepResp {
        step: step_value,
        raw,
    })
}

/// Hace una llamada a Anthropic devolviendo el JSON ya parseado + el texto
/// crudo. `prior_turns` permite encadenar mensajes (para retries con
/// feedback del error de validación).
async fn call_anthropic_for_step(
    api_key: &str,
    system_prompt: &str,
    user_msg: &str,
    prior_turns: &[(String, String)],
) -> Result<(Value, String)> {
    let mut messages = vec![json!({ "role": "user", "content": user_msg })];
    for (role, content) in prior_turns {
        messages.push(json!({ "role": role, "content": content }));
    }

    let body = json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 2048,
        "system": system_prompt,
        "messages": messages,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .context("calling Anthropic API")?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Anthropic API {}: {}",
            status,
            body_text.chars().take(500).collect::<String>()
        ));
    }
    let body_json: Value =
        serde_json::from_str(&body_text).context("parsing Anthropic response")?;
    let raw = body_json
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        })
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if raw.is_empty() {
        return Err(anyhow!(
            "Respuesta de Anthropic sin contenido textual: {}",
            body_text.chars().take(500).collect::<String>()
        ));
    }
    let cleaned = strip_code_fence(&raw);
    let step: Value = serde_json::from_str(cleaned).map_err(|e| {
        anyhow!(
            "Claude no devolvió JSON válido ({e}). Texto recibido: {}",
            cleaned.chars().take(500).collect::<String>()
        )
    })?;
    Ok((step, raw))
}

/// Valida el JSON contra el schema de Step. Devuelve un error legible si
/// no parsea o si tiene problemas comunes que el motor rechazaría
/// después (input null/vacío, etc).
fn validate_step(v: &Value) -> std::result::Result<(), String> {
    // Para que `step_uid` no sea requerido en este parse, lo asignamos
    // sintéticamente si no está. El motor real lo asigna al cargar.
    let mut v = v.clone();
    if let Value::Object(map) = &mut v {
        if !map.contains_key("step_uid") {
            map.insert("step_uid".into(), Value::Null);
        }
    }
    // Parse contra el shape canónico.
    serde_json::from_value::<crate::config::Step>(v.clone())
        .map(|_| ())
        .map_err(|e| format!("{e}"))?;
    // Reglas extra que serde acepta pero el motor rechaza después.
    if let Some(input) = v.get("input") {
        if matches!(input, Value::Null) {
            return Err("el campo `input` no puede ser null".into());
        }
        if input.as_str().map(|s| s.is_empty()).unwrap_or(false) {
            return Err("el campo `input` no puede ser una cadena vacía".into());
        }
    }
    Ok(())
}

// =====================================================================
// Milhouse-AI · Modificar un paso existente
// =====================================================================

const MODIFY_SYSTEM_PROMPT: &str = r#"
Sos Milhouse-AI: ayudás a modificar un PASO de ETL existente en el sistema
Milhouse. Recibís el JSON actual del paso y una instrucción en lenguaje natural
de lo que hay que cambiar. Devolvés ÚNICAMENTE el JSON modificado del paso,
con los mismos campos invariantes (id, step_uid, kind, depends_on, group, etc.)
salvo que la instrucción pida explícitamente cambiarlos.

Reglas:
- Mantené el `id` y el `step_uid` del paso original tal como están.
- Mantené el `kind` salvo que se pida explícitamente cambiarlo.
- Aplicá SOLO los cambios que pida la instrucción; dejá el resto igual.
- Devolvé SOLO el JSON del paso. Sin comentarios, sin markdown, sin prosa.
- Respetá todos los shapes y reglas del system prompt de build_step.
- Si el paso falló y te dan un error, analizá la causa y corregí el paso.

SHAPES POR KIND (igual que en build_step):
  sql_query: { "query": "...", "connection": "...", "output_table": "..." }
  sql_exec:  { "query": "...", "connection": "..." }
  join:      { "left": "...", "right": "...", "left_on": ["..."],
                "right_on": ["..."], "how": "inner|left|right|full",
                "output_table": "..." }
  lookup:    { "input": "...", "master": "...", "key": "...",
                "master_key": "...", "select": [{"from":"...","as":"..."}],
                "output_table": "..." }
  transform: { "input": "...", "operations": [...], "output_table": "..." }
  filter_and_subset: { "input": "...", "filter": "expr", "select": [...],
                        "output_table": "..." }
  sort: { "input": "...", "by": [{"column":"...","desc":true|false}],
           "output_table": "..." }
  export: { "input": "...", "target": {...} }
  procedural: { "input": "...", "engine":"rhai"|"rust", "script": "...",
                "state_init": {...}, "output_table": "..." }
  union: { "inputs": ["step1","step2",...], "output_table": "..." }
"#;

#[derive(Debug, Deserialize)]
pub struct ModifyStepReq {
    /// JSON actual del paso.
    pub current_step: Value,
    /// Instrucción en lenguaje natural de qué cambiar.
    pub instruction: String,
    /// Error del último run de este paso (opcional, para debugging).
    #[serde(default)]
    pub last_error: Option<String>,
    /// Step ids de todos los pasos del proyecto.
    #[serde(default)]
    pub existing_step_ids: Vec<String>,
    /// Map step_id → output_table.
    #[serde(default)]
    pub existing_tables: Value,
    /// Conexiones disponibles.
    #[serde(default)]
    pub connections: Value,
}

#[derive(Debug, Serialize)]
pub struct ModifyStepResp {
    pub step: Value,
    pub raw: String,
}

pub async fn modify_step(req: ModifyStepReq) -> Result<ModifyStepResp> {
    let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
        anyhow!(
            "ANTHROPIC_API_KEY no está configurada en el server. \
             Setea la variable de entorno y reiniciá el backend."
        )
    })?;

    let error_section = match &req.last_error {
        Some(e) if !e.trim().is_empty() => format!(
            "\nERROR DEL ÚLTIMO RUN\n====================\n{}\n",
            e.chars().take(2000).collect::<String>()
        ),
        _ => String::new(),
    };

    let user_msg = format!(
        "PASO ACTUAL (JSON)\n==================\n{}\n\
         CONTEXTO DEL PROYECTO\n=====================\n\
         Steps existentes (ids): {}\n\
         Tablas existentes (step_id → output_table): {}\n\
         Conexiones disponibles: {}\n\
         {}\
         INSTRUCCIÓN DEL USUARIO\n=======================\n{}\n\n\
         Devolveme SOLO el JSON del paso modificado.",
        serde_json::to_string_pretty(&req.current_step)
            .unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(&req.existing_step_ids).unwrap_or_else(|_| "[]".into()),
        serde_json::to_string(&req.existing_tables).unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(&req.connections).unwrap_or_else(|_| "[]".into()),
        error_section,
        req.instruction,
    );

    let (step_value_1, raw_1) =
        call_anthropic_for_step(&api_key, MODIFY_SYSTEM_PROMPT, &user_msg, &[]).await?;

    // Preservar id y step_uid del original.
    let step_value_1 = preserve_identity(step_value_1, &req.current_step);

    let (step_value, raw) = match validate_step(&step_value_1) {
        Ok(()) => (step_value_1, raw_1),
        Err(validation_err) => {
            tracing::info!(
                "AI generó un step modificado inválido ({validation_err}); reintentando"
            );
            let prior = vec![
                ("assistant".to_string(), raw_1.clone()),
                (
                    "user".to_string(),
                    format!(
                        "Ese JSON no es válido para Milhouse:\n  {validation_err}\n\n\
                         Corregilo y devolveme SOLO el JSON corregido (sin comentarios, \
                         sin markdown).",
                    ),
                ),
            ];
            let (step_value_2, raw_2) =
                call_anthropic_for_step(&api_key, MODIFY_SYSTEM_PROMPT, &user_msg, &prior).await?;
            let step_value_2 = preserve_identity(step_value_2, &req.current_step);
            match validate_step(&step_value_2) {
                Ok(()) => (step_value_2, raw_2),
                Err(e) => {
                    return Err(anyhow!(
                        "El AI no logró generar un step válido después de 2 intentos. \
                         Último error: {e}.\nÚltimo intento:\n{}",
                        raw_2.chars().take(800).collect::<String>()
                    ));
                }
            }
        }
    };

    Ok(ModifyStepResp { step: step_value, raw })
}

/// Preserva `id` y `step_uid` del paso original en el JSON devuelto por el AI.
fn preserve_identity(mut generated: Value, original: &Value) -> Value {
    if let (Value::Object(gen), Value::Object(orig)) = (&mut generated, original) {
        if let Some(id) = orig.get("id") {
            gen.insert("id".into(), id.clone());
        }
        if let Some(uid) = orig.get("step_uid") {
            gen.insert("step_uid".into(), uid.clone());
        }
    }
    generated
}

fn strip_code_fence(s: &str) -> &str {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix("```json") {
        return rest.trim_start_matches('\n').trim_end_matches("```").trim();
    }
    if let Some(rest) = s.strip_prefix("```") {
        return rest.trim_start_matches('\n').trim_end_matches("```").trim();
    }
    s
}

// =====================================================================
// Milhouse-AI · Revisar SQL y sugerir mejoras
// =====================================================================

const REVIEW_SYSTEM_PROMPT: &str = r#"
Sos Milhouse-AI revisor de SQL. Te dan UNA consulta SQL del paso actual y el
contexto del proyecto ETL (los otros pasos, qué columnas consumen aguas
abajo). Tu tarea: detectar problemas y sugerir mejoras.

Cosas a buscar:
- Columnas seleccionadas que NUNCA se usan en los pasos siguientes.
- Joins innecesarios (la tabla de la derecha no aporta columnas usadas).
- WHERE/ORDER BY redundantes (mismo predicado se vuelve a aplicar después).
- SELECT * cuando solo se usan pocas columnas.
- Tipos incorrectos (string donde un cast a int simplificaría joins).
- Subconsultas que se pueden colapsar a CTE.
- Falta de filtros que podrían empujarse para reducir rows tempranamente.
- Sintaxis del motor target (DuckDB, MySQL, SQL Server) — flagear funciones
  no portables si hay riesgo.

Devolvé ÚNICAMENTE un JSON con este shape:
{
  "summary": "una frase resumen",
  "severity": "info" | "warn" | "major",
  "suggestions": [
    {
      "title": "frase corta del problema",
      "detail": "explicación clara con ejemplos",
      "severity": "info"|"warn"|"major",
      "suggested_sql": "SQL mejorado opcional (puede ser null)"
    },
    ...
  ]
}

Si la consulta está bien, devolvé suggestions: [] y severity: "info".
NO devuelvas markdown, NO uses code fences, NO expliques fuera del JSON.
"#;

#[derive(Debug, Deserialize)]
pub struct ReviewSqlReq {
    /// SQL a revisar.
    pub sql: String,
    /// Step id del paso actual (para identificarse en el contexto).
    #[serde(default)]
    pub step_id: Option<String>,
    /// Connection type ("duckdb"|"sql_server"|"mysql"|"odbc") para que el
    /// modelo conozca el dialecto.
    #[serde(default)]
    pub connection_type: Option<String>,
    /// Lista resumida de pasos siguientes (los que dependen de éste,
    /// directa o transitivamente) con qué columnas consumen.
    /// Shape: [{step_id, kind, columns_used: [...], summary: "..."}].
    #[serde(default)]
    pub downstream: Value,
    /// Schema declarado de la output_table de este paso (si se conoce).
    #[serde(default)]
    pub output_columns: Value,
}

#[derive(Debug, Serialize)]
pub struct ReviewSqlResp {
    pub review: Value,
    pub raw: String,
}

pub async fn review_sql(req: ReviewSqlReq) -> Result<ReviewSqlResp> {
    let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
        anyhow!(
            "ANTHROPIC_API_KEY no está configurada en el server. \
             Setea la variable de entorno y reiniciá el backend."
        )
    })?;

    let user_msg = format!(
        "PASO ACTUAL\n===========\nstep_id: {}\nmotor: {}\n\
         columnas de salida (si se conocen): {}\n\n\
         SQL\n===\n{}\n\n\
         CONTEXTO AGUAS ABAJO\n=====================\n\
         (qué pasos consumen este output y qué columnas usan)\n{}\n\n\
         Revisá y devolveme SOLO el JSON con tu análisis.",
        req.step_id.as_deref().unwrap_or("(sin id)"),
        req.connection_type.as_deref().unwrap_or("desconocido"),
        serde_json::to_string(&req.output_columns).unwrap_or_else(|_| "[]".into()),
        req.sql,
        serde_json::to_string_pretty(&req.downstream).unwrap_or_else(|_| "[]".into()),
    );

    let body = json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 2048,
        "system": REVIEW_SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": user_msg,
        }],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .context("calling Anthropic API")?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Anthropic API {}: {}",
            status,
            body_text.chars().take(500).collect::<String>()
        ));
    }
    let body_json: Value =
        serde_json::from_str(&body_text).context("parsing Anthropic response")?;
    let raw = body_json
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        })
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if raw.is_empty() {
        return Err(anyhow!(
            "Respuesta de Anthropic sin contenido textual: {}",
            body_text.chars().take(500).collect::<String>()
        ));
    }
    let cleaned = strip_code_fence(&raw);
    let review: Value = serde_json::from_str(cleaned).map_err(|e| {
        anyhow!(
            "Claude no devolvió JSON válido ({e}). Texto recibido: {}",
            cleaned.chars().take(500).collect::<String>()
        )
    })?;
    Ok(ReviewSqlResp { review, raw })
}
