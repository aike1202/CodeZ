use std::{path::PathBuf, sync::Arc};

use codez_contracts::{CommandError, GitSnapshotResult, WorktreeInfo};
use codez_core::{AppError, FileSystem};
use codez_platform::NativeFileSystem;
use tauri::State;

use crate::{error::command_result, state::AppState};
use codez_runtime::git::GitService;

async fn open_filesystem(root_path: &str) -> Result<Arc<dyn FileSystem>, AppError> {
    if root_path.len() > 32_768 {
        return Err(AppError::validation("Workspace path is too long"));
    }
    let filesystem = NativeFileSystem::open(PathBuf::from(root_path))
        .await
        .map_err(AppError::from)?;
    Ok(Arc::new(filesystem))
}

fn create_git_service(state: &AppState) -> GitService {
    GitService::new(state.process_runner.clone())
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_get_git_snapshot")
)]
pub async fn workspace_get_git_snapshot(
    root_path: String,
    state: State<'_, AppState>,
) -> Result<GitSnapshotResult, CommandError> {
    let result = async {
        let filesystem = open_filesystem(&root_path).await?;
        let git_service = create_git_service(&state);
        let cancellation = codez_core::CancellationToken::new();
        git_service.get_snapshot(filesystem.as_ref(), cancellation).await
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_create_worktree")
)]
pub async fn workspace_create_worktree(
    root_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<WorktreeInfo, CommandError> {
    let result = async {
        let filesystem = open_filesystem(&root_path).await?;
        let git_service = create_git_service(&state);
        let cancellation = codez_core::CancellationToken::new();
        git_service.create_worktree(filesystem.as_ref(), &name, cancellation).await
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_remove_worktree")
)]
pub async fn workspace_remove_worktree(
    root_path: String,
    name: String,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let filesystem = open_filesystem(&root_path).await?;
        let git_service = create_git_service(&state);
        let cancellation = codez_core::CancellationToken::new();
        git_service.remove_worktree(filesystem.as_ref(), &name, force.unwrap_or(false), cancellation).await
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_list_worktrees")
)]
pub async fn workspace_list_worktrees(
    root_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<WorktreeInfo>, CommandError> {
    let result = async {
        let filesystem = open_filesystem(&root_path).await?;
        let git_service = create_git_service(&state);
        let cancellation = codez_core::CancellationToken::new();
        git_service.list_worktrees(filesystem.as_ref(), cancellation).await
    }
    .await;
    command_result(&state.errors, result)
}
