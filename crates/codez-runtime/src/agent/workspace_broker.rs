use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsString,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use codez_core::agent::{WorkspaceAssignment, WorkspaceMode};
use codez_core::{
    AgentAttemptId, AgentId, AppError, ArtifactId, AtomicPersistence, CancellationToken,
    ProcessRequest, ProcessRunner, RootRunId, TaskId,
};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;

const MANIFEST_SCHEMA_VERSION: u16 = 1;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_GIT_OUTPUT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RECOVERY_RECORDS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceAccess {
    Read,
    Write,
}

#[derive(Debug, Clone)]
pub struct PrepareWorkspaceRequest {
    pub root_run_id: RootRunId,
    pub agent_id: AgentId,
    pub attempt_id: AgentAttemptId,
    pub task_id: TaskId,
    pub source_root: PathBuf,
    pub read_scope: Vec<String>,
    pub write_scope: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLeaseManifest {
    pub schema_version: u16,
    pub root_run_id: String,
    pub agent_id: String,
    pub attempt_id: String,
    pub task_id: String,
    pub source_root: PathBuf,
    pub worktree_root: PathBuf,
    pub baseline_revision: String,
    pub baseline_manifest_sha256: String,
    pub read_scope: Vec<String>,
    pub write_scope: Vec<String>,
    pub status: String,
    pub child_patch_sha256: Option<String>,
    pub integration_patch_sha256: Option<String>,
    #[serde(default)]
    pub review_patch_sha256: Option<String>,
    #[serde(default)]
    pub review_worktree_root: Option<PathBuf>,
    #[serde(default)]
    pub review_artifact_id: Option<String>,
    #[serde(default)]
    pub review_changed_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedWorkspace {
    pub assignment: WorkspaceAssignment,
    pub manifest: WorkspaceLeaseManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceIntegrationOutcome {
    pub changed_files: Vec<String>,
    pub child_patch_path: PathBuf,
    pub integration_patch_path: Option<PathBuf>,
    pub applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceBatchIntegrationOutcome {
    pub changed_files: Vec<String>,
    pub child_patch_paths: Vec<PathBuf>,
    pub integration_patch_path: Option<PathBuf>,
    pub applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenReviewArtifact {
    pub artifact_id: ArtifactId,
    pub source_attempt_id: AgentAttemptId,
    pub baseline_revision: String,
    pub patch_path: PathBuf,
    pub patch_sha256: String,
    pub snapshot_root: PathBuf,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceArtifact {
    pub artifact_id: ArtifactId,
    pub name: String,
    pub kind: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size_bytes: u64,
    pub preview: Option<String>,
    pub preview_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceChangedFile {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRecoveryDisposition {
    Clean,
    Preserved,
    ManualIntervention,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecoveryRecord {
    pub manifest_path: PathBuf,
    pub root_run_id: Option<String>,
    pub agent_id: Option<String>,
    pub attempt_id: Option<String>,
    pub status: String,
    pub disposition: WorkspaceRecoveryDisposition,
    pub detail: String,
    pub workspace_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceEditProvenance {
    pub root_run_id: RootRunId,
    pub agent_id: AgentId,
    pub attempt_id: AgentAttemptId,
    pub task_id: TaskId,
    pub tool_call_id: String,
}

#[derive(Debug, Error)]
pub enum WorkspaceBrokerError {
    #[error("workspace path is outside the assigned root")]
    OutsideRoot,
    #[error("workspace path is not authorized by the {access:?} scope: {path}")]
    ScopeDenied {
        access: WorkspaceAccess,
        path: String,
    },
    #[error("workspace scope is invalid: {0}")]
    InvalidScope(String),
    #[error("writable Agent workspaces require at least one write scope")]
    EmptyWriteScope,
    #[error("source workspace contains uncommitted or untracked changes")]
    DirtySourceWorkspace,
    #[error("source workspace is not the root of a Git repository")]
    NotRepositoryRoot,
    #[error("workspace lease does not match the requested Agent attempt")]
    LeaseMismatch,
    #[error("workspace integration was interrupted and requires inspection")]
    IntegrationRecoveryRequired,
    #[error("workspace preimage changed: expected {expected:?}, found {actual:?}")]
    PreimageConflict {
        expected: Option<String>,
        actual: Option<String>,
    },
    #[error("workspace integration cannot apply while the source workspace is dirty")]
    IntegrationSourceDirty,
    #[error("workspace integration batch must contain at least one unique attempt")]
    EmptyIntegrationBatch,
    #[error("workspace integration batch does not share one source and baseline")]
    IntegrationBatchMismatch,
    #[error("the frozen review target changed before integration")]
    ReviewTargetChanged,
    #[error("workspace path cannot be represented as UTF-8")]
    NonUtf8Path,
    #[error("workspace manifest is invalid")]
    InvalidManifest(#[source] serde_json::Error),
    #[error("workspace record could not be serialized")]
    Serialize(#[source] serde_json::Error),
    #[error(transparent)]
    App(#[from] AppError),
}

impl From<WorkspaceBrokerError> for AppError {
    fn from(value: WorkspaceBrokerError) -> Self {
        match value {
            WorkspaceBrokerError::OutsideRoot
            | WorkspaceBrokerError::ScopeDenied { .. }
            | WorkspaceBrokerError::EmptyWriteScope => {
                AppError::permission_denied(value.to_string())
            }
            WorkspaceBrokerError::PreimageConflict { .. }
            | WorkspaceBrokerError::DirtySourceWorkspace
            | WorkspaceBrokerError::IntegrationSourceDirty
            | WorkspaceBrokerError::IntegrationRecoveryRequired
            | WorkspaceBrokerError::ReviewTargetChanged => AppError::conflict(value.to_string()),
            WorkspaceBrokerError::InvalidScope(_)
            | WorkspaceBrokerError::NotRepositoryRoot
            | WorkspaceBrokerError::LeaseMismatch
            | WorkspaceBrokerError::EmptyIntegrationBatch
            | WorkspaceBrokerError::IntegrationBatchMismatch
            | WorkspaceBrokerError::NonUtf8Path => AppError::validation(value.to_string()),
            WorkspaceBrokerError::App(source) => source,
            other => AppError::storage(
                "Agent workspace state could not be updated",
                other.to_string(),
                false,
            ),
        }
    }
}

#[derive(Clone)]
pub struct WorkspaceBroker {
    runtime_root: PathBuf,
    git_program: PathBuf,
    git_environment: BTreeMap<OsString, OsString>,
    runner: Arc<dyn ProcessRunner>,
    persistence: Arc<dyn AtomicPersistence>,
    writer: Arc<Mutex<()>>,
    integration: Arc<Mutex<()>>,
}

impl WorkspaceBroker {
    #[must_use]
    pub fn new(
        runtime_root: impl AsRef<Path>,
        git_program: PathBuf,
        git_environment: BTreeMap<OsString, OsString>,
        runner: Arc<dyn ProcessRunner>,
        persistence: Arc<dyn AtomicPersistence>,
    ) -> Self {
        Self {
            runtime_root: runtime_root.as_ref().to_path_buf(),
            git_program,
            git_environment,
            runner,
            persistence,
            writer: Arc::new(Mutex::new(())),
            integration: Arc::new(Mutex::new(())),
        }
    }

    pub async fn prepare_isolated_worktree(
        &self,
        request: PrepareWorkspaceRequest,
        cancellation: CancellationToken,
    ) -> Result<PreparedWorkspace, WorkspaceBrokerError> {
        if request.write_scope.is_empty() {
            return Err(WorkspaceBrokerError::EmptyWriteScope);
        }
        compile_scopes(&request.read_scope)?;
        compile_scopes(&request.write_scope)?;
        let _writer = self.writer.lock().await;
        if let Some(existing) = self.load_manifest(&request.attempt_id).await? {
            validate_manifest_request(&existing, &request)?;
            return Ok(prepared_from_manifest(existing));
        }
        let source_root = canonical_directory(&request.source_root).await?;
        let repository_root = self
            .git_text(
                &source_root,
                ["rev-parse", "--show-toplevel"],
                cancellation.clone(),
            )
            .await?;
        let repository_root = canonical_directory(Path::new(repository_root.trim())).await?;
        if !same_path(&source_root, &repository_root) {
            return Err(WorkspaceBrokerError::NotRepositoryRoot);
        }
        let status = self
            .git_bytes(
                &source_root,
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                cancellation.clone(),
            )
            .await?;
        if !status.is_empty() {
            return Err(WorkspaceBrokerError::DirtySourceWorkspace);
        }
        let baseline_revision = self
            .git_text(&source_root, ["rev-parse", "HEAD"], cancellation.clone())
            .await?
            .trim()
            .to_string();
        let baseline_manifest_sha256 = sha256_hex(&status);
        let worktree_root = self
            .runtime_root
            .join("worktrees")
            .join(lease_key(&request.attempt_id));
        if tokio::fs::try_exists(&worktree_root)
            .await
            .map_err(storage_io)?
        {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        tokio::fs::create_dir_all(
            worktree_root
                .parent()
                .ok_or(WorkspaceBrokerError::OutsideRoot)?,
        )
        .await
        .map_err(storage_io)?;
        self.run_git(
            &source_root,
            vec![
                "worktree".into(),
                "add".into(),
                "--detach".into(),
                worktree_root.as_os_str().to_owned(),
                baseline_revision.clone().into(),
            ],
            cancellation,
        )
        .await?;
        let manifest = WorkspaceLeaseManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            root_run_id: request.root_run_id.to_string(),
            agent_id: request.agent_id.to_string(),
            attempt_id: request.attempt_id.to_string(),
            task_id: request.task_id.to_string(),
            source_root,
            worktree_root: canonical_directory(&worktree_root).await?,
            baseline_revision,
            baseline_manifest_sha256,
            read_scope: request.read_scope,
            write_scope: request.write_scope,
            status: "active".to_string(),
            child_patch_sha256: None,
            integration_patch_sha256: None,
            review_patch_sha256: None,
            review_worktree_root: None,
            review_artifact_id: None,
            review_changed_files: Vec::new(),
        };
        self.save_manifest(&request.attempt_id, &manifest).await?;
        Ok(prepared_from_manifest(manifest))
    }

    pub async fn authorize_path(
        &self,
        assignment: &WorkspaceAssignment,
        requested: &Path,
        access: WorkspaceAccess,
    ) -> Result<PathBuf, WorkspaceBrokerError> {
        Self::authorize_assignment_path(assignment, requested, access).await
    }

    pub async fn authorize_assignment_path(
        assignment: &WorkspaceAssignment,
        requested: &Path,
        access: WorkspaceAccess,
    ) -> Result<PathBuf, WorkspaceBrokerError> {
        let root = canonical_directory(Path::new(&assignment.root)).await?;
        let resolved = resolve_beneath(&root, requested).await?;
        let relative = relative_path(&root, &resolved)?;
        let relative_text = relative
            .to_str()
            .ok_or(WorkspaceBrokerError::NonUtf8Path)?
            .replace('\\', "/");
        let scopes = match access {
            WorkspaceAccess::Read => &assignment.read_scope,
            WorkspaceAccess::Write => &assignment.write_scope,
        };
        let root_is_authorized = relative_text.is_empty()
            && scopes
                .iter()
                .any(|scope| matches!(scope.trim(), "**" | "**/*"));
        if !root_is_authorized && !compile_scopes(scopes)?.is_match(&relative_text) {
            return Err(WorkspaceBrokerError::ScopeDenied {
                access,
                path: relative_text,
            });
        }
        Ok(resolved)
    }

    pub async fn compare_and_swap_write(
        &self,
        assignment: &WorkspaceAssignment,
        requested: &Path,
        expected_sha256: Option<&str>,
        bytes: &[u8],
        provenance: &WorkspaceEditProvenance,
    ) -> Result<String, WorkspaceBrokerError> {
        let path = self
            .authorize_path(assignment, requested, WorkspaceAccess::Write)
            .await?;
        let _writer = self.writer.lock().await;
        let current = self.persistence.read(&path).await?;
        let actual = current.as_deref().map(sha256_hex);
        let expected = expected_sha256.map(str::to_string);
        if actual != expected {
            return Err(WorkspaceBrokerError::PreimageConflict { expected, actual });
        }
        let rechecked = self.persistence.read(&path).await?;
        let rechecked_hash = rechecked.as_deref().map(sha256_hex);
        if rechecked_hash != actual {
            return Err(WorkspaceBrokerError::PreimageConflict {
                expected: actual,
                actual: rechecked_hash,
            });
        }
        self.persistence.replace(&path, bytes).await?;
        let postimage_sha256 = sha256_hex(bytes);
        self.append_edit_provenance(
            provenance,
            &path,
            rechecked.as_deref().map(sha256_hex),
            &postimage_sha256,
        )
        .await?;
        Ok(postimage_sha256)
    }

    pub async fn freeze_review(
        &self,
        attempt_id: &AgentAttemptId,
        cancellation: CancellationToken,
    ) -> Result<FrozenReviewArtifact, WorkspaceBrokerError> {
        let _writer = self.writer.lock().await;
        let mut manifest = self
            .load_manifest(attempt_id)
            .await?
            .ok_or(WorkspaceBrokerError::LeaseMismatch)?;
        if let Some(artifact) = self.review_artifact_from_manifest(&manifest).await? {
            return Ok(artifact);
        }
        if manifest.status == "integrating" {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        let source_root = canonical_directory(&manifest.source_root).await?;
        let worktree_root = canonical_directory(&manifest.worktree_root).await?;
        self.run_git(
            &worktree_root,
            vec!["add".into(), "-N".into(), "--".into(), ".".into()],
            cancellation.clone(),
        )
        .await?;
        let changed_bytes = self
            .git_bytes(
                &worktree_root,
                ["diff", "--name-only", "-z", "HEAD", "--"],
                cancellation.clone(),
            )
            .await?;
        let changed_files = nul_paths(&changed_bytes)?;
        let write_scopes = compile_scopes(&manifest.write_scope)?;
        for path in &changed_files {
            if !write_scopes.is_match(path) {
                return Err(WorkspaceBrokerError::ScopeDenied {
                    access: WorkspaceAccess::Write,
                    path: path.clone(),
                });
            }
        }
        let patch = self
            .git_bytes(
                &worktree_root,
                ["diff", "--binary", "HEAD", "--"],
                cancellation.clone(),
            )
            .await?;
        let patch_sha256 = sha256_hex(&patch);
        let patch_path = self.artifact_path(attempt_id, "review.patch");
        self.persistence.replace(&patch_path, &patch).await?;
        let artifact_id = ArtifactId::parse(format!(
            "review-{}",
            sha256_hex(format!("{attempt_id}:{patch_sha256}").as_bytes())
        ))
        .map_err(|_| WorkspaceBrokerError::LeaseMismatch)?;
        let snapshot_root = self
            .runtime_root
            .join("reviews")
            .join(lease_key(attempt_id));
        if tokio::fs::try_exists(&snapshot_root)
            .await
            .map_err(storage_io)?
        {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        tokio::fs::create_dir_all(
            snapshot_root
                .parent()
                .ok_or(WorkspaceBrokerError::OutsideRoot)?,
        )
        .await
        .map_err(storage_io)?;
        self.run_git(
            &source_root,
            vec![
                "worktree".into(),
                "add".into(),
                "--detach".into(),
                snapshot_root.as_os_str().to_owned(),
                manifest.baseline_revision.clone().into(),
            ],
            cancellation.clone(),
        )
        .await?;
        if !patch.is_empty()
            && let Err(error) = self
                .run_git(
                    &snapshot_root,
                    vec![
                        "apply".into(),
                        "--binary".into(),
                        patch_path.as_os_str().to_owned(),
                    ],
                    cancellation.clone(),
                )
                .await
        {
            let _ = self
                .remove_worktree(&source_root, &snapshot_root, cancellation)
                .await;
            return Err(error);
        }
        let snapshot_root = canonical_directory(&snapshot_root).await?;
        manifest.review_patch_sha256 = Some(patch_sha256.clone());
        manifest.review_worktree_root = Some(snapshot_root.clone());
        manifest.review_artifact_id = Some(artifact_id.to_string());
        manifest.review_changed_files.clone_from(&changed_files);
        if manifest.status == "active" {
            manifest.status = "review_frozen".to_string();
        }
        self.save_manifest(attempt_id, &manifest).await?;
        Ok(FrozenReviewArtifact {
            artifact_id,
            source_attempt_id: attempt_id.clone(),
            baseline_revision: manifest.baseline_revision,
            patch_path,
            patch_sha256,
            snapshot_root,
            changed_files,
        })
    }

    pub async fn frozen_review(
        &self,
        attempt_id: &AgentAttemptId,
    ) -> Result<Option<FrozenReviewArtifact>, WorkspaceBrokerError> {
        let manifest = self
            .load_manifest(attempt_id)
            .await?
            .ok_or(WorkspaceBrokerError::LeaseMismatch)?;
        self.review_artifact_from_manifest(&manifest).await
    }

    pub async fn workspace_changes(
        &self,
        attempt_id: &AgentAttemptId,
        cancellation: CancellationToken,
    ) -> Result<Vec<WorkspaceChangedFile>, WorkspaceBrokerError> {
        let _writer = self.writer.lock().await;
        let mut manifest = self
            .load_manifest(attempt_id)
            .await?
            .ok_or(WorkspaceBrokerError::LeaseMismatch)?;
        let worktree_root = canonical_directory(&manifest.worktree_root).await?;
        self.run_git(
            &worktree_root,
            vec!["add".into(), "-N".into(), "--".into(), ".".into()],
            cancellation.clone(),
        )
        .await?;
        let status = self
            .git_bytes(
                &worktree_root,
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                cancellation.clone(),
            )
            .await?;
        let patch = self
            .git_bytes(
                &worktree_root,
                ["diff", "--binary", "HEAD", "--"],
                cancellation,
            )
            .await?;
        self.persistence
            .replace(&self.artifact_path(attempt_id, "child.patch"), &patch)
            .await?;
        manifest.child_patch_sha256 = Some(sha256_hex(&patch));
        self.save_manifest(attempt_id, &manifest).await?;
        porcelain_changes(&status)
    }

    pub async fn artifacts(
        &self,
        attempt_id: &AgentAttemptId,
        max_preview_bytes: usize,
    ) -> Result<Vec<WorkspaceArtifact>, WorkspaceBrokerError> {
        let manifest = self
            .load_manifest(attempt_id)
            .await?
            .ok_or(WorkspaceBrokerError::LeaseMismatch)?;
        let mut artifacts = Vec::new();
        if let Some(sha256) = manifest.child_patch_sha256.as_deref() {
            artifacts.push(
                self.load_workspace_artifact(
                    attempt_id,
                    "child.patch",
                    "child_patch",
                    sha256,
                    None,
                    max_preview_bytes,
                )
                .await?,
            );
        }
        if let Some(sha256) = manifest.integration_patch_sha256.as_deref() {
            artifacts.push(
                self.load_workspace_artifact(
                    attempt_id,
                    "integration.patch",
                    "integration_patch",
                    sha256,
                    None,
                    max_preview_bytes,
                )
                .await?,
            );
        }
        if let Some(sha256) = manifest.review_patch_sha256.as_deref() {
            artifacts.push(
                self.load_workspace_artifact(
                    attempt_id,
                    "review.patch",
                    "frozen_review_patch",
                    sha256,
                    manifest.review_artifact_id.as_deref(),
                    max_preview_bytes,
                )
                .await?,
            );
        }
        Ok(artifacts)
    }

    pub async fn scan_recovery(
        &self,
    ) -> Result<Vec<WorkspaceRecoveryRecord>, WorkspaceBrokerError> {
        let leases_root = self.runtime_root.join("leases");
        let mut records = Vec::new();
        let mut known_paths = HashSet::new();
        if tokio::fs::try_exists(&leases_root)
            .await
            .map_err(storage_io)?
        {
            let mut entries = tokio::fs::read_dir(&leases_root)
                .await
                .map_err(storage_io)?;
            while let Some(entry) = entries.next_entry().await.map_err(storage_io)? {
                if records.len() >= MAX_RECOVERY_RECORDS {
                    break;
                }
                if !entry.file_type().await.map_err(storage_io)?.is_file() {
                    continue;
                }
                let manifest_path = entry.path();
                let bytes = tokio::fs::read(&manifest_path).await.map_err(storage_io)?;
                let manifest = match serde_json::from_slice::<WorkspaceLeaseManifest>(&bytes) {
                    Ok(manifest) => manifest,
                    Err(error) => {
                        records.push(WorkspaceRecoveryRecord {
                            manifest_path,
                            root_run_id: None,
                            agent_id: None,
                            attempt_id: None,
                            status: "invalid_manifest".to_string(),
                            disposition: WorkspaceRecoveryDisposition::ManualIntervention,
                            detail: format!("Workspace manifest is invalid: {error}"),
                            workspace_paths: Vec::new(),
                        });
                        continue;
                    }
                };
                known_paths.insert(recovery_path_key(&manifest.worktree_root));
                let mut workspace_paths = vec![manifest.worktree_root.clone()];
                let worktree_exists = tokio::fs::try_exists(&manifest.worktree_root)
                    .await
                    .map_err(storage_io)?;
                let review_exists =
                    if let Some(review_root) = manifest.review_worktree_root.as_ref() {
                        known_paths.insert(recovery_path_key(review_root));
                        workspace_paths.push(review_root.clone());
                        tokio::fs::try_exists(review_root)
                            .await
                            .map_err(storage_io)?
                    } else {
                        true
                    };
                let (disposition, detail) = match manifest.status.as_str() {
                    "cleaned" => (
                        WorkspaceRecoveryDisposition::Clean,
                        "Workspace lease was cleaned normally".to_string(),
                    ),
                    "integrating" => (
                        WorkspaceRecoveryDisposition::ManualIntervention,
                        "Integration may have crossed an external-effect boundary; inspect source and patch before deciding whether to retry"
                            .to_string(),
                    ),
                    "active" | "review_frozen" if !worktree_exists || !review_exists => (
                        WorkspaceRecoveryDisposition::ManualIntervention,
                        "An active workspace lease references a missing worktree".to_string(),
                    ),
                    "active" | "review_frozen" => (
                        WorkspaceRecoveryDisposition::Preserved,
                        "Unintegrated worktree and artifacts were preserved for inspection"
                            .to_string(),
                    ),
                    "integrated" => (
                        WorkspaceRecoveryDisposition::Preserved,
                        "Integration completed; retained worktrees and artifacts may be cleaned after inspection"
                            .to_string(),
                    ),
                    other => (
                        WorkspaceRecoveryDisposition::ManualIntervention,
                        format!("Workspace lease has unknown status {other}"),
                    ),
                };
                records.push(WorkspaceRecoveryRecord {
                    manifest_path,
                    root_run_id: Some(manifest.root_run_id),
                    agent_id: Some(manifest.agent_id),
                    attempt_id: Some(manifest.attempt_id),
                    status: manifest.status,
                    disposition,
                    detail,
                    workspace_paths,
                });
            }
        }
        for directory in ["worktrees", "reviews", "integrations"] {
            let root = self.runtime_root.join(directory);
            if !tokio::fs::try_exists(&root).await.map_err(storage_io)? {
                continue;
            }
            let mut entries = tokio::fs::read_dir(&root).await.map_err(storage_io)?;
            while let Some(entry) = entries.next_entry().await.map_err(storage_io)? {
                if records.len() >= MAX_RECOVERY_RECORDS {
                    break;
                }
                if !entry.file_type().await.map_err(storage_io)?.is_dir()
                    || known_paths.contains(&recovery_path_key(&entry.path()))
                {
                    continue;
                }
                records.push(WorkspaceRecoveryRecord {
                    manifest_path: leases_root.clone(),
                    root_run_id: None,
                    agent_id: None,
                    attempt_id: None,
                    status: "orphaned_directory".to_string(),
                    disposition: WorkspaceRecoveryDisposition::ManualIntervention,
                    detail: format!("The {directory} directory has no matching workspace manifest"),
                    workspace_paths: vec![entry.path()],
                });
            }
        }
        records.sort_by(|left, right| {
            left.attempt_id
                .cmp(&right.attempt_id)
                .then_with(|| left.status.cmp(&right.status))
        });
        Ok(records)
    }

    pub async fn integrate(
        &self,
        attempt_id: &AgentAttemptId,
        cancellation: CancellationToken,
    ) -> Result<WorkspaceIntegrationOutcome, WorkspaceBrokerError> {
        let _integration = self.integration.lock().await;
        let _writer = self.writer.lock().await;
        let mut manifest = self
            .load_manifest(attempt_id)
            .await?
            .ok_or(WorkspaceBrokerError::LeaseMismatch)?;
        if manifest.status == "integrated" {
            return self.outcome_from_manifest(&manifest, true).await;
        }
        if manifest.status == "integrating" {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        let source_root = canonical_directory(&manifest.source_root).await?;
        let worktree_root = canonical_directory(&manifest.worktree_root).await?;
        self.run_git(
            &worktree_root,
            vec!["add".into(), "-N".into(), "--".into(), ".".into()],
            cancellation.clone(),
        )
        .await?;
        let changed_bytes = self
            .git_bytes(
                &worktree_root,
                ["diff", "--name-only", "-z", "HEAD", "--"],
                cancellation.clone(),
            )
            .await?;
        let changed_files = nul_paths(&changed_bytes)?;
        let write_scopes = compile_scopes(&manifest.write_scope)?;
        for path in &changed_files {
            if !write_scopes.is_match(path) {
                return Err(WorkspaceBrokerError::ScopeDenied {
                    access: WorkspaceAccess::Write,
                    path: path.clone(),
                });
            }
        }
        let child_patch = self
            .git_bytes(
                &worktree_root,
                ["diff", "--binary", "HEAD", "--"],
                cancellation.clone(),
            )
            .await?;
        let child_patch_path = self.artifact_path(attempt_id, "child.patch");
        self.persistence
            .replace(&child_patch_path, &child_patch)
            .await?;
        let child_patch_sha256 = sha256_hex(&child_patch);
        if manifest
            .review_patch_sha256
            .as_ref()
            .is_some_and(|frozen| frozen != &child_patch_sha256)
        {
            return Err(WorkspaceBrokerError::ReviewTargetChanged);
        }
        manifest.child_patch_sha256 = Some(child_patch_sha256);
        if child_patch.is_empty() {
            manifest.status = "integrated".to_string();
            self.save_manifest(attempt_id, &manifest).await?;
            return Ok(WorkspaceIntegrationOutcome {
                changed_files,
                child_patch_path,
                integration_patch_path: None,
                applied: false,
            });
        }
        if !self
            .git_bytes(
                &source_root,
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                cancellation.clone(),
            )
            .await?
            .is_empty()
        {
            return Err(WorkspaceBrokerError::IntegrationSourceDirty);
        }
        let current_head = self
            .git_text(&source_root, ["rev-parse", "HEAD"], cancellation.clone())
            .await?
            .trim()
            .to_string();
        let integration_root = self
            .runtime_root
            .join("integrations")
            .join(lease_key(attempt_id));
        if tokio::fs::try_exists(&integration_root)
            .await
            .map_err(storage_io)?
        {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        tokio::fs::create_dir_all(
            integration_root
                .parent()
                .ok_or(WorkspaceBrokerError::OutsideRoot)?,
        )
        .await
        .map_err(storage_io)?;
        self.run_git(
            &source_root,
            vec![
                "worktree".into(),
                "add".into(),
                "--detach".into(),
                integration_root.as_os_str().to_owned(),
                current_head.clone().into(),
            ],
            cancellation.clone(),
        )
        .await?;
        if let Err(error) = self
            .run_git(
                &integration_root,
                vec![
                    "apply".into(),
                    "--3way".into(),
                    child_patch_path.as_os_str().to_owned(),
                ],
                cancellation.clone(),
            )
            .await
        {
            let _ = self
                .remove_worktree(&source_root, &integration_root, cancellation.clone())
                .await;
            return Err(error);
        }
        let integration_patch = self
            .git_bytes(
                &integration_root,
                ["diff", "--binary", "HEAD", "--"],
                cancellation.clone(),
            )
            .await?;
        let integration_patch_path = self.artifact_path(attempt_id, "integration.patch");
        self.persistence
            .replace(&integration_patch_path, &integration_patch)
            .await?;
        manifest.integration_patch_sha256 = Some(sha256_hex(&integration_patch));
        manifest.status = "integrating".to_string();
        self.save_manifest(attempt_id, &manifest).await?;
        let head_recheck = self
            .git_text(&source_root, ["rev-parse", "HEAD"], cancellation.clone())
            .await?;
        let source_recheck = self
            .git_bytes(
                &source_root,
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                cancellation.clone(),
            )
            .await?;
        if head_recheck.trim() != current_head || !source_recheck.is_empty() {
            return Err(WorkspaceBrokerError::IntegrationSourceDirty);
        }
        self.run_git(
            &source_root,
            vec![
                "apply".into(),
                "--check".into(),
                integration_patch_path.as_os_str().to_owned(),
            ],
            cancellation.clone(),
        )
        .await?;
        self.run_git(
            &source_root,
            vec![
                "apply".into(),
                integration_patch_path.as_os_str().to_owned(),
            ],
            cancellation.clone(),
        )
        .await?;
        manifest.status = "integrated".to_string();
        self.save_manifest(attempt_id, &manifest).await?;
        let _ = self
            .remove_worktree(&source_root, &integration_root, cancellation)
            .await;
        Ok(WorkspaceIntegrationOutcome {
            changed_files,
            child_patch_path,
            integration_patch_path: Some(integration_patch_path),
            applied: true,
        })
    }

    pub async fn integrate_batch(
        &self,
        attempt_ids: &[AgentAttemptId],
        cancellation: CancellationToken,
    ) -> Result<WorkspaceBatchIntegrationOutcome, WorkspaceBrokerError> {
        let _integration = self.integration.lock().await;
        let _writer = self.writer.lock().await;
        let unique = attempt_ids.iter().collect::<HashSet<_>>();
        if attempt_ids.is_empty() || unique.len() != attempt_ids.len() {
            return Err(WorkspaceBrokerError::EmptyIntegrationBatch);
        }
        let mut manifests = Vec::with_capacity(attempt_ids.len());
        for attempt_id in attempt_ids {
            manifests.push(
                self.load_manifest(attempt_id)
                    .await?
                    .ok_or(WorkspaceBrokerError::LeaseMismatch)?,
            );
        }
        if manifests
            .iter()
            .all(|manifest| manifest.status == "integrated")
        {
            let mut changed_files = manifests
                .iter()
                .flat_map(|manifest| manifest.review_changed_files.iter().cloned())
                .collect::<Vec<_>>();
            changed_files.sort();
            changed_files.dedup();
            let integration_patch_path = manifests
                .iter()
                .position(|manifest| manifest.integration_patch_sha256.is_some())
                .map(|index| self.artifact_path(&attempt_ids[index], "integration.patch"));
            return Ok(WorkspaceBatchIntegrationOutcome {
                changed_files,
                child_patch_paths: attempt_ids
                    .iter()
                    .map(|attempt_id| self.artifact_path(attempt_id, "child.patch"))
                    .collect(),
                integration_patch_path,
                applied: false,
            });
        }
        if manifests
            .iter()
            .any(|manifest| matches!(manifest.status.as_str(), "integrated" | "integrating"))
        {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        let first = manifests
            .first()
            .ok_or(WorkspaceBrokerError::EmptyIntegrationBatch)?;
        if manifests.iter().skip(1).any(|manifest| {
            manifest.source_root != first.source_root
                || manifest.baseline_revision != first.baseline_revision
        }) {
            return Err(WorkspaceBrokerError::IntegrationBatchMismatch);
        }
        let source_root = canonical_directory(&first.source_root).await?;
        let mut changed_files = Vec::new();
        let mut child_patch_paths = Vec::with_capacity(attempt_ids.len());
        let mut child_patches = Vec::with_capacity(attempt_ids.len());
        for (attempt_id, manifest) in attempt_ids.iter().zip(&mut manifests) {
            let worktree_root = canonical_directory(&manifest.worktree_root).await?;
            self.run_git(
                &worktree_root,
                vec!["add".into(), "-N".into(), "--".into(), ".".into()],
                cancellation.clone(),
            )
            .await?;
            let changed_bytes = self
                .git_bytes(
                    &worktree_root,
                    ["diff", "--name-only", "-z", "HEAD", "--"],
                    cancellation.clone(),
                )
                .await?;
            let attempt_changed_files = nul_paths(&changed_bytes)?;
            let write_scopes = compile_scopes(&manifest.write_scope)?;
            for path in &attempt_changed_files {
                if !write_scopes.is_match(path) {
                    return Err(WorkspaceBrokerError::ScopeDenied {
                        access: WorkspaceAccess::Write,
                        path: path.clone(),
                    });
                }
            }
            changed_files.extend(attempt_changed_files);
            let patch = self
                .git_bytes(
                    &worktree_root,
                    ["diff", "--binary", "HEAD", "--"],
                    cancellation.clone(),
                )
                .await?;
            let patch_path = self.artifact_path(attempt_id, "child.patch");
            self.persistence.replace(&patch_path, &patch).await?;
            let patch_sha256 = sha256_hex(&patch);
            if manifest
                .review_patch_sha256
                .as_ref()
                .is_some_and(|frozen| frozen != &patch_sha256)
            {
                return Err(WorkspaceBrokerError::ReviewTargetChanged);
            }
            manifest.child_patch_sha256 = Some(patch_sha256);
            child_patch_paths.push(patch_path);
            child_patches.push(patch);
        }
        changed_files.sort();
        changed_files.dedup();
        if child_patches.iter().all(Vec::is_empty) {
            for (attempt_id, manifest) in attempt_ids.iter().zip(&mut manifests) {
                manifest.status = "integrated".to_string();
                self.save_manifest(attempt_id, manifest).await?;
            }
            return Ok(WorkspaceBatchIntegrationOutcome {
                changed_files,
                child_patch_paths,
                integration_patch_path: None,
                applied: false,
            });
        }
        if !self
            .git_bytes(
                &source_root,
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                cancellation.clone(),
            )
            .await?
            .is_empty()
        {
            return Err(WorkspaceBrokerError::IntegrationSourceDirty);
        }
        let current_head = self
            .git_text(&source_root, ["rev-parse", "HEAD"], cancellation.clone())
            .await?
            .trim()
            .to_string();
        let integration_root = self
            .runtime_root
            .join("integrations")
            .join(lease_key(&attempt_ids[0]));
        if tokio::fs::try_exists(&integration_root)
            .await
            .map_err(storage_io)?
        {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        tokio::fs::create_dir_all(
            integration_root
                .parent()
                .ok_or(WorkspaceBrokerError::OutsideRoot)?,
        )
        .await
        .map_err(storage_io)?;
        self.run_git(
            &source_root,
            vec![
                "worktree".into(),
                "add".into(),
                "--detach".into(),
                integration_root.as_os_str().to_owned(),
                current_head.clone().into(),
            ],
            cancellation.clone(),
        )
        .await?;
        for (patch_path, patch) in child_patch_paths.iter().zip(&child_patches) {
            if patch.is_empty() {
                continue;
            }
            if let Err(error) = self
                .run_git(
                    &integration_root,
                    vec![
                        "apply".into(),
                        "--3way".into(),
                        patch_path.as_os_str().to_owned(),
                    ],
                    cancellation.clone(),
                )
                .await
            {
                let _ = self
                    .remove_worktree(&source_root, &integration_root, cancellation.clone())
                    .await;
                return Err(error);
            }
        }
        self.run_git(
            &integration_root,
            vec!["diff".into(), "--check".into(), "HEAD".into(), "--".into()],
            cancellation.clone(),
        )
        .await?;
        let integration_patch = self
            .git_bytes(
                &integration_root,
                ["diff", "--binary", "HEAD", "--"],
                cancellation.clone(),
            )
            .await?;
        let integration_patch_sha256 = sha256_hex(&integration_patch);
        for (attempt_id, manifest) in attempt_ids.iter().zip(&mut manifests) {
            self.persistence
                .replace(
                    &self.artifact_path(attempt_id, "integration.patch"),
                    &integration_patch,
                )
                .await?;
            manifest.integration_patch_sha256 = Some(integration_patch_sha256.clone());
            manifest.status = "integrating".to_string();
            self.save_manifest(attempt_id, manifest).await?;
        }
        let head_recheck = self
            .git_text(&source_root, ["rev-parse", "HEAD"], cancellation.clone())
            .await?;
        let source_recheck = self
            .git_bytes(
                &source_root,
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                cancellation.clone(),
            )
            .await?;
        if head_recheck.trim() != current_head || !source_recheck.is_empty() {
            return Err(WorkspaceBrokerError::IntegrationSourceDirty);
        }
        let integration_patch_path = self.artifact_path(&attempt_ids[0], "integration.patch");
        self.run_git(
            &source_root,
            vec![
                "apply".into(),
                "--check".into(),
                integration_patch_path.as_os_str().to_owned(),
            ],
            cancellation.clone(),
        )
        .await?;
        self.run_git(
            &source_root,
            vec![
                "apply".into(),
                integration_patch_path.as_os_str().to_owned(),
            ],
            cancellation.clone(),
        )
        .await?;
        for (attempt_id, manifest) in attempt_ids.iter().zip(&mut manifests) {
            manifest.status = "integrated".to_string();
            self.save_manifest(attempt_id, manifest).await?;
        }
        let _ = self
            .remove_worktree(&source_root, &integration_root, cancellation)
            .await;
        Ok(WorkspaceBatchIntegrationOutcome {
            changed_files,
            child_patch_paths,
            integration_patch_path: Some(integration_patch_path),
            applied: true,
        })
    }

    pub async fn cleanup(
        &self,
        attempt_id: &AgentAttemptId,
        cancellation: CancellationToken,
    ) -> Result<(), WorkspaceBrokerError> {
        let _writer = self.writer.lock().await;
        let mut manifest = self
            .load_manifest(attempt_id)
            .await?
            .ok_or(WorkspaceBrokerError::LeaseMismatch)?;
        if manifest.status == "integrating" {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        if tokio::fs::try_exists(&manifest.worktree_root)
            .await
            .map_err(storage_io)?
        {
            self.remove_worktree(&manifest.source_root, &manifest.worktree_root, cancellation)
                .await?;
        }
        if let Some(review_root) = manifest.review_worktree_root.as_ref()
            && tokio::fs::try_exists(review_root)
                .await
                .map_err(storage_io)?
        {
            self.remove_worktree(&manifest.source_root, review_root, CancellationToken::new())
                .await?;
        }
        manifest.status = "cleaned".to_string();
        self.save_manifest(attempt_id, &manifest).await
    }

    async fn outcome_from_manifest(
        &self,
        manifest: &WorkspaceLeaseManifest,
        applied: bool,
    ) -> Result<WorkspaceIntegrationOutcome, WorkspaceBrokerError> {
        let attempt_id = AgentAttemptId::parse(manifest.attempt_id.clone())
            .map_err(|_| WorkspaceBrokerError::LeaseMismatch)?;
        let changed_files = if tokio::fs::try_exists(&manifest.worktree_root)
            .await
            .map_err(storage_io)?
        {
            nul_paths(
                &self
                    .git_bytes(
                        &manifest.worktree_root,
                        ["diff", "--name-only", "-z", "HEAD", "--"],
                        CancellationToken::new(),
                    )
                    .await?,
            )?
        } else {
            Vec::new()
        };
        Ok(WorkspaceIntegrationOutcome {
            changed_files,
            child_patch_path: self.artifact_path(&attempt_id, "child.patch"),
            integration_patch_path: manifest
                .integration_patch_sha256
                .as_ref()
                .map(|_| self.artifact_path(&attempt_id, "integration.patch")),
            applied,
        })
    }

    async fn review_artifact_from_manifest(
        &self,
        manifest: &WorkspaceLeaseManifest,
    ) -> Result<Option<FrozenReviewArtifact>, WorkspaceBrokerError> {
        let (Some(patch_sha256), Some(snapshot_root), Some(artifact_id)) = (
            manifest.review_patch_sha256.as_ref(),
            manifest.review_worktree_root.as_ref(),
            manifest.review_artifact_id.as_ref(),
        ) else {
            return Ok(None);
        };
        if !tokio::fs::try_exists(snapshot_root)
            .await
            .map_err(storage_io)?
        {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        let attempt_id = AgentAttemptId::parse(manifest.attempt_id.clone())
            .map_err(|_| WorkspaceBrokerError::LeaseMismatch)?;
        let artifact_id = ArtifactId::parse(artifact_id.clone())
            .map_err(|_| WorkspaceBrokerError::LeaseMismatch)?;
        Ok(Some(FrozenReviewArtifact {
            artifact_id,
            source_attempt_id: attempt_id.clone(),
            baseline_revision: manifest.baseline_revision.clone(),
            patch_path: self.artifact_path(&attempt_id, "review.patch"),
            patch_sha256: patch_sha256.clone(),
            snapshot_root: snapshot_root.clone(),
            changed_files: manifest.review_changed_files.clone(),
        }))
    }

    async fn load_workspace_artifact(
        &self,
        attempt_id: &AgentAttemptId,
        name: &str,
        kind: &str,
        sha256: &str,
        persisted_id: Option<&str>,
        max_preview_bytes: usize,
    ) -> Result<WorkspaceArtifact, WorkspaceBrokerError> {
        let path = self.artifact_path(attempt_id, name);
        let bytes = self
            .persistence
            .read(&path)
            .await?
            .ok_or(WorkspaceBrokerError::IntegrationRecoveryRequired)?;
        if sha256_hex(&bytes) != sha256 {
            return Err(WorkspaceBrokerError::IntegrationRecoveryRequired);
        }
        let artifact_id = match persisted_id {
            Some(value) => ArtifactId::parse(value.to_string()),
            None => ArtifactId::parse(format!(
                "workspace-{}",
                sha256_hex(format!("{attempt_id}:{name}:{sha256}").as_bytes())
            )),
        }
        .map_err(|_| WorkspaceBrokerError::LeaseMismatch)?;
        let (preview, preview_truncated) =
            std::str::from_utf8(&bytes).map_or((None, false), |text| {
                let mut end = text.len().min(max_preview_bytes);
                while !text.is_char_boundary(end) {
                    end = end.saturating_sub(1);
                }
                (Some(text[..end].to_string()), end < text.len())
            });
        Ok(WorkspaceArtifact {
            artifact_id,
            name: name.to_string(),
            kind: kind.to_string(),
            path,
            sha256: sha256.to_string(),
            size_bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            preview,
            preview_truncated,
        })
    }

    async fn append_edit_provenance(
        &self,
        provenance: &WorkspaceEditProvenance,
        path: &Path,
        preimage_sha256: Option<String>,
        postimage_sha256: &str,
    ) -> Result<(), WorkspaceBrokerError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct EditRecord<'a> {
            root_run_id: String,
            agent_id: String,
            attempt_id: String,
            task_id: String,
            tool_call_id: &'a str,
            path: &'a Path,
            preimage_sha256: Option<String>,
            postimage_sha256: &'a str,
        }
        let record = EditRecord {
            root_run_id: provenance.root_run_id.to_string(),
            agent_id: provenance.agent_id.to_string(),
            attempt_id: provenance.attempt_id.to_string(),
            task_id: provenance.task_id.to_string(),
            tool_call_id: &provenance.tool_call_id,
            path,
            preimage_sha256,
            postimage_sha256,
        };
        let mut bytes = serde_json::to_vec(&record).map_err(WorkspaceBrokerError::Serialize)?;
        bytes.push(b'\n');
        self.persistence
            .append(&self.runtime_root.join("edit-provenance.jsonl"), &bytes)
            .await?;
        Ok(())
    }

    async fn load_manifest(
        &self,
        attempt_id: &AgentAttemptId,
    ) -> Result<Option<WorkspaceLeaseManifest>, WorkspaceBrokerError> {
        self.persistence
            .read(&self.manifest_path(attempt_id))
            .await?
            .map(|bytes| {
                serde_json::from_slice(&bytes).map_err(WorkspaceBrokerError::InvalidManifest)
            })
            .transpose()
    }

    async fn save_manifest(
        &self,
        attempt_id: &AgentAttemptId,
        manifest: &WorkspaceLeaseManifest,
    ) -> Result<(), WorkspaceBrokerError> {
        let bytes = serde_json::to_vec_pretty(manifest).map_err(WorkspaceBrokerError::Serialize)?;
        self.persistence
            .replace(&self.manifest_path(attempt_id), &bytes)
            .await?;
        Ok(())
    }

    fn manifest_path(&self, attempt_id: &AgentAttemptId) -> PathBuf {
        self.runtime_root
            .join("leases")
            .join(format!("{}.json", lease_key(attempt_id)))
    }

    fn artifact_path(&self, attempt_id: &AgentAttemptId, name: &str) -> PathBuf {
        self.runtime_root
            .join("artifacts")
            .join(lease_key(attempt_id))
            .join(name)
    }

    async fn git_text<const N: usize>(
        &self,
        directory: &Path,
        arguments: [&str; N],
        cancellation: CancellationToken,
    ) -> Result<String, WorkspaceBrokerError> {
        let output = self
            .run_git(
                directory,
                arguments.into_iter().map(OsString::from).collect(),
                cancellation,
            )
            .await?;
        String::from_utf8(output).map_err(|error| {
            AppError::external("Git output was not UTF-8", error.to_string(), false).into()
        })
    }

    async fn git_bytes<const N: usize>(
        &self,
        directory: &Path,
        arguments: [&str; N],
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, WorkspaceBrokerError> {
        self.run_git(
            directory,
            arguments.into_iter().map(OsString::from).collect(),
            cancellation,
        )
        .await
    }

    async fn run_git(
        &self,
        directory: &Path,
        arguments: Vec<OsString>,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, WorkspaceBrokerError> {
        let output = self
            .runner
            .run(
                ProcessRequest {
                    program: self.git_program.clone(),
                    arguments,
                    current_directory: directory.to_path_buf(),
                    environment: self.git_environment.clone(),
                    timeout: GIT_TIMEOUT,
                    max_output_bytes: MAX_GIT_OUTPUT_BYTES,
                },
                cancellation,
            )
            .await?;
        Ok(output.stdout)
    }

    async fn remove_worktree(
        &self,
        source_root: &Path,
        worktree_root: &Path,
        cancellation: CancellationToken,
    ) -> Result<(), WorkspaceBrokerError> {
        self.run_git(
            source_root,
            vec![
                "worktree".into(),
                "remove".into(),
                "--force".into(),
                worktree_root.as_os_str().to_owned(),
            ],
            cancellation,
        )
        .await
        .map(|_| ())
    }
}

fn prepared_from_manifest(manifest: WorkspaceLeaseManifest) -> PreparedWorkspace {
    PreparedWorkspace {
        assignment: WorkspaceAssignment {
            mode: WorkspaceMode::IsolatedWorktree,
            root: manifest.worktree_root.to_string_lossy().into_owned(),
            read_scope: manifest.read_scope.clone(),
            write_scope: manifest.write_scope.clone(),
            baseline_revision: Some(manifest.baseline_revision.clone()),
            baseline_manifest: Some(manifest.baseline_manifest_sha256.clone()),
            integration_policy: "serial_three_way".to_string(),
        },
        manifest,
    }
}

fn validate_manifest_request(
    manifest: &WorkspaceLeaseManifest,
    request: &PrepareWorkspaceRequest,
) -> Result<(), WorkspaceBrokerError> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.root_run_id != request.root_run_id.as_str()
        || manifest.agent_id != request.agent_id.as_str()
        || manifest.attempt_id != request.attempt_id.as_str()
        || manifest.task_id != request.task_id.as_str()
        || manifest.read_scope != request.read_scope
        || manifest.write_scope != request.write_scope
    {
        return Err(WorkspaceBrokerError::LeaseMismatch);
    }
    Ok(())
}

fn compile_scopes(scopes: &[String]) -> Result<GlobSet, WorkspaceBrokerError> {
    let mut builder = GlobSetBuilder::new();
    for scope in scopes {
        if scope.trim().is_empty() || Path::new(scope).is_absolute() {
            return Err(WorkspaceBrokerError::InvalidScope(scope.clone()));
        }
        let glob = GlobBuilder::new(&scope.replace('\\', "/"))
            .literal_separator(true)
            .case_insensitive(cfg!(windows))
            .build()
            .map_err(|_| WorkspaceBrokerError::InvalidScope(scope.clone()))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|error| WorkspaceBrokerError::InvalidScope(error.to_string()))
}

async fn canonical_directory(path: &Path) -> Result<PathBuf, WorkspaceBrokerError> {
    let canonical = dunce::canonicalize(path).map_err(|error| {
        AppError::storage(
            "Agent workspace directory could not be resolved",
            format!("canonicalize {}: {error}", path.display()),
            false,
        )
    })?;
    if !tokio::fs::metadata(&canonical)
        .await
        .map_err(storage_io)?
        .is_dir()
    {
        return Err(WorkspaceBrokerError::OutsideRoot);
    }
    Ok(canonical)
}

async fn resolve_beneath(root: &Path, requested: &Path) -> Result<PathBuf, WorkspaceBrokerError> {
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        if requested
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
        {
            return Err(WorkspaceBrokerError::OutsideRoot);
        }
        root.join(requested)
    };
    let resolved = if tokio::fs::try_exists(&candidate)
        .await
        .map_err(storage_io)?
    {
        dunce::canonicalize(&candidate).map_err(storage_io)?
    } else {
        let mut existing = candidate.as_path();
        let mut suffix = Vec::new();
        while !tokio::fs::try_exists(existing).await.map_err(storage_io)? {
            let name = existing
                .file_name()
                .ok_or(WorkspaceBrokerError::OutsideRoot)?
                .to_os_string();
            suffix.push(name);
            existing = existing.parent().ok_or(WorkspaceBrokerError::OutsideRoot)?;
        }
        let mut resolved = dunce::canonicalize(existing).map_err(storage_io)?;
        for component in suffix.into_iter().rev() {
            resolved.push(component);
        }
        resolved
    };
    if !path_within(root, &resolved) {
        return Err(WorkspaceBrokerError::OutsideRoot);
    }
    Ok(resolved)
}

fn relative_path(root: &Path, path: &Path) -> Result<PathBuf, WorkspaceBrokerError> {
    if !path_within(root, path) {
        return Err(WorkspaceBrokerError::OutsideRoot);
    }
    Ok(path.components().skip(root.components().count()).collect())
}

fn path_within(root: &Path, path: &Path) -> bool {
    let root_components = root
        .components()
        .map(normalized_component)
        .collect::<Vec<_>>();
    let path_components = path
        .components()
        .map(normalized_component)
        .collect::<Vec<_>>();
    path_components.starts_with(&root_components)
}

fn same_path(left: &Path, right: &Path) -> bool {
    path_within(left, right) && path_within(right, left)
}

fn recovery_path_key(path: &Path) -> String {
    path.components()
        .map(normalized_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn normalized_component(component: Component<'_>) -> String {
    let value = component.as_os_str().to_string_lossy();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.into_owned()
    }
}

fn nul_paths(bytes: &[u8]) -> Result<Vec<String>, WorkspaceBrokerError> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| {
            std::str::from_utf8(value)
                .map(|path| path.replace('\\', "/"))
                .map_err(|_| WorkspaceBrokerError::NonUtf8Path)
        })
        .collect()
}

fn porcelain_changes(bytes: &[u8]) -> Result<Vec<WorkspaceChangedFile>, WorkspaceBrokerError> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 || field[2] != b' ' {
            return Err(AppError::storage(
                "Git returned invalid Agent workspace status",
                "porcelain status entry is malformed",
                false,
            )
            .into());
        }
        let status = &field[..2];
        let path = std::str::from_utf8(&field[3..])
            .map_err(|_| WorkspaceBrokerError::NonUtf8Path)?
            .replace('\\', "/");
        let renamed = status.contains(&b'R') || status.contains(&b'C');
        let kind = if status == b"??" || status.contains(&b'A') {
            "created"
        } else if status.contains(&b'D') {
            "deleted"
        } else {
            "modified"
        };
        changes.push(WorkspaceChangedFile {
            path,
            kind: kind.to_string(),
        });
        if renamed {
            let _ = fields.next();
        }
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

fn lease_key(attempt_id: &AgentAttemptId) -> String {
    sha256_hex(attempt_id.as_str().as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn storage_io(error: std::io::Error) -> WorkspaceBrokerError {
    AppError::storage("Agent workspace I/O failed", error.to_string(), false).into()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use codez_core::{AgentAttemptId, AgentId, AtomicPersistence, RootRunId, TaskId};
    use codez_storage::AtomicFileStore;

    use super::{WorkspaceAccess, WorkspaceBroker, WorkspaceBrokerError, WorkspaceEditProvenance};

    #[test]
    fn porcelain_status_should_project_authoritative_change_kinds() {
        let changes =
            super::porcelain_changes(b" M src/lib.rs\0?? src/new.rs\0 D src/removed.rs\0")
                .expect("porcelain status must parse");

        assert_eq!(
            changes
                .into_iter()
                .map(|change| (change.path, change.kind))
                .collect::<Vec<_>>(),
            [
                ("src/lib.rs".to_string(), "modified".to_string()),
                ("src/new.rs".to_string(), "created".to_string()),
                ("src/removed.rs".to_string(), "deleted".to_string()),
            ]
        );
    }

    #[test]
    fn scope_globs_should_follow_the_platform_path_case_rules() {
        let scopes =
            super::compile_scopes(&["SRC/**".to_string()]).expect("fixture scope must compile");

        assert_eq!(scopes.is_match("src/lib.rs"), cfg!(windows));
        assert!(scopes.is_match("SRC/lib.rs"));
    }

    #[tokio::test]
    async fn full_read_scope_should_authorize_the_workspace_root() {
        let workspace = tempfile::tempdir().expect("temporary workspace must exist");

        let authorized = WorkspaceBroker::authorize_assignment_path(
            &assignment(workspace.path()),
            Path::new("."),
            WorkspaceAccess::Read,
        )
        .await
        .expect("a full read scope must include the assigned root");

        assert_eq!(
            authorized,
            dunce::canonicalize(workspace.path()).expect("workspace must canonicalize")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scope_should_reject_a_symlink_that_resolves_outside_the_workspace() {
        let workspace = tempfile::tempdir().expect("temporary workspace must exist");
        let outside = tempfile::tempdir().expect("temporary outside directory must exist");
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape"))
            .expect("fixture symlink must be created");

        let error = WorkspaceBroker::authorize_assignment_path(
            &assignment(workspace.path()),
            Path::new("escape/file.rs"),
            WorkspaceAccess::Read,
        )
        .await
        .expect_err("an out-of-workspace symlink must be rejected");

        assert!(matches!(error, WorkspaceBrokerError::OutsideRoot));
    }

    #[tokio::test]
    async fn scoped_cas_should_reject_a_second_stale_writer() {
        let directory = tempfile::tempdir().expect("temporary workspace must exist");
        let runtime = tempfile::tempdir().expect("temporary runtime must exist");
        let target = directory.path().join("src").join("lib.rs");
        tokio::fs::create_dir_all(target.parent().expect("target has a parent"))
            .await
            .expect("source directory must exist");
        tokio::fs::write(&target, b"before")
            .await
            .expect("fixture file must exist");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let broker = WorkspaceBroker::new(
            runtime.path(),
            PathBuf::from("C:/unused/git.exe"),
            BTreeMap::new(),
            Arc::new(PanicProcessRunner),
            persistence,
        );
        let assignment = assignment(directory.path());
        let provenance = provenance();
        let before = super::sha256_hex(b"before");
        broker
            .compare_and_swap_write(
                &assignment,
                Path::new("src/lib.rs"),
                Some(&before),
                b"first",
                &provenance,
            )
            .await
            .expect("first writer must succeed");

        let error = broker
            .compare_and_swap_write(
                &assignment,
                Path::new("src/lib.rs"),
                Some(&before),
                b"second",
                &provenance,
            )
            .await
            .expect_err("stale writer must be rejected");

        assert!(matches!(
            error,
            WorkspaceBrokerError::PreimageConflict { .. }
        ));
    }

    #[tokio::test]
    async fn scope_should_reject_parent_traversal_before_file_creation() {
        let directory = tempfile::tempdir().expect("temporary workspace must exist");
        let runtime = tempfile::tempdir().expect("temporary runtime must exist");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let broker = WorkspaceBroker::new(
            runtime.path(),
            PathBuf::from("C:/unused/git.exe"),
            BTreeMap::new(),
            Arc::new(PanicProcessRunner),
            persistence,
        );

        let error = broker
            .authorize_path(
                &assignment(directory.path()),
                Path::new("../outside.rs"),
                WorkspaceAccess::Write,
            )
            .await
            .expect_err("parent traversal must be denied");

        assert!(matches!(error, WorkspaceBrokerError::OutsideRoot));
    }

    #[tokio::test]
    async fn isolated_worktree_should_integrate_through_a_temporary_merge_workspace() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let request = fixture.prepare_request("attempt-integrate");
        let prepared = broker
            .prepare_isolated_worktree(request, codez_core::CancellationToken::new())
            .await
            .expect("clean repository must create an isolated worktree");
        tokio::fs::write(
            Path::new(&prepared.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 2 }\n",
        )
        .await
        .expect("child change must be written");

        let outcome = broker
            .integrate(
                &AgentAttemptId::parse("attempt-integrate").expect("attempt ID must parse"),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("non-conflicting child patch must integrate");

        assert!(outcome.applied);
        assert_eq!(
            std::fs::read_to_string(fixture.root.path().join("src/lib.rs"))
                .expect("integrated file must be readable"),
            "pub fn value() -> u8 { 2 }\n"
        );
    }

    #[tokio::test]
    async fn workspace_changes_should_persist_an_authoritative_child_patch() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let attempt_id = AgentAttemptId::parse("attempt-changes").expect("attempt ID must parse");
        let prepared = broker
            .prepare_isolated_worktree(
                fixture.prepare_request(attempt_id.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("clean repository must create an isolated worktree");
        tokio::fs::write(
            Path::new(&prepared.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 2 }\n",
        )
        .await
        .expect("child change must be written");

        let changes = broker
            .workspace_changes(&attempt_id, codez_core::CancellationToken::new())
            .await
            .expect("workspace changes must scan");
        let artifacts = broker
            .artifacts(&attempt_id, 1024)
            .await
            .expect("child patch artifact must load");

        assert_eq!(
            (
                changes
                    .into_iter()
                    .map(|change| (change.path, change.kind))
                    .collect::<Vec<_>>(),
                artifacts[0].kind.as_str(),
                artifacts[0]
                    .preview
                    .as_deref()
                    .is_some_and(|preview| preview.contains("+pub fn value() -> u8 { 2 }")),
            ),
            (
                vec![("src/lib.rs".to_string(), "modified".to_string())],
                "child_patch",
                true,
            )
        );
    }

    #[tokio::test]
    async fn integration_batch_should_apply_independent_child_patches_once() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let frontend = AgentAttemptId::parse("attempt-frontend").expect("attempt ID must parse");
        let backend = AgentAttemptId::parse("attempt-backend").expect("attempt ID must parse");
        let frontend_workspace = broker
            .prepare_isolated_worktree(
                fixture.prepare_request(frontend.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("frontend worktree must be created");
        let backend_workspace = broker
            .prepare_isolated_worktree(
                fixture.prepare_request(backend.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("backend worktree must be created");
        tokio::fs::write(
            Path::new(&frontend_workspace.assignment.root).join("src/frontend.rs"),
            b"pub fn frontend() {}\n",
        )
        .await
        .expect("frontend change must be written");
        tokio::fs::write(
            Path::new(&backend_workspace.assignment.root).join("src/backend.rs"),
            b"pub fn backend() {}\n",
        )
        .await
        .expect("backend change must be written");

        let outcome = broker
            .integrate_batch(&[frontend, backend], codez_core::CancellationToken::new())
            .await
            .expect("independent child patches must integrate as one batch");

        assert_eq!(
            (
                outcome.applied,
                std::fs::read_to_string(fixture.root.path().join("src/frontend.rs"))
                    .expect("integrated frontend file must be readable"),
                std::fs::read_to_string(fixture.root.path().join("src/backend.rs"))
                    .expect("integrated backend file must be readable"),
            ),
            (
                true,
                "pub fn frontend() {}\n".to_string(),
                "pub fn backend() {}\n".to_string(),
            )
        );
    }

    #[tokio::test]
    async fn conflicting_integration_batch_should_not_modify_the_source_workspace() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let first = AgentAttemptId::parse("attempt-conflict-a").expect("attempt ID must parse");
        let second = AgentAttemptId::parse("attempt-conflict-b").expect("attempt ID must parse");
        let first_workspace = broker
            .prepare_isolated_worktree(
                fixture.prepare_request(first.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("first worktree must be created");
        let second_workspace = broker
            .prepare_isolated_worktree(
                fixture.prepare_request(second.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("second worktree must be created");
        tokio::fs::write(
            Path::new(&first_workspace.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 2 }\n",
        )
        .await
        .expect("first conflicting change must be written");
        tokio::fs::write(
            Path::new(&second_workspace.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 3 }\n",
        )
        .await
        .expect("second conflicting change must be written");

        let result = broker
            .integrate_batch(&[first, second], codez_core::CancellationToken::new())
            .await;

        assert_eq!(
            (
                result.is_err(),
                std::fs::read_to_string(fixture.root.path().join("src/lib.rs"))
                    .expect("source file must remain readable"),
            ),
            (true, "pub fn value() -> u8 { 1 }\n".to_string())
        );
    }

    #[tokio::test]
    async fn frozen_review_should_materialize_an_immutable_patch_snapshot() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let attempt_id = AgentAttemptId::parse("attempt-review").expect("attempt ID must parse");
        let prepared = broker
            .prepare_isolated_worktree(
                fixture.prepare_request(attempt_id.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("clean repository must create an isolated worktree");
        tokio::fs::write(
            Path::new(&prepared.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 2 }\n",
        )
        .await
        .expect("child change must be written");

        let frozen = broker
            .freeze_review(&attempt_id, codez_core::CancellationToken::new())
            .await
            .expect("terminal child patch must freeze for review");
        tokio::fs::write(
            Path::new(&prepared.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 3 }\n",
        )
        .await
        .expect("source child worktree may move after the frozen copy");

        assert_eq!(
            std::fs::read_to_string(frozen.snapshot_root.join("src/lib.rs"))
                .expect("review snapshot must be readable"),
            "pub fn value() -> u8 { 2 }\n"
        );
    }

    #[tokio::test]
    async fn integration_should_reject_a_child_patch_changed_after_review_freeze() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let attempt_id =
            AgentAttemptId::parse("attempt-review-moved").expect("attempt ID must parse");
        let prepared = broker
            .prepare_isolated_worktree(
                fixture.prepare_request(attempt_id.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("clean repository must create an isolated worktree");
        tokio::fs::write(
            Path::new(&prepared.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 2 }\n",
        )
        .await
        .expect("child change must be written");
        broker
            .freeze_review(&attempt_id, codez_core::CancellationToken::new())
            .await
            .expect("child patch must freeze for review");
        tokio::fs::write(
            Path::new(&prepared.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 3 }\n",
        )
        .await
        .expect("child target must move for the conflict fixture");

        let error = broker
            .integrate(&attempt_id, codez_core::CancellationToken::new())
            .await
            .expect_err("integration must reject a moved review target");

        assert!(matches!(error, WorkspaceBrokerError::ReviewTargetChanged));
    }

    #[tokio::test]
    async fn recovery_scan_should_require_manual_inspection_for_integrating_manifest() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let attempt_id = AgentAttemptId::parse("attempt-recovery").expect("attempt ID must parse");
        broker
            .prepare_isolated_worktree(
                fixture.prepare_request(attempt_id.as_str()),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect("clean repository must create an isolated worktree");
        let mut manifest = broker
            .load_manifest(&attempt_id)
            .await
            .expect("workspace manifest must load")
            .expect("workspace manifest must exist");
        manifest.status = "integrating".to_string();
        broker
            .save_manifest(&attempt_id, &manifest)
            .await
            .expect("integrating fixture must persist");

        let records = broker
            .scan_recovery()
            .await
            .expect("recovery records must scan");

        assert_eq!(
            records[0].disposition,
            super::WorkspaceRecoveryDisposition::ManualIntervention
        );
    }

    #[tokio::test]
    async fn conflicting_integration_should_leave_the_source_workspace_unchanged() {
        let fixture = GitFixture::new();
        let broker = fixture.broker();
        let request = fixture.prepare_request("attempt-conflict");
        let prepared = broker
            .prepare_isolated_worktree(request, codez_core::CancellationToken::new())
            .await
            .expect("clean repository must create an isolated worktree");
        tokio::fs::write(
            Path::new(&prepared.assignment.root).join("src/lib.rs"),
            b"pub fn value() -> u8 { 2 }\n",
        )
        .await
        .expect("child change must be written");
        std::fs::write(
            fixture.root.path().join("src/lib.rs"),
            "pub fn value() -> u8 { 3 }\n",
        )
        .expect("main change must be written");
        fixture.git(["add", "src/lib.rs"]);
        fixture.git(["commit", "-m", "move main"]);

        broker
            .integrate(
                &AgentAttemptId::parse("attempt-conflict").expect("attempt ID must parse"),
                codez_core::CancellationToken::new(),
            )
            .await
            .expect_err("conflicting patch must not integrate");

        assert_eq!(
            std::fs::read_to_string(fixture.root.path().join("src/lib.rs"))
                .expect("source file must remain readable"),
            "pub fn value() -> u8 { 3 }\n"
        );
    }

    fn assignment(root: &Path) -> codez_core::agent::WorkspaceAssignment {
        codez_core::agent::WorkspaceAssignment {
            mode: codez_core::agent::WorkspaceMode::IsolatedWorktree,
            root: root.to_string_lossy().into_owned(),
            read_scope: vec!["**/*".to_string()],
            write_scope: vec!["src/**".to_string()],
            baseline_revision: Some("baseline".to_string()),
            baseline_manifest: Some("manifest".to_string()),
            integration_policy: "serial_three_way".to_string(),
        }
    }

    fn provenance() -> WorkspaceEditProvenance {
        WorkspaceEditProvenance {
            root_run_id: RootRunId::parse("root-1").expect("root ID must parse"),
            agent_id: AgentId::parse("agent-1").expect("Agent ID must parse"),
            attempt_id: AgentAttemptId::parse("attempt-1").expect("attempt ID must parse"),
            task_id: TaskId::parse("task-1").expect("task ID must parse"),
            tool_call_id: "call-1".to_string(),
        }
    }

    struct PanicProcessRunner;

    impl codez_core::ProcessRunner for PanicProcessRunner {
        fn run<'a>(
            &'a self,
            _request: codez_core::ProcessRequest,
            _cancellation: codez_core::CancellationToken,
        ) -> codez_core::PortFuture<'a, codez_core::ProcessOutput> {
            Box::pin(async { panic!("scope and CAS tests must not invoke Git") })
        }
    }

    struct GitFixture {
        root: tempfile::TempDir,
        runtime: tempfile::TempDir,
        git_program: PathBuf,
        environment: BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    }

    impl GitFixture {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("temporary Git repository must exist");
            let runtime = tempfile::tempdir().expect("temporary runtime must exist");
            let (git_program, environment) = codez_platform::GitInstallation::discover()
                .expect("Git must be available for repository tests")
                .into_parts();
            let fixture = Self {
                root,
                runtime,
                git_program,
                environment,
            };
            fixture.git(["init"]);
            fixture.git(["config", "user.name", "CodeZ Test"]);
            fixture.git(["config", "user.email", "codez-test@example.invalid"]);
            fixture.git(["config", "core.autocrlf", "false"]);
            std::fs::create_dir_all(fixture.root.path().join("src"))
                .expect("source directory must exist");
            std::fs::write(
                fixture.root.path().join("src/lib.rs"),
                "pub fn value() -> u8 { 1 }\n",
            )
            .expect("initial source file must exist");
            fixture.git(["add", "src/lib.rs"]);
            fixture.git(["commit", "-m", "baseline"]);
            fixture
        }

        fn broker(&self) -> WorkspaceBroker {
            let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
            WorkspaceBroker::new(
                self.runtime.path(),
                self.git_program.clone(),
                self.environment.clone(),
                Arc::new(codez_platform::NativeProcessRunner::new()),
                persistence,
            )
        }

        fn prepare_request(&self, attempt: &str) -> super::PrepareWorkspaceRequest {
            super::PrepareWorkspaceRequest {
                root_run_id: RootRunId::parse("root-git").expect("root ID must parse"),
                agent_id: AgentId::parse(format!("agent-{attempt}")).expect("Agent ID must parse"),
                attempt_id: AgentAttemptId::parse(attempt).expect("attempt ID must parse"),
                task_id: TaskId::parse(format!("task-{attempt}")).expect("task ID must parse"),
                source_root: self.root.path().to_path_buf(),
                read_scope: vec!["**/*".to_string()],
                write_scope: vec!["src/**".to_string()],
            }
        }

        fn git<const N: usize>(&self, arguments: [&str; N]) {
            let output = std::process::Command::new(&self.git_program)
                .args(arguments)
                .current_dir(self.root.path())
                .env_clear()
                .envs(self.environment.clone())
                .output()
                .expect("Git test command must start");
            assert!(
                output.status.success(),
                "Git test command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
