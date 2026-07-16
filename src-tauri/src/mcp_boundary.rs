use std::{collections::BTreeMap, sync::Arc};

use chrono::Utc;
use codez_contracts::mcp as wire;
use codez_mcp as domain;
use codez_storage::{
    CredentialError as StorageCredentialError, CredentialId as StorageCredentialId, CredentialKind,
    CredentialStore as StorageCredentialStore, SecretValue as StorageSecretValue,
};

/// Desktop adapter that keeps MCP secret plaintext inside the OS credential boundary.
pub(crate) struct StorageMcpSecretStore {
    credentials: Arc<dyn StorageCredentialStore>,
}

impl StorageMcpSecretStore {
    pub(crate) fn new(credentials: Arc<dyn StorageCredentialStore>) -> Self {
        Self { credentials }
    }
}

impl domain::McpSecretStore for StorageMcpSecretStore {
    fn get(
        &self,
        key: domain::McpSecretKey,
    ) -> domain::SecretFuture<'_, Option<domain::McpSecretValue>> {
        let credentials = Arc::clone(&self.credentials);
        Box::pin(async move {
            let credential_id = storage_secret_id(&key)?;
            let result = tokio::task::spawn_blocking(move || credentials.get(&credential_id))
                .await
                .map_err(|_| domain::McpSecretStoreError::Unavailable)?;
            match result {
                Ok(secret) => domain::McpSecretValue::new(secret.expose_secret().to_owned())
                    .map(Some)
                    .map_err(|_| domain::McpSecretStoreError::Corrupt),
                Err(StorageCredentialError::NotFound { .. }) => Ok(None),
                Err(error) => Err(map_storage_secret_error(error)),
            }
        })
    }

    fn set(
        &self,
        key: domain::McpSecretKey,
        value: domain::McpSecretValue,
    ) -> domain::SecretFuture<'_, ()> {
        let credentials = Arc::clone(&self.credentials);
        Box::pin(async move {
            let credential_id = storage_secret_id(&key)?;
            let secret = StorageSecretValue::new(value.expose_secret().to_owned())
                .map_err(map_storage_secret_error)?;
            tokio::task::spawn_blocking(move || credentials.set(&credential_id, &secret))
                .await
                .map_err(|_| domain::McpSecretStoreError::Unavailable)?
                .map_err(map_storage_secret_error)
        })
    }

    fn delete(&self, key: domain::McpSecretKey) -> domain::SecretFuture<'_, ()> {
        let credentials = Arc::clone(&self.credentials);
        Box::pin(async move {
            let credential_id = storage_secret_id(&key)?;
            match tokio::task::spawn_blocking(move || credentials.delete(&credential_id))
                .await
                .map_err(|_| domain::McpSecretStoreError::Unavailable)?
            {
                Ok(()) | Err(StorageCredentialError::NotFound { .. }) => Ok(()),
                Err(error) => Err(map_storage_secret_error(error)),
            }
        })
    }
}

fn storage_secret_id(
    key: &domain::McpSecretKey,
) -> Result<StorageCredentialId, domain::McpSecretStoreError> {
    StorageCredentialId::new(CredentialKind::McpSecret, key.as_str())
        .map_err(|_| domain::McpSecretStoreError::InvalidIdentifier)
}

fn map_storage_secret_error(error: StorageCredentialError) -> domain::McpSecretStoreError {
    match error {
        StorageCredentialError::InvalidIdentifier => domain::McpSecretStoreError::InvalidIdentifier,
        StorageCredentialError::EmptySecret => domain::McpSecretStoreError::EmptySecret,
        StorageCredentialError::NotFound { .. } => domain::McpSecretStoreError::NotFound,
        StorageCredentialError::AccessDenied { .. } => domain::McpSecretStoreError::AccessDenied,
        StorageCredentialError::Unavailable { .. } => domain::McpSecretStoreError::Unavailable,
        StorageCredentialError::Corrupt { .. } => domain::McpSecretStoreError::Corrupt,
        StorageCredentialError::SecretTooLarge { .. } => {
            domain::McpSecretStoreError::SecretTooLarge
        }
    }
}

pub(crate) fn servers_from_wire(
    servers: BTreeMap<String, wire::McpServerConfig>,
) -> BTreeMap<String, domain::McpServerConfig> {
    servers
        .into_iter()
        .map(|(name, config)| (name, server_config_from_wire(config)))
        .collect()
}

pub(crate) fn list_payload(
    servers: Vec<domain::UserMcpServer>,
    runtime_statuses: Vec<wire::McpServerStatus>,
) -> wire::McpListPayload {
    let updated_at = Utc::now().to_rfc3339();
    let mut configs = Vec::with_capacity(servers.len());
    let mut statuses_by_name = runtime_statuses
        .into_iter()
        .map(|status| (status.name.clone(), status))
        .collect::<BTreeMap<_, _>>();
    let mut statuses = Vec::with_capacity(servers.len());

    for server in servers {
        let transport = transport_to_wire(server.config.transport);
        let enabled = server.config.enabled != Some(false);
        let state = if enabled {
            wire::McpServerState::Stopped
        } else {
            wire::McpServerState::Disabled
        };
        let fingerprint = server.fingerprint.clone();
        let name = server.name.clone();
        configs.push(wire::ScopedMcpServerConfig {
            name: server.name,
            scope: wire::McpConfigScope::User,
            config: server_config_to_wire(server.config),
            fingerprint: fingerprint.clone(),
            trusted: true,
            effective: true,
            shadowed_by: None,
            policy_disabled: None,
        });
        statuses.push(
            statuses_by_name
                .remove(&name)
                .unwrap_or(wire::McpServerStatus {
                    name,
                    scope: wire::McpConfigScope::User,
                    state,
                    fingerprint,
                    transport,
                    capabilities: None,
                    server_info: None,
                    tool_count: 0,
                    resource_count: 0,
                    prompt_count: 0,
                    error: None,
                    next_retry_at: None,
                    updated_at: updated_at.clone(),
                    logs: Vec::new(),
                }),
        );
    }

    wire::McpListPayload { configs, statuses }
}

pub(crate) fn secret_key_from_wire(
    value: String,
) -> Result<domain::McpSecretKey, domain::McpSecretError> {
    domain::McpSecretKey::parse(value)
}

pub(crate) fn secret_value_from_wire(
    value: String,
) -> Result<domain::McpSecretValue, domain::McpSecretError> {
    domain::McpSecretValue::new(value)
}

fn server_config_from_wire(value: wire::McpServerConfig) -> domain::McpServerConfig {
    domain::McpServerConfig {
        transport: transport_from_wire(value.transport),
        description: value.description,
        enabled: value.enabled,
        timeout_ms: value.timeout_ms,
        handshake_timeout_ms: value.handshake_timeout_ms,
        always_load_tools: value.always_load_tools,
        blocked_tools: value.blocked_tools,
        auto_start: value.auto_start,
        reconnect: value.reconnect.map(reconnect_from_wire),
        instructions_policy: value.instructions_policy.map(instructions_policy_from_wire),
        sampling_policy: value.sampling_policy.map(approval_policy_from_wire),
        elicitation_policy: value.elicitation_policy.map(approval_policy_from_wire),
        sampling_max_tokens: value.sampling_max_tokens,
        resource_subscriptions: value.resource_subscriptions,
        command: value.command,
        args: value.args,
        env: value.env,
        cwd: value.cwd,
        url: value.url,
        headers: value.headers,
        oauth: value.oauth.map(oauth_from_wire),
        extensions: value.extensions,
    }
}

fn server_config_to_wire(value: domain::McpServerConfig) -> wire::McpServerConfig {
    wire::McpServerConfig {
        transport: transport_to_wire(value.transport),
        description: value.description,
        enabled: value.enabled,
        timeout_ms: value.timeout_ms,
        handshake_timeout_ms: value.handshake_timeout_ms,
        always_load_tools: value.always_load_tools,
        blocked_tools: value.blocked_tools,
        auto_start: value.auto_start,
        reconnect: value.reconnect.map(reconnect_to_wire),
        instructions_policy: value.instructions_policy.map(instructions_policy_to_wire),
        sampling_policy: value.sampling_policy.map(approval_policy_to_wire),
        elicitation_policy: value.elicitation_policy.map(approval_policy_to_wire),
        sampling_max_tokens: value.sampling_max_tokens,
        resource_subscriptions: value.resource_subscriptions,
        command: value.command,
        args: value.args,
        env: value.env,
        cwd: value.cwd,
        url: value.url,
        headers: value.headers,
        oauth: value.oauth.map(oauth_to_wire),
        extensions: value.extensions,
    }
}

fn transport_from_wire(value: wire::McpTransport) -> domain::McpTransport {
    match value {
        wire::McpTransport::Stdio => domain::McpTransport::Stdio,
        wire::McpTransport::Http => domain::McpTransport::Http,
        wire::McpTransport::Sse => domain::McpTransport::Sse,
    }
}

pub(crate) fn transport_to_wire(value: domain::McpTransport) -> wire::McpTransport {
    match value {
        domain::McpTransport::Stdio => wire::McpTransport::Stdio,
        domain::McpTransport::Http => wire::McpTransport::Http,
        domain::McpTransport::Sse => wire::McpTransport::Sse,
    }
}

fn reconnect_from_wire(value: wire::McpReconnectPolicy) -> domain::McpReconnectPolicy {
    domain::McpReconnectPolicy {
        enabled: value.enabled,
        max_attempts: value.max_attempts,
        base_delay_ms: value.base_delay_ms,
        max_delay_ms: value.max_delay_ms,
    }
}

fn reconnect_to_wire(value: domain::McpReconnectPolicy) -> wire::McpReconnectPolicy {
    wire::McpReconnectPolicy {
        enabled: value.enabled,
        max_attempts: value.max_attempts,
        base_delay_ms: value.base_delay_ms,
        max_delay_ms: value.max_delay_ms,
    }
}

fn oauth_from_wire(value: wire::McpOAuthConfig) -> domain::McpOAuthConfig {
    domain::McpOAuthConfig {
        client_id: value.client_id,
        callback_port: value.callback_port,
        scope: value.scope,
    }
}

fn oauth_to_wire(value: domain::McpOAuthConfig) -> wire::McpOAuthConfig {
    wire::McpOAuthConfig {
        client_id: value.client_id,
        callback_port: value.callback_port,
        scope: value.scope,
    }
}

fn approval_policy_from_wire(value: wire::McpApprovalPolicy) -> domain::McpApprovalPolicy {
    match value {
        wire::McpApprovalPolicy::Deny => domain::McpApprovalPolicy::Deny,
        wire::McpApprovalPolicy::Ask => domain::McpApprovalPolicy::Ask,
        wire::McpApprovalPolicy::Allow => domain::McpApprovalPolicy::Allow,
    }
}

fn approval_policy_to_wire(value: domain::McpApprovalPolicy) -> wire::McpApprovalPolicy {
    match value {
        domain::McpApprovalPolicy::Deny => wire::McpApprovalPolicy::Deny,
        domain::McpApprovalPolicy::Ask => wire::McpApprovalPolicy::Ask,
        domain::McpApprovalPolicy::Allow => wire::McpApprovalPolicy::Allow,
    }
}

fn instructions_policy_from_wire(
    value: wire::McpInstructionsPolicy,
) -> domain::McpInstructionsPolicy {
    match value {
        wire::McpInstructionsPolicy::Ignore => domain::McpInstructionsPolicy::Ignore,
        wire::McpInstructionsPolicy::ToolHints => domain::McpInstructionsPolicy::ToolHints,
        wire::McpInstructionsPolicy::Approved => domain::McpInstructionsPolicy::Approved,
    }
}

fn instructions_policy_to_wire(
    value: domain::McpInstructionsPolicy,
) -> wire::McpInstructionsPolicy {
    match value {
        domain::McpInstructionsPolicy::Ignore => wire::McpInstructionsPolicy::Ignore,
        domain::McpInstructionsPolicy::ToolHints => wire::McpInstructionsPolicy::ToolHints,
        domain::McpInstructionsPolicy::Approved => wire::McpInstructionsPolicy::Approved,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use codez_contracts::mcp as wire;

    use super::{list_payload, servers_from_wire};

    #[test]
    fn conversion_preserves_the_user_server_and_reports_an_honest_stopped_status() {
        let servers = servers_from_wire(BTreeMap::from([(
            "fixture".to_string(),
            wire::McpServerConfig {
                transport: wire::McpTransport::Stdio,
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
                command: Some("node".to_string()),
                args: Some(vec!["server.js".to_string()]),
                env: None,
                cwd: None,
                url: None,
                headers: None,
                oauth: None,
                extensions: BTreeMap::new(),
            },
        )]));
        let payload = list_payload(
            servers
                .into_iter()
                .map(|(name, config)| codez_mcp::UserMcpServer {
                    fingerprint: "fingerprint".to_string(),
                    name,
                    config,
                })
                .collect(),
            Vec::new(),
        );

        assert_eq!(
            (
                payload.configs[0].scope,
                payload.statuses[0].state,
                payload.statuses[0].tool_count,
            ),
            (wire::McpConfigScope::User, wire::McpServerState::Stopped, 0)
        );
    }
}
