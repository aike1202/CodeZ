use std::path::PathBuf;

/// Human-readable bounded Git status snapshot for model context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSnapshotResult {
    pub snapshot: String,
}

/// One Git worktree discovered or created by the runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: String,
    pub head: String,
}
