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
   "filter_and_subset", "sort", "export", "procedural"
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
  procedural: { "input": "...", "engine":"rhai"|"rust", ... }

Reglas importantes:
- Usá nombres de tablas/conexiones que estén en el CONTEXTO si los hay.
- Si no se especifica conexión, dejala fuera o pon "default" como conexión.
- output_table debe ser único entre pasos.
- depends_on usa los step ids del contexto que correspondan.
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

    let body = json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 2048,
        "system": SYSTEM_PROMPT,
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
    // Anthropic responde { content: [{type:"text", text:"..."}], ... }
    let raw = body_json
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
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
    // Limpiar code fences si vienen.
    let cleaned = strip_code_fence(&raw);
    let step: Value = serde_json::from_str(cleaned).map_err(|e| {
        anyhow!(
            "Claude no devolvió JSON válido ({e}). Texto recibido: {}",
            cleaned.chars().take(500).collect::<String>()
        )
    })?;
    Ok(BuildStepResp { step, raw })
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
