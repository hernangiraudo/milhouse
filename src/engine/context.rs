use crate::config::{Connection, ConnectionKind, ConnectionsFile};
use anyhow::{anyhow, Context, Result};
use duckdb::Connection as DuckConn;
use odbc_api::{Connection as OdbcConn, ConnectionOptions, Environment};
use polars::frame::DataFrame;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, RwLock};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;

/// Cliente SQL Server (tiberius) sobre TcpStream tokio adaptado a futures-io.
pub type SqlServerClient = tiberius::Client<Compat<TcpStream>>;

pub type TableStore = Arc<RwLock<HashMap<String, Arc<DataFrame>>>>;

/// Environment global de ODBC. Se inicializa lazy; debe vivir lo mismo que
/// las conexiones que abre.
static ODBC_ENV: OnceLock<Environment> = OnceLock::new();

pub fn odbc_environment() -> Result<&'static Environment> {
    if let Some(e) = ODBC_ENV.get() {
        return Ok(e);
    }
    let env = Environment::new()
        .map_err(|e| anyhow!("could not initialize ODBC environment: {e}"))?;
    let _ = ODBC_ENV.set(env);
    Ok(ODBC_ENV.get().expect("ODBC environment set above"))
}

/// Una conexión abierta puede ser DuckDB o ODBC. Cada variante guarda su
/// handle bajo Mutex porque la mayoría de los drivers no son Sync.
pub enum OpenedConnection {
    Duckdb(Arc<Mutex<DuckConn>>),
    /// La conexión ODBC ata su lifetime al Environment global (static), por
    /// eso `'static`. La envuelvo en `Mutex` para serializar accesos.
    Odbc(Arc<Mutex<OdbcConn<'static>>>),
    /// SQL Server nativo (tiberius). Es un pool: cada `acquire()` da una
    /// conexión exclusiva. Si todas están en uso, abre una nueva (hasta el
    /// máximo configurado).
    SqlServer(Arc<SqlServerPool>),
    /// MySQL/MariaDB nativo (mysql_async). Pool maneja conexiones internas.
    Mysql(Arc<mysql_async::Pool>),
}

impl OpenedConnection {
    pub fn kind_name(&self) -> &'static str {
        match self {
            OpenedConnection::Duckdb(_) => "duckdb",
            OpenedConnection::Odbc(_) => "odbc",
            OpenedConnection::SqlServer(_) => "sql_server",
            OpenedConnection::Mysql(_) => "mysql",
        }
    }
}

/// Spec necesaria para abrir conexiones SQL Server bajo demanda.
#[derive(Clone, Debug)]
pub struct SqlServerSpec {
    pub conn_name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: String,
    pub encrypt: String,
    pub trust_server_certificate: bool,
}

/// Pool de conexiones SQL Server. Sirve clientes de a uno; si todas están
/// ocupadas, abre una nueva hasta el máximo. Permite paralelismo real sobre
/// la misma conexión lógica del config (`name`).
pub struct SqlServerPool {
    spec: SqlServerSpec,
    idle: Mutex<Vec<SqlServerClient>>,
    semaphore: Arc<tokio::sync::Semaphore>,
    max: usize,
}

const SQLSERVER_POOL_MAX: usize = 8;

impl SqlServerPool {
    pub fn new(spec: SqlServerSpec) -> Self {
        Self {
            spec,
            idle: Mutex::new(Vec::new()),
            semaphore: Arc::new(tokio::sync::Semaphore::new(SQLSERVER_POOL_MAX)),
            max: SQLSERVER_POOL_MAX,
        }
    }

    pub fn max(&self) -> usize {
        self.max
    }

    pub fn spec(&self) -> &SqlServerSpec {
        &self.spec
    }

    /// Toma una conexión del pool (de las idle o abre una nueva). El permiso
    /// del semáforo se libera cuando se hace `release(client)`.
    pub async fn acquire(self: &Arc<Self>) -> Result<SqlServerLease> {
        let permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| anyhow!("SQL Server pool semaphore: {e}"))?;
        let existing = {
            let mut idle = self.idle.lock().await;
            idle.pop()
        };
        let client = match existing {
            Some(c) => c,
            None => {
                open_sql_server(
                    &self.spec.conn_name,
                    &self.spec.host,
                    self.spec.port,
                    &self.spec.user,
                    self.spec.password.as_deref(),
                    &self.spec.database,
                    &self.spec.encrypt,
                    self.spec.trust_server_certificate,
                )
                .await?
            }
        };
        Ok(SqlServerLease {
            pool: self.clone(),
            client: Some(client),
            _permit: permit,
        })
    }
}

/// RAII: al droppear, devuelve el cliente al pool.
pub struct SqlServerLease {
    pool: Arc<SqlServerPool>,
    client: Option<SqlServerClient>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl SqlServerLease {
    pub fn client_mut(&mut self) -> &mut SqlServerClient {
        self.client.as_mut().expect("client present until drop")
    }
}

impl Drop for SqlServerLease {
    fn drop(&mut self) {
        if let Some(c) = self.client.take() {
            let pool = self.pool.clone();
            // Devolver al idle en un task para no bloquear el drop.
            tokio::spawn(async move {
                let mut idle = pool.idle.lock().await;
                idle.push(c);
            });
        }
    }
}

/// Pool de conexiones declaradas en `connections.json`. Abre cada conexión
/// la primera vez que se usa y la deja cacheada por nombre.
///
/// El `file` está bajo `RwLock` para que la API pueda actualizarlo cuando el
/// usuario crea/edita/borra conexiones desde la UI sin tener que reiniciar
/// el server. Las conexiones ya abiertas se siguen reusando vía cache; las
/// modificadas o borradas se eliminan del cache para que la próxima apertura
/// use la nueva spec.
pub struct ConnectionPool {
    file: tokio::sync::RwLock<ConnectionsFile>,
    cache: Mutex<HashMap<String, Arc<OpenedConnection>>>,
}

impl ConnectionPool {
    pub fn new(file: ConnectionsFile) -> Self {
        Self {
            file: tokio::sync::RwLock::new(file),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn snapshot_file(&self) -> ConnectionsFile {
        self.file.read().await.clone()
    }

    pub async fn default_name(&self) -> Option<String> {
        self.file.read().await.default.clone()
    }

    /// Reemplaza el archivo de conexiones (típicamente tras un CRUD por API)
    /// e invalida el cache de las conexiones que dejaron de existir o cambiaron.
    pub async fn replace_file(&self, new_file: ConnectionsFile) {
        let old_specs: HashMap<String, crate::config::Connection> = {
            let guard = self.file.read().await;
            guard.lookup_map()
        };
        {
            let mut w = self.file.write().await;
            *w = new_file;
        }
        // Invalidar cache: si una conexión desapareció o su spec cambió,
        // sacarla del cache para que la próxima apertura use la nueva.
        let new_specs: HashMap<String, crate::config::Connection> = {
            let guard = self.file.read().await;
            guard.lookup_map()
        };
        let mut cache = self.cache.lock().await;
        cache.retain(|name, _| match new_specs.get(name) {
            None => false,
            Some(new_def) => {
                // Si la spec interna no cambió, mantener; si sí, invalidar.
                match old_specs.get(name) {
                    Some(old) => same_spec(old, new_def),
                    None => true,
                }
            }
        });
    }

    /// Devuelve la conexión abierta (cualquier tipo) para el nombre dado
    /// (o la default si es None). Abre lazy y cachea.
    pub async fn get_any(&self, name: Option<&str>) -> Result<Arc<OpenedConnection>> {
        let conn_def = {
            let guard = self.file.read().await;
            guard.resolve(name).map_err(|e| anyhow!("{e}"))?.clone()
        };
        let key = conn_def.name.clone();
        let mut cache = self.cache.lock().await;
        if let Some(existing) = cache.get(&key) {
            return Ok(existing.clone());
        }
        let opened = open_connection(&conn_def).await?;
        let arc = Arc::new(opened);
        cache.insert(key, arc.clone());
        Ok(arc)
    }

    /// Devuelve la conexión DuckDB para el nombre dado. Falla si es de otro tipo.
    pub async fn get_duckdb(&self, name: Option<&str>) -> Result<Arc<Mutex<DuckConn>>> {
        let opened = self.get_any(name).await?;
        match &*opened {
            OpenedConnection::Duckdb(c) => Ok(c.clone()),
            other => Err(anyhow!(
                "connection is of type `{}`, expected duckdb",
                other.kind_name()
            )),
        }
    }
}

/// Compara si dos definiciones de conexión apuntan al mismo backend con
/// los mismos parámetros (ignora `description`, sólo nos importa lo que
/// afecta a la apertura).
fn same_spec(a: &Connection, b: &Connection) -> bool {
    // Serializar el kind a JSON y comparar — más liviano que implementar PartialEq manual.
    let aj = serde_json::to_value(&a.kind).unwrap_or(serde_json::Value::Null);
    let bj = serde_json::to_value(&b.kind).unwrap_or(serde_json::Value::Null);
    aj == bj
}

async fn open_connection(conn: &Connection) -> Result<OpenedConnection> {
    match &conn.kind {
        ConnectionKind::Duckdb { path } => {
            let c = DuckConn::open(path).with_context(|| {
                format!("opening duckdb file at {path} (connection `{}`)", conn.name)
            })?;
            Ok(OpenedConnection::Duckdb(Arc::new(Mutex::new(c))))
        }
        ConnectionKind::DuckdbMemory => {
            let c = DuckConn::open_in_memory().with_context(|| {
                format!("opening duckdb in-memory (connection `{}`)", conn.name)
            })?;
            Ok(OpenedConnection::Duckdb(Arc::new(Mutex::new(c))))
        }
        ConnectionKind::Odbc { connection_string } => {
            let env = odbc_environment()?;
            let c = env
                .connect_with_connection_string(connection_string, ConnectionOptions::default())
                .map_err(|e| {
                    anyhow!(
                        "opening ODBC connection `{}`: {e}",
                        conn.name
                    )
                })?;
            Ok(OpenedConnection::Odbc(Arc::new(Mutex::new(c))))
        }
        ConnectionKind::SqlServer {
            host,
            port,
            user,
            password,
            database,
            encrypt,
            trust_server_certificate,
        } => {
            // Probamos abrir 1 conexión para validar credenciales/red. Si
            // funciona, devolvemos un pool que maneja N concurrentes.
            let probe = open_sql_server(
                &conn.name,
                host,
                *port,
                user,
                password.as_deref(),
                database,
                encrypt,
                *trust_server_certificate,
            )
            .await?;
            let spec = SqlServerSpec {
                conn_name: conn.name.clone(),
                host: host.clone(),
                port: *port,
                user: user.clone(),
                password: password.clone(),
                database: database.clone(),
                encrypt: encrypt.clone(),
                trust_server_certificate: *trust_server_certificate,
            };
            let pool = Arc::new(SqlServerPool::new(spec));
            // Sembrar la conexión probada para no descartarla.
            {
                let mut idle = pool.idle.lock().await;
                idle.push(probe);
            }
            Ok(OpenedConnection::SqlServer(pool))
        }
        ConnectionKind::Mysql {
            host,
            port,
            user,
            password,
            database,
            ssl,
        } => {
            let pool = open_mysql(host, *port, user, password.as_deref(), database, *ssl)
                .map_err(|e| anyhow!("opening MySQL `{}`: {e}", conn.name))?;
            Ok(OpenedConnection::Mysql(Arc::new(pool)))
        }
        ConnectionKind::Postgres { .. } => Err(anyhow!(
            "connection `{}`: Postgres connections are declared but not implemented natively yet (use type `odbc` con un driver de Postgres por ahora)",
            conn.name
        )),
        ConnectionKind::Sqlite { .. } => Err(anyhow!(
            "connection `{}`: SQLite connections are declared but not implemented natively yet (use type `odbc` con SQLite ODBC driver por ahora)",
            conn.name
        )),
    }
}

#[allow(clippy::too_many_arguments)]
async fn open_sql_server(
    conn_name: &str,
    host: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    database: &str,
    encrypt: &str,
    trust_server_certificate: bool,
) -> Result<SqlServerClient> {
    use tiberius::{AuthMethod, Config, EncryptionLevel};
    let mut cfg = Config::new();
    cfg.host(host);
    cfg.port(port);
    cfg.database(database);
    // Marca para que el Monitor SQL identifique las sesiones que abrimos
    // como "Milhouse" en sys.dm_exec_sessions.program_name.
    cfg.application_name(format!("milhouse/{conn_name}"));
    cfg.authentication(AuthMethod::sql_server(user, password.unwrap_or("")));
    cfg.encryption(match encrypt.to_ascii_lowercase().as_str() {
        "off" | "false" | "no" => EncryptionLevel::Off,
        "required" | "strict" => EncryptionLevel::Required,
        _ => EncryptionLevel::On,
    });
    if trust_server_certificate {
        cfg.trust_cert();
    }
    let tcp = TcpStream::connect(cfg.get_addr())
        .await
        .map_err(|e| anyhow!("connecting SQL Server `{conn_name}` at {host}:{port}: {e}"))?;
    tcp.set_nodelay(true).ok();
    let client = tiberius::Client::connect(cfg, tcp.compat_write())
        .await
        .map_err(|e| anyhow!("SQL Server handshake `{conn_name}`: {e}"))?;
    Ok(client)
}

fn open_mysql(
    host: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    database: &str,
    ssl: bool,
) -> Result<mysql_async::Pool> {
    use mysql_async::{Opts, OptsBuilder, SslOpts};
    let mut b = OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(user.to_string()))
        .pass(password.map(|s| s.to_string()))
        .db_name(Some(database.to_string()));
    if ssl {
        b = b.ssl_opts(Some(SslOpts::default()));
    }
    let opts: Opts = b.into();
    Ok(mysql_async::Pool::new(opts))
}

/// Abre una conexión efímera y ejecuta `SELECT 1`. NO cachea. Devuelve la
/// latencia y un mensaje informativo o un error claro del driver.
pub async fn test_connection(conn: &Connection) -> Result<TestResult> {
    use std::time::Instant;
    let started = Instant::now();
    match &conn.kind {
        ConnectionKind::Duckdb { path } => {
            let path = path.clone();
            tokio::task::spawn_blocking(move || -> Result<TestResult> {
                let started = Instant::now();
                let c = DuckConn::open(&path)
                    .with_context(|| format!("opening duckdb at {path}"))?;
                let _: i64 = c.query_row("SELECT 1", [], |r| r.get(0))?;
                Ok(TestResult {
                    ok: true,
                    latency_ms: started.elapsed().as_millis() as u64,
                    info: format!("DuckDB OK ({path})"),
                })
            })
            .await?
        }
        ConnectionKind::DuckdbMemory => {
            tokio::task::spawn_blocking(|| -> Result<TestResult> {
                let started = Instant::now();
                let c = DuckConn::open_in_memory()?;
                let _: i64 = c.query_row("SELECT 1", [], |r| r.get(0))?;
                Ok(TestResult {
                    ok: true,
                    latency_ms: started.elapsed().as_millis() as u64,
                    info: "DuckDB in-memory OK".into(),
                })
            })
            .await?
        }
        ConnectionKind::Odbc { connection_string } => {
            let cs = connection_string.clone();
            tokio::task::spawn_blocking(move || -> Result<TestResult> {
                let started = Instant::now();
                let env = odbc_environment()?;
                let c = env
                    .connect_with_connection_string(&cs, ConnectionOptions::default())
                    .map_err(|e| anyhow!("ODBC connect: {e}"))?;
                let mut stmt = c
                    .prepare("SELECT 1")
                    .map_err(|e| anyhow!("prepare SELECT 1: {e}"))?;
                let _ = stmt
                    .execute(())
                    .map_err(|e| anyhow!("execute SELECT 1: {e}"))?;
                Ok(TestResult {
                    ok: true,
                    latency_ms: started.elapsed().as_millis() as u64,
                    info: "ODBC OK".into(),
                })
            })
            .await?
        }
        ConnectionKind::SqlServer {
            host,
            port,
            user,
            password,
            database,
            encrypt,
            trust_server_certificate,
        } => {
            let mut client = open_sql_server(
                &conn.name,
                host,
                *port,
                user,
                password.as_deref(),
                database,
                encrypt,
                *trust_server_certificate,
            )
            .await?;
            let _ = client
                .simple_query("SELECT 1")
                .await
                .map_err(|e| anyhow!("SQL Server SELECT 1: {e}"))?
                .into_results()
                .await
                .ok();
            Ok(TestResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                info: format!("SQL Server OK ({host}:{port}/{database})"),
            })
        }
        ConnectionKind::Mysql {
            host,
            port,
            user,
            password,
            database,
            ssl,
        } => {
            let pool = open_mysql(host, *port, user, password.as_deref(), database, *ssl)?;
            let mut c = pool
                .get_conn()
                .await
                .map_err(|e| anyhow!("MySQL get_conn: {e}"))?;
            use mysql_async::prelude::Queryable;
            let _: Vec<i64> = c
                .query("SELECT 1")
                .await
                .map_err(|e| anyhow!("MySQL SELECT 1: {e}"))?;
            drop(c);
            pool.disconnect().await.ok();
            Ok(TestResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                info: format!("MySQL OK ({host}:{port}/{database})"),
            })
        }
        ConnectionKind::Postgres { .. } | ConnectionKind::Sqlite { .. } => Err(anyhow!(
            "type `{}` is declared but not implemented natively yet (use type `odbc` for now)",
            conn.kind.type_name()
        )),
    }
}

#[derive(Debug, serde::Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub info: String,
}

pub struct StepContext {
    pub tables: TableStore,
    pub connections: Arc<ConnectionPool>,
    pub cancel: CancellationToken,
    /// Parámetros resueltos para esta ejecución (`:nombre` → valor).
    /// Vacío si el proyecto no declara parámetros.
    pub params: Arc<crate::engine::params::ResolvedParams>,
}

impl StepContext {
    pub async fn get_table(&self, name: &str) -> Result<Arc<DataFrame>> {
        let guard = self.tables.read().await;
        match guard.get(name).cloned() {
            Some(df) => Ok(df),
            None => {
                let mut available: Vec<&String> = guard.keys().collect();
                available.sort();
                let list = if available.is_empty() {
                    "<ninguna>".to_string()
                } else {
                    available
                        .iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                Err(anyhow!(
                    "tabla `{}` no encontrada en el store. Tablas disponibles: {}. \
                     Probablemente el step que la produce no se ejecutó antes (revisar depends_on).",
                    name,
                    list
                ))
            }
        }
    }

    pub async fn insert_table(&self, name: String, df: DataFrame) {
        let mut guard = self.tables.write().await;
        guard.insert(name, Arc::new(df));
    }

    /// Atajo: conexión DuckDB default (usada por export y similares).
    pub async fn default_duckdb(&self) -> Result<Arc<Mutex<DuckConn>>> {
        self.connections.get_duckdb(None).await
    }
}
