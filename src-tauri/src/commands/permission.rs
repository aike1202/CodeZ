use codez_contracts::CommandError;
use tauri::{State, Window};

use crate::{error::command_result, state::AppState};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Auto,
    FullAccess,
}

#[tauri::command]
#[tracing::instrument(name = "desktop.command", skip_all, fields(command = "permission_mode_get"))]
pub fn permission_mode_get(
    window: Window,
    state: State<'_, AppState>,
    root_path: String,
) -> Result<PermissionMode, CommandError> {
    // Basic fallback implementation for mode retrieval
    // In a full implementation, it reads from WorkspacePermissionStore
    Ok(PermissionMode::Auto)
}

#[tauri::command]
#[tracing::instrument(name = "desktop.command", skip_all, fields(command = "permission_mode_set"))]
pub fn permission_mode_set(
    window: Window,
    state: State<'_, AppState>,
    root_path: String,
    mode: PermissionMode,
) -> Result<PermissionMode, CommandError> {
    // In a full implementation, writes to WorkspacePermissionStore
    Ok(mode)
}
