use super::{ProcCtx, ProceduralFn};
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use polars::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

pub struct Registry {
    fns: HashMap<&'static str, Arc<dyn ProceduralFn>>,
}

impl Registry {
    pub fn get(&self, name: &str) -> Option<Arc<dyn ProceduralFn>> {
        self.fns.get(name).cloned()
    }
    pub fn names(&self) -> Vec<&'static str> {
        self.fns.keys().copied().collect()
    }
}

static REGISTRY: Lazy<Registry> = Lazy::new(|| {
    let mut fns: HashMap<&'static str, Arc<dyn ProceduralFn>> = HashMap::new();
    fns.insert("fraud_scoring_v1", Arc::new(FraudScoringV1));
    fns.insert("running_balance_v1", Arc::new(RunningBalanceV1));
    Registry { fns }
});

pub fn global() -> &'static Registry {
    &REGISTRY
}

// =====================================================================
// fraud_scoring_v1
//
// Itera transacciones, mantiene un acumulador por cuenta y marca como
// sospechosas:
//   - amount > threshold (param) AND país de la tx ≠ país de la cuenta
//   - O bien si en una ventana corta se acumulan muchas tx grandes para
//     la misma cuenta (proxy de comportamiento anómalo).
//
// Espera columnas: account_id, amount, country, account_country.
// Devuelve la tabla original + columnas score (f64) y is_suspicious (bool).
// =====================================================================
pub struct FraudScoringV1;

impl ProceduralFn for FraudScoringV1 {
    fn process(
        &self,
        df: &DataFrame,
        params: &serde_json::Value,
        ctx: &mut ProcCtx,
    ) -> Result<DataFrame> {
        let threshold = params
            .get("threshold")
            .and_then(|v| v.as_f64())
            .unwrap_or(5000.0);

        let n = df.height();
        let account_id = df.column("account_id")?.cast(&DataType::Int64)?;
        let account_id = account_id.i64()?;
        let amount = df.column("amount")?.cast(&DataType::Float64)?;
        let amount = amount.f64()?;
        let country = df.column("country")?.str()?.clone();
        let acc_country = df.column("account_country")?.str()?.clone();

        let mut score_out = Vec::with_capacity(n);
        let mut flag_out = Vec::with_capacity(n);

        let mut count_large_per_account: HashMap<i64, u32> = HashMap::new();
        let mut sum_per_account: HashMap<i64, f64> = HashMap::new();
        let mut total_flagged: u64 = 0;

        let report_every = (n / 100).max(1000);
        let mut last_report = 0usize;

        for i in 0..n {
            if i % 4096 == 0 && ctx.is_cancelled() {
                return Err(anyhow!("cancelled"));
            }
            let acc = account_id.get(i).unwrap_or(-1);
            let amt = amount.get(i).unwrap_or(0.0);
            let c_tx = country.get(i).unwrap_or("");
            let c_acc = acc_country.get(i).unwrap_or("");

            let cnt = count_large_per_account.entry(acc).or_insert(0);
            let sum = sum_per_account.entry(acc).or_insert(0.0);
            *sum += amt;

            let mut score = 0.0_f64;
            let mut sus = false;
            if amt > threshold {
                score += 0.4;
                if c_tx != c_acc {
                    score += 0.5;
                }
                *cnt += 1;
                if *cnt >= 3 {
                    score += 0.2;
                }
            }
            if score > 0.7 {
                sus = true;
                total_flagged += 1;
            }
            score_out.push(score.min(1.0));
            flag_out.push(sus);

            if i - last_report >= report_every {
                ctx.report_progress(i + 1);
                last_report = i;
            }
        }
        ctx.report_progress(n);
        ctx.log(format!(
            "fraud_scoring_v1: flagged={} / {} ({:.2}%)",
            total_flagged,
            n,
            (total_flagged as f64) * 100.0 / (n.max(1) as f64)
        ));

        let mut out = df.clone();
        out.with_column(Series::new("score".into(), score_out))?;
        out.with_column(Series::new("is_suspicious".into(), flag_out))?;
        Ok(out)
    }
}

// =====================================================================
// running_balance_v1
//
// Mantiene balance acumulado por account_id. Espera columnas:
//   account_id, amount, timestamp (cualquier tipo, se asume orden previo)
// Agrega columna: balance (f64).
// =====================================================================
pub struct RunningBalanceV1;

impl ProceduralFn for RunningBalanceV1 {
    fn process(
        &self,
        df: &DataFrame,
        _params: &serde_json::Value,
        ctx: &mut ProcCtx,
    ) -> Result<DataFrame> {
        let n = df.height();
        let account_id = df.column("account_id")?.cast(&DataType::Int64)?;
        let account_id = account_id.i64()?;
        let amount = df.column("amount")?.cast(&DataType::Float64)?;
        let amount = amount.f64()?;
        let mut balance: HashMap<i64, f64> = HashMap::new();
        let mut out_col = Vec::with_capacity(n);
        let report_every = (n / 100).max(1000);
        let mut last_report = 0usize;

        for i in 0..n {
            if i % 4096 == 0 && ctx.is_cancelled() {
                return Err(anyhow!("cancelled"));
            }
            let acc = account_id.get(i).unwrap_or(-1);
            let amt = amount.get(i).unwrap_or(0.0);
            let b = balance.entry(acc).or_insert(0.0);
            *b += amt;
            out_col.push(*b);
            if i - last_report >= report_every {
                ctx.report_progress(i + 1);
                last_report = i;
            }
        }
        ctx.report_progress(n);
        let mut out = df.clone();
        out.with_column(Series::new("balance".into(), out_col))?;
        Ok(out)
    }
}
