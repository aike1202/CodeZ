use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use codez_contracts::{CommandError, mcp as wire};
use codez_core::{AppError, WorkspaceRoot};
use codez_mcp::{McpProjectConfigService, McpSecretService, McpUserConfigService};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::{
    error::command_result,
    mcp_boundary::{list_payload, secret_key_from_wire, secret_value_from_wire, servers_from_wire},
    state::AppState,
};

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_list(
    workspace_root: Option<String>,
    state: State<'_, AppState>,
) -> Result<wire::McpListPayload, CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        Ok(mcp_payload(&state, servers, true).await)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, servers))]
pub async fn mcp_save_user(
    servers: BTreeMap<String, wire::McpServerConfig>,
    workspace_root: Option<String>,
    state: State<'_, AppState>,
) -> Result<wire::McpListPayload, CommandError> {
    let result = async {
        let user = state
            .mcp_config
            .save_servers(servers_from_wire(servers))
            .await
            .map_err(AppError::from)?;
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = match workspace.as_ref() {
            Some(workspace) => mcp_servers_for_workspace(&state, Some(workspace)).await?,
            None => user,
        };
        Ok(mcp_payload(&state, servers, workspace.is_some()).await)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_set_enabled(
    name: String,
    enabled: bool,
    workspace_root: Option<String>,
    state: State<'_, AppState>,
) -> Result<wire::McpListPayload, CommandError> {
    let result = async {
        let user = state
            .mcp_config
            .set_enabled(&name, enabled)
            .await
            .map_err(AppError::from)?;
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = match workspace.as_ref() {
            Some(workspace) => mcp_servers_for_workspace(&state, Some(workspace)).await?,
            None => user,
        };
        Ok(mcp_payload(&state, servers, workspace.is_some()).await)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_get_catalog(
    name: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<wire::McpServerCatalog, CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        let server = effective_server(&servers, &name)?;
        let effective = effective_servers(&servers);
        state.mcp_runtime.reconcile(&effective).await;
        state.mcp_runtime.catalog(server).await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_read_resource(
    name: String,
    uri: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<wire::McpResourceReadResult, CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        state
            .mcp_runtime
            .reconcile(&effective_servers(&servers))
            .await;
        let server = effective_server(&servers, &name)?;
        state.mcp_runtime.read_resource(server, &uri).await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_subscribe_resource(
    name: String,
    uri: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        state
            .mcp_runtime
            .reconcile(&effective_servers(&servers))
            .await;
        let server = effective_server(&servers, &name)?;
        state.mcp_runtime.subscribe_resource(server, &uri).await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_unsubscribe_resource(
    name: String,
    uri: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        let server = effective_server(&servers, &name)?;
        state.mcp_runtime.unsubscribe_resource(server, &uri).await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, arguments))]
pub async fn mcp_get_prompt(
    name: String,
    prompt: String,
    arguments: BTreeMap<String, serde_json::Value>,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<wire::McpPromptGetResult, CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        state
            .mcp_runtime
            .reconcile(&effective_servers(&servers))
            .await;
        let server = effective_server(&servers, &name)?;
        state
            .mcp_runtime
            .get_prompt(server, &prompt, arguments)
            .await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_reconnect(
    name: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        let server = effective_server(&servers, &name)?;
        state.mcp_runtime.reconnect(server).await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, app))]
pub async fn mcp_authorize(
    name: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        let server = effective_server(&servers, &name)?;
        state
            .mcp_runtime
            .authorize(server, |authorization_url| {
                open_mcp_authorization_url(&app, authorization_url)
            })
            .await?;

        let refreshed = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        let current = effective_server(&refreshed, &name)?;
        if current.fingerprint != server.fingerprint {
            return Err(AppError::conflict(
                "The MCP configuration changed while OAuth authorization was in progress",
            ));
        }
        state.mcp_runtime.reconnect(current).await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_logout(
    name: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        let servers = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        let server = effective_server(&servers, &name)?;
        let logout_result = state.mcp_runtime.logout(server).await;
        let refreshed = mcp_servers_for_workspace(&state, workspace.as_ref()).await?;
        state
            .mcp_runtime
            .reconcile(&effective_servers(&refreshed))
            .await;
        logout_result
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, response))]
pub async fn mcp_respond_reverse_request(
    request_id: String,
    response: wire::McpReverseRequestResponse,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = state
        .mcp_runtime
        .respond_reverse_request(&request_id, response)
        .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_trust_project(
    fingerprint: String,
    workspace_root: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref())
            .await?
            .ok_or_else(|| {
                AppError::validation(
                    "A canonical workspace path is required to trust a project MCP configuration",
                )
            })?;
        let project = state
            .mcp_project_config
            .trust_current_fingerprint(&workspace, &fingerprint)
            .await
            .map_err(AppError::from)?;
        let user = state.mcp_config.list().await.map_err(AppError::from)?;
        let servers = codez_mcp::merge_scoped_servers(user, project).map_err(AppError::from)?;
        state
            .mcp_runtime
            .reconcile(&effective_servers(&servers))
            .await;
        emit_statuses(&app, &state).await;
        Ok(())
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_list_secret_keys(
    workspace_root: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    let result = async {
        let workspace = resolve_mcp_workspace_root(workspace_root.as_deref()).await?;
        list_secret_keys(&state, workspace.as_ref()).await
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, value))]
pub async fn mcp_set_secret(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    let result = async {
        let key = secret_key_from_wire(key).map_err(AppError::from)?;
        let value = secret_value_from_wire(value).map_err(AppError::from)?;
        state
            .mcp_secrets
            .set(key, value)
            .await
            .map_err(AppError::from)?;
        list_secret_keys(&state, None).await
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_delete_secret(
    key: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    let result = async {
        let key = secret_key_from_wire(key).map_err(AppError::from)?;
        state
            .mcp_secrets
            .delete(key)
            .await
            .map_err(AppError::from)?;
        list_secret_keys(&state, None).await
    }
    .await;
    command_result(&state.errors, result)
}

async fn list_secret_keys(
    state: &AppState,
    workspace: Option<&WorkspaceRoot>,
) -> Result<Vec<String>, AppError> {
    list_secret_keys_for_workspace(
        &state.mcp_config,
        &state.mcp_project_config,
        &state.mcp_secrets,
        workspace,
    )
    .await
}

async fn list_secret_keys_for_workspace(
    user_config: &McpUserConfigService,
    project_config: &McpProjectConfigService,
    secrets: &McpSecretService,
    workspace: Option<&WorkspaceRoot>,
) -> Result<Vec<String>, AppError> {
    let mut referenced = user_config
        .referenced_secret_keys()
        .await
        .map_err(AppError::from)?;
    if let Some(workspace) = workspace {
        referenced.extend(
            project_config
                .referenced_secret_keys(workspace)
                .await
                .map_err(AppError::from)?,
        );
    }
    secret_key_names(secrets, &referenced).await
}

async fn secret_key_names(
    secrets: &McpSecretService,
    referenced: &BTreeSet<codez_mcp::McpSecretKey>,
) -> Result<Vec<String>, AppError> {
    secrets
        .list_keys(referenced)
        .await
        .map(|keys| {
            keys.into_iter()
                .map(|key| key.as_str().to_string())
                .collect()
        })
        .map_err(AppError::from)
}

async fn mcp_payload(
    state: &AppState,
    servers: Vec<codez_mcp::ScopedMcpServer>,
    reconcile: bool,
) -> wire::McpListPayload {
    let statuses = if reconcile {
        state
            .mcp_runtime
            .reconcile(&effective_servers(&servers))
            .await
    } else {
        state.mcp_runtime.statuses().await
    };
    list_payload(servers, statuses)
}

async fn mcp_servers_for_workspace(
    state: &AppState,
    workspace: Option<&WorkspaceRoot>,
) -> Result<Vec<codez_mcp::ScopedMcpServer>, AppError> {
    let user = state.mcp_config.list().await.map_err(AppError::from)?;
    let project = match workspace {
        Some(workspace) => state
            .mcp_project_config
            .list(workspace)
            .await
            .map_err(AppError::from)?,
        None => Vec::new(),
    };
    codez_mcp::merge_scoped_servers(user, project).map_err(AppError::from)
}

fn effective_servers(servers: &[codez_mcp::ScopedMcpServer]) -> Vec<codez_mcp::ScopedMcpServer> {
    servers
        .iter()
        .filter(|server| server.effective)
        .cloned()
        .collect()
}

fn effective_server<'a>(
    servers: &'a [codez_mcp::ScopedMcpServer],
    name: &str,
) -> Result<&'a codez_mcp::ScopedMcpServer, AppError> {
    servers
        .iter()
        .find(|server| server.effective && server.name == name)
        .ok_or_else(|| AppError::not_found("The MCP server is not configured"))
}

async fn resolve_mcp_workspace_root(
    workspace_root: Option<&str>,
) -> Result<Option<WorkspaceRoot>, AppError> {
    let Some(workspace_root) = workspace_root else {
        return Ok(None);
    };
    if workspace_root.trim().is_empty() || workspace_root.len() > 32 * 1024 {
        return Err(AppError::validation("The MCP workspace path is invalid"));
    }
    let canonical = tokio::fs::canonicalize(Path::new(workspace_root))
        .await
        .map_err(|source| {
            AppError::validation(format!("The MCP workspace cannot be resolved: {source}"))
        })?;
    let metadata = tokio::fs::metadata(&canonical).await.map_err(|source| {
        AppError::validation(format!("The MCP workspace cannot be inspected: {source}"))
    })?;
    if !metadata.is_dir() {
        return Err(AppError::validation(
            "The MCP workspace must be an existing directory",
        ));
    }
    WorkspaceRoot::from_canonical(canonical)
        .map(Some)
        .map_err(|source| AppError::validation(source.to_string()))
}

async fn emit_statuses(app: &AppHandle, state: &AppState) {
    let statuses = state.mcp_runtime.statuses().await;
    if let Err(source) = app.emit("mcp:status-changed", statuses) {
        state.errors.log(&AppError::external(
            "MCP status updates could not be delivered to the interface",
            format!("emit mcp status update: {source}"),
            false,
        ));
    }
}

fn open_mcp_authorization_url(app: &AppHandle, authorization_url: &str) -> Result<(), AppError> {
    let url = parse_mcp_authorization_url(authorization_url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| {
            AppError::external(
                "MCP OAuth could not open the system browser",
                "open discovered MCP OAuth authorization URL",
                true,
            )
        })
}

fn parse_mcp_authorization_url(authorization_url: &str) -> Result<Url, AppError> {
    let url = Url::parse(authorization_url)
        .map_err(|_| AppError::validation("MCP OAuth authorization URL is invalid"))?;
    let allowed = url.scheme() == "https"
        || (url.scheme() == "http" && url.host_str().is_some_and(is_loopback_host));
    if !allowed || !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::validation(
            "MCP OAuth authorization URL is not allowed",
        ));
    }
    Ok(url)
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || matches!(host.parse::<std::net::IpAddr>(), Ok(address) if address.is_loopback())
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, sync::Arc};

    use codez_core::{AtomicPersistence, WorkspaceRoot};
    use codez_mcp::{
        McpConfigError, McpProjectConfigService, McpSecretKey, McpSecretService, McpSecretStore,
        McpSecretStoreError, McpSecretValue, McpServerConfig, McpTransport, McpUserConfigService,
        SecretFuture,
    };
    use codez_storage::AtomicFileStore;
    use tempfile::tempdir;
    use tokio::sync::Mutex;

    use super::{list_secret_keys_for_workspace, parse_mcp_authorization_url};

    #[derive(Default)]
    struct TestSecretStore {
        values: Mutex<BTreeMap<McpSecretKey, String>>,
    }

    impl TestSecretStore {
        async fn seed(&self, key: &str, value: &str) -> Result<(), codez_mcp::McpSecretError> {
            let key = McpSecretKey::parse(key.to_string())?;
            self.values.lock().await.insert(key, value.to_string());
            Ok(())
        }
    }

    impl McpSecretStore for TestSecretStore {
        fn get(&self, key: McpSecretKey) -> SecretFuture<'_, Option<McpSecretValue>> {
            Box::pin(async move {
                let value = self.values.lock().await.get(&key).cloned();
                match value {
                    Some(value) => McpSecretValue::new(value)
                        .map(Some)
                        .map_err(|_| McpSecretStoreError::Corrupt),
                    None => Ok(None),
                }
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

    fn stdio_config(secret_key: &str) -> McpServerConfig {
        McpServerConfig {
            transport: McpTransport::Stdio,
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
            command: Some("node".to_string()),
            args: Some(vec!["server.js".to_string()]),
            env: Some(BTreeMap::from([(
                "TOKEN".to_string(),
                format!("${{secret:{secret_key}}}"),
            )])),
            cwd: None,
            url: None,
            headers: None,
            oauth: None,
            extensions: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn project_mcp_symlink_is_rejected_before_configuration_is_parsed()
    -> Result<(), Box<dyn std::error::Error>> {
        let workspace = tempdir()?;
        let target = workspace.path().join("project-config-source.json");
        let link = workspace.path().join(".mcp.json");
        fs::write(
            &target,
            br#"{"servers":{"project":{"type":"stdio","command":"node"}}}"#,
        )?;
        create_file_symlink(&target, &link)?;
        let workspace = WorkspaceRoot::from_canonical(dunce::canonicalize(workspace.path())?)?;
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let service = McpProjectConfigService::new(
            persistence,
            std::env::temp_dir().join("codez-mcp-project-trust-test.json"),
        );

        let result = service.list(&workspace).await;

        assert!(matches!(result, Err(McpConfigError::Persistence { .. })));
        Ok(())
    }

    #[tokio::test]
    async fn workspace_secret_index_includes_trusted_project_references_without_values()
    -> Result<(), Box<dyn std::error::Error>> {
        let data = tempdir()?;
        let workspace_directory = tempdir()?;
        let workspace =
            WorkspaceRoot::from_canonical(dunce::canonicalize(workspace_directory.path())?)?;
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let user_config =
            McpUserConfigService::new(Arc::clone(&persistence), data.path().join("mcp.json"));
        let project_config = McpProjectConfigService::new(
            Arc::clone(&persistence),
            data.path().join("mcp-project-trust.json"),
        );
        let secret_store = Arc::new(TestSecretStore::default());
        let secret_store_port: Arc<dyn McpSecretStore> = secret_store.clone();
        let secrets = McpSecretService::new(
            Arc::clone(&persistence),
            data.path().join("mcp-secret-index.json"),
            secret_store_port,
        );

        user_config
            .save_servers(BTreeMap::from([(
                "user".to_string(),
                stdio_config("user.token"),
            )]))
            .await?;
        tokio::fs::write(
            workspace.as_path().join(".mcp.json"),
            br#"{"servers":{"project":{"type":"stdio","command":"node","args":["server.js"],"env":{"TOKEN":"${secret:project.token}"}}}}"#,
        )
        .await?;
        secret_store.seed("user.token", "user-secret-value").await?;
        secret_store
            .seed("project.token", "project-secret-value")
            .await?;

        let before_trust = list_secret_keys_for_workspace(
            &user_config,
            &project_config,
            &secrets,
            Some(&workspace),
        )
        .await?;
        let project = project_config.list(&workspace).await?;
        let fingerprint = project
            .first()
            .ok_or_else(|| std::io::Error::other("project configuration was not loaded"))?
            .fingerprint
            .clone();
        project_config
            .trust_current_fingerprint(&workspace, &fingerprint)
            .await?;
        let after_trust = list_secret_keys_for_workspace(
            &user_config,
            &project_config,
            &secrets,
            Some(&workspace),
        )
        .await?;

        assert_eq!(before_trust, vec!["user.token".to_string()]);
        assert_eq!(
            after_trust,
            vec!["project.token".to_string(), "user.token".to_string()]
        );
        assert!(after_trust.iter().all(|key| !key.contains("secret-value")));
        Ok(())
    }

    #[test]
    fn oauth_authorization_boundary_allows_https_and_loopback_http_urls() {
        let https = parse_mcp_authorization_url("https://accounts.example.test/authorize")
            .expect("HTTPS OAuth authorization URL should be allowed");
        let loopback = parse_mcp_authorization_url("http://127.0.0.1:4180/authorize")
            .expect("loopback HTTP OAuth authorization URL should be allowed");

        assert_eq!(https.scheme(), "https");
        assert_eq!(loopback.host_str(), Some("127.0.0.1"));
    }

    #[test]
    fn oauth_authorization_boundary_rejects_remote_http_and_credentials() {
        let remote_http = parse_mcp_authorization_url("http://accounts.example.test/authorize");
        let credentials = parse_mcp_authorization_url(
            "https://username:password@accounts.example.test/authorize",
        );

        assert!(remote_http.is_err());
        assert!(credentials.is_err());
    }

    #[cfg(unix)]
    fn create_file_symlink(
        target: &std::path::Path,
        link: &std::path::Path,
    ) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(
        target: &std::path::Path,
        link: &std::path::Path,
    ) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
}
