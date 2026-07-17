use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use chrono::Utc;
use codez_contracts::mcp as wire;
use codez_core::{AppError, redact_sensitive_text, redact_sensitive_value};
use codez_mcp::{
    McpCatalog, McpCatalogKind, McpConfigScope, McpConnectionInfo, McpError, McpEvent, McpGateway,
    McpGatewayLimits, McpOAuthClient, McpOAuthError, McpReverseRequestPolicy, McpSecretKey,
    McpSecretStore, McpSecretStoreError, McpServerConfig, McpServerId, McpTimeouts, McpTransport,
    ScopedMcpServer, StdioServerConfig, StreamableHttpServerConfig,
};
use codez_runtime::{ShutdownFuture, ShutdownHook, ShutdownPhase};
use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::mcp_boundary::transport_to_wire;
use crate::mcp_interaction::McpReverseRequestDesktopContext;

const USER_SERVER_ID_PREFIX: &str = "user:";
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_INTERACTIVE_RESULT_BYTES: usize = 256 * 1024;
const MAX_RESOURCE_URI_BYTES: usize = 8 * 1024;
const MAX_PROMPT_NAME_BYTES: usize = 512;
const MAX_PROMPT_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_RESOURCE_SUBSCRIPTIONS_PER_SERVER: usize = 128;
const MAX_STATUS_LOG_ENTRIES: usize = 200;
const MAX_STATUS_LOG_MESSAGE_BYTES: usize = 8 * 1024;
const MAX_STATUS_LOG_DATA_BYTES: usize = 32 * 1024;
const MAX_SERVER_LOGS_PER_SECOND: usize = 100;
const SERVER_LOG_WINDOW: Duration = Duration::from_secs(1);
const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
const OAUTH_CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OAUTH_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;

/// Owns live user-scoped MCP connections and their redacted desktop status.
///
/// A gateway is scoped to one configuration so validated per-server request and
/// handshake budgets are applied without making another server's configuration
/// affect it. The manager serializes lifecycle transitions, while the gateway
/// remains responsible for process/network cleanup for each connection.
pub(crate) struct McpRuntimeManager {
    secret_store: Arc<dyn McpSecretStore>,
    reverse_request_context: Option<Arc<McpReverseRequestDesktopContext>>,
    accepting: AtomicBool,
    cancellation: CancellationToken,
    operation_lock: Mutex<()>,
    oauth_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    state: Arc<Mutex<McpRuntimeState>>,
}

#[derive(Default)]
struct McpRuntimeState {
    active: BTreeMap<String, ActiveConnection>,
    catalogs: BTreeMap<String, wire::McpServerCatalog>,
    statuses: BTreeMap<String, wire::McpServerStatus>,
    log_windows: BTreeMap<String, McpLogWindow>,
}

#[derive(Clone)]
struct ActiveConnection {
    fingerprint: String,
    server_id: McpServerId,
    gateway: Arc<McpGateway>,
    supports_resource_subscriptions: bool,
    subscriptions: Arc<Mutex<BTreeSet<String>>>,
    event_cancellation: CancellationToken,
}

struct McpLogWindow {
    started_at: Instant,
    emitted: usize,
    dropped: u64,
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
    OAuth(McpOAuthError),
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
            Self::OAuth(McpOAuthError::AuthorizationRequired) => (
                "OAUTH_REQUIRED",
                "This MCP server requires OAuth authorization before it can connect.",
            ),
            Self::OAuth(McpOAuthError::CredentialStore) => (
                "OAUTH_CREDENTIAL_STORE_UNAVAILABLE",
                "The operating-system credential store is unavailable for MCP OAuth.",
            ),
            Self::OAuth(_) => (
                "OAUTH_FAILED",
                "MCP OAuth could not complete its secure authorization flow.",
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
            Self::OAuth(McpOAuthError::AuthorizationRequired) => {
                AppError::not_found("MCP OAuth authorization is required")
            }
            Self::OAuth(McpOAuthError::CredentialStore) => AppError::external(
                "The operating-system credential store is unavailable",
                "MCP OAuth credential adapter could not access the keychain",
                true,
            ),
            Self::OAuth(_) => AppError::external(
                "MCP OAuth could not complete its secure authorization flow",
                "MCP OAuth adapter returned a redacted failure",
                true,
            ),
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
            reverse_request_context: None,
            accepting: AtomicBool::new(true),
            cancellation: CancellationToken::new(),
            operation_lock: Mutex::new(()),
            oauth_locks: Mutex::new(BTreeMap::new()),
            state: Arc::new(Mutex::new(McpRuntimeState::default())),
        }
    }

    /// Creates an MCP runtime whose policy-approved reverse requests can be
    /// mediated by the Tauri desktop and current CodeZ Provider.
    #[must_use]
    pub(crate) fn with_desktop_reverse_requests(
        secret_store: Arc<dyn McpSecretStore>,
        app: tauri::AppHandle,
        providers: Arc<codez_providers::service::ProviderService>,
        application_cancellation: CancellationToken,
    ) -> Self {
        let mut manager = Self::new(secret_store);
        manager.reverse_request_context = Some(Arc::new(McpReverseRequestDesktopContext::new(
            app,
            providers,
            application_cancellation,
        )));
        manager
    }

    /// Resolves exactly one pending desktop response for an MCP reverse request.
    ///
    /// # Errors
    ///
    /// Returns a typed error if this runtime has no desktop mediator, the request
    /// expired, or the response does not match its original request type/schema.
    pub(crate) async fn respond_reverse_request(
        &self,
        request_id: &str,
        response: wire::McpReverseRequestResponse,
    ) -> Result<(), AppError> {
        let context = self.reverse_request_context.as_ref().ok_or_else(|| {
            AppError::conflict("The MCP desktop reverse-request mediator is unavailable")
        })?;
        context.respond(request_id, response).await
    }

    /// Reconciles live connections with the complete persisted user configuration.
    ///
    /// Existing connections with an unchanged fingerprint are retained. Removed,
    /// disabled, unsupported, or changed configurations are stopped before a
    /// replacement is started. Individual connection failures become typed
    /// statuses so a valid configuration save is never rolled back by a remote
    /// process or network failure.
    pub(crate) async fn reconcile(
        &self,
        servers: &[ScopedMcpServer],
    ) -> Vec<wire::McpServerStatus> {
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
    pub(crate) async fn reconnect(&self, server: &ScopedMcpServer) -> Result<(), AppError> {
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
            ConnectionMode::TrustRequired => {
                self.set_status(trust_required_status(server)).await;
                Err(AppError::permission_denied(
                    "The project MCP configuration must be explicitly trusted before it can connect",
                ))
            }
            ConnectionMode::Connect => self.connect_and_record(server).await,
            ConnectionMode::Disabled => Err(AppError::conflict("The MCP server is disabled")),
        }
    }

    /// Runs one interactive OAuth flow for a currently trusted remote server.
    ///
    /// The caller may only open the URL generated by this transaction. Tokens
    /// and PKCE state remain in the MCP OAuth adapter and OS credential store.
    pub(crate) async fn authorize<F>(
        &self,
        server: &ScopedMcpServer,
        open_external: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce(&str) -> Result<(), AppError>,
    {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(ConnectionFailure::AdmissionClosed.into_app_error());
        }
        if server.config.enabled == Some(false) {
            return Err(AppError::conflict("The MCP server is disabled"));
        }
        if !server.trusted {
            return Err(AppError::permission_denied(
                "The project MCP configuration must be explicitly trusted before OAuth authorization",
            ));
        }
        let lock = self.oauth_lock(&server.fingerprint).await;
        let _authorization = lock.lock().await;
        let result = async {
            let client = self.oauth_client(server)?;
            let listener = bind_oauth_callback_listener(server.config.oauth.as_ref())
                .await
                .map_err(ConnectionFailure::into_app_error)?;
            let port = listener
                .local_addr()
                .map_err(|_| {
                    AppError::external(
                        "MCP OAuth could not prepare its callback listener",
                        "read bound OAuth callback port",
                        false,
                    )
                })?
                .port();
            let callback_url = format!("http://127.0.0.1:{port}/oauth/callback");
            let authorization = client
                .start_authorization(&callback_url, &format!("CodeZ MCP ({})", server.name))
                .await
                .map_err(ConnectionFailure::OAuth)
                .map_err(ConnectionFailure::into_app_error)?;
            open_external(authorization.authorization_url().as_str())?;
            wait_for_oauth_callback(&listener, &authorization).await
        }
        .await;
        if let Err(error) = result {
            let failure = ConnectionFailure::OAuth(McpOAuthError::AuthorizationRequired);
            self.set_status(failure_status(
                server,
                wire::McpServerState::NeedsAuth,
                &failure,
            ))
            .await;
            return Err(error);
        }
        Ok(())
    }

    /// Revokes the current server's OAuth credentials where supported, clears
    /// the OS keychain entry, and closes any connection that used the token.
    pub(crate) async fn logout(&self, server: &ScopedMcpServer) -> Result<(), AppError> {
        if !server.trusted {
            return Err(AppError::permission_denied(
                "The project MCP configuration must be explicitly trusted before OAuth logout",
            ));
        }
        let lock = self.oauth_lock(&server.fingerprint).await;
        let _logout = lock.lock().await;
        let client = self.oauth_client(server)?;
        let result = client
            .logout()
            .await
            .map_err(ConnectionFailure::OAuth)
            .map_err(ConnectionFailure::into_app_error);
        {
            let _operation = self.operation_lock.lock().await;
            self.remove_active_connection(&server.name).await;
            let failure = ConnectionFailure::OAuth(McpOAuthError::AuthorizationRequired);
            self.set_status(failure_status(
                server,
                wire::McpServerState::NeedsAuth,
                &failure,
            ))
            .await;
        }
        result
    }

    /// Reads a fresh catalog from one currently live MCP server.
    ///
    /// A previously discovered catalog is returned as `stale` when the current
    /// refresh fails. No cache is fabricated for a server that has never
    /// returned a catalog.
    pub(crate) async fn catalog(
        &self,
        server: &ScopedMcpServer,
    ) -> Result<wire::McpServerCatalog, AppError> {
        let _operation = self.operation_lock.lock().await;
        let active = self.active_connection(server, "catalog").await?;

        match active
            .gateway
            .list_catalog(&active.server_id, &self.cancellation)
            .await
        {
            Ok(catalog) => {
                let catalog = catalog_to_wire(&server.name, catalog);
                self.update_catalog(&server.name, catalog.clone()).await;
                Ok(catalog)
            }
            Err(error) => {
                self.record_catalog_failure(&server.name, &error).await;
                let cached = {
                    let state = self.state.lock().await;
                    state.catalogs.get(&server.name).cloned()
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

    /// Reads one explicitly selected resource from a trusted active server.
    pub(crate) async fn read_resource(
        &self,
        server: &ScopedMcpServer,
        uri: &str,
    ) -> Result<wire::McpResourceReadResult, AppError> {
        validate_remote_identifier(uri, MAX_RESOURCE_URI_BYTES, "resource URI")?;
        let catalog = self.catalog(server).await?;
        if !catalog_advertises_resource(&catalog, uri) {
            return Err(AppError::permission_denied(
                "The requested MCP resource was not advertised by the connected server",
            ));
        }
        let _operation = self.operation_lock.lock().await;
        let active = self.active_connection(server, "resource").await?;
        let result = active
            .gateway
            .read_resource(&active.server_id, uri, &self.cancellation)
            .await
            .map_err(ConnectionFailure::Gateway)
            .map_err(ConnectionFailure::into_app_error)?;
        Ok(wire::McpResourceReadResult {
            server: server.name.clone(),
            contents: bounded_desktop_value(&result.contents)?,
        })
    }

    /// Subscribes to an advertised resource only when the configuration and
    /// initialized server capability both explicitly allow notifications.
    pub(crate) async fn subscribe_resource(
        &self,
        server: &ScopedMcpServer,
        uri: &str,
    ) -> Result<(), AppError> {
        validate_remote_identifier(uri, MAX_RESOURCE_URI_BYTES, "resource URI")?;
        if server.config.resource_subscriptions != Some(true) {
            return Err(AppError::permission_denied(
                "MCP resource subscriptions are disabled for this server",
            ));
        }
        let catalog = self.catalog(server).await?;
        if !catalog_advertises_resource(&catalog, uri) {
            return Err(AppError::permission_denied(
                "The requested MCP resource was not advertised by the connected server",
            ));
        }

        let _operation = self.operation_lock.lock().await;
        let active = self
            .active_connection(server, "resource subscription")
            .await?;
        if !active.supports_resource_subscriptions {
            return Err(AppError::unsupported(
                "The connected MCP server does not support resource subscriptions",
            ));
        }
        {
            let subscriptions = active.subscriptions.lock().await;
            if subscriptions.contains(uri) {
                return Ok(());
            }
            if subscriptions.len() >= MAX_RESOURCE_SUBSCRIPTIONS_PER_SERVER {
                return Err(AppError::validation(
                    "The MCP server has reached the resource subscription limit",
                ));
            }
        }
        active
            .gateway
            .subscribe(&active.server_id, uri, &self.cancellation)
            .await
            .map_err(ConnectionFailure::Gateway)
            .map_err(ConnectionFailure::into_app_error)?;
        active.subscriptions.lock().await.insert(uri.to_owned());
        self.record_runtime_log(
            &server.name,
            &server.fingerprint,
            wire::McpLogLevel::Info,
            "MCP resource subscription created",
            Some(serde_json::json!({ "uri": uri })),
        )
        .await;
        Ok(())
    }

    /// Stops a previously successful subscription. Unknown local subscriptions
    /// are idempotent so callers can safely release UI resources twice.
    pub(crate) async fn unsubscribe_resource(
        &self,
        server: &ScopedMcpServer,
        uri: &str,
    ) -> Result<(), AppError> {
        validate_remote_identifier(uri, MAX_RESOURCE_URI_BYTES, "resource URI")?;
        let _operation = self.operation_lock.lock().await;
        let active = self
            .active_connection(server, "resource unsubscription")
            .await?;
        if !active.subscriptions.lock().await.contains(uri) {
            return Ok(());
        }
        active
            .gateway
            .unsubscribe(&active.server_id, uri, &self.cancellation)
            .await
            .map_err(ConnectionFailure::Gateway)
            .map_err(ConnectionFailure::into_app_error)?;
        active.subscriptions.lock().await.remove(uri);
        self.record_runtime_log(
            &server.name,
            &server.fingerprint,
            wire::McpLogLevel::Info,
            "MCP resource subscription removed",
            Some(serde_json::json!({ "uri": uri })),
        )
        .await;
        Ok(())
    }

    /// Resolves one explicitly selected prompt from a trusted active server.
    pub(crate) async fn get_prompt(
        &self,
        server: &ScopedMcpServer,
        name: &str,
        arguments: BTreeMap<String, Value>,
    ) -> Result<wire::McpPromptGetResult, AppError> {
        validate_remote_identifier(name, MAX_PROMPT_NAME_BYTES, "prompt name")?;
        validate_prompt_arguments(&arguments)?;
        let _operation = self.operation_lock.lock().await;
        let active = self.active_connection(server, "prompt").await?;
        let result = active
            .gateway
            .get_prompt(
                &active.server_id,
                name,
                arguments.into_iter().collect(),
                &self.cancellation,
            )
            .await
            .map_err(ConnectionFailure::Gateway)
            .map_err(ConnectionFailure::into_app_error)?;
        Ok(wire::McpPromptGetResult {
            server: server.name.clone(),
            description: result
                .description
                .map(|value| redact_sensitive_text(&value)),
            messages: bounded_desktop_value(&result.messages)?,
        })
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
            cleanup_failed |= !self.close_connection(connection).await;
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

    async fn reconcile_locked(&self, servers: &[ScopedMcpServer]) {
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
            state
                .log_windows
                .retain(|name, _| configured_names.contains(name));
        }

        for server in servers {
            match connection_mode(server) {
                ConnectionMode::Disabled => self.set_status(disabled_status(server)).await,
                ConnectionMode::TrustRequired => {
                    self.set_status(trust_required_status(server)).await
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

    async fn connect_and_record(&self, server: &ScopedMcpServer) -> Result<(), AppError> {
        self.set_status(connecting_status(server)).await;
        match self.connect(server).await {
            Ok((connection, status)) => {
                {
                    let mut state = self.state.lock().await;
                    state.active.insert(server.name.clone(), connection.clone());
                }
                self.set_status(status).await;
                self.spawn_event_listener(&server.name, &connection);
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

    async fn active_connection(
        &self,
        server: &ScopedMcpServer,
        operation: &str,
    ) -> Result<ActiveConnection, AppError> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(ConnectionFailure::AdmissionClosed.into_app_error());
        }
        if !server.trusted {
            return Err(AppError::permission_denied(format!(
                "The project MCP configuration must be explicitly trusted before its {operation} can be read",
            )));
        }
        let active = {
            let state = self.state.lock().await;
            state.active.get(&server.name).cloned()
        }
        .ok_or_else(|| AppError::not_found("The MCP server is not connected"))?;
        if active.fingerprint != server.fingerprint {
            return Err(AppError::conflict(
                "The MCP server configuration changed and must be reconciled before its content can be read",
            ));
        }
        Ok(active)
    }

    async fn connect(
        &self,
        server: &ScopedMcpServer,
    ) -> Result<(ActiveConnection, wire::McpServerStatus), ConnectionFailure> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(ConnectionFailure::AdmissionClosed);
        }
        let server_id = user_server_id(&server.name)?;
        let reverse_requests = McpReverseRequestPolicy::from_server_config(&server.config);
        let reverse_requests = match self.reverse_request_context.as_ref() {
            Some(context) => reverse_requests.with_handler(context.handler_for(server)),
            None => reverse_requests,
        };
        let gateway = Arc::new(McpGateway::with_config_and_reverse_requests(
            timeouts_for(&server.config)?,
            McpGatewayLimits::default(),
            reverse_requests,
        ));
        let info = match server.config.transport {
            McpTransport::Stdio => {
                let config = self.stdio_config(&server.config).await?;
                gateway
                    .connect_stdio(server_id.clone(), config, &self.cancellation)
                    .await
            }
            McpTransport::Http => {
                let config = self.http_config(server).await?;
                gateway
                    .connect_streamable_http(server_id.clone(), config, &self.cancellation)
                    .await
            }
            McpTransport::Sse => {
                let config = self.http_config(server).await?;
                gateway
                    .connect_legacy_sse(server_id.clone(), config, &self.cancellation)
                    .await
            }
        }
        .map_err(ConnectionFailure::Gateway)?;

        let supports_resource_subscriptions = info
            .server
            .capabilities
            .resources
            .as_ref()
            .and_then(|resources| resources.subscribe)
            == Some(true);

        Ok((
            ActiveConnection {
                fingerprint: server.fingerprint.clone(),
                server_id,
                gateway,
                supports_resource_subscriptions,
                subscriptions: Arc::new(Mutex::new(BTreeSet::new())),
                event_cancellation: self.cancellation.child_token(),
            },
            connected_status(server, &info),
        ))
    }

    fn spawn_event_listener(&self, name: &str, connection: &ActiveConnection) {
        let state = Arc::clone(&self.state);
        let name = name.to_owned();
        let fingerprint = connection.fingerprint.clone();
        let server_id = connection.server_id.clone();
        let gateway = Arc::clone(&connection.gateway);
        let subscriptions = Arc::clone(&connection.subscriptions);
        let cancellation = connection.event_cancellation.clone();
        tokio::spawn(async move {
            run_mcp_event_listener(
                state,
                name,
                fingerprint,
                server_id,
                gateway,
                subscriptions,
                cancellation,
            )
            .await;
        });
    }

    async fn record_runtime_log(
        &self,
        name: &str,
        fingerprint: &str,
        level: wire::McpLogLevel,
        message: &str,
        data: Option<Value>,
    ) {
        record_runtime_log(&self.state, name, fingerprint, level, message, data).await;
    }

    async fn oauth_lock(&self, fingerprint: &str) -> Arc<Mutex<()>> {
        let mut locks = self.oauth_locks.lock().await;
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        Arc::clone(
            locks
                .entry(fingerprint.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    fn oauth_client(&self, server: &ScopedMcpServer) -> Result<McpOAuthClient, AppError> {
        if matches!(server.config.transport, McpTransport::Stdio) {
            return Err(AppError::validation(
                "MCP OAuth is only available for remote HTTP or SSE servers",
            ));
        }
        let endpoint = server
            .config
            .url
            .as_deref()
            .ok_or_else(|| AppError::validation("The MCP OAuth endpoint is missing"))?;
        let oauth =
            server.config.oauth.clone().ok_or_else(|| {
                AppError::validation("OAuth is not configured for this MCP server")
            })?;
        McpOAuthClient::new(
            endpoint,
            &server.fingerprint,
            oauth,
            Arc::clone(&self.secret_store),
        )
        .map_err(ConnectionFailure::OAuth)
        .map_err(ConnectionFailure::into_app_error)
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
        server: &ScopedMcpServer,
    ) -> Result<StreamableHttpServerConfig, ConnectionFailure> {
        let endpoint = server
            .config
            .url
            .as_deref()
            .ok_or(ConnectionFailure::InvalidConfiguration)?;
        let ResolvedStringMap {
            values: headers,
            secret_redaction_values: _,
        } = self
            .resolve_string_map(server.config.headers.as_ref())
            .await?;
        let config = StreamableHttpServerConfig::new(endpoint, headers)
            .map_err(ConnectionFailure::Gateway)?;
        match server.config.oauth.clone() {
            Some(oauth) => {
                let client = McpOAuthClient::new(
                    endpoint,
                    &server.fingerprint,
                    oauth,
                    Arc::clone(&self.secret_store),
                )
                .map_err(ConnectionFailure::OAuth)?;
                let token = client
                    .access_token()
                    .await
                    .map_err(ConnectionFailure::OAuth)?;
                Ok(config.with_bearer_token(token))
            }
            None => Ok(config),
        }
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
            let _clean = self.close_connection(active).await;
        }
    }

    async fn remove_active_connection_with_value(&self, name: &str, active: ActiveConnection) {
        {
            let mut state = self.state.lock().await;
            state.catalogs.remove(name);
            state.active.remove(name);
        }
        let _clean = self.close_connection(active).await;
    }

    async fn close_connection(&self, active: ActiveConnection) -> bool {
        active.event_cancellation.cancel();
        let subscriptions = {
            let mut subscriptions = active.subscriptions.lock().await;
            std::mem::take(&mut *subscriptions)
        };
        let cancellation = CancellationToken::new();
        let mut clean = true;
        for uri in subscriptions {
            if active
                .gateway
                .unsubscribe(&active.server_id, &uri, &cancellation)
                .await
                .is_err()
            {
                clean = false;
            }
        }
        if active
            .gateway
            .disconnect(&active.server_id, &cancellation)
            .await
            .is_err()
        {
            clean = false;
        }
        if active
            .gateway
            .shutdown()
            .await
            .into_iter()
            .any(|(_, report)| report.is_err())
        {
            clean = false;
        }
        clean
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

    async fn record_stopped_statuses(&self, servers: &[ScopedMcpServer]) {
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

    async fn set_status(&self, mut status: wire::McpServerStatus) {
        let mut state = self.state.lock().await;
        if let Some(previous) = state.statuses.get(&status.name) {
            status.logs = previous.logs.clone();
        }
        state.statuses.insert(status.name.clone(), status);
    }

    async fn statuses_for(&self, servers: &[ScopedMcpServer]) -> Vec<wire::McpServerStatus> {
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

async fn run_mcp_event_listener(
    state: Arc<Mutex<McpRuntimeState>>,
    name: String,
    fingerprint: String,
    server_id: McpServerId,
    gateway: Arc<McpGateway>,
    subscriptions: Arc<Mutex<BTreeSet<String>>>,
    cancellation: CancellationToken,
) {
    loop {
        match gateway.next_event(&server_id, &cancellation).await {
            Ok(event) => {
                if !apply_mcp_event(&state, &name, &fingerprint, &subscriptions, event).await {
                    return;
                }
            }
            Err(McpError::Cancelled { .. }) => return,
            Err(McpError::Timeout { .. }) => continue,
            Err(error) => {
                record_event_stream_failure(&state, &name, &fingerprint, error).await;
                let _reports = gateway.shutdown().await;
                return;
            }
        }
    }
}

async fn apply_mcp_event(
    state: &Arc<Mutex<McpRuntimeState>>,
    name: &str,
    fingerprint: &str,
    subscriptions: &Arc<Mutex<BTreeSet<String>>>,
    event: McpEvent,
) -> bool {
    let subscribed_resource = match &event {
        McpEvent::ResourceUpdated { uri } => subscriptions.lock().await.contains(uri),
        _ => false,
    };
    let mut state = state.lock().await;
    if !active_connection_matches(&state, name, fingerprint) {
        return false;
    }

    match event {
        McpEvent::Logging {
            level,
            logger,
            data,
        } => {
            let message = logger
                .map(|logger| format!("MCP server log: {logger}"))
                .unwrap_or_else(|| "MCP server log".to_owned());
            append_status_log(
                &mut state,
                name,
                log_level_from_protocol(&level),
                &message,
                Some(data),
            );
        }
        McpEvent::Progress {
            progress_token,
            progress,
            total,
            message,
        } => {
            append_status_log(
                &mut state,
                name,
                wire::McpLogLevel::Debug,
                message.as_deref().unwrap_or("MCP progress notification"),
                Some(serde_json::json!({
                    "progressToken": progress_token,
                    "progress": progress,
                    "total": total,
                })),
            );
        }
        McpEvent::ResourceUpdated { uri } if subscribed_resource => {
            append_status_log(
                &mut state,
                name,
                wire::McpLogLevel::Info,
                "MCP resource updated",
                Some(serde_json::json!({ "uri": uri })),
            );
        }
        McpEvent::ResourceUpdated { .. } => {}
        McpEvent::CatalogChanged { catalog } => {
            state.catalogs.remove(name);
            if let Some(status) = state.statuses.get_mut(name) {
                match catalog {
                    McpCatalogKind::Tools => status.tool_count = 0,
                    McpCatalogKind::Resources => status.resource_count = 0,
                    McpCatalogKind::Prompts => status.prompt_count = 0,
                }
            }
            append_status_log(
                &mut state,
                name,
                wire::McpLogLevel::Debug,
                "MCP server catalog changed",
                Some(serde_json::json!({ "catalog": catalog })),
            );
        }
        McpEvent::CustomNotification { method } => {
            append_status_log(
                &mut state,
                name,
                wire::McpLogLevel::Debug,
                "MCP server sent a custom notification",
                Some(serde_json::json!({ "method": method })),
            );
        }
        McpEvent::ReverseRequestPending { kind } => {
            append_status_log(
                &mut state,
                name,
                wire::McpLogLevel::Warning,
                "MCP reverse request requires desktop approval",
                Some(serde_json::json!({ "kind": kind })),
            );
        }
        McpEvent::Overflow { dropped } => {
            append_status_log(
                &mut state,
                name,
                wire::McpLogLevel::Warning,
                "MCP server events were dropped because the bounded queue was full",
                Some(serde_json::json!({ "dropped": dropped })),
            );
        }
    }
    true
}

async fn record_runtime_log(
    state: &Arc<Mutex<McpRuntimeState>>,
    name: &str,
    fingerprint: &str,
    level: wire::McpLogLevel,
    message: &str,
    data: Option<Value>,
) {
    let mut state = state.lock().await;
    if active_connection_matches(&state, name, fingerprint) {
        append_status_log(&mut state, name, level, message, data);
    }
}

async fn record_event_stream_failure(
    state: &Arc<Mutex<McpRuntimeState>>,
    name: &str,
    fingerprint: &str,
    _error: McpError,
) {
    let mut state = state.lock().await;
    if !active_connection_matches(&state, name, fingerprint) {
        return;
    }
    state.active.remove(name);
    state.catalogs.remove(name);
    if let Some(status) = state.statuses.get_mut(name) {
        status.state = wire::McpServerState::Failed;
        status.error = Some(wire::McpStatusError {
            code: "MCP_EVENT_STREAM_CLOSED".to_owned(),
            message: "The MCP server event stream ended unexpectedly.".to_owned(),
        });
        status.updated_at = now();
    }
    append_status_log(
        &mut state,
        name,
        wire::McpLogLevel::Warning,
        "MCP server event stream ended unexpectedly",
        None,
    );
}

fn active_connection_matches(state: &McpRuntimeState, name: &str, fingerprint: &str) -> bool {
    state
        .active
        .get(name)
        .is_some_and(|active| active.fingerprint == fingerprint)
}

fn append_status_log(
    state: &mut McpRuntimeState,
    name: &str,
    level: wire::McpLogLevel,
    message: &str,
    data: Option<Value>,
) {
    let timestamp = now();
    let now_instant = Instant::now();
    let window = state
        .log_windows
        .entry(name.to_owned())
        .or_insert(McpLogWindow {
            started_at: now_instant,
            emitted: 0,
            dropped: 0,
        });
    let mut dropped_from_previous_window = None;
    if now_instant.duration_since(window.started_at) >= SERVER_LOG_WINDOW {
        dropped_from_previous_window = (window.dropped > 0).then_some(window.dropped);
        window.started_at = now_instant;
        window.emitted = 0;
        window.dropped = 0;
    }

    let Some(status) = state.statuses.get_mut(name) else {
        return;
    };
    if let Some(dropped) = dropped_from_previous_window {
        push_status_log(
            status,
            wire::McpLogLevel::Warning,
            format!("Dropped {dropped} MCP log messages due to rate limiting."),
            None,
            &timestamp,
        );
    }
    if window.emitted >= MAX_SERVER_LOGS_PER_SECOND {
        if window.dropped == 0 {
            push_status_log(
                status,
                wire::McpLogLevel::Warning,
                "MCP server log rate limit exceeded; subsequent messages are dropped.".to_owned(),
                None,
                &timestamp,
            );
        }
        window.dropped += 1;
        status.updated_at = timestamp;
        return;
    }

    window.emitted += 1;
    push_status_log(
        status,
        level,
        truncate_utf8(
            &redact_sensitive_text(message),
            MAX_STATUS_LOG_MESSAGE_BYTES,
        ),
        data.map(bounded_log_data),
        &timestamp,
    );
    status.updated_at = timestamp;
}

fn push_status_log(
    status: &mut wire::McpServerStatus,
    level: wire::McpLogLevel,
    message: String,
    data: Option<Value>,
    timestamp: &str,
) {
    status.logs.push(wire::McpLogEntry {
        timestamp: timestamp.to_owned(),
        level,
        message,
        data,
    });
    let excess = status.logs.len().saturating_sub(MAX_STATUS_LOG_ENTRIES);
    if excess > 0 {
        status.logs.drain(..excess);
    }
}

fn bounded_log_data(value: Value) -> Value {
    let value = redact_sensitive_value(&value);
    match serde_json::to_vec(&value) {
        Ok(serialized) if serialized.len() <= MAX_STATUS_LOG_DATA_BYTES => value,
        Ok(serialized) => Value::String(format!(
            "[MCP log data truncated: {} bytes]",
            serialized.len()
        )),
        Err(_) => Value::String("[MCP log data could not be encoded]".to_owned()),
    }
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_owned();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}[truncated]", &value[..end])
}

fn log_level_from_protocol(level: &str) -> wire::McpLogLevel {
    match level {
        "debug" => wire::McpLogLevel::Debug,
        "info" => wire::McpLogLevel::Info,
        "notice" => wire::McpLogLevel::Notice,
        "warning" | "warn" => wire::McpLogLevel::Warning,
        "error" => wire::McpLogLevel::Error,
        "critical" => wire::McpLogLevel::Critical,
        "alert" => wire::McpLogLevel::Alert,
        "emergency" => wire::McpLogLevel::Emergency,
        _ => wire::McpLogLevel::Info,
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

async fn bind_oauth_callback_listener(
    oauth: Option<&codez_mcp::McpOAuthConfig>,
) -> Result<TcpListener, ConnectionFailure> {
    let port = oauth
        .ok_or(ConnectionFailure::InvalidConfiguration)?
        .callback_port
        .unwrap_or(0);
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .await
        .map_err(|_| ConnectionFailure::OAuth(McpOAuthError::Protocol))
}

async fn wait_for_oauth_callback(
    listener: &TcpListener,
    authorization: &codez_mcp::McpOAuthAuthorization,
) -> Result<(), AppError> {
    timeout(OAUTH_CALLBACK_TIMEOUT, async {
        loop {
            let (mut stream, peer) = listener.accept().await.map_err(|_| {
                AppError::external(
                    "MCP OAuth could not receive its callback",
                    "accept OAuth callback connection",
                    true,
                )
            })?;
            if peer.ip() != std::net::IpAddr::V4(Ipv4Addr::LOCALHOST) {
                write_oauth_callback_response(
                    &mut stream,
                    "404 Not Found",
                    "OAuth callback not found.",
                )
                .await;
                continue;
            }
            let callback_url = match read_oauth_callback_request(&mut stream, listener).await {
                Ok(callback_url) => callback_url,
                Err(error) => {
                    write_oauth_callback_response(
                        &mut stream,
                        "400 Bad Request",
                        "OAuth callback is invalid. Return to CodeZ.",
                    )
                    .await;
                    return Err(error);
                }
            };
            match authorization.handle_callback_url(&callback_url).await {
                Ok(()) => {
                    write_oauth_callback_response(
                        &mut stream,
                        "200 OK",
                        "OAuth authorization completed. You can return to CodeZ.",
                    )
                    .await;
                    return Ok(());
                }
                Err(_) => {
                    write_oauth_callback_response(
                        &mut stream,
                        "400 Bad Request",
                        "OAuth authorization failed. Return to CodeZ.",
                    )
                    .await;
                    return Err(AppError::external(
                        "MCP OAuth authorization could not be completed",
                        "validate OAuth callback and exchange authorization code",
                        true,
                    ));
                }
            }
        }
    })
    .await
    .map_err(|_| AppError::timeout("MCP OAuth authorization timed out"))?
}

async fn read_oauth_callback_request(
    stream: &mut tokio::net::TcpStream,
    listener: &TcpListener,
) -> Result<String, AppError> {
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = timeout(OAUTH_CALLBACK_READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| AppError::timeout("MCP OAuth callback request timed out"))?
            .map_err(|_| {
                AppError::validation("MCP OAuth callback request could not be read safely")
            })?;
        if read == 0 {
            return Err(AppError::validation(
                "MCP OAuth callback request ended before its headers",
            ));
        }
        request.extend_from_slice(&chunk[..read]);
        if request.len() > MAX_OAUTH_CALLBACK_REQUEST_BYTES {
            return Err(AppError::validation(
                "MCP OAuth callback request is too large",
            ));
        }
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = std::str::from_utf8(&request)
        .map_err(|_| AppError::validation("MCP OAuth callback request is not valid UTF-8"))?;
    let request_line = request
        .split("\r\n")
        .next()
        .ok_or_else(|| AppError::validation("MCP OAuth callback request is malformed"))?;
    let mut parts = request_line.split_ascii_whitespace();
    let method = parts.next();
    let target = parts.next();
    let protocol = parts.next();
    if method != Some("GET")
        || !matches!(protocol, Some("HTTP/1.0" | "HTTP/1.1"))
        || parts.next().is_some()
    {
        return Err(AppError::validation(
            "MCP OAuth callback must be an HTTP GET request",
        ));
    }
    let target =
        target.ok_or_else(|| AppError::validation("MCP OAuth callback target is missing"))?;
    if !target.starts_with('/') || target.len() > MAX_OAUTH_CALLBACK_REQUEST_BYTES {
        return Err(AppError::validation("MCP OAuth callback target is invalid"));
    }
    let port = listener
        .local_addr()
        .map_err(|_| AppError::internal("MCP OAuth callback listener lost its local address"))?
        .port();
    let callback_url = format!("http://127.0.0.1:{port}{target}");
    let parsed = Url::parse(&callback_url)
        .map_err(|_| AppError::validation("MCP OAuth callback URL is invalid"))?;
    if parsed.path() != "/oauth/callback" || parsed.fragment().is_some() {
        return Err(AppError::validation("MCP OAuth callback path is invalid"));
    }
    Ok(callback_url)
}

async fn write_oauth_callback_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    body: &str,
) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _write = stream.write_all(response.as_bytes()).await;
    let _shutdown = stream.shutdown().await;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionMode {
    Disabled,
    TrustRequired,
    Connect,
}

fn connection_mode(server: &ScopedMcpServer) -> ConnectionMode {
    if server.config.enabled == Some(false) {
        return ConnectionMode::Disabled;
    }
    if !server.trusted {
        return ConnectionMode::TrustRequired;
    }
    ConnectionMode::Connect
}

fn should_keep_connection(server: &ScopedMcpServer, active: &ActiveConnection) -> bool {
    connection_mode(server) == ConnectionMode::Connect && active.fingerprint == server.fingerprint
}

fn failure_state(failure: &ConnectionFailure) -> wire::McpServerState {
    match failure {
        ConnectionFailure::MissingSecret
        | ConnectionFailure::SecretStore(McpSecretStoreError::AccessDenied)
        | ConnectionFailure::SecretStore(McpSecretStoreError::Unavailable) => {
            wire::McpServerState::NeedsAuth
        }
        ConnectionFailure::OAuth(McpOAuthError::AuthorizationRequired)
        | ConnectionFailure::OAuth(McpOAuthError::CredentialStore) => {
            wire::McpServerState::NeedsAuth
        }
        ConnectionFailure::AdmissionClosed
        | ConnectionFailure::Gateway(McpError::Cancelled { .. }) => wire::McpServerState::Stopped,
        ConnectionFailure::InvalidConfiguration
        | ConnectionFailure::InvalidExpression
        | ConnectionFailure::MissingEnvironment
        | ConnectionFailure::SecretStore(_)
        | ConnectionFailure::OAuth(_)
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

fn validate_remote_identifier(value: &str, max_bytes: usize, label: &str) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(AppError::validation(format!("The MCP {label} is invalid")));
    }
    Ok(())
}

fn catalog_advertises_resource(catalog: &wire::McpServerCatalog, uri: &str) -> bool {
    catalog.resources.iter().any(|resource| {
        if resource.template == Some(true) {
            resource_template_matches(&resource.uri, uri)
        } else {
            resource.uri == uri
        }
    })
}

fn resource_template_matches(template: &str, uri: &str) -> bool {
    if template.is_empty()
        || template.len() > MAX_RESOURCE_URI_BYTES
        || template.chars().any(char::is_control)
    {
        return false;
    }

    let mut remaining_template = template;
    let mut remaining_uri = uri;
    while let Some(open) = remaining_template.find('{') {
        let literal = &remaining_template[..open];
        let Some(after_literal) = remaining_uri.strip_prefix(literal) else {
            return false;
        };
        let expression = &remaining_template[open + 1..];
        let Some(close) = expression.find('}') else {
            return false;
        };
        if expression[..close].trim().is_empty() {
            return false;
        }
        remaining_template = &expression[close + 1..];
        if let Some(next_open) = remaining_template.find('{') {
            let next_literal = &remaining_template[..next_open];
            let Some(next_literal_start) = after_literal.find(next_literal) else {
                return false;
            };
            remaining_uri = &after_literal[next_literal_start..];
        } else if let Some(after_template) = after_literal.strip_suffix(remaining_template) {
            return !after_template.is_empty() || !remaining_template.is_empty();
        } else {
            return false;
        }
    }
    remaining_uri == remaining_template
}

fn validate_prompt_arguments(arguments: &BTreeMap<String, Value>) -> Result<(), AppError> {
    for key in arguments.keys() {
        validate_remote_identifier(key, MAX_PROMPT_NAME_BYTES, "prompt argument name")?;
    }
    let serialized = serde_json::to_vec(arguments).map_err(|source| {
        AppError::external(
            "The MCP prompt arguments could not be encoded",
            format!("serialize MCP prompt arguments: {source}"),
            false,
        )
    })?;
    if serialized.len() > MAX_PROMPT_ARGUMENT_BYTES {
        return Err(AppError::validation(
            "The MCP prompt arguments are too large",
        ));
    }
    Ok(())
}

fn bounded_desktop_value(value: &impl Serialize) -> Result<Value, AppError> {
    let mut value = serde_json::to_value(value).map_err(|source| {
        AppError::external(
            "The MCP response could not be decoded",
            format!("serialize MCP response: {source}"),
            false,
        )
    })?;
    strip_protocol_metadata(&mut value);
    let value = redact_sensitive_value(&value);
    let serialized = serde_json::to_vec(&value).map_err(|source| {
        AppError::external(
            "The MCP response could not be decoded",
            format!("encode bounded MCP response: {source}"),
            false,
        )
    })?;
    if serialized.len() > MAX_INTERACTIVE_RESULT_BYTES {
        return Err(AppError::validation(
            "The MCP response is too large to display",
        ));
    }
    Ok(value)
}

fn strip_protocol_metadata(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                strip_protocol_metadata(item);
            }
        }
        Value::Object(values) => {
            values.remove("_meta");
            for item in values.values_mut() {
                strip_protocol_metadata(item);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn base_status(server: &ScopedMcpServer, state: wire::McpServerState) -> wire::McpServerStatus {
    wire::McpServerStatus {
        name: server.name.clone(),
        scope: scope_to_wire(server.scope),
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

fn disabled_status(server: &ScopedMcpServer) -> wire::McpServerStatus {
    base_status(server, wire::McpServerState::Disabled)
}

fn trust_required_status(server: &ScopedMcpServer) -> wire::McpServerStatus {
    base_status(server, wire::McpServerState::TrustRequired)
}

fn stopped_status(server: &ScopedMcpServer) -> wire::McpServerStatus {
    base_status(server, wire::McpServerState::Stopped)
}

fn connecting_status(server: &ScopedMcpServer) -> wire::McpServerStatus {
    base_status(server, wire::McpServerState::Connecting)
}

fn failure_status(
    server: &ScopedMcpServer,
    state: wire::McpServerState,
    failure: &ConnectionFailure,
) -> wire::McpServerStatus {
    let mut status = base_status(server, state);
    status.error = Some(failure.status_error());
    status
}

fn connected_status(server: &ScopedMcpServer, info: &McpConnectionInfo) -> wire::McpServerStatus {
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

fn scope_to_wire(scope: McpConfigScope) -> wire::McpConfigScope {
    match scope {
        McpConfigScope::User => wire::McpConfigScope::User,
        McpConfigScope::Project => wire::McpConfigScope::Project,
    }
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
        process::Stdio,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use codez_mcp::{McpSecretValue, SecretFuture};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        process::{Child, Command},
        sync::{Mutex, oneshot},
        time::timeout,
    };

    use super::*;

    type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

    #[derive(Default)]
    struct TestSecretStore {
        values: Mutex<BTreeMap<McpSecretKey, String>>,
        reads: AtomicUsize,
    }

    impl McpSecretStore for TestSecretStore {
        fn get(&self, key: McpSecretKey) -> SecretFuture<'_, Option<McpSecretValue>> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::AcqRel);
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

    fn server(name: &str, config: McpServerConfig) -> ScopedMcpServer {
        ScopedMcpServer {
            name: name.to_string(),
            scope: McpConfigScope::User,
            config,
            fingerprint: format!("fingerprint-{name}"),
            trusted: true,
            effective: true,
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

    async fn start_legacy_sse_fixture() -> TestResult<(Child, String)> {
        let root = workspace_root();
        let mut command = Command::new(node_executable()?);
        command
            .arg(
                root.join("src")
                    .join("tests")
                    .join("fixtures")
                    .join("mcp-legacy-sse-server.cjs"),
            )
            .current_dir(&root)
            .env_clear()
            .envs(fixture_environment())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or("legacy SSE fixture stdout was not piped")?;
        let mut lines = BufReader::new(stdout).lines();
        let line = timeout(Duration::from_secs(5), lines.next_line())
            .await
            .map_err(|_| "legacy SSE fixture did not report its address")??
            .ok_or("legacy SSE fixture exited before reporting its address")?;
        let payload: Value = serde_json::from_str(&line)?;
        let endpoint = payload["url"]
            .as_str()
            .ok_or("legacy SSE fixture address was invalid")?
            .to_owned();
        Ok((child, endpoint))
    }

    async fn start_oauth_fixture() -> TestResult<(Child, String)> {
        let root = workspace_root();
        let mut command = Command::new(node_executable()?);
        command
            .arg(
                root.join("src")
                    .join("tests")
                    .join("fixtures")
                    .join("mcp-oauth-server.cjs"),
            )
            .current_dir(&root)
            .env_clear()
            .envs(fixture_environment())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or("OAuth fixture stdout was not piped")?;
        let mut lines = BufReader::new(stdout).lines();
        let line = timeout(Duration::from_secs(5), lines.next_line())
            .await
            .map_err(|_| "OAuth fixture did not report its address")??
            .ok_or("OAuth fixture exited before reporting its address")?;
        let payload: Value = serde_json::from_str(&line)?;
        let endpoint = payload["origin"]
            .as_str()
            .ok_or("OAuth fixture address was invalid")?
            .to_owned();
        Ok((child, endpoint))
    }

    async fn http_get(url: &Url) -> TestResult<String> {
        let host = url.host_str().ok_or("HTTP fixture host is missing")?;
        let port = url
            .port_or_known_default()
            .ok_or("HTTP fixture port is missing")?;
        let target = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_string(),
        };
        let mut stream = tokio::net::TcpStream::connect((host, port)).await?;
        stream
            .write_all(
                format!("GET {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await?;
        let mut response = String::new();
        stream.read_to_string(&mut response).await?;
        Ok(response)
    }

    fn response_header<'a>(response: &'a str, name: &str) -> Option<&'a str> {
        response
            .split("\r\n\r\n")
            .next()?
            .split("\r\n")
            .skip(1)
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name).then_some(value.trim())
            })
    }

    async fn follow_oauth_authorization_url(url: String) -> TestResult<String> {
        let response = http_get(&Url::parse(&url)?).await?;
        let callback =
            response_header(&response, "location").ok_or("OAuth fixture did not redirect")?;
        let callback = Url::parse(callback)?;
        let host = callback
            .host_str()
            .ok_or("OAuth callback host is missing")?;
        let port = callback.port().ok_or("OAuth callback port is missing")?;
        let target = match callback.query() {
            Some(query) => format!("{}?{query}", callback.path()),
            None => callback.path().to_string(),
        };
        let mut stream = tokio::net::TcpStream::connect((host, port)).await?;
        stream
            .write_all(
                format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await?;
        let mut response = String::new();
        stream.read_to_string(&mut response).await?;
        Ok(response)
    }

    fn fixture_server() -> TestResult<ScopedMcpServer> {
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
    async fn untrusted_project_server_never_resolves_secrets_or_exposes_a_catalog() {
        let store = Arc::new(TestSecretStore::default());
        let manager = McpRuntimeManager::new(Arc::clone(&store) as Arc<dyn McpSecretStore>);
        let mut config = config(McpTransport::Stdio);
        config.env = Some(BTreeMap::from([(
            "API_TOKEN".to_string(),
            "${secret:project.token}".to_string(),
        )]));
        let mut server = server("project", config);
        server.scope = McpConfigScope::Project;
        server.trusted = false;

        let statuses = manager.reconcile(std::slice::from_ref(&server)).await;
        let catalog = manager.catalog(&server).await;

        assert_eq!(statuses[0].state, wire::McpServerState::TrustRequired);
        assert!(catalog.is_err());
        assert_eq!(store.reads.load(Ordering::Acquire), 0);
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

    #[test]
    fn legacy_sse_is_admitted_for_gateway_connection() {
        let server = server("legacy", config(McpTransport::Sse));

        assert_eq!(connection_mode(&server), ConnectionMode::Connect);
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
        let mut server = server("oauth", config);
        server.fingerprint = "a".repeat(64);
        let statuses = manager.reconcile(&[server]).await;

        assert_eq!(
            (
                statuses[0].state,
                statuses[0].error.as_ref().map(|error| error.code.as_str()),
            ),
            (wire::McpServerState::NeedsAuth, Some("OAUTH_REQUIRED"))
        );
    }

    #[tokio::test]
    async fn oauth_authorization_uses_loopback_callback_and_logout_clears_credentials() -> TestResult
    {
        let (mut fixture, origin) = start_oauth_fixture().await?;
        let secrets = Arc::new(TestSecretStore::default());
        let manager = McpRuntimeManager::new(Arc::clone(&secrets) as Arc<dyn McpSecretStore>);
        let mut config = config(McpTransport::Http);
        config.command = None;
        config.url = Some(format!("{origin}/mcp"));
        config.oauth = Some(codez_mcp::McpOAuthConfig {
            client_id: None,
            callback_port: None,
            scope: Some("mcp".to_string()),
        });
        let mut server = server("oauth", config);
        server.fingerprint = "b".repeat(64);
        let (browser_complete, browser_response) = oneshot::channel();

        manager
            .authorize(&server, move |authorization_url| {
                let authorization_url = authorization_url.to_owned();
                tokio::spawn(async move {
                    let _sent = browser_complete
                        .send(follow_oauth_authorization_url(authorization_url).await);
                });
                Ok(())
            })
            .await?;
        let browser_response = browser_response.await??;
        assert!(browser_response.starts_with("HTTP/1.1 200 OK"));

        manager.logout(&server).await?;
        let revocation_response =
            http_get(&Url::parse(&format!("{origin}/revoke-status"))?).await?;
        let revocations = serde_json::from_str::<Value>(
            revocation_response
                .split_once("\r\n\r\n")
                .ok_or("OAuth revoke status response was malformed")?
                .1,
        )?;
        assert_eq!(revocations["count"], 2);
        let statuses = manager.statuses().await;
        assert_eq!(statuses[0].state, wire::McpServerState::NeedsAuth);

        fixture.kill().await?;
        let _status = fixture.wait().await?;
        Ok(())
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

        let catalog = manager.catalog(&server).await?;
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
        assert!(manager.catalog(&server).await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn manager_reads_fixture_resources_and_resolves_fixture_prompts() -> TestResult {
        let manager = manager();
        let server = fixture_server()?;
        let statuses = manager.reconcile(std::slice::from_ref(&server)).await;

        assert_eq!(statuses[0].state, wire::McpServerState::Connected);

        let resource = manager.read_resource(&server, "test://example").await?;
        let prompt = manager
            .get_prompt(
                &server,
                "review",
                BTreeMap::from([("subject".to_string(), Value::String("Rust".to_string()))]),
            )
            .await?;

        assert_eq!(resource.contents[0]["text"], "resource-content");
        assert_eq!(prompt.messages[0]["content"]["text"], "Review Rust");

        manager.force_cleanup().await?;
        Ok(())
    }

    #[tokio::test]
    async fn manager_connects_to_a_legacy_sse_server_and_exposes_its_catalog() -> TestResult {
        let (mut fixture, endpoint) = start_legacy_sse_fixture().await?;
        let manager = manager();
        let mut config = config(McpTransport::Sse);
        config.command = None;
        config.url = Some(endpoint);
        let server = server("legacy-sse", config);

        let statuses = manager.reconcile(std::slice::from_ref(&server)).await;
        let catalog = manager.catalog(&server).await?;
        let resource = manager.read_resource(&server, "test://sse").await?;
        let prompt = manager
            .get_prompt(&server, "review", BTreeMap::new())
            .await?;

        assert_eq!(statuses[0].state, wire::McpServerState::Connected);
        assert!(catalog.tools.iter().any(|tool| tool.name == "echo"));
        assert_eq!(resource.contents[0]["text"], "legacy SSE resource");
        assert_eq!(prompt.messages[0]["content"]["text"], "Review legacy SSE");

        manager.force_cleanup().await?;
        fixture.kill().await?;
        let _status = fixture.wait().await?;
        Ok(())
    }
}
