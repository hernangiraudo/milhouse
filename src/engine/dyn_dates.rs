//! Resolución de fechas dinámicas para parámetros de kind=date.
//!
//! Sintaxis soportada:
//!   - `today`, `yesterday`, `tomorrow`
//!   - `start_of_month`, `end_of_month`
//!   - `start_of_year`, `end_of_year`
//!   - `<token> + Nd` / `<token> - Nd` (días)
//!   - `<token> + Nm` / `<token> - Nm` (meses calendario)
//!   - `<token> + Ny` / `<token> - Ny` (años)
//!
//! Devolvemos `Some(NaiveDate)` si la expresión parsea, `None` si no.
//! El caller decide qué hacer con None (típicamente: usar el string
//! tal cual asumiendo que ya es una fecha en formato YYYY-MM-DD).

use chrono::{Datelike, Duration, NaiveDate, Utc};

/// Intenta interpretar `s` como expresión dinámica. Si lo logra,
/// devuelve la fecha resuelta contra `today` (UTC). Si no matchea
/// ninguna sintaxis, devuelve None — el caller asume que el string
/// es una fecha literal.
pub fn try_resolve(s: &str) -> Option<NaiveDate> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Si parece YYYY-MM-DD o YYYY/MM/DD, no es dinámico.
    let looks_iso = trimmed.len() >= 8
        && trimmed.chars().take(4).all(|c| c.is_ascii_digit());
    if looks_iso {
        return None;
    }
    let today = Utc::now().date_naive();
    parse_expr(trimmed, today)
}

fn parse_expr(s: &str, today: NaiveDate) -> Option<NaiveDate> {
    // Buscamos el primer `+` o `-` que separa el token del offset.
    // No usamos split por simplicidad de borrowing.
    let lower = s.to_ascii_lowercase();
    let (token_str, op_pos) = {
        let mut found: Option<(usize, char)> = None;
        for (i, c) in lower.char_indices() {
            // Saltear el primer carácter (puede ser un `-` raro pero no aplica).
            if i == 0 {
                continue;
            }
            if c == '+' || c == '-' {
                found = Some((i, c));
                break;
            }
        }
        match found {
            Some((i, _)) => (lower[..i].trim().to_string(), Some(i)),
            None => (lower.clone(), None),
        }
    };

    let base = resolve_token(&token_str, today)?;
    let Some(i) = op_pos else { return Some(base) };

    let op_char = lower.as_bytes()[i] as char;
    let rest = lower[i + 1..].trim();
    let amount = parse_amount(rest)?;
    let signed = match op_char {
        '+' => amount,
        '-' => negate(amount),
        _ => return None,
    };
    apply_amount(base, signed)
}

#[derive(Debug, Clone, Copy)]
enum AmountUnit {
    Days,
    Months,
    Years,
}

fn parse_amount(s: &str) -> Option<(i64, AmountUnit)> {
    // Formato esperado: NUMBER ('d'|'m'|'y' / o las palabras enteras).
    let s = s.trim().trim_end_matches('s');
    let last = s.chars().last()?;
    let (num_part, unit) = if last.is_ascii_alphabetic() {
        let unit = match last {
            'd' => AmountUnit::Days,
            'm' => AmountUnit::Months,
            'y' => AmountUnit::Years,
            _ => return None,
        };
        (s[..s.len() - 1].trim(), unit)
    } else {
        // Sin letra de unidad: asumimos días.
        (s, AmountUnit::Days)
    };
    let n: i64 = num_part.parse().ok()?;
    Some((n, unit))
}

fn negate(a: (i64, AmountUnit)) -> (i64, AmountUnit) {
    (-a.0, a.1)
}

fn apply_amount(base: NaiveDate, (n, unit): (i64, AmountUnit)) -> Option<NaiveDate> {
    match unit {
        AmountUnit::Days => base.checked_add_signed(Duration::days(n)),
        AmountUnit::Months => add_months(base, n),
        AmountUnit::Years => add_months(base, n.checked_mul(12)?),
    }
}

/// Suma N meses calendario a una fecha. Si el día no existe en el mes
/// destino (ej. 31-ene + 1m), agarra el último día del mes.
fn add_months(base: NaiveDate, n: i64) -> Option<NaiveDate> {
    let year = base.year() as i64;
    let month = base.month() as i64;
    let day = base.day();
    let total_months = (year * 12) + (month - 1) + n;
    let new_year = total_months.div_euclid(12);
    let new_month = total_months.rem_euclid(12) as u32 + 1;
    let new_year_i32 = i32::try_from(new_year).ok()?;
    let last_day_new = last_day_of_month(new_year_i32, new_month);
    let new_day = day.min(last_day_new);
    NaiveDate::from_ymd_opt(new_year_i32, new_month, new_day)
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let next_month = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    next_month
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

fn resolve_token(token: &str, today: NaiveDate) -> Option<NaiveDate> {
    match token {
        "today" | "hoy" => Some(today),
        "yesterday" | "ayer" => today.pred_opt(),
        "tomorrow" | "manana" | "mañana" => today.succ_opt(),
        "start_of_month" | "inicio_de_mes" | "inicio_mes" => {
            NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
        }
        "end_of_month" | "fin_de_mes" | "fin_mes" => {
            let last = last_day_of_month(today.year(), today.month());
            NaiveDate::from_ymd_opt(today.year(), today.month(), last)
        }
        "start_of_year" | "inicio_de_anio" | "inicio_anio" => {
            NaiveDate::from_ymd_opt(today.year(), 1, 1)
        }
        "end_of_year" | "fin_de_anio" | "fin_anio" => {
            NaiveDate::from_ymd_opt(today.year(), 12, 31)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn iso_passes_through() {
        assert_eq!(try_resolve("2024-01-15"), None);
        assert_eq!(try_resolve("2024/01/15"), None);
    }

    #[test]
    fn token_today() {
        let r = try_resolve("today").unwrap();
        assert_eq!(r, Utc::now().date_naive());
    }

    #[test]
    fn add_days() {
        let today = Utc::now().date_naive();
        let r = parse_expr("today + 5d", today).unwrap();
        assert_eq!(r, today + Duration::days(5));
    }

    #[test]
    fn subtract_days() {
        let today = d(2024, 6, 15);
        assert_eq!(parse_expr("today - 20d", today), Some(d(2024, 5, 26)));
    }

    #[test]
    fn add_months_basic() {
        let today = d(2024, 1, 31);
        assert_eq!(parse_expr("today + 1m", today), Some(d(2024, 2, 29)));
    }

    #[test]
    fn start_of_month() {
        let today = d(2024, 6, 15);
        assert_eq!(parse_expr("start_of_month", today), Some(d(2024, 6, 1)));
    }

    #[test]
    fn end_of_month_minus_month() {
        let today = d(2024, 3, 5);
        assert_eq!(parse_expr("end_of_month - 1m", today), Some(d(2024, 2, 29)));
    }
}
