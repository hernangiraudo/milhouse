//! Parámetros y respuestas guardadas a nivel global (compartidos entre
//! todos los proyectos). Se persisten en `configs/parameters.json`.
//!
//! Shape:
//! ```json
//! {
//!   "parameters": [
//!     {"name": "FechaDesde", "kind": "date", "label": "Fecha desde"}
//!   ],
//!   "presets": [
//!     {"name": "YTD", "values": {"FechaDesde": "2025-12-31"}}
//!   ]
//! }
//! ```
//!
//! Al ejecutar un proyecto, el merge se hace **local pisa global por
//! nombre**: si un proyecto declara su propio `FechaDesde`, ese tiene
//! prioridad sobre el global.

use crate::config::{ParamPreset, ParamSpec};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobalParamsFile {
    #[serde(default)]
    pub parameters: Vec<ParamSpec>,
    #[serde(default)]
    pub presets: Vec<ParamPreset>,
}

impl GlobalParamsFile {
    pub fn load_or_empty(path: &std::path::Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(
                "global parameters file {} no es JSON válido: {e}; arrancando vacío",
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
}
