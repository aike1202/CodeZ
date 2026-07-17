use std::{
    collections::{BTreeMap, BTreeSet},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_core::{AppError, AtomicPersistence, SafeWorkspacePath, WorkspaceRoot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;
use url::Url;

use crate::secret::McpSecretKey;

const CONFIG_SCHEMA_VERSION: u16 = 1;
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_SERVERS: usize = 256;
const MAX_SERVER_NAME_CHARS: usize = 128;
const MAX_DESCRIPTION_CHARS: usize = 1024;
const MAX_COMMAND_CHARS: usize = 4096;
const MAX_ARGUMENTS: usize = 4096;
const MAX_ARGUMENT_CHARS: usize = 16 * 1024;
const MAX_MAP_ENTRIES: usize = 4096;
const MAX_MAP_KEY_CHARS: usize = 512;
const MAX_MAP_VALUE_CHARS: usize = 64 * 1024;
const MAX_TOOL_FILTERS: usize = 4096;
const MAX_TOOL_NAME_CHARS: usize = 512;
const PROJECT_TRUST_SCHEMA_VERSION: u16 = 1;
const MAX_TRUSTED_PROJECT_FINGERPRINTS: usize = 4096;

/// Transport selected for one configured MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Stdio,
    Http,
    Sse,
}

/// Policy for reverse requests initiated by an MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpApprovalPolicy {
    Deny,
    Ask,
    Allow,
}

/// Policy for incorporating untrusted MCP server instructions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpInstructionsPolicy {
    Ignore,
    ToolHints,
    Approved,
}

/// Bounded reconnect settings for one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReconnectPolicy {
    pub enabled: bool,
    pub max_attempts: u32,
    pub base_delay_ms: u32,
    pub max_delay_ms: u32,
}

/// Non-secret OAuth client preferences for a remote MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// Validated non-secret configuration for one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    #[serde(rename = "type", default)]
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handshake_timeout_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_load_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_start: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconnect: Option<McpReconnectPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions_policy: Option<McpInstructionsPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling_policy: Option<McpApprovalPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elicitation_policy: Option<McpApprovalPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling_max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_subscriptions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<McpOAuthConfig>,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
}

/// Origin of one configured MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpConfigScope {
    User,
    Project,
}

/// One validated MCP server after its configuration scopes have been resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedMcpServer {
    pub name: String,
    pub scope: McpConfigScope,
    pub config: McpServerConfig,
    pub fingerprint: String,
    pub trusted: bool,
    pub effective: bool,
}

/// Typed failures from MCP user configuration validation and persistence.
#[derive(Debug, Error)]
pub enum McpConfigError {
    #[error("invalid MCP configuration: {message}")]
    Validation { message: String },
    #[error("MCP configuration exceeds the 1 MiB limit")]
    DocumentTooLarge,
    #[error("MCP configuration is not valid JSON")]
    InvalidDocument {
        #[source]
        source: serde_json::Error,
    },
    #[error("MCP configuration schema version {version} is unsupported")]
    UnsupportedVersion { version: u16 },
    #[error("MCP server is not configured in the user scope")]
    ServerNotFound,
    #[error("MCP project configuration fingerprint is not currently available for approval")]
    ProjectFingerprintNotFound,
    #[error("MCP project trust contains too many fingerprints")]
    ProjectTrustTooLarge,
    #[error("MCP project trust schema version {version} is unsupported")]
    UnsupportedProjectTrustVersion { version: u16 },
    #[error("MCP configuration could not be encoded")]
    Serialize {
        #[source]
        source: serde_json::Error,
    },
    #[error("MCP configuration persistence failed")]
    Persistence {
        #[source]
        source: AppError,
    },
}

impl From<McpConfigError> for AppError {
    fn from(error: McpConfigError) -> Self {
        match error {
            McpConfigError::Validation { message } => AppError::validation(message),
            McpConfigError::ServerNotFound => {
                AppError::not_found("The MCP server is not configured in the user scope")
            }
            McpConfigError::ProjectFingerprintNotFound => AppError::validation(
                "The MCP project configuration changed or is not available for approval",
            ),
            McpConfigError::Persistence { source } => source,
            McpConfigError::DocumentTooLarge
            | McpConfigError::InvalidDocument { .. }
            | McpConfigError::UnsupportedVersion { .. }
            | McpConfigError::ProjectTrustTooLarge
            | McpConfigError::UnsupportedProjectTrustVersion { .. }
            | McpConfigError::Serialize { .. } => AppError::storage(
                "The MCP configuration could not be loaded or saved",
                error.to_string(),
                false,
            ),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigDocument {
    #[serde(default)]
    schema_version: u16,
    #[serde(default, alias = "servers")]
    mcp_servers: BTreeMap<String, McpServerConfig>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTrustDocument {
    #[serde(default)]
    schema_version: u16,
    #[serde(default)]
    trusted_fingerprints: BTreeSet<String>,
}

/// Concurrent, bounded service for the user-scoped `mcp.json` document.
pub struct McpUserConfigService {
    persistence: Arc<dyn AtomicPersistence>,
    path: PathBuf,
    mutation_lock: Mutex<()>,
}

impl std::fmt::Debug for McpUserConfigService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpUserConfigService")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl McpUserConfigService {
    /// Creates a user configuration service over an atomic persistence port.
    #[must_use]
    pub fn new(persistence: Arc<dyn AtomicPersistence>, path: PathBuf) -> Self {
        Self {
            persistence,
            path,
            mutation_lock: Mutex::new(()),
        }
    }

    /// Loads and validates all user-scoped MCP servers.
    ///
    /// # Errors
    ///
    /// Returns [`McpConfigError`] for corrupt, oversized, unsupported, invalid,
    /// or inaccessible configuration data.
    pub async fn list(&self) -> Result<Vec<ScopedMcpServer>, McpConfigError> {
        let _guard = self.mutation_lock.lock().await;
        let document = self.load_document().await?;
        validate_servers(&document.mcp_servers)?;
        document
            .mcp_servers
            .into_iter()
            .map(|(name, config)| {
                let fingerprint = fingerprint(&name, &config)?;
                Ok(scoped_user_server(name, config, fingerprint))
            })
            .collect()
    }

    /// Atomically replaces the complete user-scoped server map.
    ///
    /// # Errors
    ///
    /// Returns [`McpConfigError`] before persistence when any server is invalid,
    /// or when the encoded document exceeds 1 MiB.
    pub async fn save_servers(
        &self,
        servers: BTreeMap<String, McpServerConfig>,
    ) -> Result<Vec<ScopedMcpServer>, McpConfigError> {
        let _guard = self.mutation_lock.lock().await;
        validate_servers(&servers)?;
        self.persist_servers(&servers).await?;
        servers
            .into_iter()
            .map(|(name, config)| {
                let fingerprint = fingerprint(&name, &config)?;
                Ok(scoped_user_server(name, config, fingerprint))
            })
            .collect()
    }

    /// Updates one user server without losing concurrent changes to other entries.
    ///
    /// # Errors
    ///
    /// Returns [`McpConfigError::ServerNotFound`] when `name` is absent, plus
    /// the normal read, validation, and persistence failures.
    pub async fn set_enabled(
        &self,
        name: &str,
        enabled: bool,
    ) -> Result<Vec<ScopedMcpServer>, McpConfigError> {
        validate_server_name(name)?;
        let _guard = self.mutation_lock.lock().await;
        let mut document = self.load_document().await?;
        let config = document
            .mcp_servers
            .get_mut(name)
            .ok_or(McpConfigError::ServerNotFound)?;
        config.enabled = Some(enabled);
        validate_servers(&document.mcp_servers)?;
        self.persist_servers(&document.mcp_servers).await?;
        document
            .mcp_servers
            .into_iter()
            .map(|(name, config)| {
                let fingerprint = fingerprint(&name, &config)?;
                Ok(scoped_user_server(name, config, fingerprint))
            })
            .collect()
    }

    /// Finds secure-secret keys referenced by the current user configuration.
    ///
    /// # Errors
    ///
    /// Returns the same bounded read and validation failures as [`Self::list`].
    pub async fn referenced_secret_keys(&self) -> Result<BTreeSet<McpSecretKey>, McpConfigError> {
        let _guard = self.mutation_lock.lock().await;
        let document = self.load_document().await?;
        validate_servers(&document.mcp_servers)?;
        referenced_secret_keys_from_configs(document.mcp_servers.values())
    }

    async fn load_document(&self) -> Result<McpConfigDocument, McpConfigError> {
        let Some(bytes) = self
            .persistence
            .read(&self.path)
            .await
            .map_err(|source| McpConfigError::Persistence { source })?
        else {
            return Ok(McpConfigDocument::default());
        };
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(McpConfigError::DocumentTooLarge);
        }
        let document = serde_json::from_slice::<McpConfigDocument>(&bytes)
            .map_err(|source| McpConfigError::InvalidDocument { source })?;
        if document.schema_version > CONFIG_SCHEMA_VERSION {
            return Err(McpConfigError::UnsupportedVersion {
                version: document.schema_version,
            });
        }
        Ok(document)
    }

    async fn persist_servers(
        &self,
        servers: &BTreeMap<String, McpServerConfig>,
    ) -> Result<(), McpConfigError> {
        let document = McpConfigDocument {
            schema_version: CONFIG_SCHEMA_VERSION,
            mcp_servers: servers.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&document)
            .map_err(|source| McpConfigError::Serialize { source })?;
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(McpConfigError::DocumentTooLarge);
        }
        self.persistence
            .replace(&self.path, &bytes)
            .await
            .map_err(|source| McpConfigError::Persistence { source })
    }
}

/// Concurrent, bounded loader for workspace-owned `.mcp.json` documents and
/// fingerprint-bound user approval records.
///
/// The service never writes into a workspace. Project configuration is read
/// through the atomic persistence boundary, which rejects non-regular files,
/// while approvals are stored only under the application data root.
pub struct McpProjectConfigService {
    persistence: Arc<dyn AtomicPersistence>,
    trust_path: PathBuf,
    mutation_lock: Mutex<()>,
}

impl std::fmt::Debug for McpProjectConfigService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpProjectConfigService")
            .field("trust_path", &self.trust_path)
            .finish_non_exhaustive()
    }
}

impl McpProjectConfigService {
    /// Creates a project configuration loader with a private trust store.
    #[must_use]
    pub fn new(persistence: Arc<dyn AtomicPersistence>, trust_path: PathBuf) -> Self {
        Self {
            persistence,
            trust_path,
            mutation_lock: Mutex::new(()),
        }
    }

    /// Loads the current project MCP configuration without resolving secrets or
    /// starting transports. Each returned configuration is trusted only when an
    /// exact content-and-workspace fingerprint appears in the trust store.
    ///
    /// # Errors
    ///
    /// Returns bounded read, validation, or trust-store persistence failures.
    pub async fn list(
        &self,
        workspace: &WorkspaceRoot,
    ) -> Result<Vec<ScopedMcpServer>, McpConfigError> {
        let _guard = self.mutation_lock.lock().await;
        let trust = self.load_trust_document().await?;
        self.load_servers_with_trust(workspace, &trust.trusted_fingerprints)
            .await
    }

    /// Finds secure-secret keys referenced by trusted project configuration.
    ///
    /// Untrusted project files must not trigger credential-store existence
    /// probes: a repository could otherwise infer whether a named local
    /// credential exists. The returned keys are names only, never values.
    ///
    /// # Errors
    ///
    /// Returns the same bounded read, validation, and trust-store failures as
    /// [`Self::list`].
    pub async fn referenced_secret_keys(
        &self,
        workspace: &WorkspaceRoot,
    ) -> Result<BTreeSet<McpSecretKey>, McpConfigError> {
        let servers = self.list(workspace).await?;
        referenced_secret_keys_from_configs(
            servers
                .iter()
                .filter(|server| server.trusted)
                .map(|server| &server.config),
        )
    }

    /// Persists approval for one fingerprint only after it is found in the
    /// current workspace configuration. A changed project document therefore
    /// cannot inherit approval from a previous configuration.
    ///
    /// # Errors
    ///
    /// Returns [`McpConfigError::ProjectFingerprintNotFound`] when the caller
    /// attempts to approve an absent, malformed, or stale fingerprint.
    pub async fn trust_current_fingerprint(
        &self,
        workspace: &WorkspaceRoot,
        fingerprint: &str,
    ) -> Result<Vec<ScopedMcpServer>, McpConfigError> {
        if !is_fingerprint(fingerprint) {
            return Err(McpConfigError::ProjectFingerprintNotFound);
        }
        let _guard = self.mutation_lock.lock().await;
        let mut trust = self.load_trust_document().await?;
        let current = self
            .load_servers_with_trust(workspace, &BTreeSet::new())
            .await?;
        if !current
            .iter()
            .any(|server| server.fingerprint == fingerprint)
        {
            return Err(McpConfigError::ProjectFingerprintNotFound);
        }
        if !trust.trusted_fingerprints.contains(fingerprint)
            && trust.trusted_fingerprints.len() == MAX_TRUSTED_PROJECT_FINGERPRINTS
        {
            return Err(McpConfigError::ProjectTrustTooLarge);
        }
        trust.trusted_fingerprints.insert(fingerprint.to_string());
        trust.schema_version = PROJECT_TRUST_SCHEMA_VERSION;
        self.persist_trust_document(&trust).await?;
        self.load_servers_with_trust(workspace, &trust.trusted_fingerprints)
            .await
    }

    async fn load_servers_with_trust(
        &self,
        workspace: &WorkspaceRoot,
        trusted_fingerprints: &BTreeSet<String>,
    ) -> Result<Vec<ScopedMcpServer>, McpConfigError> {
        let document = self.load_project_document(workspace).await?;
        validate_servers(&document.mcp_servers)?;
        document
            .mcp_servers
            .into_iter()
            .map(|(name, config)| {
                let fingerprint = project_fingerprint(workspace, &name, &config)?;
                Ok(ScopedMcpServer {
                    name,
                    scope: McpConfigScope::Project,
                    config,
                    trusted: trusted_fingerprints.contains(&fingerprint),
                    fingerprint,
                    effective: true,
                })
            })
            .collect()
    }

    async fn load_project_document(
        &self,
        workspace: &WorkspaceRoot,
    ) -> Result<McpConfigDocument, McpConfigError> {
        let path = project_config_path(workspace)?;
        load_document_from_path(self.persistence.as_ref(), &path).await
    }

    async fn load_trust_document(&self) -> Result<ProjectTrustDocument, McpConfigError> {
        let Some(bytes) = self
            .persistence
            .read(&self.trust_path)
            .await
            .map_err(|source| McpConfigError::Persistence { source })?
        else {
            return Ok(ProjectTrustDocument::default());
        };
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(McpConfigError::ProjectTrustTooLarge);
        }
        let document = serde_json::from_slice::<ProjectTrustDocument>(&bytes)
            .map_err(|source| McpConfigError::InvalidDocument { source })?;
        if document.schema_version > PROJECT_TRUST_SCHEMA_VERSION {
            return Err(McpConfigError::UnsupportedProjectTrustVersion {
                version: document.schema_version,
            });
        }
        if document.trusted_fingerprints.len() > MAX_TRUSTED_PROJECT_FINGERPRINTS
            || document
                .trusted_fingerprints
                .iter()
                .any(|fingerprint| !is_fingerprint(fingerprint))
        {
            return Err(McpConfigError::ProjectTrustTooLarge);
        }
        Ok(document)
    }

    async fn persist_trust_document(
        &self,
        document: &ProjectTrustDocument,
    ) -> Result<(), McpConfigError> {
        let bytes = serde_json::to_vec_pretty(document)
            .map_err(|source| McpConfigError::Serialize { source })?;
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(McpConfigError::ProjectTrustTooLarge);
        }
        self.persistence
            .replace(&self.trust_path, &bytes)
            .await
            .map_err(|source| McpConfigError::Persistence { source })
    }
}

/// Resolves user and project configurations with project entries taking the
/// same precedence as the legacy desktop host. Shadowed entries remain visible
/// to the UI but are never eligible for runtime reconciliation.
///
/// # Errors
///
/// Returns validation failures when effective server names collapse to the
/// same normalized runtime identity.
pub fn merge_scoped_servers(
    user: Vec<ScopedMcpServer>,
    project: Vec<ScopedMcpServer>,
) -> Result<Vec<ScopedMcpServer>, McpConfigError> {
    let mut servers = user;
    servers.extend(project);
    let mut effective_by_name = BTreeMap::<String, usize>::new();
    for index in 0..servers.len() {
        let name = servers[index].name.clone();
        if let Some(previous) = effective_by_name.insert(name, index) {
            servers[previous].effective = false;
        }
    }
    let mut normalized_names = BTreeMap::<String, &str>::new();
    for server in servers.iter().filter(|server| server.effective) {
        let normalized = normalize_server_name(&server.name);
        if let Some(previous) = normalized_names.insert(normalized, &server.name)
            && previous != server.name
        {
            return Err(validation(format!(
                "MCP server names '{previous}' and '{}' normalize to the same identity",
                server.name
            )));
        }
    }
    Ok(servers)
}

fn scoped_user_server(
    name: String,
    config: McpServerConfig,
    fingerprint: String,
) -> ScopedMcpServer {
    ScopedMcpServer {
        name,
        scope: McpConfigScope::User,
        config,
        fingerprint,
        trusted: true,
        effective: true,
    }
}

async fn load_document_from_path(
    persistence: &dyn AtomicPersistence,
    path: &Path,
) -> Result<McpConfigDocument, McpConfigError> {
    let Some(bytes) = persistence
        .read(path)
        .await
        .map_err(|source| McpConfigError::Persistence { source })?
    else {
        return Ok(McpConfigDocument::default());
    };
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(McpConfigError::DocumentTooLarge);
    }
    let document = serde_json::from_slice::<McpConfigDocument>(&bytes)
        .map_err(|source| McpConfigError::InvalidDocument { source })?;
    if document.schema_version > CONFIG_SCHEMA_VERSION {
        return Err(McpConfigError::UnsupportedVersion {
            version: document.schema_version,
        });
    }
    Ok(document)
}

fn project_config_path(workspace: &WorkspaceRoot) -> Result<PathBuf, McpConfigError> {
    SafeWorkspacePath::from_relative(workspace, Path::new(".mcp.json"))
        .map(|path| path.absolute_path())
        .map_err(|error| validation(error.to_string()))
}

fn validate_servers(servers: &BTreeMap<String, McpServerConfig>) -> Result<(), McpConfigError> {
    if servers.len() > MAX_SERVERS {
        return Err(validation(format!(
            "at most {MAX_SERVERS} user MCP servers may be configured"
        )));
    }
    let mut normalized_names = BTreeMap::<String, &str>::new();
    for (name, config) in servers {
        validate_server_name(name)?;
        let normalized = normalize_server_name(name);
        if let Some(previous) = normalized_names.insert(normalized, name)
            && previous != name
        {
            return Err(validation(format!(
                "MCP server names '{previous}' and '{name}' normalize to the same identity"
            )));
        }
        validate_server(name, config)?;
    }
    Ok(())
}

fn validate_server_name(name: &str) -> Result<(), McpConfigError> {
    if name.trim().is_empty()
        || name.chars().count() > MAX_SERVER_NAME_CHARS
        || name.chars().any(|character| character <= '\u{1f}')
    {
        return Err(validation("MCP server name is invalid"));
    }
    Ok(())
}

fn validate_server(name: &str, config: &McpServerConfig) -> Result<(), McpConfigError> {
    if let Some(description) = &config.description
        && (description.chars().count() > MAX_DESCRIPTION_CHARS
            || description.chars().any(is_disallowed_description_control))
    {
        return Err(server_validation(
            name,
            "description must contain at most 1024 characters and no control characters",
        ));
    }
    validate_optional_range(name, "timeoutMs", config.timeout_ms, 100, 600_000)?;
    validate_optional_range(
        name,
        "handshakeTimeoutMs",
        config.handshake_timeout_ms,
        100,
        120_000,
    )?;
    validate_optional_range(
        name,
        "samplingMaxTokens",
        config.sampling_max_tokens,
        1,
        16_384,
    )?;
    validate_reconnect(name, config.reconnect.as_ref())?;
    validate_tool_filters(name, "alwaysLoadTools", config.always_load_tools.as_deref())?;
    validate_tool_filters(name, "blockedTools", config.blocked_tools.as_deref())?;

    match config.transport {
        McpTransport::Stdio => validate_stdio(name, config),
        McpTransport::Http | McpTransport::Sse => validate_remote(name, config),
    }
}

fn validate_reconnect(
    name: &str,
    reconnect: Option<&McpReconnectPolicy>,
) -> Result<(), McpConfigError> {
    let Some(reconnect) = reconnect else {
        return Ok(());
    };
    validate_range(
        name,
        "reconnect.maxAttempts",
        reconnect.max_attempts,
        0,
        100,
    )?;
    validate_range(
        name,
        "reconnect.baseDelayMs",
        reconnect.base_delay_ms,
        10,
        60_000,
    )?;
    validate_range(
        name,
        "reconnect.maxDelayMs",
        reconnect.max_delay_ms,
        10,
        300_000,
    )?;
    if reconnect.max_delay_ms < reconnect.base_delay_ms {
        return Err(server_validation(
            name,
            "reconnect.maxDelayMs must be at least reconnect.baseDelayMs",
        ));
    }
    Ok(())
}

fn validate_tool_filters(
    name: &str,
    field: &str,
    tools: Option<&[String]>,
) -> Result<(), McpConfigError> {
    let Some(tools) = tools else {
        return Ok(());
    };
    if tools.len() > MAX_TOOL_FILTERS
        || tools.iter().any(|tool| {
            tool.is_empty()
                || tool.chars().count() > MAX_TOOL_NAME_CHARS
                || tool.chars().any(char::is_control)
        })
    {
        return Err(server_validation(
            name,
            format!("{field} contains too many or invalid tool names"),
        ));
    }
    Ok(())
}

fn validate_stdio(name: &str, config: &McpServerConfig) -> Result<(), McpConfigError> {
    let Some(command) = config.command.as_deref() else {
        return Err(server_validation(name, "stdio command is required"));
    };
    if command.trim().is_empty()
        || command.chars().count() > MAX_COMMAND_CHARS
        || command.chars().any(char::is_control)
    {
        return Err(server_validation(name, "stdio command is invalid"));
    }
    if let Some(cwd) = config.cwd.as_deref()
        && (cwd.trim().is_empty()
            || cwd.chars().count() > MAX_COMMAND_CHARS
            || cwd.chars().any(char::is_control))
    {
        return Err(server_validation(name, "stdio cwd is invalid"));
    }
    let arguments = config.args.as_deref().unwrap_or_default();
    if arguments.len() > MAX_ARGUMENTS
        || arguments.iter().any(|argument| {
            argument.chars().count() > MAX_ARGUMENT_CHARS
                || argument
                    .chars()
                    .any(|character| character == '\0' || character == '\r' || character == '\n')
        })
    {
        return Err(server_validation(
            name,
            "stdio args are invalid or too large",
        ));
    }
    validate_string_map(name, "env", config.env.as_ref())?;
    validate_sensitive_map(name, "env", config.env.as_ref())?;
    validate_sensitive_arguments(name, arguments)?;
    if is_shell_executable(command)
        && arguments.iter().any(|argument| {
            matches!(
                argument.to_ascii_lowercase().as_str(),
                "/c" | "-c" | "-command" | "-encodedcommand"
            )
        })
    {
        return Err(server_validation(
            name,
            "shell command-string execution is not allowed for MCP stdio servers",
        ));
    }
    Ok(())
}

fn validate_remote(name: &str, config: &McpServerConfig) -> Result<(), McpConfigError> {
    let Some(raw_url) = config.url.as_deref() else {
        return Err(server_validation(name, "URL is required"));
    };
    if raw_url.chars().count() > MAX_MAP_VALUE_CHARS || raw_url.chars().any(char::is_control) {
        return Err(server_validation(name, "URL is invalid or too large"));
    }
    let url = Url::parse(raw_url).map_err(|_| server_validation(name, "URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(server_validation(name, "URL must use http or https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(server_validation(
            name,
            "credentials are not allowed in MCP URLs",
        ));
    }
    let loopback = url.host_str().is_some_and(is_loopback_host);
    if url.scheme() != "https" && !loopback {
        return Err(server_validation(name, "remote MCP URLs must use HTTPS"));
    }
    if url.scheme() != "https" && !loopback && config.oauth.is_some() {
        return Err(server_validation(
            name,
            "OAuth is only allowed over HTTPS or loopback HTTP",
        ));
    }
    validate_string_map(name, "headers", config.headers.as_ref())?;
    validate_sensitive_map(name, "headers", config.headers.as_ref())?;
    if config.oauth.is_some()
        && config.headers.as_ref().is_some_and(|headers| {
            headers
                .keys()
                .any(|header| header.eq_ignore_ascii_case("authorization"))
        })
    {
        return Err(server_validation(
            name,
            "OAuth MCP servers must not configure an Authorization header",
        ));
    }
    validate_oauth(name, config.oauth.as_ref())
}

fn validate_oauth(name: &str, oauth: Option<&McpOAuthConfig>) -> Result<(), McpConfigError> {
    let Some(oauth) = oauth else {
        return Ok(());
    };
    for (field, value) in [
        ("oauth.clientId", &oauth.client_id),
        ("oauth.scope", &oauth.scope),
    ] {
        if let Some(value) = value
            && (value.chars().count() > MAX_MAP_VALUE_CHARS
                || value
                    .chars()
                    .any(|character| character == '\0' || character == '\r' || character == '\n'))
        {
            return Err(server_validation(
                name,
                format!("{field} is invalid or too large"),
            ));
        }
    }
    Ok(())
}

fn validate_string_map(
    name: &str,
    field: &str,
    values: Option<&BTreeMap<String, String>>,
) -> Result<(), McpConfigError> {
    let Some(values) = values else {
        return Ok(());
    };
    if values.len() > MAX_MAP_ENTRIES
        || values.iter().any(|(key, value)| {
            key.is_empty()
                || key.chars().count() > MAX_MAP_KEY_CHARS
                || key.chars().any(char::is_control)
                || value.chars().count() > MAX_MAP_VALUE_CHARS
                || value
                    .chars()
                    .any(|character| character == '\0' || character == '\r' || character == '\n')
        })
    {
        return Err(server_validation(
            name,
            format!("{field} contains too many or invalid entries"),
        ));
    }
    Ok(())
}

fn validate_sensitive_map(
    name: &str,
    field: &str,
    values: Option<&BTreeMap<String, String>>,
) -> Result<(), McpConfigError> {
    for (key, value) in values.into_iter().flatten() {
        if secret_references(value).is_err() {
            return Err(server_validation(
                name,
                format!("{field}.{key} contains an invalid secret expression"),
            ));
        }
        if is_sensitive_key(key) && !contains_secure_expression(value) {
            return Err(server_validation(
                name,
                format!("{field}.{key} must use an env or secure-secret expression"),
            ));
        }
    }
    Ok(())
}

fn validate_sensitive_arguments(name: &str, arguments: &[String]) -> Result<(), McpConfigError> {
    for (index, argument) in arguments.iter().enumerate() {
        let Some((flag, inline_value)) = sensitive_flag(argument) else {
            continue;
        };
        let secured = inline_value.is_some_and(contains_secure_expression)
            || (inline_value.is_none()
                && arguments
                    .get(index + 1)
                    .is_some_and(|value| contains_secure_expression(value)));
        if !secured {
            return Err(server_validation(
                name,
                format!(
                    "sensitive stdio argument '{flag}' must use an env or secure-secret expression"
                ),
            ));
        }
    }
    Ok(())
}

fn sensitive_flag(argument: &str) -> Option<(&str, Option<&str>)> {
    let without_prefix = argument
        .strip_prefix("--")
        .or_else(|| argument.strip_prefix('-'))?;
    let (flag, value) = without_prefix
        .split_once('=')
        .map_or((without_prefix, None), |(flag, value)| (flag, Some(value)));
    let normalized = flag.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "token" | "secret" | "password" | "apikey" | "api-key" | "api_key"
    )
    .then_some((flag, value))
}

fn is_shell_executable(command: &str) -> bool {
    let file_name = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    let executable = file_name.strip_suffix(".exe").unwrap_or(&file_name);
    matches!(
        executable,
        "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "zsh"
    )
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "token",
        "secret",
        "password",
        "apikey",
        "api-key",
        "api_key",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn contains_secure_expression(value: &str) -> bool {
    secret_references(value)
        .is_ok_and(|keys| !keys.is_empty() || contains_valid_env_expression(value))
}

fn contains_valid_env_expression(value: &str) -> bool {
    parse_expressions(value).is_ok_and(|expressions| {
        expressions
            .iter()
            .any(|(source, _)| *source == ExpressionSource::Environment)
    })
}

fn secret_references(value: &str) -> Result<Vec<&str>, ()> {
    parse_expressions(value).map(|expressions| {
        expressions
            .into_iter()
            .filter_map(|(source, key)| (source == ExpressionSource::Secret).then_some(key))
            .collect()
    })
}

fn referenced_secret_keys_from_configs<'a>(
    configs: impl IntoIterator<Item = &'a McpServerConfig>,
) -> Result<BTreeSet<McpSecretKey>, McpConfigError> {
    let mut keys = BTreeSet::new();
    for config in configs {
        for value in config
            .env
            .iter()
            .flat_map(|values| values.values())
            .chain(config.headers.iter().flat_map(|values| values.values()))
            .chain(config.args.iter().flatten())
        {
            for key in secret_references(value).map_err(|()| {
                validation("MCP configuration contains an invalid secure-secret expression")
            })? {
                keys.insert(McpSecretKey::parse(key).map_err(|_| {
                    validation("MCP configuration contains an invalid secure-secret key")
                })?);
            }
        }
    }
    Ok(keys)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpressionSource {
    Environment,
    Secret,
}

fn parse_expressions(value: &str) -> Result<Vec<(ExpressionSource, &str)>, ()> {
    let mut expressions = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        let expression = &rest[start + 2..];
        let end = expression.find('}').ok_or(())?;
        let body = &expression[..end];
        let (source, key) = body.split_once(':').ok_or(())?;
        let source = match source {
            "env" if valid_environment_key(key) => ExpressionSource::Environment,
            "secret" if McpSecretKey::parse(key).is_ok() => ExpressionSource::Secret,
            _ => return Err(()),
        };
        expressions.push((source, key));
        rest = &expression[end + 1..];
    }
    Ok(expressions)
}

fn valid_environment_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn validate_optional_range(
    name: &str,
    field: &str,
    value: Option<u32>,
    minimum: u32,
    maximum: u32,
) -> Result<(), McpConfigError> {
    if let Some(value) = value {
        validate_range(name, field, value, minimum, maximum)?;
    }
    Ok(())
}

fn validate_range(
    name: &str,
    field: &str,
    value: u32,
    minimum: u32,
    maximum: u32,
) -> Result<(), McpConfigError> {
    if !(minimum..=maximum).contains(&value) {
        return Err(server_validation(
            name,
            format!("{field} must be between {minimum} and {maximum}"),
        ));
    }
    Ok(())
}

fn normalize_server_name(value: &str) -> String {
    let mut normalized = String::new();
    let mut previous_underscore = false;
    for character in value.chars() {
        let accepted = character.is_ascii_alphanumeric() || matches!(character, '_' | '-');
        let next = if accepted { character } else { '_' };
        if next == '_' {
            if previous_underscore || normalized.is_empty() {
                previous_underscore = true;
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        normalized.push(next);
        if normalized.len() == 48 {
            break;
        }
    }
    while normalized.ends_with('_') {
        normalized.pop();
    }
    if normalized.is_empty() {
        "server".to_string()
    } else {
        normalized
    }
}

fn fingerprint(name: &str, config: &McpServerConfig) -> Result<String, McpConfigError> {
    let bytes = serde_json::to_vec(&(name, config))
        .map_err(|source| McpConfigError::Serialize { source })?;
    Ok(sha256_hex(&bytes))
}

fn project_fingerprint(
    workspace: &WorkspaceRoot,
    name: &str,
    config: &McpServerConfig,
) -> Result<String, McpConfigError> {
    let configuration =
        serde_json::to_value(config).map_err(|source| McpConfigError::Serialize { source })?;
    let identity = serde_json::json!({
        "workspaceRoot": workspace.as_path().to_string_lossy(),
        "name": name,
        "scope": "project",
        "config": configuration,
    });
    let canonical = canonical_json(&identity)?;
    Ok(sha256_hex(canonical.as_bytes()))
}

fn canonical_json(value: &Value) -> Result<String, McpConfigError> {
    let mut output = String::new();
    append_canonical_json(value, &mut output)?;
    Ok(output)
}

fn append_canonical_json(value: &Value, output: &mut String) -> Result<(), McpConfigError> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => {
            output.push_str(&value.to_string());
        }
        Value::String(text) => output.push_str(
            &serde_json::to_string(text).map_err(|source| McpConfigError::Serialize { source })?,
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                append_canonical_json(item, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by_key(|(key, _)| *key);
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|source| McpConfigError::Serialize { source })?,
                );
                output.push(':');
                append_canonical_json(item, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn is_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_disallowed_description_control(character: char) -> bool {
    character <= '\u{8}'
        || matches!(character, '\u{b}' | '\u{c}')
        || ('\u{e}'..='\u{1f}').contains(&character)
}

fn validation(message: impl Into<String>) -> McpConfigError {
    McpConfigError::Validation {
        message: message.into(),
    }
}

fn server_validation(name: &str, message: impl AsRef<str>) -> McpConfigError {
    validation(format!("{name}: {}", message.as_ref()))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use codez_core::{AppError, AtomicCreateOutcome, AtomicPersistence, PortFuture, WorkspaceRoot};
    use tokio::sync::Mutex;

    use super::{
        CONFIG_SCHEMA_VERSION, MAX_CONFIG_BYTES, McpConfigError, McpConfigScope, McpOAuthConfig,
        McpProjectConfigService, McpServerConfig, McpTransport, McpUserConfigService,
        ScopedMcpServer, merge_scoped_servers,
    };

    #[derive(Default)]
    struct MemoryPersistence {
        entries: Mutex<BTreeMap<PathBuf, Vec<u8>>>,
    }

    impl MemoryPersistence {
        async fn insert(&self, path: PathBuf, bytes: Vec<u8>) {
            self.entries.lock().await.insert(path, bytes);
        }
    }

    impl AtomicPersistence for MemoryPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move { Ok(self.entries.lock().await.get(path).cloned()) })
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.entries
                    .lock()
                    .await
                    .insert(path.to_path_buf(), bytes.to_vec());
                Ok(())
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                let mut entries = self.entries.lock().await;
                match entries.get(path) {
                    Some(existing) if existing == bytes => Ok(AtomicCreateOutcome::Reused),
                    Some(_) => Err(AppError::conflict(
                        "The in-memory persistence entry already exists with different bytes",
                    )),
                    None => {
                        entries.insert(path.to_path_buf(), bytes.to_vec());
                        Ok(AtomicCreateOutcome::Created)
                    }
                }
            })
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.entries
                    .lock()
                    .await
                    .entry(path.to_path_buf())
                    .or_default()
                    .extend_from_slice(bytes);
                Ok(())
            })
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move { Ok(self.entries.lock().await.remove(path).is_some()) })
        }
    }

    fn blank_config(transport: McpTransport) -> McpServerConfig {
        McpServerConfig {
            transport,
            description: None,
            enabled: None,
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
            command: None,
            args: None,
            env: None,
            cwd: None,
            url: None,
            headers: None,
            oauth: None,
            extensions: BTreeMap::new(),
        }
    }

    fn service(persistence: Arc<MemoryPersistence>, path: PathBuf) -> McpUserConfigService {
        McpUserConfigService::new(persistence, path)
    }

    fn workspace_root() -> WorkspaceRoot {
        WorkspaceRoot::from_canonical(std::env::temp_dir().join("codez-mcp-project-config"))
            .expect("fixture workspace root must be absolute")
    }

    fn project_config_path(workspace: &WorkspaceRoot) -> PathBuf {
        workspace.as_path().join(".mcp.json")
    }

    fn project_service(
        persistence: Arc<MemoryPersistence>,
        trust_path: PathBuf,
    ) -> McpProjectConfigService {
        McpProjectConfigService::new(persistence, trust_path)
    }

    #[tokio::test]
    async fn project_config_requires_exact_fingerprint_approval_and_persists_it() {
        let persistence = Arc::new(MemoryPersistence::default());
        let workspace = workspace_root();
        let trust_path = PathBuf::from("mcp-project-trust.json");
        persistence
            .insert(
                project_config_path(&workspace),
                br#"{"servers":{"project":{"type":"stdio","command":"node","args":["server.js"],"env":{"TOKEN":"${secret:project.token}"}}}}"#.to_vec(),
            )
            .await;
        let service = project_service(Arc::clone(&persistence), trust_path.clone());

        let before = service
            .list(&workspace)
            .await
            .expect("project configuration should load without granting trust");
        let fingerprint = before[0].fingerprint.clone();
        service
            .trust_current_fingerprint(&workspace, &fingerprint)
            .await
            .expect("current project fingerprint should be approvable");
        let restarted = project_service(Arc::clone(&persistence), trust_path)
            .list(&workspace)
            .await
            .expect("persisted project approval should survive a service restart");

        assert!(restarted[0].trusted);
    }

    #[tokio::test]
    async fn trusted_project_config_exposes_only_its_secret_key_references() {
        let persistence = Arc::new(MemoryPersistence::default());
        let workspace = workspace_root();
        let trust_path = PathBuf::from("mcp-project-trust.json");
        persistence
            .insert(
                project_config_path(&workspace),
                br#"{"servers":{"project":{"type":"stdio","command":"node","args":["server.js"],"env":{"TOKEN":"${secret:project.token}"}}}}"#.to_vec(),
            )
            .await;
        let service = project_service(Arc::clone(&persistence), trust_path);

        let untrusted = service
            .referenced_secret_keys(&workspace)
            .await
            .expect("untrusted project configuration should load");
        let fingerprint = service
            .list(&workspace)
            .await
            .expect("project configuration should load")[0]
            .fingerprint
            .clone();
        service
            .trust_current_fingerprint(&workspace, &fingerprint)
            .await
            .expect("current project fingerprint should be approvable");
        let trusted = service
            .referenced_secret_keys(&workspace)
            .await
            .expect("trusted project configuration should expose references");

        assert!(untrusted.is_empty());
        assert_eq!(
            trusted
                .into_iter()
                .map(|key| key.as_str().to_string())
                .collect::<Vec<_>>(),
            vec!["project.token".to_string()]
        );
    }

    #[tokio::test]
    async fn project_config_change_invalidates_previous_fingerprint_approval() {
        let persistence = Arc::new(MemoryPersistence::default());
        let workspace = workspace_root();
        let trust_path = PathBuf::from("mcp-project-trust.json");
        persistence
            .insert(
                project_config_path(&workspace),
                br#"{"servers":{"project":{"type":"stdio","command":"node","args":["server.js"]}}}"#.to_vec(),
            )
            .await;
        let service = project_service(Arc::clone(&persistence), trust_path);
        let original = service
            .list(&workspace)
            .await
            .expect("initial project configuration should load");
        service
            .trust_current_fingerprint(&workspace, &original[0].fingerprint)
            .await
            .expect("initial fingerprint should be approvable");
        persistence
            .insert(
                project_config_path(&workspace),
                br#"{"servers":{"project":{"type":"stdio","command":"node","args":["changed.js"]}}}"#.to_vec(),
            )
            .await;
        let changed = service
            .list(&workspace)
            .await
            .expect("changed project configuration should load");

        assert!(!changed[0].trusted);
    }

    #[tokio::test]
    async fn project_trust_rejects_a_stale_or_unknown_fingerprint() {
        let persistence = Arc::new(MemoryPersistence::default());
        let workspace = workspace_root();
        persistence
            .insert(
                project_config_path(&workspace),
                br#"{"servers":{"project":{"type":"stdio","command":"node"}}}"#.to_vec(),
            )
            .await;
        let service = project_service(persistence, PathBuf::from("mcp-project-trust.json"));

        let result = service
            .trust_current_fingerprint(&workspace, &"a".repeat(64))
            .await;

        assert!(matches!(
            result,
            Err(McpConfigError::ProjectFingerprintNotFound)
        ));
    }

    #[tokio::test]
    async fn project_config_is_reported_with_project_scope() {
        let persistence = Arc::new(MemoryPersistence::default());
        let workspace = workspace_root();
        persistence
            .insert(
                project_config_path(&workspace),
                br#"{"servers":{"project":{"type":"stdio","command":"node"}}}"#.to_vec(),
            )
            .await;
        let service = project_service(persistence, PathBuf::from("mcp-project-trust.json"));
        let servers = service
            .list(&workspace)
            .await
            .expect("project configuration should load");

        assert_eq!(servers[0].scope, McpConfigScope::Project);
    }

    #[test]
    fn project_config_shadows_same_named_user_config_before_runtime_selection() {
        let config = blank_config(McpTransport::Stdio);
        let user = ScopedMcpServer {
            name: "shared".to_string(),
            scope: McpConfigScope::User,
            config: config.clone(),
            fingerprint: "user-fingerprint".to_string(),
            trusted: true,
            effective: true,
        };
        let project = ScopedMcpServer {
            name: "shared".to_string(),
            scope: McpConfigScope::Project,
            config,
            fingerprint: "project-fingerprint".to_string(),
            trusted: false,
            effective: true,
        };
        let servers = merge_scoped_servers(vec![user], vec![project])
            .expect("same raw name should resolve by scope precedence");

        assert_eq!(
            servers
                .iter()
                .map(|server| (server.scope, server.effective, server.trusted))
                .collect::<Vec<_>>(),
            vec![
                (McpConfigScope::User, false, true),
                (McpConfigScope::Project, true, false),
            ]
        );
    }

    #[tokio::test]
    async fn save_servers_accepts_direct_stdio_and_https_secret_expressions() {
        let persistence = Arc::new(MemoryPersistence::default());
        let path = PathBuf::from("mcp.json");
        let service = service(Arc::clone(&persistence), path);
        let mut stdio = blank_config(McpTransport::Stdio);
        stdio.command = Some("node".to_string());
        stdio.args = Some(vec![
            "server.js".to_string(),
            "--token".to_string(),
            "${env:MCP_TOKEN}".to_string(),
        ]);
        stdio.env = Some(BTreeMap::from([(
            "UPSTREAM_TOKEN".to_string(),
            "${secret:stdio.token}".to_string(),
        )]));
        let mut remote = blank_config(McpTransport::Http);
        remote.url = Some("https://mcp.example.test/v1".to_string());
        remote.headers = Some(BTreeMap::from([(
            "Authorization".to_string(),
            "Bearer ${secret:remote.token}".to_string(),
        )]));

        let saved = service
            .save_servers(BTreeMap::from([
                ("stdio".to_string(), stdio),
                ("remote".to_string(), remote),
            ]))
            .await
            .expect("valid MCP server configurations should persist");
        let references = service
            .referenced_secret_keys()
            .await
            .expect("valid secret expressions should be discoverable");

        assert_eq!(saved.len(), 2);
        assert_eq!(
            references
                .into_iter()
                .map(|key| key.as_str().to_string())
                .collect::<Vec<_>>(),
            vec!["remote.token".to_string(), "stdio.token".to_string()]
        );
    }

    #[tokio::test]
    async fn save_servers_rejects_shell_command_string_execution() {
        let persistence = Arc::new(MemoryPersistence::default());
        let service = service(persistence, PathBuf::from("mcp.json"));
        let mut config = blank_config(McpTransport::Stdio);
        config.command = Some("powershell.exe".to_string());
        config.args = Some(vec!["-Command".to_string(), "Get-ChildItem".to_string()]);

        let result = service
            .save_servers(BTreeMap::from([("unsafe".to_string(), config)]))
            .await;

        assert!(matches!(result, Err(McpConfigError::Validation { .. })));
    }

    #[tokio::test]
    async fn save_servers_rejects_plaintext_sensitive_stdio_argument() {
        let persistence = Arc::new(MemoryPersistence::default());
        let service = service(persistence, PathBuf::from("mcp.json"));
        let mut config = blank_config(McpTransport::Stdio);
        config.command = Some("node".to_string());
        config.args = Some(vec![
            "server.js".to_string(),
            "--api-key=plaintext".to_string(),
        ]);

        let result = service
            .save_servers(BTreeMap::from([("unsafe".to_string(), config)]))
            .await;

        assert!(matches!(result, Err(McpConfigError::Validation { .. })));
    }

    #[tokio::test]
    async fn save_servers_rejects_non_loopback_http() {
        let persistence = Arc::new(MemoryPersistence::default());
        let service = service(persistence, PathBuf::from("mcp.json"));
        let mut config = blank_config(McpTransport::Http);
        config.url = Some("http://mcp.example.test/v1".to_string());

        let result = service
            .save_servers(BTreeMap::from([("remote".to_string(), config)]))
            .await;

        assert!(matches!(result, Err(McpConfigError::Validation { .. })));
    }

    #[tokio::test]
    async fn save_servers_accepts_loopback_http_oauth() {
        let persistence = Arc::new(MemoryPersistence::default());
        let service = service(persistence, PathBuf::from("mcp.json"));
        let mut config = blank_config(McpTransport::Http);
        config.url = Some("http://127.0.0.1:43119/mcp".to_string());
        config.oauth = Some(McpOAuthConfig {
            client_id: None,
            callback_port: None,
            scope: Some("mcp".to_string()),
        });

        let saved = service
            .save_servers(BTreeMap::from([("loopback".to_string(), config)]))
            .await;

        assert!(saved.is_ok());
    }

    #[tokio::test]
    async fn save_servers_rejects_manual_authorization_header_with_oauth() {
        let persistence = Arc::new(MemoryPersistence::default());
        let service = service(persistence, PathBuf::from("mcp.json"));
        let mut config = blank_config(McpTransport::Http);
        config.url = Some("https://mcp.example.test/v1".to_string());
        config.headers = Some(BTreeMap::from([(
            "Authorization".to_string(),
            "Bearer ${secret:token}".to_string(),
        )]));
        config.oauth = Some(McpOAuthConfig {
            client_id: None,
            callback_port: None,
            scope: None,
        });

        let result = service
            .save_servers(BTreeMap::from([("oauth".to_string(), config)]))
            .await;

        assert!(matches!(result, Err(McpConfigError::Validation { .. })));
    }

    #[tokio::test]
    async fn save_servers_rejects_invalid_sensitive_expression() {
        let persistence = Arc::new(MemoryPersistence::default());
        let service = service(persistence, PathBuf::from("mcp.json"));
        let mut config = blank_config(McpTransport::Http);
        config.url = Some("https://mcp.example.test/v1".to_string());
        config.headers = Some(BTreeMap::from([(
            "Authorization".to_string(),
            "Bearer ${secret:invalid/key}".to_string(),
        )]));

        let result = service
            .save_servers(BTreeMap::from([("remote".to_string(), config)]))
            .await;

        assert!(matches!(result, Err(McpConfigError::Validation { .. })));
    }

    #[tokio::test]
    async fn list_rejects_a_document_larger_than_one_mebibyte() {
        let persistence = Arc::new(MemoryPersistence::default());
        let path = PathBuf::from("mcp.json");
        persistence
            .insert(path.clone(), vec![b'x'; MAX_CONFIG_BYTES + 1])
            .await;
        let service = service(persistence, path);

        let result = service.list().await;

        assert!(matches!(result, Err(McpConfigError::DocumentTooLarge)));
    }

    #[tokio::test]
    async fn list_rejects_a_newer_config_document_schema() {
        let persistence = Arc::new(MemoryPersistence::default());
        let path = PathBuf::from("mcp.json");
        let document = format!(
            r#"{{"schemaVersion":{},"mcpServers":{{}}}}"#,
            CONFIG_SCHEMA_VERSION + 1
        );
        persistence
            .insert(path.clone(), document.into_bytes())
            .await;
        let service = service(persistence, path);

        let result = service.list().await;

        assert!(matches!(
            result,
            Err(McpConfigError::UnsupportedVersion { .. })
        ));
    }

    #[tokio::test]
    async fn concurrent_set_enabled_updates_do_not_lose_either_server_change() {
        let persistence = Arc::new(MemoryPersistence::default());
        let service = Arc::new(service(persistence, PathBuf::from("mcp.json")));
        let mut first = blank_config(McpTransport::Stdio);
        first.command = Some("first-server".to_string());
        let mut second = blank_config(McpTransport::Stdio);
        second.command = Some("second-server".to_string());
        service
            .save_servers(BTreeMap::from([
                ("first".to_string(), first),
                ("second".to_string(), second),
            ]))
            .await
            .expect("initial MCP configuration should persist");

        let first_update = Arc::clone(&service);
        let second_update = Arc::clone(&service);
        let (first_result, second_result) = tokio::join!(
            first_update.set_enabled("first", true),
            second_update.set_enabled("second", false),
        );
        first_result.expect("first concurrent update should succeed");
        second_result.expect("second concurrent update should succeed");
        let enabled_by_name = service
            .list()
            .await
            .expect("final MCP configuration should remain valid")
            .into_iter()
            .map(|server| (server.name, server.config.enabled))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(
            enabled_by_name,
            BTreeMap::from([
                ("first".to_string(), Some(true)),
                ("second".to_string(), Some(false)),
            ])
        );
    }
}
