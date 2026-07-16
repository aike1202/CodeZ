use std::{
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use codez_contracts::{GitSnapshotResult, WorktreeInfo};
use codez_core::{AppError, CancellationToken, FileSystem, ProcessRequest, ProcessRunner};

const GIT_TIMEOUT_SECS: u64 = 30;
const BRANCH_PREFIX: &str = "codez/wt/";

pub struct GitService {
    process_runner: Arc<dyn ProcessRunner>,
}

impl GitService {
    #[must_use]
    pub fn new(process_runner: Arc<dyn ProcessRunner>) -> Self {
        Self { process_runner }
    }

    async fn run_git(
        &self,
        workspace_root: &PathBuf,
        args: Vec<String>,
        timeout_secs: u64,
        cancellation: CancellationToken,
    ) -> Result<String, AppError> {
        let request = ProcessRequest {
            program: "git".into(),
            arguments: args.into_iter().map(Into::into).collect(),
            current_directory: workspace_root.clone(),
            environment: std::collections::BTreeMap::new(),
            timeout: Duration::from_secs(timeout_secs),
            max_output_bytes: 5 * 1024 * 1024,
        };

        let output = self.process_runner.run(request, cancellation).await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                if out.exit_code == Some(0) {
                    Ok(stdout)
                } else {
                    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                    Err(AppError::external(
                        "Git command failed",
                        stderr,
                        false,
                    ))
                }
            }
            Err(e) => Err(e),
        }
    }

    pub async fn get_snapshot(
        &self,
        filesystem: &dyn FileSystem,
        cancellation: CancellationToken,
    ) -> Result<GitSnapshotResult, AppError> {
        let root = filesystem.workspace_root().as_path().to_path_buf();
        let out = match self
            .run_git(
                &root,
                vec!["status".into(), "--short".into(), "--branch".into()],
                5,
                cancellation,
            )
            .await
        {
            Ok(out) => out,
            Err(_) => return Ok(GitSnapshotResult { snapshot: String::new() }),
        };

        let lines: Vec<&str> = out.split(|c| c == '\r' || c == '\n').map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        if lines.is_empty() {
            return Ok(GitSnapshotResult {
                snapshot: "Branch: unknown\nWorking tree: clean".to_string(),
            });
        }

        let branch = lines[0].strip_prefix("## ").unwrap_or(lines[0]).trim_start().to_string();
        let changes = &lines[1..];
        let visible_changes = changes.iter().take(40).copied().collect::<Vec<_>>();

        let mut snapshot_lines = vec![
            format!("Branch: {}", branch),
            format!(
                "Working tree: {}",
                if changes.is_empty() {
                    "clean".to_string()
                } else {
                    format!("{} changed path(s)", changes.len())
                }
            ),
        ];

        for change in visible_changes {
            snapshot_lines.push(change.to_string());
        }

        if changes.len() > 40 {
            snapshot_lines.push(format!("... {} more changed path(s)", changes.len() - 40));
        }

        Ok(GitSnapshotResult {
            snapshot: snapshot_lines.join("\n"),
        })
    }

    pub async fn is_git_repository(
        &self,
        filesystem: &dyn FileSystem,
        cancellation: CancellationToken,
    ) -> bool {
        let root = filesystem.workspace_root().as_path().to_path_buf();
        self.run_git(&root, vec!["rev-parse".into(), "--git-dir".into()], GIT_TIMEOUT_SECS, cancellation)
            .await
            .is_ok()
    }

    fn sanitize_worktree_name(name: &str) -> Result<String, AppError> {
        let safe: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
            .take(64)
            .collect();
        if safe.is_empty() || safe == "." || safe == ".." {
            Err(AppError::validation(format!("Invalid worktree name: \"{}\"", name)))
        } else {
            Ok(safe)
        }
    }

    fn branch_name(name: &str) -> String {
        format!("{}{}", BRANCH_PREFIX, name)
    }

    fn worktree_path(root: &PathBuf, name: &str) -> PathBuf {
        root.join(".codez").join("worktrees").join(name)
    }

    pub async fn create_worktree(
        &self,
        filesystem: &dyn FileSystem,
        name: &str,
        cancellation: CancellationToken,
    ) -> Result<WorktreeInfo, AppError> {
        let root = filesystem.workspace_root().as_path().to_path_buf();
        if !self.is_git_repository(filesystem, cancellation.clone()).await {
            return Err(AppError::validation("Not a git repository"));
        }

        let safe_name = Self::sanitize_worktree_name(name)?;
        let branch = Self::branch_name(&safe_name);
        let wt_path = Self::worktree_path(&root, &safe_name);

        // Ensure parent directory exists
        if let Some(parent) = wt_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let branch_exists = self
            .run_git(
                &root,
                vec!["rev-parse".into(), "--verify".into(), "--quiet".into(), format!("refs/heads/{}", branch)],
                GIT_TIMEOUT_SECS,
                cancellation.clone(),
            )
            .await
            .is_ok();

        let wt_path_str = wt_path.to_string_lossy().to_string();

        if branch_exists {
            self.run_git(
                &root,
                vec!["worktree".into(), "add".into(), wt_path_str.clone(), branch.clone()],
                GIT_TIMEOUT_SECS,
                cancellation,
            )
            .await?;
        } else {
            self.run_git(
                &root,
                vec!["worktree".into(), "add".into(), wt_path_str.clone(), "-b".into(), branch.clone()],
                GIT_TIMEOUT_SECS,
                cancellation,
            )
            .await?;
        }

        Ok(WorktreeInfo {
            path: wt_path_str,
            branch: branch.clone(),
            head: branch, // Approximation, accurate head requires reading
        })
    }

    pub async fn remove_worktree(
        &self,
        filesystem: &dyn FileSystem,
        name: &str,
        force: bool,
        cancellation: CancellationToken,
    ) -> Result<(), AppError> {
        let root = filesystem.workspace_root().as_path().to_path_buf();
        if !self.is_git_repository(filesystem, cancellation.clone()).await {
            return Err(AppError::validation("Not a git repository"));
        }

        let safe_name = Self::sanitize_worktree_name(name)?;
        let branch = Self::branch_name(&safe_name);
        let wt_path = Self::worktree_path(&root, &safe_name);
        let wt_path_str = wt_path.to_string_lossy().to_string();

        let mut args = vec!["worktree".into(), "remove".into(), wt_path_str];
        if force {
            args.push("--force".into());
        }

        self.run_git(&root, args, GIT_TIMEOUT_SECS, cancellation.clone()).await?;

        // Try deleting the branch, ignore failures
        let _ = self.run_git(&root, vec!["branch".into(), "-D".into(), branch], GIT_TIMEOUT_SECS, cancellation).await;

        Ok(())
    }

    pub async fn list_worktrees(
        &self,
        filesystem: &dyn FileSystem,
        cancellation: CancellationToken,
    ) -> Result<Vec<WorktreeInfo>, AppError> {
        let root = filesystem.workspace_root().as_path().to_path_buf();
        if !self.is_git_repository(filesystem, cancellation.clone()).await {
            return Ok(Vec::new());
        }

        let out = match self.run_git(&root, vec!["worktree".into(), "list".into(), "--porcelain".into()], GIT_TIMEOUT_SECS, cancellation).await {
            Ok(out) => out,
            Err(_) => return Ok(Vec::new()),
        };

        let mut results = Vec::new();
        let blocks = out.split("\n\n");
        for block in blocks {
            let mut wt_path = String::new();
            let mut branch = String::new();
            let mut head = String::new();

            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    wt_path = p.trim().to_string();
                } else if let Some(h) = line.strip_prefix("HEAD ") {
                    head = h.trim().to_string();
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = b.trim().strip_prefix("refs/heads/").unwrap_or(b.trim()).to_string();
                }
            }

            if !wt_path.is_empty() {
                results.push(WorktreeInfo { path: wt_path, branch, head });
            }
        }

        Ok(results)
    }
}
