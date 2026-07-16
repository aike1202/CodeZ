use std::collections::BTreeMap;

use codez_contracts::{CommandError, mcp as wire};
use codez_core::AppError;
use tauri::{AppHandle, Emitter, State};

use crate::{
    error::command_result,
    mcp_boundary::{list_payload, secret_key_from_wire, secret_value_from_wire, servers_from_wire},
    state::AppState,
};

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_list(state: State<'_, AppState>) -> Result<wire::McpListPayload, CommandError> {
    let result = async {
        let servers = state.mcp_config.list().await.map_err(AppError::from)?;
        Ok(mcp_payload(&state, servers).await)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, servers))]
pub async fn mcp_save_user(
    servers: BTreeMap<String, wire::McpServerConfig>,
    state: State<'_, AppState>,
) -> Result<wire::McpListPayload, CommandError> {
    let result = async {
        let servers = state
            .mcp_config
            .save_servers(servers_from_wire(servers))
            .await
            .map_err(AppError::from)?;
        Ok(mcp_payload(&state, servers).await)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_set_enabled(
    name: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<wire::McpListPayload, CommandError> {
    let result = async {
        let servers = state
            .mcp_config
            .set_enabled(&name, enabled)
            .await
            .map_err(AppError::from)?;
        Ok(mcp_payload(&state, servers).await)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_get_catalog(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<wire::McpServerCatalog, CommandError> {
    let result = state.mcp_runtime.catalog(&name).await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_reconnect(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let servers = state.mcp_config.list().await.map_err(AppError::from)?;
        let server = servers
            .iter()
            .find(|server| server.name == name)
            .ok_or_else(|| AppError::not_found("The MCP server is not configured"))?;
        state.mcp_runtime.reconnect(server).await
    }
    .await;
    emit_statuses(&app, &state).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_authorize(name: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    let result = Err(AppError::unsupported(format!(
        "OAuth authorization for MCP server '{name}' is not implemented by the Rust desktop host"
    )));
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_logout(name: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    let result = Err(AppError::unsupported(format!(
        "OAuth logout for MCP server '{name}' is not implemented by the Rust desktop host"
    )));
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_trust_project(
    fingerprint: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = Err(AppError::unsupported(format!(
        "Project-scoped MCP trust for '{fingerprint}' is not implemented by the Rust desktop host"
    )));
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn mcp_list_secret_keys(state: State<'_, AppState>) -> Result<Vec<String>, CommandError> {
    let result = list_secret_keys(&state).await;
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
        list_secret_keys(&state).await
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
        list_secret_keys(&state).await
    }
    .await;
    command_result(&state.errors, result)
}

async fn list_secret_keys(state: &AppState) -> Result<Vec<String>, AppError> {
    let referenced = state
        .mcp_config
        .referenced_secret_keys()
        .await
        .map_err(AppError::from)?;
    state
        .mcp_secrets
        .list_keys(&referenced)
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
    servers: Vec<codez_mcp::UserMcpServer>,
) -> wire::McpListPayload {
    let statuses = state.mcp_runtime.reconcile(&servers).await;
    list_payload(servers, statuses)
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
