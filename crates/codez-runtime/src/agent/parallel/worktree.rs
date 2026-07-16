use std::path::PathBuf;
use std::sync::Arc;
use codez_core::{CancellationToken, FileSystem};

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
    ) -> Result<PathBuf, String> {
        match self.git_service.create_worktree(filesystem, name, cancellation).await {
            Ok(info) => Ok(PathBuf::from(info.path)),
            Err(e) => Err(e.to_string()),
        }
    }

    pub async fn clean_worktree(
        &self,
        filesystem: &dyn FileSystem,
        name: &str,
        cancellation: CancellationToken,
    ) -> Result<(), String> {
        match self.git_service.remove_worktree(filesystem, name, false, cancellation).await {
            Ok(_) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
