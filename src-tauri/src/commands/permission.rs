use std::path::Path;

use codez_contracts::{CommandError, permission as wire};
use codez_core::AppError;
use codez_runtime::permission::decision;
use tauri::State;

use crate::{error::command_result, state::AppState};

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "permission_mode_get")
)]
pub async fn permission_mode_get(
    state: State<'_, AppState>,
    root_path: String,
) -> Result<wire::PermissionMode, CommandError> {
    let result = state
        .workspace_permissions
        .get_mode(Path::new(&root_path))
        .await
        .map(permission_mode_to_wire)
        .map_err(AppError::from);
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "permission_mode_set")
)]
pub async fn permission_mode_set(
    state: State<'_, AppState>,
    root_path: String,
    mode: wire::PermissionMode,
) -> Result<wire::PermissionMode, CommandError> {
    let result = state
        .workspace_permissions
        .set_mode(Path::new(&root_path), permission_mode_from_wire(mode))
        .await
        .map(permission_mode_to_wire)
        .map_err(AppError::from);
    command_result(&state.errors, result)
}

fn permission_mode_from_wire(value: wire::PermissionMode) -> decision::PermissionMode {
    match value {
        wire::PermissionMode::Auto => decision::PermissionMode::Auto,
        wire::PermissionMode::FullAccess => decision::PermissionMode::FullAccess,
    }
}

fn permission_mode_to_wire(value: decision::PermissionMode) -> wire::PermissionMode {
    match value {
        decision::PermissionMode::Auto => wire::PermissionMode::Auto,
        decision::PermissionMode::FullAccess => wire::PermissionMode::FullAccess,
    }
}

#[cfg(test)]
mod tests {
    use codez_contracts::permission as wire;
    use codez_core::{AppError, AppErrorKind};
    use codez_runtime::permission::{decision, store::PermissionStoreError};

    use super::{permission_mode_from_wire, permission_mode_to_wire};

    #[test]
    fn wire_full_access_converts_to_the_runtime_policy() {
        assert_eq!(
            permission_mode_from_wire(wire::PermissionMode::FullAccess),
            decision::PermissionMode::FullAccess
        );
    }

    #[test]
    fn runtime_auto_converts_to_the_wire_policy() {
        assert_eq!(
            permission_mode_to_wire(decision::PermissionMode::Auto),
            wire::PermissionMode::Auto
        );
    }

    #[test]
    fn invalid_workspace_errors_are_exposed_as_validation_failures() {
        let error = AppError::from(PermissionStoreError::InvalidWorkspace);

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }
}
