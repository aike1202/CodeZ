use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use codez_core::{
    AppError, CancellationToken, FileSystem, GitSnapshotResult, ProcessRequest, ProcessRunner,
    WorktreeInfo,
};

const GIT_TIMEOUT_SECS: u64 = 30;
const BRANCH_PREFIX: &str = "codez/wt/";

pub struct GitService {
    git_executable: PathBuf,
    process_environment: BTreeMap<OsString, OsString>,
    process_runner: Arc<dyn ProcessRunner>,
}

impl GitService {
    /// Creates a Git service from host-resolved process dependencies.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the executable path is not absolute.
    pub fn new(
        git_executable: PathBuf,
        process_environment: BTreeMap<OsString, OsString>,
        process_runner: Arc<dyn ProcessRunner>,
    ) -> Result<Self, AppError> {
        if !git_executable.is_absolute() {
            return Err(AppError::validation("Git executable path must be absolute"));
        }
        Ok(Self {
            git_executable,
            process_environment,
            process_runner,
        })
    }

    async fn run_git(
        &self,
        workspace_root: &Path,
        args: Vec<String>,
        timeout_secs: u64,
        cancellation: CancellationToken,
    ) -> Result<String, AppError> {
        let request = ProcessRequest {
            program: self.git_executable.clone(),
            arguments: args.into_iter().map(Into::into).collect(),
            current_directory: workspace_root.to_path_buf(),
            environment: self.process_environment.clone(),
            timeout: Duration::from_secs(timeout_secs),
            max_output_bytes: 5 * 1024 * 1024,
        };

        let output = self.process_runner.run(request, cancellation).await?;
        if output.exit_code == Some(0) {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(AppError::process_failed(
                "Git command failed",
                String::from_utf8_lossy(&output.stderr),
            ))
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
            Err(_) => {
                return Ok(GitSnapshotResult {
                    snapshot: String::new(),
                });
            }
        };

        let lines: Vec<&str> = out
            .split(['\r', '\n'])
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            return Ok(GitSnapshotResult {
                snapshot: "Branch: unknown\nWorking tree: clean".to_string(),
            });
        }

        let branch = lines[0]
            .strip_prefix("## ")
            .unwrap_or(lines[0])
            .trim_start()
            .to_string();
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
        self.run_git(
            &root,
            vec!["rev-parse".into(), "--git-dir".into()],
            GIT_TIMEOUT_SECS,
            cancellation,
        )
        .await
        .is_ok()
    }

    fn sanitize_worktree_name(name: &str) -> Result<String, AppError> {
        let safe: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .take(64)
            .collect();
        if safe.is_empty() || safe == "." || safe == ".." {
            Err(AppError::validation(format!(
                "Invalid worktree name: \"{}\"",
                name
            )))
        } else {
            Ok(safe)
        }
    }

    fn branch_name(name: &str) -> String {
        format!("{}{}", BRANCH_PREFIX, name)
    }

    fn worktree_path(root: &Path, name: &str) -> PathBuf {
        root.join(".codez").join("worktrees").join(name)
    }

    pub async fn create_worktree(
        &self,
        filesystem: &dyn FileSystem,
        name: &str,
        cancellation: CancellationToken,
    ) -> Result<WorktreeInfo, AppError> {
        let root = filesystem.workspace_root().as_path().to_path_buf();
        if !self
            .is_git_repository(filesystem, cancellation.clone())
            .await
        {
            return Err(AppError::validation("Not a git repository"));
        }

        let safe_name = Self::sanitize_worktree_name(name)?;
        let branch = Self::branch_name(&safe_name);
        let wt_path = Self::worktree_path(&root, &safe_name);

        if let Some(parent) = wt_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|source| {
                AppError::storage(
                    "The worktree directory could not be prepared",
                    format!("create worktree parent {}: {source}", parent.display()),
                    false,
                )
            })?;
        }

        let branch_exists = self
            .run_git(
                &root,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--quiet".into(),
                    format!("refs/heads/{}", branch),
                ],
                GIT_TIMEOUT_SECS,
                cancellation.clone(),
            )
            .await
            .is_ok();

        let wt_path_str = wt_path.to_string_lossy().to_string();

        if branch_exists {
            self.run_git(
                &root,
                vec![
                    "worktree".into(),
                    "add".into(),
                    wt_path_str.clone(),
                    branch.clone(),
                ],
                GIT_TIMEOUT_SECS,
                cancellation,
            )
            .await?;
        } else {
            self.run_git(
                &root,
                vec![
                    "worktree".into(),
                    "add".into(),
                    wt_path_str.clone(),
                    "-b".into(),
                    branch.clone(),
                ],
                GIT_TIMEOUT_SECS,
                cancellation,
            )
            .await?;
        }

        Ok(WorktreeInfo {
            path: wt_path,
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
        if !self
            .is_git_repository(filesystem, cancellation.clone())
            .await
        {
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

        self.run_git(&root, args, GIT_TIMEOUT_SECS, cancellation.clone())
            .await?;

        // Try deleting the branch, ignore failures
        let _ = self
            .run_git(
                &root,
                vec!["branch".into(), "-D".into(), branch],
                GIT_TIMEOUT_SECS,
                cancellation,
            )
            .await;

        Ok(())
    }

    pub async fn list_worktrees(
        &self,
        filesystem: &dyn FileSystem,
        cancellation: CancellationToken,
    ) -> Result<Vec<WorktreeInfo>, AppError> {
        let root = filesystem.workspace_root().as_path().to_path_buf();
        if !self
            .is_git_repository(filesystem, cancellation.clone())
            .await
        {
            return Ok(Vec::new());
        }

        let out = match self
            .run_git(
                &root,
                vec!["worktree".into(), "list".into(), "--porcelain".into()],
                GIT_TIMEOUT_SECS,
                cancellation,
            )
            .await
        {
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
                    branch = b
                        .trim()
                        .strip_prefix("refs/heads/")
                        .unwrap_or(b.trim())
                        .to_string();
                }
            }

            if !wt_path.is_empty() {
                results.push(WorktreeInfo {
                    path: PathBuf::from(wt_path),
                    branch,
                    head,
                });
            }
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        ffi::OsString,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use codez_core::{
        AppError, AppErrorKind, CancellationToken, PortFuture, ProcessOutput, ProcessRequest,
        ProcessRunner,
    };
    use tempfile::tempdir;

    use super::GitService;

    struct RecordingProcessRunner {
        request: Mutex<Option<ProcessRequest>>,
        output: ProcessOutput,
    }

    impl RecordingProcessRunner {
        fn successful(stdout: &[u8]) -> Self {
            Self {
                request: Mutex::new(None),
                output: ProcessOutput {
                    exit_code: Some(0),
                    stdout: stdout.to_vec(),
                    stderr: Vec::new(),
                    output_truncated: false,
                    elapsed: Duration::from_millis(1),
                },
            }
        }

        fn take_request(&self) -> ProcessRequest {
            self.request
                .lock()
                .expect("recorded request lock should not be poisoned")
                .take()
                .expect("the Git request should be recorded")
        }
    }

    impl ProcessRunner for RecordingProcessRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            _cancellation: CancellationToken,
        ) -> PortFuture<'a, ProcessOutput> {
            Box::pin(async move {
                *self
                    .request
                    .lock()
                    .map_err(|_| AppError::internal("recorded request lock was poisoned"))? =
                    Some(request);
                Ok(self.output.clone())
            })
        }
    }

    #[test]
    fn new_should_reject_a_relative_git_executable() {
        let runner = Arc::new(RecordingProcessRunner::successful(b""));

        let error = GitService::new(PathBuf::from("git"), BTreeMap::new(), runner)
            .err()
            .expect("relative Git executable paths must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn run_git_should_forward_the_injected_absolute_process_request() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(if cfg!(windows) {
            "git-test.exe"
        } else {
            "git-test"
        });
        let environment = BTreeMap::from([
            (OsString::from("PATH"), OsString::from("explicit-path")),
            (OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0")),
        ]);
        let runner = Arc::new(RecordingProcessRunner::successful(b"ok\n"));
        let service = GitService::new(executable.clone(), environment.clone(), runner.clone())
            .expect("absolute Git executable path should be accepted");

        service
            .run_git(
                directory.path(),
                vec!["status".to_string(), "--short".to_string()],
                7,
                CancellationToken::new(),
            )
            .await
            .expect("the fake Git command should succeed");

        assert_eq!(
            runner.take_request(),
            ProcessRequest {
                program: executable,
                arguments: vec![OsString::from("status"), OsString::from("--short")],
                current_directory: directory.path().to_path_buf(),
                environment,
                timeout: Duration::from_secs(7),
                max_output_bytes: 5 * 1024 * 1024,
            }
        );
    }

    #[tokio::test]
    async fn run_git_should_classify_a_nonzero_exit_as_process_failed() {
        let directory = tempdir().expect("temporary directory should be available");
        let runner = Arc::new(RecordingProcessRunner {
            request: Mutex::new(None),
            output: ProcessOutput {
                exit_code: Some(128),
                stdout: Vec::new(),
                stderr: b"fatal".to_vec(),
                output_truncated: false,
                elapsed: Duration::from_millis(1),
            },
        });
        let service = GitService::new(directory.path().join("git-test"), BTreeMap::new(), runner)
            .expect("absolute Git executable path should be accepted");

        let error = service
            .run_git(
                directory.path(),
                vec!["status".to_string()],
                1,
                CancellationToken::new(),
            )
            .await
            .expect_err("a nonzero Git exit must fail");

        assert_eq!(error.kind(), AppErrorKind::ProcessFailed);
    }
}
