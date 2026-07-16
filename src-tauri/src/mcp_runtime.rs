use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chrono::Utc;
use codez_contracts::mcp as wire;
use codez_core::{AppError, redact_sensitive_text, redact_sensitive_value};
use codez_mcp::{
    McpCatalog, McpConnectionInfo, McpError, McpGateway, McpGatewayLimits, McpSecretKey,
    McpSecretStore, McpSecretStoreError, McpServerConfig, McpServerId, McpTimeouts, McpTransport,
    StdioServerConfig, StreamableHttpServerConfig, UserMcpServer,
};
use codez_runtime::{ShutdownFuture, ShutdownHook, ShutdownPhase};
use serde_json::Value;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::mcp_boundary::transport_to_wire;

const USER_SERVER_ID_PREFIX: &str = "user:";
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Owns live user-scoped MCP connections and their redacted desktop status.
///
/// A gateway is scoped to one configuration so validated per-server request and
/// handshake budgets are applied without making another server's configuration
/// affect it. The manager serializes lifecycle transitions, while the gateway
/// remains responsible for process/network cleanup for each connection.
pub(crate) struct McpRuntimeManager {
    secret_store: Arc<dyn McpSecretStore>,
    accepting: AtomicBool,
    cancellation: CancellationToken,
    operation_lock: Mutex<()>,
    state: Mutex<McpRuntimeState>,
}

#[derive(Default)]
struct McpRuntimeState {
    active: BTreeMap<String, ActiveConnection>,
    catalogs: BTreeMap<String, wire::McpServerCatalog>,
    statuses: BTreeMap<String, wire::McpServerStatus>,
}

#[derive(Clone)]
struct ActiveConnection {
    fingerprint: String,
    server_id: McpServerId,
    gateway: Arc<McpGateway>,
}

struct ResolvedValue {
    value: String,
    secret_redaction_values: Vec<String>,
}

struct ResolvedArguments {
    values: Vec<String>,
    secret_redaction_values: Vec<String>,
}

struct ResolvedStringMap {
    values: BTreeMap<String, String>,
    secret_redaction_values: Vec<String>,
}

#[derive(Debug)]
enum ConnectionFailure {
    AdmissionClosed,
    InvalidConfiguration,
    InvalidExpression,
    MissingEnvironment,
    MissingSecret,
    SecretStore(McpSecretStoreError),
    UnsupportedOAuth,
    UnsupportedTransport,
    Gateway(McpError),
}

impl ConnectionFailure {
    fn status_error(&self) -> wire::McpStatusError {
        let (code, message) = match self {
            Self::AdmissionClosed => (
                "SHUTTING_DOWN",
                "The desktop host is shutting down and cannot start an MCP connection.",
            ),
            Self::InvalidConfiguration => (
                "INVALID_RUNTIME_CONFIGURATION",
                "This MCP configuration cannot be started by the Rust gateway.",
            ),
            Self::InvalidExpression => (
                "INVALID_SECRET_EXPRESSION",
                "This MCP configuration contains an invalid secure expression.",
            ),
            Self::MissingEnvironment => (
                "ENVIRONMENT_VARIABLE_UNAVAILABLE",
                "A required environment variable is unavailable for this MCP server.",
            ),
            Self::MissingSecret => (
                "MCP_SECRET_UNAVAILABLE",
                "A required MCP secret is not configured in the operating-system credential store.",
            ),
            Self::SecretStore(McpSecretStoreError::AccessDenied) => (
                "MCP_SECRET_ACCESS_DENIED",
                "The operating-system credential store denied access to a required MCP secret.",
            ),
            Self::SecretStore(McpSecretStoreError::Unavailable) => (
                "MCP_SECRET_STORE_UNAVAILABLE",
                "The operating-system credential store is unavailable.",
            ),
            Self::SecretStore(_) => (
                "MCP_SECRET_UNAVAILABLE",
                "A required MCP secret could not be read from the operating-system credential store.",
            ),
            Self::UnsupportedOAuth => (
                "OAUTH_UNSUPPORTED",
                "OAuth MCP connections are not implemented by the Rust desktop host.",
            ),
            Self::UnsupportedTransport => (
                "UNSUPPORTED_TRANSPORT",
                "Legacy SSE MCP transport is not implemented by the Rust desktop host.",
            ),
            Self::Gateway(McpError::Timeout { .. }) => (
                "CONNECTION_TIMEOUT",
                "The MCP server did not complete its connection within the configured deadline.",
            ),
            Self::Gateway(McpError::Cancelled { .. }) => (
                "CONNECTION_CANCELLED",
                "The MCP connection was cancelled before it completed.",
            ),
            Self::Gateway(_) => (
                "CONNECTION_FAILED",
                "The MCP server could not be connected by the Rust gateway.",
            ),
        };
        wire::McpStatusError {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    fn into_app_error(self) -> AppError {
        match self {
            Self::AdmissionClosed => AppError::conflict(
                "The desktop host is shutting down and cannot start an MCP connection",
            ),
            Self::InvalidConfiguration | Self::InvalidExpression => {
                AppError::validation("This MCP configuration cannot be started by the Rust gateway")
            }
            Self::MissingEnvironment | Self::MissingSecret => {
                AppError::not_found("A required MCP credential is not configured")
            }
            Self::SecretStore(McpSecretStoreError::AccessDenied) => AppError::permission_denied(
                "The operating-system credential store denied access to a required MCP secret",
            ),
            Self::SecretStore(McpSecretStoreError::Unavailable) => AppError::external(
                "The operating-system credential store is unavailable",
                "MCP secret lookup could not access the keychain",
                true,
            ),
            Self::SecretStore(_) => AppError::storage(
                "A required MCP secret could not be read",
                "MCP secret lookup returned an invalid credential-store result",
                false,
            ),
            Self::UnsupportedOAuth | Self::UnsupportedTransport => {
                AppError::unsupported(self.status_error().message)
            }
            Self::Gateway(McpError::Timeout { .. }) => AppError::timeout(
                "The MCP server did not complete its connection within the configured deadline",
            ),
            Self::Gateway(McpError::Cancelled { .. }) => {
                AppError::cancelled("The MCP connection was cancelled before it completed")
            }
            Self::Gateway(_) => AppError::external(
                "The MCP server could not be connected",
                "MCP gateway returned a redacted connection failure",
                true,
            ),
        }
    }
}

impl McpRuntimeManager {
    #[must_use]
    pub(crate) fn new(secret_store: Arc<dyn McpSecretStore>) -> Self {
        Self {
            secret_store,
            accepting: AtomicBool::new(true),
            cancellation: CancellationToken::new(),
            operation_lock: Mutex::new(()),
            state: Mutex::new(McpRuntimeState::default()),
        }
    }

    /// Reconciles live connections with the complete persisted user configuration.
    ///
    /// Existing connections with an unchanged fingerprint are retained. Removed,
    /// disabled, unsupported, or changed configurations are stopped before a
    /// replacement is started. Individual connection failures become typed
    /// statuses so a valid configuration save is never rolled back by a remote
    /// process or network failure.
    pub(crate) async fn reconcile(&self, servers: &[UserMcpServer]) -> Vec<wire::McpServerStatus> {
        let _operation = self.operation_lock.lock().await;
        if !self.accepting.load(Ordering::Acquire) {
            self.record_stopped_statuses(servers).await;
            return self.statuses_for(servers).await;
        }

        self.reconcile_locked(servers).await;
        self.statuses_for(servers).await
    }

    /// Stops and starts one explicitly requested server using its current config.
    ///
    /// # Errors
    ///
    /// Returns a typed command error when the server is unknown, disabled, or
    /// cannot establish a fresh connection. The status is updated before that
    /// error crosses the command boundary.
    pub(crate) async fn reconnect(&self, server: &UserMcpServer) -> Result<(), AppError> {
        let _operation = self.operation_lock.lock().await;
        if !self.accepting.load(Ordering::Acquire) {
            self.set_status(stopped_status(server)).await;
            return Err(ConnectionFailure::AdmissionClosed.into_app_error());
        }

        if server.config.enabled == Some(false) {
            self.set_status(disabled_status(server)).await;
            return Err(AppError::conflict("The MCP server is disabled"));
        }

        self.remove_active_connection(&server.name).await;
        match connection_mode(server) {
            ConnectionMode::UnsupportedTransport => {
                let failure = ConnectionFailure::UnsupportedTransport;
                self.set_status(failure_status(
                    server,
                    wire::McpServerState::Failed,
                    &failure,
                ))
                .await;
                Err(failure.into_app_error())
            }
            ConnectionMode::UnsupportedOAuth => {
                let failure = ConnectionFailure::UnsupportedOAuth;
                self.set_status(failure_status(
                    server,
                    wire::McpServerState::NeedsAuth,
                    &failure,
                ))
                .await;
                Err(failure.into_app_error())
            }
            ConnectionMode::Connect => self.connect_and_record(server).await,
            ConnectionMode::Disabled => Err(AppError::conflict("The MCP server is disabled")),
        }
    }

    /// Reads a fresh catalog from one currently live MCP server.
    ///
    /// A previously discovered catalog is returned as `stale` when the current
    /// refresh fails. No cache is fabricated for a server that has never
    /// returned a catalog.
    pub(crate) async fn catalog(&self, name: &str) -> Result<wire::McpServerCatalog, AppError> {
        let _operation = self.operation_lock.lock().await;
        if !self.accepting.load(Ordering::Acquire) {
            return Err(ConnectionFailure::AdmissionClosed.into_app_error());
        }
        let active = {
            let state = self.state.lock().await;
            state.active.get(name).cloned()
        }
        .ok_or_else(|| AppError::not_found("The MCP server is not connected"))?;

        match active
            .gateway
            .list_catalog(&active.server_id, &self.cancellation)
            .await
        {
            Ok(catalog) => {
                let catalog = catalog_to_wire(name, catalog);
                self.update_catalog(name, catalog.clone()).await;
                Ok(catalog)
            }
            Err(error) => {
                self.record_catalog_failure(name, &error).await;
                let cached = {
                    let state = self.state.lock().await;
                    state.catalogs.get(name).cloned()
                };
                cached.map_or_else(
                    || Err(ConnectionFailure::Gateway(error).into_app_error()),
                    |mut catalog| {
                        catalog.stale = true;
                        Ok(catalog)
                    },
                )
            }
        }
    }

    #[must_use]
    pub(crate) async fn statuses(&self) -> Vec<wire::McpServerStatus> {
        self.state.lock().await.statuses.values().cloned().collect()
    }

    pub(crate) fn stop_accepting(&self) {
        self.accepting.store(false, Ordering::Release);
    }

    pub(crate) fn cancel_active(&self) {
        self.cancellation.cancel();
    }

    /// Closes every gateway after cooperative cancellation has been requested.
    ///
    /// # Errors
    ///
    /// Returns a generic, redacted error only when one or more gateway cleanup
    /// operations report failure. Remaining gateways are still closed.
    pub(crate) async fn force_cleanup(&self) -> Result<(), AppError> {
        let _operation = self.operation_lock.lock().await;
        let active = {
            let mut state = self.state.lock().await;
            state.catalogs.clear();
            std::mem::take(&mut state.active)
                .into_iter()
                .collect::<Vec<_>>()
        };
        let active_names = active
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<BTreeSet<_>>();
        let mut cleanup_failed = false;
        for (_, connection) in active {
            if connection
                .gateway
                .shutdown()
                .await
                .into_iter()
                .any(|(_, report)| report.is_err())
            {
                cleanup_failed = true;
            }
        }
        self.record_cleanup_statuses(&active_names, cleanup_failed)
            .await;
        if cleanup_failed {
            return Err(AppError::external(
                "One or more MCP connections did not close cleanly",
                "MCP gateway shutdown reported a cleanup failure",
                false,
            ));
        }
        Ok(())
    }

    async fn reconcile_locked(&self, servers: &[UserMcpServer]) {
        let desired = servers
            .iter()
            .map(|server| (server.name.as_str(), server))
            .collect::<BTreeMap<_, _>>();
        let stale = {
            let state = self.state.lock().await;
            state
                .active
                .iter()
                .filter(|(name, active)| {
                    desired
                        .get(name.as_str())
                        .is_none_or(|server| !should_keep_connection(server, active))
                })
                .map(|(name, active)| (name.clone(), active.clone()))
                .collect::<Vec<_>>()
        };
        for (name, active) in stale {
            self.remove_active_connection_with_value(&name, active)
                .await;
        }

        let configured_names = servers
            .iter()
            .map(|server| server.name.clone())
            .collect::<BTreeSet<_>>();
        {
            let mut state = self.state.lock().await;
            state
                .statuses
                .retain(|name, _| configured_names.contains(name));
            state
                .catalogs
                .retain(|name, _| configured_names.contains(name));
        }

        for server in servers {
            match connection_mode(server) {
                ConnectionMode::Disabled => self.set_status(disabled_status(server)).await,
                ConnectionMode::UnsupportedTransport => {
                    let failure = ConnectionFailure::UnsupportedTransport;
                    self.set_status(failure_status(
                        server,
                        wire::McpServerState::Failed,
                        &failure,
                    ))
                    .await;
                }
                ConnectionMode::UnsupportedOAuth => {
                    let failure = ConnectionFailure::UnsupportedOAuth;
                    self.set_status(failure_status(
                        server,
                        wire::McpServerState::NeedsAuth,
                        &failure,
                    ))
                    .await;
                }
                ConnectionMode::Connect => {
                    let already_connected = {
                        let state = self.state.lock().await;
                        state.active.contains_key(&server.name)
                    };
                    if !already_connected {
                        let _result = self.connect_and_record(server).await;
                    }
                }
            }
        }
    }

    async fn connect_and_record(&self, server: &UserMcpServer) -> Result<(), AppError> {
        self.set_status(connecting_status(server)).await;
        match self.connect(server).await {
            Ok((connection, status)) => {
                let mut state = self.state.lock().await;
                state.active.insert(server.name.clone(), connection);
                state.statuses.insert(server.name.clone(), status);
                Ok(())
            }
            Err(failure) => {
                let state = failure_state(&failure);
                self.set_status(failure_status(server, state, &failure))
                    .await;
                Err(failure.into_app_error())
            }
        }
    }

    async fn connect(
        &self,
        server: &UserMcpServer,
    ) -> Result<(ActiveConnection, wire::McpServerStatus), ConnectionFailure> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(ConnectionFailure::AdmissionClosed);
        }
        let server_id = user_server_id(&server.name)?;
        let gateway = Arc::new(McpGateway::with_config(
            timeouts_for(&server.config)?,
            McpGatewayLimits::default(),
        ));
        let info = match server.config.transport {
            McpTransport::Stdio => {
                let config = self.stdio_config(&server.config).await?;
                gateway
                    .connect_stdio(server_id.clone(), config, &self.cancellation)
                    .await
            }
            McpTransport::Http => {
                let config = self.http_config(&server.config).await?;
                gateway
                    .connect_streamable_http(server_id.clone(), config, &self.cancellation)
                    .await
            }
            McpTransport::Sse => return Err(ConnectionFailure::UnsupportedTransport),
        }
        .map_err(ConnectionFailure::Gateway)?;

        Ok((
            ActiveConnection {
                fingerprint: server.fingerprint.clone(),
                server_id,
                gateway,
            },
            connected_status(server, &info),
        ))
    }

    async fn stdio_config(
        &self,
        config: &McpServerConfig,
    ) -> Result<StdioServerConfig, ConnectionFailure> {
        let command = config
            .command
            .as_deref()
            .ok_or(ConnectionFailure::InvalidConfiguration)?;
        let ResolvedArguments {
            values: arguments,
            mut secret_redaction_values,
        } = self
            .resolve_arguments(config.args.as_deref().unwrap_or_default())
            .await?;
        let ResolvedStringMap {
            values: environment,
            secret_redaction_values: environment_redaction_values,
        } = self.resolve_string_map(config.env.as_ref()).await?;
        secret_redaction_values.extend(environment_redaction_values);
        let working_directory = config.cwd.as_deref().map(PathBuf::from);
        let config = StdioServerConfig::new(
            PathBuf::from(command),
            arguments.into_iter().map(OsString::from).collect(),
            environment
                .into_iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value)))
                .collect(),
            working_directory,
        )
        .map_err(ConnectionFailure::Gateway)?;
        Ok(config.with_redaction_values(secret_redaction_values))
    }

    async fn http_config(
        &self,
        config: &McpServerConfig,
    ) -> Result<StreamableHttpServerConfig, ConnectionFailure> {
        if config.oauth.is_some() {
            return Err(ConnectionFailure::UnsupportedOAuth);
        }
        let endpoint = config
            .url
            .as_deref()
            .ok_or(ConnectionFailure::InvalidConfiguration)?;
        let ResolvedStringMap {
            values: headers,
            secret_redaction_values: _,
        } = self.resolve_string_map(config.headers.as_ref()).await?;
        StreamableHttpServerConfig::new(endpoint, headers).map_err(ConnectionFailure::Gateway)
    }

    async fn resolve_arguments(
        &self,
        arguments: &[String],
    ) -> Result<ResolvedArguments, ConnectionFailure> {
        let mut values = Vec::with_capacity(arguments.len());
        let mut secret_redaction_values = Vec::new();
        for argument in arguments {
            let resolved = self.resolve_value(argument).await?;
            secret_redaction_values.extend(resolved.secret_redaction_values);
            values.push(resolved.value);
        }
        Ok(ResolvedArguments {
            values,
            secret_redaction_values,
        })
    }

    async fn resolve_string_map(
        &self,
        values: Option<&BTreeMap<String, String>>,
    ) -> Result<ResolvedStringMap, ConnectionFailure> {
        let Some(values) = values else {
            return Ok(ResolvedStringMap {
                values: BTreeMap::new(),
                secret_redaction_values: Vec::new(),
            });
        };
        let mut resolved_values = BTreeMap::new();
        let mut secret_redaction_values = Vec::new();
        for (key, value) in values {
            let resolved = self.resolve_value(value).await?;
            secret_redaction_values.extend(resolved.secret_redaction_values);
            resolved_values.insert(key.clone(), resolved.value);
        }
        Ok(ResolvedStringMap {
            values: resolved_values,
            secret_redaction_values,
        })
    }

    async fn resolve_value(&self, configured: &str) -> Result<ResolvedValue, ConnectionFailure> {
        let mut value = String::with_capacity(configured.len());
        let mut secret_redaction_values = Vec::new();
        let mut remaining = configured;
        while let Some(start) = remaining.find("${") {
            value.push_str(&remaining[..start]);
            let expression = &remaining[start + 2..];
            let end = expression
                .find('}')
                .ok_or(ConnectionFailure::InvalidExpression)?;
            let body = &expression[..end];
            let (source, key) = body
                .split_once(':')
                .ok_or(ConnectionFailure::InvalidExpression)?;
            match source {
                "env" if valid_environment_key(key) => {
                    let environment_value =
                        std::env::var(key).map_err(|_| ConnectionFailure::MissingEnvironment)?;
                    value.push_str(&environment_value);
                }
                "secret" => {
                    let key = McpSecretKey::parse(key.to_owned())
                        .map_err(|_| ConnectionFailure::InvalidExpression)?;
                    let secret = self
                        .secret_store
                        .get(key)
                        .await
                        .map_err(ConnectionFailure::SecretStore)?
                        .ok_or(ConnectionFailure::MissingSecret)?;
                    let secret_value = secret.expose_secret();
                    value.push_str(secret_value);
                    secret_redaction_values.push(secret_value.to_string());
                }
                _ => return Err(ConnectionFailure::InvalidExpression),
            }
            remaining = &expression[end + 1..];
        }
        value.push_str(remaining);
        Ok(ResolvedValue {
            value,
            secret_redaction_values,
        })
    }

    async fn remove_active_connection(&self, name: &str) {
        let active = {
            let mut state = self.state.lock().await;
            state.catalogs.remove(name);
            state.active.remove(name)
        };
        if let Some(active) = active {
            self.close_connection(active).await;
        }
    }

    async fn remove_active_connection_with_value(&self, name: &str, active: ActiveConnection) {
        {
            let mut state = self.state.lock().await;
            state.catalogs.remove(name);
            state.active.remove(name);
        }
        self.close_connection(active).await;
    }

    async fn close_connection(&self, active: ActiveConnection) {
        let cancellation = CancellationToken::new();
        let _disconnect = active
            .gateway
            .disconnect(&active.server_id, &cancellation)
            .await;
        let _shutdown = active.gateway.shutdown().await;
    }

    async fn update_catalog(&self, name: &str, catalog: wire::McpServerCatalog) {
        let mut state = self.state.lock().await;
        if let Some(status) = state.statuses.get_mut(name) {
            status.tool_count = catalog.tools.len();
            status.resource_count = catalog.resources.len();
            status.prompt_count = catalog.prompts.len();
            status.error = None;
            status.updated_at = now();
        }
        state.catalogs.insert(name.to_string(), catalog);
    }

    async fn record_catalog_failure(&self, name: &str, error: &McpError) {
        let failure = ConnectionFailure::Gateway(clone_gateway_error_kind(error));
        let mut state = self.state.lock().await;
        if let Some(status) = state.statuses.get_mut(name) {
            status.error = Some(failure.status_error());
            status.updated_at = now();
        }
    }

    async fn record_stopped_statuses(&self, servers: &[UserMcpServer]) {
        let mut state = self.state.lock().await;
        for server in servers {
            state
                .statuses
                .insert(server.name.clone(), stopped_status(server));
        }
    }

    async fn record_cleanup_statuses(&self, active_names: &BTreeSet<String>, cleanup_failed: bool) {
        let mut state = self.state.lock().await;
        for (name, status) in &mut state.statuses {
            if !active_names.contains(name) {
                continue;
            }
            status.state = wire::McpServerState::Stopped;
            status.capabilities = None;
            status.server_info = None;
            status.tool_count = 0;
            status.resource_count = 0;
            status.prompt_count = 0;
            status.error = cleanup_failed.then(|| wire::McpStatusError {
                code: "CONNECTION_CLEANUP_FAILED".to_string(),
                message: "The MCP connection did not close cleanly.".to_string(),
            });
            status.updated_at = now();
        }
    }

    async fn set_status(&self, status: wire::McpServerStatus) {
        self.state
            .lock()
            .await
            .statuses
            .insert(status.name.clone(), status);
    }

    async fn statuses_for(&self, servers: &[UserMcpServer]) -> Vec<wire::McpServerStatus> {
        let state = self.state.lock().await;
        servers
            .iter()
            .map(|server| {
                state
                    .statuses
                    .get(&server.name)
                    .cloned()
                    .unwrap_or_else(|| stopped_status(server))
            })
            .collect()
    }
}

impl ShutdownHook for McpRuntimeManager {
    fn name(&self) -> &'static str {
        "mcp-runtime"
    }

    fn run(&self, phase: ShutdownPhase) -> ShutdownFuture<'_> {
        Box::pin(async move {
            match phase {
                ShutdownPhase::StopAccepting => self.stop_accepting(),
                ShutdownPhase::Cancel => self.cancel_active(),
                ShutdownPhase::ForceCleanup => self.force_cleanup().await?,
                ShutdownPhase::Flush => {}
            }
            Ok(())
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConnectionMode {
    Disabled,
    UnsupportedTransport,
    UnsupportedOAuth,
    Connect,
}

fn connection_mode(server: &UserMcpServer) -> ConnectionMode {
    if server.config.enabled == Some(false) {
        return ConnectionMode::Disabled;
    }
    if server.config.oauth.is_some() {
        return ConnectionMode::UnsupportedOAuth;
    }
    match server.config.transport {
        McpTransport::Stdio | McpTransport::Http => ConnectionMode::Connect,
        McpTransport::Sse => ConnectionMode::UnsupportedTransport,
    }
}

fn should_keep_connection(server: &UserMcpServer, active: &ActiveConnection) -> bool {
    connection_mode(server) == ConnectionMode::Connect && active.fingerprint == server.fingerprint
}

fn failure_state(failure: &ConnectionFailure) -> wire::McpServerState {
    match failure {
        ConnectionFailure::MissingSecret
        | ConnectionFailure::SecretStore(McpSecretStoreError::AccessDenied)
        | ConnectionFailure::SecretStore(McpSecretStoreError::Unavailable) => {
            wire::McpServerState::NeedsAuth
        }
        ConnectionFailure::UnsupportedOAuth => wire::McpServerState::NeedsAuth,
        ConnectionFailure::AdmissionClosed
        | ConnectionFailure::Gateway(McpError::Cancelled { .. }) => wire::McpServerState::Stopped,
        ConnectionFailure::InvalidConfiguration
        | ConnectionFailure::InvalidExpression
        | ConnectionFailure::MissingEnvironment
        | ConnectionFailure::SecretStore(_)
        | ConnectionFailure::UnsupportedTransport
        | ConnectionFailure::Gateway(_) => wire::McpServerState::Failed,
    }
}

fn user_server_id(name: &str) -> Result<McpServerId, ConnectionFailure> {
    McpServerId::new(format!("{USER_SERVER_ID_PREFIX}{name}"))
        .map_err(|_| ConnectionFailure::InvalidConfiguration)
}

fn timeouts_for(config: &McpServerConfig) -> Result<McpTimeouts, ConnectionFailure> {
    let connect = config
        .handshake_timeout_ms
        .map_or(DEFAULT_CONNECT_TIMEOUT, |milliseconds| {
            Duration::from_millis(u64::from(milliseconds))
        });
    let request = config
        .timeout_ms
        .map_or(DEFAULT_REQUEST_TIMEOUT, |milliseconds| {
            Duration::from_millis(u64::from(milliseconds))
        });
    McpTimeouts::new(connect, request, DEFAULT_CLOSE_TIMEOUT).map_err(ConnectionFailure::Gateway)
}

fn valid_environment_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn base_status(server: &UserMcpServer, state: wire::McpServerState) -> wire::McpServerStatus {
    wire::McpServerStatus {
        name: server.name.clone(),
        scope: wire::McpConfigScope::User,
        state,
        fingerprint: server.fingerprint.clone(),
        transport: transport_to_wire(server.config.transport),
        capabilities: None,
        server_info: None,
        tool_count: 0,
        resource_count: 0,
        prompt_count: 0,
        error: None,
        next_retry_at: None,
        updated_at: now(),
        logs: Vec::new(),
    }
}

fn disabled_status(server: &UserMcpServer) -> wire::McpServerStatus {
    base_status(server, wire::McpServerState::Disabled)
}

fn stopped_status(server: &UserMcpServer) -> wire::McpServerStatus {
    base_status(server, wire::McpServerState::Stopped)
}

fn connecting_status(server: &UserMcpServer) -> wire::McpServerStatus {
    base_status(server, wire::McpServerState::Connecting)
}

fn failure_status(
    server: &UserMcpServer,
    state: wire::McpServerState,
    failure: &ConnectionFailure,
) -> wire::McpServerStatus {
    let mut status = base_status(server, state);
    status.error = Some(failure.status_error());
    status
}

fn connected_status(server: &UserMcpServer, info: &McpConnectionInfo) -> wire::McpServerStatus {
    let mut status = base_status(server, wire::McpServerState::Connected);
    status.capabilities = serde_json::to_value(&info.server.capabilities)
        .ok()
        .map(|value| redact_sensitive_value(&value));
    status.server_info = Some(wire::McpServerIdentity {
        name: redact_sensitive_text(&info.server.server_info.name),
        version: redact_sensitive_text(&info.server.server_info.version),
        title: info
            .server
            .server_info
            .title
            .as_deref()
            .map(redact_sensitive_text),
    });
    status
}

fn catalog_to_wire(name: &str, catalog: McpCatalog) -> wire::McpServerCatalog {
    let mut resources = catalog
        .resources
        .into_iter()
        .map(|resource| wire::McpResourceSummary {
            server: name.to_string(),
            uri: redact_sensitive_text(&resource.uri),
            name: redact_sensitive_text(&resource.name),
            description: resource.description.as_deref().map(redact_sensitive_text),
            mime_type: resource.mime_type.as_deref().map(redact_sensitive_text),
            template: None,
        })
        .collect::<Vec<_>>();
    resources.extend(catalog.resource_templates.into_iter().map(|template| {
        wire::McpResourceSummary {
            server: name.to_string(),
            uri: redact_sensitive_text(&template.uri_template),
            name: redact_sensitive_text(&template.name),
            description: template.description.as_deref().map(redact_sensitive_text),
            mime_type: template.mime_type.as_deref().map(redact_sensitive_text),
            template: Some(true),
        }
    }));

    wire::McpServerCatalog {
        server: name.to_string(),
        tools: catalog
            .tools
            .into_iter()
            .map(|tool| wire::McpToolSummary {
                name: redact_sensitive_text(tool.name.as_ref()),
                title: tool.title.as_deref().map(redact_sensitive_text),
                description: tool.description.as_deref().map(redact_sensitive_text),
                input_schema: redact_sensitive_value(&Value::Object((*tool.input_schema).clone())),
                output_schema: tool
                    .output_schema
                    .map(|schema| redact_sensitive_value(&Value::Object((*schema).clone()))),
                annotations: tool.annotations.and_then(|annotations| {
                    serde_json::to_value(annotations)
                        .ok()
                        .map(|value| redact_sensitive_value(&value))
                }),
            })
            .collect(),
        resources,
        prompts: catalog
            .prompts
            .into_iter()
            .map(|prompt| wire::McpPromptSummary {
                server: name.to_string(),
                name: redact_sensitive_text(&prompt.name),
                description: prompt.description.as_deref().map(redact_sensitive_text),
                arguments: prompt.arguments.map(|arguments| {
                    arguments
                        .into_iter()
                        .map(|argument| wire::McpPromptArgument {
                            name: redact_sensitive_text(&argument.name),
                            description: argument.description.as_deref().map(redact_sensitive_text),
                            required: argument.required,
                        })
                        .collect()
                }),
            })
            .collect(),
        updated_at: Some(now()),
        stale: false,
    }
}

fn clone_gateway_error_kind(error: &McpError) -> McpError {
    match error {
        McpError::Timeout { operation, timeout } => McpError::Timeout {
            operation: *operation,
            timeout: *timeout,
        },
        McpError::Cancelled { operation } => McpError::Cancelled {
            operation: *operation,
        },
        _ => McpError::BackgroundTask,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        env,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use codez_mcp::{McpSecretValue, SecretFuture};
    use tokio::sync::Mutex;

    use super::*;

    type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

    #[derive(Default)]
    struct TestSecretStore {
        values: Mutex<BTreeMap<McpSecretKey, String>>,
    }

    impl McpSecretStore for TestSecretStore {
        fn get(&self, key: McpSecretKey) -> SecretFuture<'_, Option<McpSecretValue>> {
            Box::pin(async move {
                self.values
                    .lock()
                    .await
                    .get(&key)
                    .cloned()
                    .map(McpSecretValue::new)
                    .transpose()
                    .map_err(|_| McpSecretStoreError::Corrupt)
            })
        }

        fn set(&self, key: McpSecretKey, value: McpSecretValue) -> SecretFuture<'_, ()> {
            Box::pin(async move {
                self.values
                    .lock()
                    .await
                    .insert(key, value.expose_secret().to_string());
                Ok(())
            })
        }

        fn delete(&self, key: McpSecretKey) -> SecretFuture<'_, ()> {
            Box::pin(async move {
                self.values.lock().await.remove(&key);
                Ok(())
            })
        }
    }

    fn manager() -> McpRuntimeManager {
        McpRuntimeManager::new(Arc::new(TestSecretStore::default()))
    }

    fn server(name: &str, config: McpServerConfig) -> UserMcpServer {
        UserMcpServer {
            name: name.to_string(),
            config,
            fingerprint: format!("fingerprint-{name}"),
        }
    }

    fn config(transport: McpTransport) -> McpServerConfig {
        McpServerConfig {
            transport,
            description: None,
            enabled: Some(true),
            timeout_ms: None,
            handshake_timeout_ms: None,
            always_load_tools: None,
            blocked_tools: None,
            auto_start: None,
            reconnect: None,
            instructions_policy: None,
            sampling_policy: None,
            elicitation_policy: None,
            sampling_max_tokens: None,
            resource_subscriptions: None,
            command: Some("C:\\fixture\\server.exe".to_string()),
            args: None,
            env: None,
            cwd: None,
            url: Some("https://example.test/mcp".to_string()),
            headers: None,
            oauth: None,
            extensions: BTreeMap::new(),
        }
    }

    fn workspace_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri must be located below the workspace root")
            .to_path_buf()
    }

    fn node_executable() -> TestResult<PathBuf> {
        let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
        let path =
            env::var_os("PATH").ok_or("PATH is required to locate the MCP stdio fixture host")?;
        for directory in env::split_paths(&path) {
            let candidate = directory.join(executable_name);
            if candidate.is_file() {
                return Ok(std::fs::canonicalize(candidate)?);
            }
        }
        Err("Node executable was not found on PATH".into())
    }

    fn fixture_environment() -> BTreeMap<String, String> {
        [
            "HOME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "PATH",
        ]
        .into_iter()
        .filter_map(|key| env::var(key).ok().map(|value| (key.to_string(), value)))
        .collect()
    }

    fn fixture_server() -> TestResult<UserMcpServer> {
        let root = workspace_root();
        let mut fixture = config(McpTransport::Stdio);
        fixture.command = Some(node_executable()?.to_string_lossy().into_owned());
        fixture.args = Some(vec![
            root.join("src")
                .join("tests")
                .join("fixtures")
                .join("mcp-stdio-server.cjs")
                .to_string_lossy()
                .into_owned(),
        ]);
        fixture.env = Some(fixture_environment());
        fixture.cwd = Some(root.to_string_lossy().into_owned());
        fixture.url = None;
        Ok(server("fixture", fixture))
    }

    #[tokio::test]
    async fn reconcile_reports_disabled_servers_without_opening_a_gateway() {
        let manager = manager();
        let mut config = config(McpTransport::Stdio);
        config.enabled = Some(false);
        let statuses = manager.reconcile(&[server("disabled", config)]).await;

        assert_eq!(statuses[0].state, wire::McpServerState::Disabled);
    }

    #[tokio::test]
    async fn force_cleanup_preserves_non_running_statuses() {
        let manager = manager();
        let mut config = config(McpTransport::Stdio);
        config.enabled = Some(false);
        let server = server("disabled", config);
        manager.reconcile(std::slice::from_ref(&server)).await;

        manager
            .force_cleanup()
            .await
            .expect("cleaning up no active gateways must succeed");
        let statuses = manager.statuses().await;

        assert_eq!(statuses[0].state, wire::McpServerState::Disabled);
    }

    #[tokio::test]
    async fn reconcile_reports_legacy_sse_as_a_typed_unsupported_failure() {
        let manager = manager();
        let statuses = manager
            .reconcile(&[server("legacy", config(McpTransport::Sse))])
            .await;

        assert_eq!(
            statuses[0].error.as_ref().map(|error| error.code.as_str()),
            Some("UNSUPPORTED_TRANSPORT")
        );
    }

    #[tokio::test]
    async fn reconcile_reports_oauth_as_needs_auth_without_connecting() {
        let manager = manager();
        let mut config = config(McpTransport::Http);
        config.oauth = Some(codez_mcp::McpOAuthConfig {
            client_id: None,
            callback_port: None,
            scope: None,
        });
        let statuses = manager.reconcile(&[server("oauth", config)]).await;

        assert_eq!(
            (
                statuses[0].state,
                statuses[0].error.as_ref().map(|error| error.code.as_str()),
            ),
            (wire::McpServerState::NeedsAuth, Some("OAUTH_UNSUPPORTED"))
        );
    }

    #[tokio::test]
    async fn missing_secret_expression_fails_closed_without_exposing_its_value() {
        let manager = manager();
        let mut config = config(McpTransport::Stdio);
        config.env = Some(BTreeMap::from([(
            "API_TOKEN".to_string(),
            "Bearer ${secret:missing.token}".to_string(),
        )]));
        let statuses = manager.reconcile(&[server("private", config)]).await;
        let error = statuses[0]
            .error
            .as_ref()
            .expect("missing secret must produce a status error");

        assert_eq!(error.code, "MCP_SECRET_UNAVAILABLE");
        assert!(!error.message.contains("missing.token"));
    }

    #[tokio::test]
    async fn resolve_value_expands_os_secret_values_only_inside_the_runtime_boundary() {
        let store = Arc::new(TestSecretStore::default());
        let key = McpSecretKey::parse("fixture.token").expect("test key must be valid");
        store
            .set(
                key,
                McpSecretValue::new("runtime-secret").expect("test secret must be valid"),
            )
            .await
            .expect("test credential write must succeed");
        let manager = McpRuntimeManager::new(store);

        let resolved = manager
            .resolve_value("Bearer ${secret:fixture.token}")
            .await
            .expect("configured secret must resolve");

        assert_eq!(resolved.value, "Bearer runtime-secret");
        assert_eq!(resolved.secret_redaction_values, vec!["runtime-secret"]);
    }

    #[tokio::test]
    async fn manager_runs_a_local_stdio_fixture_and_reports_stopped_after_cleanup() -> TestResult {
        let manager = manager();
        let server = fixture_server()?;

        let statuses = manager.reconcile(std::slice::from_ref(&server)).await;
        assert_eq!(statuses[0].state, wire::McpServerState::Connected);
        assert_eq!(
            statuses[0]
                .server_info
                .as_ref()
                .map(|identity| identity.name.as_str()),
            Some("codez-test-server")
        );

        let catalog = manager.catalog(&server.name).await?;
        assert!(catalog.tools.iter().any(|tool| tool.name == "echo"));
        assert!(
            catalog
                .resources
                .iter()
                .any(|resource| resource.uri == "test://example")
        );
        assert!(catalog.prompts.iter().any(|prompt| prompt.name == "review"));

        manager.force_cleanup().await?;
        let statuses = manager.statuses().await;
        let stopped = statuses
            .iter()
            .find(|status| status.name == server.name)
            .ok_or("fixture status must remain visible after cleanup")?;
        assert_eq!(stopped.state, wire::McpServerState::Stopped);
        assert!(stopped.server_info.is_none());
        assert_eq!(
            (
                stopped.tool_count,
                stopped.resource_count,
                stopped.prompt_count,
                stopped.error.as_ref().map(|error| error.code.as_str()),
            ),
            (0, 0, 0, None)
        );
        assert!(manager.catalog(&server.name).await.is_err());
        Ok(())
    }
}
