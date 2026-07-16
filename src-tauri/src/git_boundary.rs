use codez_contracts::{
    GitSnapshotResult as WireGitSnapshotResult, WorktreeInfo as WireWorktreeInfo,
};
use codez_core::{AppError, GitSnapshotResult, WorktreeInfo};

pub(crate) fn snapshot_to_wire(snapshot: GitSnapshotResult) -> WireGitSnapshotResult {
    let GitSnapshotResult { snapshot } = snapshot;
    WireGitSnapshotResult { snapshot }
}

pub(crate) fn worktree_to_wire(worktree: WorktreeInfo) -> Result<WireWorktreeInfo, AppError> {
    let WorktreeInfo { path, branch, head } = worktree;
    let path = path.into_os_string().into_string().map_err(|_| {
        AppError::unsupported("The worktree path cannot be represented by the desktop bridge")
    })?;
    Ok(WireWorktreeInfo { path, branch, head })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[cfg(unix)]
    use codez_core::AppErrorKind;
    use codez_core::{GitSnapshotResult, WorktreeInfo};

    use super::{snapshot_to_wire, worktree_to_wire};

    #[test]
    fn snapshot_conversion_preserves_model_context() {
        let snapshot = "Branch: main\nWorking tree: clean".to_string();

        let wire = snapshot_to_wire(GitSnapshotResult {
            snapshot: snapshot.clone(),
        });

        assert_eq!(wire.snapshot, snapshot);
    }

    #[test]
    fn worktree_conversion_preserves_every_wire_field() {
        let source = WorktreeInfo {
            path: PathBuf::from("C:/workspace/.codez/worktrees/task"),
            branch: "codez/wt/task".to_string(),
            head: "0123456789abcdef".to_string(),
        };

        let wire = worktree_to_wire(source.clone())
            .expect("a UTF-8 worktree path must convert to the desktop contract");

        assert_eq!(
            (wire.path, wire.branch, wire.head),
            (
                source
                    .path
                    .into_os_string()
                    .into_string()
                    .expect("fixture path is UTF-8"),
                source.branch,
                source.head,
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn worktree_conversion_rejects_a_non_utf8_path() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let error = worktree_to_wire(WorktreeInfo {
            path: PathBuf::from(OsString::from_vec(vec![0xFF])),
            branch: "codez/wt/task".to_string(),
            head: "0123456789abcdef".to_string(),
        })
        .expect_err("a non-UTF-8 worktree path must not be silently corrupted");

        assert_eq!(error.kind(), AppErrorKind::Unsupported);
    }
}
