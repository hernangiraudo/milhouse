//! Constantes globales compartidas entre todos los proyectos. Se persisten
//! en `configs/constants.json`. Pensadas para valores que cambian poco y
//! se usan en muchos proyectos (códigos de tipo, IDs canónicos, etc).
//!
//! Shape:
//! ```json
//! {
//!   "groups": [
//!     {"name": "MovimientoTipoCuenta", "description": "Códigos..."}
//!   ],
//!   "constants": [
//!     {"name": "Monetaria", "group": "MovimientoTipoCuenta",
//!      "kind": "number", "value": "1"},
//!     {"name": "Titulos",   "group": "MovimientoTipoCuenta",
//!      "kind": "number", "value": "2"}
//!   ]
//! }
//! ```
//!
//! En SQL/expresiones se referencian como `:Grupo.Nombre` (las del grupo
//! `MovimientoTipoCuenta` arriba se usan `:MovimientoTipoCuenta.Monetaria`
//! y `:MovimientoTipoCuenta.Titulos`). Una constante sin grupo se
//! referencia como `:Nombre` directo.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobalConstantsFile {
    #[serde(default)]
    pub groups: Vec<ConstantGroup>,
    #[serde(default)]
    pub constants: Vec<ConstantSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstantGroup {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstantSpec {
    pub name: String,
    /// Grupo opcional. Si está presente, se referencia como `:Grupo.Nombre`.
    /// Si no, como `:Nombre`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default = "default_const_kind")]
    pub kind: ConstantKind,
    /// Representación literal del valor. Para `number`, debe parsearse a
    /// f64; para `text` es libre. La serialización SQL depende del kind.
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConstantKind {
    #[default]
    Number,
    Text,
    /// Fragmento de SQL crudo. Se inserta tal cual, sin quotes ni
    /// escapes. Útil para filtros completos, listas de IDs, predicados
    /// reutilizables, etc. Sin sanitización: la constante la define el
    /// operador del sistema, no llega del usuario.
    RawSql,
}

fn default_const_kind() -> ConstantKind {
    ConstantKind::Number
}

impl ConstantSpec {
    /// Identificador completo: `Grupo.Nombre` si tiene grupo, `Nombre` si no.
    pub fn full_name(&self) -> String {
        match &self.group {
            Some(g) => format!("{g}.{}", self.name),
            None => self.name.clone(),
        }
    }

    /// Renderizado SQL:
    /// - `number`: value sin quotes.
    /// - `text`: con quotes simples + escape de `'` → `''`.
    /// - `raw_sql`: value tal cual (sin sanitizar).
    pub fn render_sql(&self) -> String {
        match self.kind {
            ConstantKind::Number => self.value.clone(),
            ConstantKind::Text => {
                let escaped = self.value.replace('\'', "''");
                format!("'{escaped}'")
            }
            ConstantKind::RawSql => self.value.clone(),
        }
    }
}

impl GlobalConstantsFile {
    pub fn load_or_empty(path: &std::path::Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(
                "constants file {} no es JSON válido: {e}; arrancando vacío",
                path.display()
            );
            Self::default()
        })
    }

    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(self).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, format!("serialize: {e}"))
        })?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, text)
    }

    /// Map de full_name → spec, para sustitución rápida en el motor.
    pub fn into_map(&self) -> std::collections::HashMap<String, ConstantSpec> {
        self.constants
            .iter()
            .map(|c| (c.full_name(), c.clone()))
            .collect()
    }
}

/// Constantes built-in que se inyectan automáticamente al ejecutar
/// cualquier job. Se evalúan al inicio del job (no son fechas vivas que
/// cambian durante la ejecución — el primer paso y el último ven el
/// mismo valor, lo cual es lo razonable para reproducibilidad).
///
/// Si el usuario declara una constante con el mismo `full_name`, la suya
/// gana (estas son fallback). Esa lógica vive en el caller que mergea
/// `builtin_constants()` con el archivo de usuario.
pub fn builtin_constants() -> Vec<ConstantSpec> {
    use chrono::{Datelike, Utc};
    let today = Utc::now().date_naive();
    let yesterday = today.pred_opt().unwrap_or(today);
    let tomorrow = today.succ_opt().unwrap_or(today);
    let som = chrono::NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
        .unwrap_or(today);
    let eom = {
        let (y, m) = if today.month() == 12 {
            (today.year() + 1, 1)
        } else {
            (today.year(), today.month() + 1)
        };
        chrono::NaiveDate::from_ymd_opt(y, m, 1)
            .and_then(|d| d.pred_opt())
            .unwrap_or(today)
    };

    let to_iso = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();

    fn c(name: &str, group: &str, value: String, desc: &str) -> ConstantSpec {
        ConstantSpec {
            name: name.to_string(),
            group: Some(group.to_string()),
            kind: ConstantKind::Text,
            value,
            description: Some(desc.to_string()),
        }
    }
    vec![
        c(
            "Today",
            "Fecha",
            to_iso(today),
            "Fecha actual al momento de lanzar el job (formato YYYY-MM-DD)",
        ),
        c(
            "Yesterday",
            "Fecha",
            to_iso(yesterday),
            "Día anterior a hoy",
        ),
        c(
            "Tomorrow",
            "Fecha",
            to_iso(tomorrow),
            "Día siguiente a hoy",
        ),
        c(
            "StartOfMonth",
            "Fecha",
            to_iso(som),
            "Primer día del mes actual",
        ),
        c(
            "EndOfMonth",
            "Fecha",
            to_iso(eom),
            "Último día del mes actual",
        ),
        c(
            "StartOfYear",
            "Fecha",
            chrono::NaiveDate::from_ymd_opt(today.year(), 1, 1)
                .map(to_iso)
                .unwrap_or_default(),
            "Primer día del año actual",
        ),
        c(
            "EndOfYear",
            "Fecha",
            chrono::NaiveDate::from_ymd_opt(today.year(), 12, 31)
                .map(to_iso)
                .unwrap_or_default(),
            "Último día del año actual",
        ),
    ]
}

/// Mergea las built-in con las del archivo de usuario. Si el usuario
/// declaró una constante con el mismo `full_name`, la suya gana.
pub fn merge_with_builtins(user_constants: &[ConstantSpec]) -> Vec<ConstantSpec> {
    let user_names: std::collections::HashSet<String> =
        user_constants.iter().map(|c| c.full_name()).collect();
    let mut out: Vec<ConstantSpec> = user_constants.to_vec();
    for b in builtin_constants() {
        if !user_names.contains(&b.full_name()) {
            out.push(b);
        }
    }
    out
}
