//! Sustitución de parámetros `:nombre` en textos (SQL/expresiones).
//!
//! Reglas:
//! - `:nombre` busca el parámetro y devuelve su renderizado SQL.
//! - Si el parámetro es lista y aparece dentro de `IN (...)`, expande
//!   a `IN (v1, v2, v3)`. Detectamos contexto IN escaneando hacia atrás
//!   los caracteres previos al `:`.
//! - Respeta strings y comentarios SQL: dentro de `'...'`, `"..."`, `-- ...`
//!   o `/* ... */` no sustituye nada.
//! - Si el texto referencia un parámetro que no está resuelto, devuelve
//!   Err con el nombre del parámetro faltante.

use crate::config::{ConstantSpec, ParamKind, ParamSpec, ParamValue};
use anyhow::{anyhow, Result};
use std::collections::HashMap;

/// Contexto resuelto para una ejecución: specs (para saber el tipo) + valores
/// de parámetros, más constantes globales (sustitución `:Grupo.Nombre`).
#[derive(Debug, Clone, Default)]
pub struct ResolvedParams {
    pub specs: HashMap<String, ParamSpec>,
    pub values: HashMap<String, ParamValue>,
    /// Constantes indexadas por `full_name` (`Grupo.Nombre` o `Nombre`).
    pub constants: HashMap<String, ConstantSpec>,
}

impl ResolvedParams {
    pub fn new(specs: &[ParamSpec], values: HashMap<String, ParamValue>) -> Self {
        let specs_map: HashMap<String, ParamSpec> = specs
            .iter()
            .map(|s| (s.name.clone(), s.clone()))
            .collect();
        Self {
            specs: specs_map,
            values,
            constants: HashMap::new(),
        }
    }

    /// Agrega constantes globales al contexto. Builder-style.
    pub fn with_constants(mut self, constants: &[ConstantSpec]) -> Self {
        self.constants = constants.iter().map(|c| (c.full_name(), c.clone())).collect();
        self
    }

    /// True si no hay parámetros declarados ni valores ni constantes — el texto se devuelve tal cual.
    pub fn is_empty(&self) -> bool {
        self.specs.is_empty() && self.values.is_empty() && self.constants.is_empty()
    }
}

/// Sustituye `:nombre` por el valor correspondiente. Devuelve error si
/// alguna referencia no está resuelta.
pub fn substitute(text: &str, params: &ResolvedParams) -> Result<String> {
    // Fast-path: si no hay parámetros declarados y el texto no contiene `:`
    // seguido de letra, no hay nada que hacer.
    if params.is_empty() && !text.contains(':') {
        return Ok(text.to_string());
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let n = bytes.len();

    enum Mode {
        Normal,
        SingleStr, // dentro de '...'
        DoubleStr, // dentro de "..."
        LineComm,  // dentro de --
        BlockComm, // dentro de /* */
    }
    let mut mode = Mode::Normal;

    while i < n {
        let c = bytes[i] as char;
        let nx = if i + 1 < n { bytes[i + 1] as char } else { '\0' };

        match mode {
            Mode::SingleStr => {
                out.push(c);
                if c == '\'' {
                    if nx == '\'' {
                        out.push(nx);
                        i += 2;
                        continue;
                    }
                    mode = Mode::Normal;
                }
                i += 1;
                continue;
            }
            Mode::DoubleStr => {
                out.push(c);
                if c == '"' {
                    mode = Mode::Normal;
                }
                i += 1;
                continue;
            }
            Mode::LineComm => {
                out.push(c);
                if c == '\n' {
                    mode = Mode::Normal;
                }
                i += 1;
                continue;
            }
            Mode::BlockComm => {
                out.push(c);
                if c == '*' && nx == '/' {
                    out.push(nx);
                    i += 2;
                    mode = Mode::Normal;
                    continue;
                }
                i += 1;
                continue;
            }
            Mode::Normal => {
                if c == '\'' {
                    out.push(c);
                    mode = Mode::SingleStr;
                    i += 1;
                    continue;
                }
                if c == '"' {
                    out.push(c);
                    mode = Mode::DoubleStr;
                    i += 1;
                    continue;
                }
                if c == '-' && nx == '-' {
                    out.push(c);
                    out.push(nx);
                    i += 2;
                    mode = Mode::LineComm;
                    continue;
                }
                if c == '/' && nx == '*' {
                    out.push(c);
                    out.push(nx);
                    i += 2;
                    mode = Mode::BlockComm;
                    continue;
                }
                // Posible parámetro: `:nombre` donde nombre = [A-Za-z_][A-Za-z0-9_]*
                if c == ':' && is_ident_start(nx) {
                    // Evitar `::` (cast estilo Postgres) — si la char previa es
                    // también `:`, no es un parámetro.
                    // Aquí ya copiamos el primer `:` si fue cast. Lo manejamos:
                    if i + 1 < n && bytes[i + 1] as char == ':' {
                        out.push(c);
                        i += 1;
                        continue;
                    }
                    // Si la char previa que escribimos fue `:`, tampoco — es cast.
                    if out.ends_with(':') {
                        out.push(c);
                        i += 1;
                        continue;
                    }
                    // Leer el nombre. Aceptamos un `.ident` opcional para
                    // referencias a constantes agrupadas (`:Grupo.Nombre`).
                    let mut end = i + 1;
                    while end < n && is_ident_cont(bytes[end] as char) {
                        end += 1;
                    }
                    if end < n
                        && bytes[end] as char == '.'
                        && end + 1 < n
                        && is_ident_start(bytes[end + 1] as char)
                    {
                        end += 1; // consumir `.`
                        while end < n && is_ident_cont(bytes[end] as char) {
                            end += 1;
                        }
                    }
                    let name = &text[i + 1..end];
                    // Sustituir.
                    let rendered = render_param(name, params, &out)?;
                    out.push_str(&rendered);
                    i = end;
                    continue;
                }
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(out)
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}
fn is_ident_cont(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn render_param(name: &str, params: &ResolvedParams, out_so_far: &str) -> Result<String> {
    // Resolución:
    //   1. Si el nombre tiene `.`, sólo busca en constantes (`Grupo.Nombre`).
    //   2. Sin `.`: busca primero como parámetro (más específico al proyecto),
    //      después como constante sin grupo. El parámetro gana al colisionar.
    if name.contains('.') {
        let c = params
            .constants
            .get(name)
            .ok_or_else(|| anyhow!("constante `:{}` no resuelta", name))?;
        return Ok(c.render_sql());
    }
    if let Some(value) = params.values.get(name) {
        let spec = params.specs.get(name);
        let kind = spec.map(|s| s.kind);
        let quote = match kind {
            Some(ParamKind::Number)
            | Some(ParamKind::ListNumber)
            | Some(ParamKind::Boolean) => false,
            _ => true,
        };
        let in_context = detect_in_context(out_so_far);
        return Ok(value.render_sql(quote, in_context));
    }
    if let Some(c) = params.constants.get(name) {
        return Ok(c.render_sql());
    }
    Err(anyhow!("parámetro `:{}` no resuelto", name))
}

fn detect_in_context(s: &str) -> bool {
    // recortar espacios al final
    let trimmed = s.trim_end_matches(|c: char| c.is_whitespace());
    if !trimmed.ends_with('(') {
        return false;
    }
    let before_paren = trimmed[..trimmed.len() - 1].trim_end_matches(|c: char| c.is_whitespace());
    // Tomar los últimos 2 chars como palabra
    let tail: String = before_paren
        .chars()
        .rev()
        .take(2)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    tail.eq_ignore_ascii_case("IN")
        && before_paren.len() >= 2
        && !before_paren
            .as_bytes()
            .get(before_paren.len().saturating_sub(3))
            .map(|b| (*b as char).is_alphanumeric() || *b == b'_')
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn rp(specs: Vec<ParamSpec>, vals: Vec<(&str, ParamValue)>) -> ResolvedParams {
        let mut map = HashMap::new();
        for (k, v) in vals {
            map.insert(k.to_string(), v);
        }
        ResolvedParams::new(&specs, map)
    }

    #[test]
    fn date_substitution() {
        let p = rp(
            vec![ParamSpec {
                name: "FechaDesde".into(),
                kind: ParamKind::Date,
                label: None,
                description: None,
            }],
            vec![(
                "FechaDesde",
                ParamValue::Single("2024-01-01".to_string()),
            )],
        );
        let out = substitute("WHERE date >= :FechaDesde", &p).unwrap();
        assert_eq!(out, "WHERE date >= '2024-01-01'");
    }

    #[test]
    fn list_in_context() {
        let p = rp(
            vec![ParamSpec {
                name: "Comitente".into(),
                kind: ParamKind::ListNumber,
                label: None,
                description: None,
            }],
            vec![(
                "Comitente",
                ParamValue::List(vec!["1".into(), "2".into(), "3".into()]),
            )],
        );
        let out = substitute("WHERE id IN (:Comitente)", &p).unwrap();
        assert_eq!(out, "WHERE id IN (1, 2, 3)");
    }

    #[test]
    fn cast_double_colon_ignored() {
        let p = rp(vec![], vec![]);
        let out = substitute("SELECT now()::timestamp", &p).unwrap();
        assert_eq!(out, "SELECT now()::timestamp");
    }

    #[test]
    fn inside_string_not_substituted() {
        let p = rp(
            vec![ParamSpec {
                name: "X".into(),
                kind: ParamKind::Text,
                label: None,
                description: None,
            }],
            vec![("X", ParamValue::Single("hola".into()))],
        );
        let out = substitute("SELECT ':X' AS lit, :X AS val", &p).unwrap();
        assert_eq!(out, "SELECT ':X' AS lit, 'hola' AS val");
    }

    #[test]
    fn missing_param_errors() {
        let p = rp(vec![], vec![]);
        let err = substitute("SELECT :X", &p).unwrap_err();
        assert!(err.to_string().contains(":X"));
    }
}
