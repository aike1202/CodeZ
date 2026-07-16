use std::{ffi::OsString, path::PathBuf};

use codez_contracts::CommandError;
use codez_core::{AppError, RecentProjectRepository};
use tauri::State;

use super::path_security::authorize_workspace;
use crate::{error::command_result, state::AppState};

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_start(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: String,
) -> Result<(), CommandError> {
    let result = async {
        let registered = state.recent_projects.list().await?;
        let workspace = authorize_workspace(&root_path, None, &registered).await?;
        let (program, arguments) = resolve_default_shell().await?;
        state
            .pty_manager
            .start(
                workspace_id,
                program,
                arguments,
                workspace.as_path().to_path_buf(),
            )
            .await
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_write(
    state: State<'_, AppState>,
    workspace_id: String,
    text: String,
) -> Result<(), CommandError> {
    let result = state
        .pty_manager
        .write(&workspace_id, text.as_bytes())
        .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    workspace_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let result = state.pty_manager.resize(&workspace_id, cols, rows).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_ack(
    state: State<'_, AppState>,
    workspace_id: String,
    sequence: u64,
) -> Result<(), CommandError> {
    let result = state.pty_manager.acknowledge(&workspace_id, sequence);
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_kill(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), CommandError> {
    let result = state.pty_manager.kill(&workspace_id).await;
    command_result(&state.errors, result)
}

async fn resolve_default_shell() -> Result<(PathBuf, Vec<OsString>), AppError> {
    tokio::task::spawn_blocking(resolve_default_shell_blocking)
        .await
        .map_err(|source| AppError::internal(format!("terminal shell resolver failed: {source}")))?
}

#[cfg(windows)]
fn resolve_default_shell_blocking() -> Result<(PathBuf, Vec<OsString>), AppError> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| AppError::not_found("The Windows system directory is unavailable"))?;
    let program = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    validate_shell_executable(&program)?;
    Ok((
        program,
        vec![
            OsString::from("-NoExit"),
            OsString::from("-Command"),
            OsString::from("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"),
        ],
    ))
}

#[cfg(not(windows))]
fn resolve_default_shell_blocking() -> Result<(PathBuf, Vec<OsString>), AppError> {
    let program = [PathBuf::from("/bin/bash"), PathBuf::from("/usr/bin/bash")]
        .into_iter()
        .find(|candidate| validate_shell_executable(candidate).is_ok())
        .ok_or_else(|| AppError::not_found("No supported terminal shell is installed"))?;
    Ok((program, vec![OsString::from("-l")]))
}

fn validate_shell_executable(path: &std::path::Path) -> Result<(), AppError> {
    let metadata = std::fs::metadata(path).map_err(|source| {
        AppError::external(
            "The terminal shell is unavailable",
            format!("inspect terminal executable {}: {source}", path.display()),
            false,
        )
    })?;
    if !metadata.is_file() {
        return Err(AppError::validation(
            "The configured terminal shell is not a regular file",
        ));
    }
    Ok(())
}
