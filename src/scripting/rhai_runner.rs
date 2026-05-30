use super::{ProcCtx, ResolvedParamsForScripts};
use crate::config::{ParamKind, ParamValue};
use anyhow::{anyhow, Result};
use polars::prelude::*;
use rhai::{Dynamic, Engine, Map, Scope, AST};

/// Resultado de ejecutar un script Rhai: el DataFrame de salida + las
/// mutaciones que el script hizo sobre `params`. Los siguientes pasos
/// del job verán esos valores al sustituir `:NombreParam` en SQL.
pub struct RhaiRunResult {
    pub df: DataFrame,
    pub param_mutations: Vec<(String, ParamValue)>,
}

/// Ejecuta un script Rhai por cada fila (o una sola vez con DataFrame
/// vacío). El script recibe:
///   - `row`    : Map mutable de la fila (puede agregar/modificar campos)
///   - `state`  : Map mutable persistente entre filas (acumuladores)
///   - `params` : Map mutable con los parámetros del job. Las
///                asignaciones se propagan a pasos siguientes.
///   - debe devolver la `row` (mutada o no)
///
/// Si el DataFrame está vacío, el script se ejecuta una sola vez con
/// `row` vacía — útil para pasos que solo manipulan params/state.
pub fn run(
    df: &DataFrame,
    script: &str,
    state_init: &serde_json::Value,
    ctx: &mut ProcCtx,
) -> Result<RhaiRunResult> {
    let mut engine = Engine::new();
    engine.set_max_operations(50_000_000);
    engine.set_max_expr_depths(64, 64);
    engine.set_max_call_levels(64);

    // Redirigir `print(...)` y `debug(...)` del script al panel de logs
    // del step. Sin esto van a stdout del backend y no se ven en la UI.
    let reporter_for_print = ctx.reporter.clone();
    engine.on_print(move |s| reporter_for_print.log(s.to_string()));
    let reporter_for_debug = ctx.reporter.clone();
    engine.on_debug(move |s, src, pos| {
        let src = src.unwrap_or("script");
        reporter_for_debug.log(format!("[debug {src}:{pos:?}] {s}"));
    });

    let ast: AST = engine
        .compile(script)
        .map_err(|e| anyhow!("rhai compile error: {e}"))?;

    let mut state: Map = json_to_rhai_map(state_init)?;

    // `params.NombreParametro` accesible desde el script. Coerciona al
    // tipo nativo según el kind del spec (boolean → int 1/0, number →
    // int o float, text → string, listas → array).
    let initial_params_map: Map = params_to_rhai_map(&ctx.params_resolved);
    // Mutable a través del loop: si el script asigna `params.X = ...`,
    // las modificaciones quedan acumuladas y se aplican al StepContext
    // al terminar.
    let mut params_map: Map = initial_params_map.clone();

    let cols = df.get_columns();
    let col_names: Vec<String> = cols.iter().map(|s| s.name().to_string()).collect();
    let n = df.height();
    // Si no hay filas, igual ejecutamos el script una vez con row vacía.
    // Soporta el caso "preparar params dinámicos antes de un SQL".
    let iters = n.max(1);
    let run_once_only = n == 0;

    // Para construir el output sin saber todas las columnas finales por adelantado,
    // recolectamos las filas como vectores de (col_name, AnyValue) y luego lo
    // convertimos a Series. Para eficiencia, usamos columnas iniciales del input
    // y agregamos las nuevas en orden de aparición.
    let mut out_columns: Vec<String> = col_names.clone();
    let mut out_rows: Vec<Vec<Dynamic>> = Vec::with_capacity(n);

    let mut scope = Scope::new();
    let report_every = (iters / 100).max(1000);
    let mut last_report = 0usize;

    for i in 0..iters {
        if i % 1024 == 0 && ctx.is_cancelled() {
            return Err(anyhow!("cancelled"));
        }
        // build row map (vacío si no hay filas reales)
        let mut row = Map::new();
        if !run_once_only {
            for (idx, c) in cols.iter().enumerate() {
                let v = c.get(i).map_err(|e| anyhow!("row {i} col {}: {e}", col_names[idx]))?;
                row.insert(col_names[idx].clone().into(), anyvalue_to_dyn(v));
            }
        }

        scope.clear();
        scope.push("row", row);
        scope.push("state", state.clone());
        scope.push("params", params_map.clone());

        let returned: Dynamic = engine
            .eval_ast_with_scope::<Dynamic>(&mut scope, &ast)
            .map_err(|e| anyhow!("rhai runtime error at row {i}: {e}"))?;

        // tomar de vuelta el state mutado, los params mutados y la row resultante
        if let Some(s) = scope.get_value::<Map>("state") {
            state = s;
        }
        if let Some(p) = scope.get_value::<Map>("params") {
            params_map = p;
        }
        let row_map: Map = if returned.is_map() {
            returned.cast::<Map>()
        } else if let Some(r) = scope.get_value::<Map>("row") {
            r
        } else if run_once_only {
            // Sin DataFrame de entrada el script no necesita devolver row;
            // tratamos la salida como Map vacío (no produce filas).
            Map::new()
        } else {
            return Err(anyhow!("rhai script must return the row (a map)"));
        };

        if !run_once_only {
            // descubrir nuevas columnas
            for k in row_map.keys() {
                if !out_columns.iter().any(|c| c == k.as_str()) {
                    out_columns.push(k.to_string());
                }
            }

            let row_vec: Vec<Dynamic> = out_columns
                .iter()
                .map(|c| row_map.get(c.as_str()).cloned().unwrap_or(Dynamic::UNIT))
                .collect();
            out_rows.push(row_vec);
        }

        if i - last_report >= report_every {
            ctx.report_progress(i + 1);
            last_report = i;
        }
    }
    ctx.report_progress(n);

    // Construir series por columna (DataFrame vacío si no había input).
    let df_out = if run_once_only {
        DataFrame::empty()
    } else {
        let mut series_vec: Vec<Column> = Vec::with_capacity(out_columns.len());
        for (col_idx, col_name) in out_columns.iter().enumerate() {
            let any_values: Vec<AnyValue> = out_rows
                .iter()
                .map(|r| dyn_to_anyvalue(&r[col_idx]))
                .collect();
            let s = build_series_from_anyvalues(col_name, &any_values)?;
            series_vec.push(s.into());
        }
        DataFrame::new(series_vec)?
    };

    // Diff entre el snapshot inicial y los params resultantes: cualquier
    // valor que cambió o se agregó se convierte a ParamValue para volcar
    // al StepContext.
    let param_mutations = diff_params(&initial_params_map, &params_map, &ctx.params_resolved);

    Ok(RhaiRunResult {
        df: df_out,
        param_mutations,
    })
}

/// Detecta cambios entre el snapshot inicial del Map params y el final.
/// Para cada key que difiere (o que es nueva), construye un ParamValue
/// según el kind declarado en specs (si existe) o asume Text si no.
fn diff_params(
    before: &Map,
    after: &Map,
    resolved: &ResolvedParamsForScripts,
) -> Vec<(String, ParamValue)> {
    let mut out = Vec::new();
    for (k, v_after) in after.iter() {
        let same = before.get(k).map(|b| dyn_eq(b, v_after)).unwrap_or(false);
        if same {
            continue;
        }
        let name = k.to_string();
        let kind = resolved.specs.get(&name).map(|s| s.kind);
        let pv = dyn_to_param_value(v_after, kind);
        out.push((name, pv));
    }
    out
}

fn dyn_eq(a: &Dynamic, b: &Dynamic) -> bool {
    // Comparación robusta: stringificar y comparar. Suficiente para
    // detectar cambios; los falsos positivos solo causarían una
    // reescritura innecesaria del mismo valor.
    a.to_string() == b.to_string()
}

fn dyn_to_param_value(d: &Dynamic, kind: Option<ParamKind>) -> ParamValue {
    use crate::config::ParamKind::*;
    // Listas (Rhai array) → ParamValue::List independientemente del kind.
    if let Some(arr) = d.clone().try_cast::<rhai::Array>() {
        let items: Vec<String> = arr.iter().map(|x| dyn_to_string(x)).collect();
        return ParamValue::List(items);
    }
    let s = match kind {
        Some(Boolean) => {
            // En Rhai, 0/1 o true/false → render SQL "1"/"0".
            if let Some(b) = d.clone().try_cast::<bool>() {
                if b { "1".to_string() } else { "0".to_string() }
            } else if let Some(i) = d.clone().try_cast::<i64>() {
                if i != 0 { "1".to_string() } else { "0".to_string() }
            } else {
                dyn_to_string(d)
            }
        }
        _ => dyn_to_string(d),
    };
    ParamValue::Single(s)
}

fn dyn_to_string(d: &Dynamic) -> String {
    if let Some(s) = d.clone().try_cast::<String>() {
        s
    } else {
        d.to_string()
    }
}

fn json_to_rhai_map(v: &serde_json::Value) -> Result<Map> {
    let mut out = Map::new();
    if v.is_null() {
        return Ok(out);
    }
    let obj = v
        .as_object()
        .ok_or_else(|| anyhow!("state_init must be an object"))?;
    for (k, vv) in obj {
        out.insert(k.clone().into(), json_to_dyn(vv));
    }
    Ok(out)
}

fn json_to_dyn(v: &serde_json::Value) -> Dynamic {
    match v {
        serde_json::Value::Null => Dynamic::UNIT,
        serde_json::Value::Bool(b) => Dynamic::from(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Dynamic::from(i)
            } else if let Some(f) = n.as_f64() {
                Dynamic::from(f)
            } else {
                Dynamic::UNIT
            }
        }
        serde_json::Value::String(s) => Dynamic::from(s.clone()),
        serde_json::Value::Array(a) => Dynamic::from(a.iter().map(json_to_dyn).collect::<Vec<_>>()),
        serde_json::Value::Object(_) => {
            let m = json_to_rhai_map(v).unwrap_or_default();
            Dynamic::from(m)
        }
    }
}

fn anyvalue_to_dyn(v: AnyValue) -> Dynamic {
    match v {
        AnyValue::Null => Dynamic::UNIT,
        AnyValue::Boolean(b) => Dynamic::from(b),
        AnyValue::Int8(i) => Dynamic::from(i as i64),
        AnyValue::Int16(i) => Dynamic::from(i as i64),
        AnyValue::Int32(i) => Dynamic::from(i as i64),
        AnyValue::Int64(i) => Dynamic::from(i),
        AnyValue::UInt8(i) => Dynamic::from(i as i64),
        AnyValue::UInt16(i) => Dynamic::from(i as i64),
        AnyValue::UInt32(i) => Dynamic::from(i as i64),
        AnyValue::UInt64(i) => Dynamic::from(i as i64),
        AnyValue::Float32(f) => Dynamic::from(f as f64),
        AnyValue::Float64(f) => Dynamic::from(f),
        AnyValue::String(s) => Dynamic::from(s.to_string()),
        AnyValue::StringOwned(s) => Dynamic::from(s.to_string()),
        other => Dynamic::from(other.to_string()),
    }
}

fn dyn_to_anyvalue(d: &Dynamic) -> AnyValue<'static> {
    if d.is_unit() {
        AnyValue::Null
    } else if let Some(b) = d.clone().try_cast::<bool>() {
        AnyValue::Boolean(b)
    } else if let Some(i) = d.clone().try_cast::<i64>() {
        AnyValue::Int64(i)
    } else if let Some(f) = d.clone().try_cast::<f64>() {
        AnyValue::Float64(f)
    } else if let Some(s) = d.clone().try_cast::<String>() {
        AnyValue::StringOwned(s.into())
    } else {
        AnyValue::StringOwned(d.to_string().into())
    }
}

fn build_series_from_anyvalues(name: &str, values: &[AnyValue]) -> Result<Series> {
    // Detectar dtype dominante.
    let mut has_str = false;
    let mut has_float = false;
    let mut has_int = false;
    let mut has_bool = false;
    for v in values {
        match v {
            AnyValue::Null => {}
            AnyValue::Boolean(_) => has_bool = true,
            AnyValue::Int64(_) => has_int = true,
            AnyValue::Float64(_) => has_float = true,
            AnyValue::StringOwned(_) | AnyValue::String(_) => has_str = true,
            _ => has_str = true,
        }
    }
    let dtype = if has_str {
        DataType::String
    } else if has_float {
        DataType::Float64
    } else if has_int {
        DataType::Int64
    } else if has_bool {
        DataType::Boolean
    } else {
        DataType::String
    };
    let s = Series::from_any_values_and_dtype(name.into(), values, &dtype, true)?;
    Ok(s)
}

/// Construye un Map rhai con los parámetros resueltos, coercionando cada
/// valor según el `kind` del spec (boolean → int 1/0, number → i64/f64,
/// list_number → array de i64/f64, text/list_text → string/array).
fn params_to_rhai_map(resolved: &ResolvedParamsForScripts) -> Map {
    let mut out: Map = Map::new();
    for (name, value) in &resolved.values {
        let kind = resolved.specs.get(name).map(|s| s.kind);
        let dyn_value: Dynamic = match (kind, value) {
            (Some(ParamKind::Boolean), ParamValue::Single(s)) => {
                // 1 / 0 estrictos según el render SQL.
                if s == "1" || s.eq_ignore_ascii_case("true") {
                    1i64.into()
                } else {
                    0i64.into()
                }
            }
            (Some(ParamKind::Number), ParamValue::Single(s)) => {
                if let Ok(n) = s.parse::<i64>() {
                    n.into()
                } else if let Ok(f) = s.parse::<f64>() {
                    f.into()
                } else {
                    s.clone().into()
                }
            }
            (Some(ParamKind::ListNumber), ParamValue::List(items)) => {
                let arr: Vec<Dynamic> = items
                    .iter()
                    .map(|v| {
                        if let Ok(n) = v.parse::<i64>() {
                            n.into()
                        } else if let Ok(f) = v.parse::<f64>() {
                            f.into()
                        } else {
                            v.clone().into()
                        }
                    })
                    .collect();
                arr.into()
            }
            (_, ParamValue::Single(s)) => s.clone().into(),
            (_, ParamValue::List(items)) => {
                let arr: Vec<Dynamic> =
                    items.iter().map(|v| v.clone().into()).collect();
                arr.into()
            }
        };
        out.insert(name.as_str().into(), dyn_value);
    }
    out
}
