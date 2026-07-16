use std::{path::PathBuf, sync::Arc};

use codez_core::{AppError, CancellationToken, FileSystem};

use crate::git::GitService;

pub struct ParallelWorktreeManager {
    git_service: Arc<GitService>,
}

impl ParallelWorktreeManager {
    pub fn new(git_service: Arc<GitService>) -> Self {
        Self { git_service }
    }

    pub async fn checkout_isolated_worktree(
        &self,
        filesystem: &dyn FileSystem,
        name: &str,
        cancellation: CancellationToken,
    ) -> Result<PathBuf, AppError> {
        self.git_service
            .create_worktree(filesystem, name, cancellation)
            .await
            .map(|info| info.path)
    }

    pub async fn clean_worktree(
        &self,
        filesystem: &dyn FileSystem,
        name: &str,
        cancellation: CancellationToken,
    ) -> Result<(), AppError> {
        self.git_service
            .remove_worktree(filesystem, name, false, cancellation)
            .await
    }
}
