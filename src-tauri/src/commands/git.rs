use std::sync::Arc;

use codez_contracts::{CommandError, GitSnapshotResult, WorktreeInfo};
use codez_core::{AppError, FileSystem, RecentProjectRepository};
use codez_platform::{GitInstallation, NativeFileSystem};
use codez_runtime::git::GitService;
use tauri::State;

use super::path_security::authorize_workspace;
use crate::{
    error::command_result,
    git_boundary::{snapshot_to_wire, worktree_to_wire},
    state::AppState,
};

async fn open_filesystem(
    state: &AppState,
    root_path: &str,
) -> Result<Arc<dyn FileSystem>, AppError> {
    let registered = state.recent_projects.list().await?;
    let workspace = authorize_workspace(root_path, None, &registered).await?;
    let filesystem = NativeFileSystem::open(workspace.as_path().to_path_buf())
        .await
        .map_err(AppError::from)?;
    Ok(Arc::new(filesystem))
}

fn create_git_service(state: &AppState) -> Result<GitService, AppError> {
    let (git_executable, process_environment) = GitInstallation::discover()?.into_parts();
    GitService::new(
        git_executable,
        process_environment,
        state.process_runner.clone(),
    )
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
        let filesystem = open_filesystem(state.inner(), &root_path).await?;
        let git_service = create_git_service(&state)?;
        let cancellation = codez_core::CancellationToken::new();
        git_service
            .get_snapshot(filesystem.as_ref(), cancellation)
            .await
            .map(snapshot_to_wire)
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
        let filesystem = open_filesystem(state.inner(), &root_path).await?;
        let git_service = create_git_service(&state)?;
        let cancellation = codez_core::CancellationToken::new();
        git_service
            .create_worktree(filesystem.as_ref(), &name, cancellation)
            .await
            .and_then(worktree_to_wire)
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
        let filesystem = open_filesystem(state.inner(), &root_path).await?;
        let git_service = create_git_service(&state)?;
        let cancellation = codez_core::CancellationToken::new();
        git_service
            .remove_worktree(
                filesystem.as_ref(),
                &name,
                force.unwrap_or(false),
                cancellation,
            )
            .await
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
        let filesystem = open_filesystem(state.inner(), &root_path).await?;
        let git_service = create_git_service(&state)?;
        let cancellation = codez_core::CancellationToken::new();
        git_service
            .list_worktrees(filesystem.as_ref(), cancellation)
            .await
            .and_then(|worktrees| worktrees.into_iter().map(worktree_to_wire).collect())
    }
    .await;
    command_result(&state.errors, result)
}
