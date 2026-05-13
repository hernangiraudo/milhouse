use anyhow::Result;
use chrono::{Duration as ChronoDuration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use clap::Parser;
use duckdb::{params, Connection};
use rand::distributions::WeightedIndex;
use rand::prelude::*;
use std::path::PathBuf;

#[derive(Parser, Debug)]
struct Args {
    /// Ruta del archivo .duckdb a crear
    #[arg(long, default_value = "data/demo.duckdb")]
    out: String,
    /// Cantidad de transacciones a generar
    #[arg(long, default_value_t = 50_000)]
    rows: usize,
    /// Cantidad de cuentas a generar
    #[arg(long, default_value_t = 500)]
    accounts: usize,
}

const CURRENCIES: &[(&str, &str, f64)] = &[
    ("USD", "$", 1.0),
    ("EUR", "€", 1.1),
    ("ARS", "$", 0.0010),
    ("BRL", "R$", 0.2),
    ("GBP", "£", 1.3),
    ("JPY", "¥", 0.007),
    ("CNY", "¥", 0.14),
    ("MXN", "$", 0.057),
    ("CLP", "$", 0.0011),
    ("UYU", "$U", 0.025),
];

const COUNTRIES: &[&str] = &["AR", "BR", "UY", "CL", "MX", "US", "GB", "DE", "JP", "CN"];

const CATEGORIES: &[(&str, Option<i32>)] = &[
    ("food", None),
    ("groceries", Some(1)),
    ("restaurants", Some(1)),
    ("travel", None),
    ("flights", Some(4)),
    ("hotels", Some(4)),
    ("transport", None),
    ("fuel", Some(7)),
    ("public_transport", Some(7)),
    ("salary", None),
    ("bonus", Some(10)),
    ("entertainment", None),
    ("subscriptions", Some(12)),
    ("health", None),
    ("medical", Some(14)),
    ("education", None),
    ("rent", None),
    ("utilities", None),
    ("transfer", None),
    ("misc", None),
];

const FIRST_NAMES: &[&str] = &[
    "Ana", "Luis", "María", "Juan", "Carla", "Diego", "Sofía", "Pedro", "Lucía", "Martín",
    "Valeria", "Tomás", "Camila", "Mateo", "Florencia", "Federico", "Julieta", "Nicolás", "Paula",
    "Gonzalo",
];
const LAST_NAMES: &[&str] = &[
    "Pérez", "García", "Rodríguez", "Fernández", "López", "Martínez", "Sánchez", "Romero", "Díaz",
    "Suárez", "Álvarez", "Torres", "Ruiz", "Ramírez", "Castro", "Vega", "Méndez", "Ortiz",
    "Silva", "Vargas",
];

fn main() -> Result<()> {
    let args = Args::parse();

    let out_path = PathBuf::from(&args.out);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if out_path.exists() {
        std::fs::remove_file(&out_path)?;
    }

    let conn = Connection::open(&out_path)?;
    create_schema(&conn)?;
    insert_currencies(&conn)?;
    insert_categories(&conn)?;

    let mut rng = StdRng::seed_from_u64(42);
    let n_accounts = args.accounts as i64;

    let account_country: Vec<&'static str> = (0..n_accounts)
        .map(|_| *COUNTRIES.choose(&mut rng).unwrap())
        .collect();
    let account_currency: Vec<i64> =
        (0..n_accounts).map(|_| rng.gen_range(1..=CURRENCIES.len() as i64)).collect();

    {
        let mut app = conn.appender("accounts")?;
        for i in 0..n_accounts {
            let fn_ = FIRST_NAMES.choose(&mut rng).unwrap();
            let ln_ = LAST_NAMES.choose(&mut rng).unwrap();
            let owner = format!("{fn_} {ln_}");
            let cc = account_country[i as usize];
            let cur = account_currency[i as usize];
            let opened_days_ago = rng.gen_range(30..3650);
            let opened = (Utc::now() - ChronoDuration::days(opened_days_ago)).date_naive();
            app.append_row(params![i + 1, owner, cc, cur, opened.to_string()])?;
        }
    }
    println!("inserted {n_accounts} accounts");

    // transactions
    let n = args.rows as i64;
    let cat_count = CATEGORIES.len() as i64;
    // Distribución de monto: lognormal aprox (rng en exp scale)
    let weights = vec![60, 25, 10, 4, 1]; // proporciones de buckets de monto
    let buckets = vec![
        (1.0, 100.0),
        (100.0, 1_000.0),
        (1_000.0, 5_000.0),
        (5_000.0, 20_000.0),
        (20_000.0, 100_000.0),
    ];
    let dist = WeightedIndex::new(&weights).unwrap();

    let statuses = ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "pending"];

    let now = Utc::now();
    let start = now - ChronoDuration::days(730);

    {
        let mut app = conn.appender("transactions")?;
        for i in 0..n {
            let acc = rng.gen_range(0..n_accounts);
            let acc_country = account_country[acc as usize];
            let mut tx_country = acc_country;
            // 5% mismatch
            if rng.gen_bool(0.05) {
                tx_country = COUNTRIES
                    .iter()
                    .filter(|c| **c != acc_country)
                    .choose(&mut rng)
                    .copied()
                    .unwrap_or(acc_country);
            }
            let cat = rng.gen_range(1..=cat_count);
            let cur = rng.gen_range(1..=CURRENCIES.len() as i64);
            let bucket_idx = dist.sample(&mut rng);
            let (lo, hi) = buckets[bucket_idx];
            let amount: f64 = rng.gen_range(lo..hi);
            // signo: 30% negativo (gasto)
            let amount = if rng.gen_bool(0.7) { amount } else { -amount };

            let elapsed_secs = rng.gen_range(0..(730 * 24 * 3600));
            let ts: NaiveDateTime = (start + ChronoDuration::seconds(elapsed_secs)).naive_utc();
            let status = statuses.choose(&mut rng).unwrap();

            app.append_row(params![
                i + 1,
                acc + 1,
                cat,
                amount,
                cur,
                ts.to_string(),
                tx_country,
                *status
            ])?;

            if (i + 1) % 10_000 == 0 {
                println!("inserted {} / {n}", i + 1);
            }
        }
    }

    conn.execute_batch(
        "CREATE INDEX idx_tx_account ON transactions(account_id);
         CREATE INDEX idx_tx_category ON transactions(category_id);
         CREATE INDEX idx_tx_currency ON transactions(currency_id);",
    )?;
    println!("indexes created");

    println!(
        "DONE  - wrote {} (currencies={}, categories={}, accounts={}, transactions={})",
        args.out,
        CURRENCIES.len(),
        CATEGORIES.len(),
        n_accounts,
        n
    );
    let _ = NaiveDate::from_ymd_opt(2024, 1, 1);
    let _ = Utc.timestamp_opt(0, 0).unwrap();
    Ok(())
}

fn create_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE currencies (
            id INTEGER PRIMARY KEY,
            code VARCHAR NOT NULL,
            symbol VARCHAR NOT NULL,
            rate_to_usd DOUBLE NOT NULL
         );
         CREATE TABLE categories (
            id INTEGER PRIMARY KEY,
            name VARCHAR NOT NULL,
            parent_id INTEGER
         );
         CREATE TABLE accounts (
            id BIGINT PRIMARY KEY,
            owner_name VARCHAR NOT NULL,
            country VARCHAR NOT NULL,
            currency_id BIGINT NOT NULL,
            opened_at VARCHAR NOT NULL
         );
         CREATE TABLE transactions (
            tx_id BIGINT PRIMARY KEY,
            account_id BIGINT NOT NULL,
            category_id BIGINT NOT NULL,
            amount DOUBLE NOT NULL,
            currency_id BIGINT NOT NULL,
            timestamp VARCHAR NOT NULL,
            country VARCHAR NOT NULL,
            status VARCHAR NOT NULL
         );",
    )?;
    Ok(())
}

fn insert_currencies(conn: &Connection) -> Result<()> {
    let mut app = conn.appender("currencies")?;
    for (i, (code, symbol, rate)) in CURRENCIES.iter().enumerate() {
        app.append_row(params![(i + 1) as i32, *code, *symbol, *rate])?;
    }
    Ok(())
}

fn insert_categories(conn: &Connection) -> Result<()> {
    let mut app = conn.appender("categories")?;
    for (i, (name, parent)) in CATEGORIES.iter().enumerate() {
        let id = (i + 1) as i32;
        match parent {
            Some(p) => app.append_row(params![id, *name, *p])?,
            None => app.append_row(params![id, *name, Option::<i32>::None])?,
        }
    }
    Ok(())
}
