use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use codez_core::{
    AppError, AppPaths, AtomicPersistence, CancellationToken, DirectoryListing, FileKind,
    FileMetadata, FileSystem, PortFuture, SafeWorkspacePath, WorkspaceRoot,
};
use codez_runtime::permission::audit::PermissionAuditLog;
use codez_runtime::permission::contract::{
    PermissionAction, PermissionApprovalScope, PermissionCapability,
};
use codez_runtime::permission::decision::PermissionMode;
use codez_runtime::permission::service::{
    PermissionApprovalHandler, PermissionApprovalRequest, PermissionApprovalResponse,
    PermissionService,
};
use codez_runtime::permission::store::{
    PermissionRuleStore, RememberPermissionRuleInput, WorkspacePermissionStore,
    normalize_workspace_key,
};
use codez_runtime::tools::authorization::AuthorizationBinding;
use codez_runtime::tools::builtin::bash::BashTool;
use codez_runtime::tools::builtin::edit::EditTool;
use codez_runtime::tools::builtin::notebook_edit::NotebookEditTool;
use codez_runtime::tools::builtin::read::ReadTool;
use codez_runtime::tools::builtin::write::WriteTool;
use codez_runtime::tools::exposure::ToolCatalogSnapshot;
use codez_runtime::tools::journal::{ToolExecutionJournal, ToolJournalIdentity};
use codez_runtime::tools::large_result::LargeToolResultStore;
use codez_runtime::tools::pipeline::{
    ToolAuthorizationDecision, ToolExecutionPipeline, ToolExecutionPipelineContext,
};
use codez_runtime::tools::processor::ToolResultProcessor;
use codez_runtime::tools::registry::{ToolFileServices, ToolHandler};
use codez_runtime::tools::scheduler::ToolScheduler;
use codez_runtime::tools::types::{
    AgentRole, NormalizedToolCall, PreparedToolCall, ToolExecutionError, ToolExecutionResult,
};
use codez_runtime::tools::validation::ToolInputValidator;
use codez_runtime::{
    edit_transaction::EditTransactionService, fingerprint::ReadFingerprintStore,
    mutation_coordinator::FileMutationCoordinator,
};
use tempfile::TempDir;

mod support;

use support::MemoryAtomicPersistence;

struct StaticApproval {
    approved: bool,
    scope: PermissionApprovalScope,
}

#[async_trait]
impl PermissionApprovalHandler for StaticApproval {
    async fn request(
        &self,
        _request: &PermissionApprovalRequest,
    ) -> Result<PermissionApprovalResponse, Box<dyn std::error::Error + Send + Sync>> {
        Ok(PermissionApprovalResponse {
            approved: self.approved,
            scope: self.scope.clone(),
        })
    }
}

struct TestContext {
    catalog: ToolCatalogSnapshot,
    workspace_root: PathBuf,
    permission: PermissionService,
    approval: Option<Arc<dyn PermissionApprovalHandler>>,
    cancellation: CancellationToken,
    receipt_ttl: Option<Duration>,
    file_services: ToolFileServices,
    transaction_id: String,
}

#[derive(Clone)]
struct TestFileSystem {
    root: WorkspaceRoot,
}

impl FileSystem for TestFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        &self.root
    }

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        let candidate = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            self.root.as_path().join(requested)
        };
        Box::pin(async move {
            SafeWorkspacePath::from_canonical(&self.root, &candidate)
                .map_err(|error| AppError::permission_denied(error.to_string()))
        })
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        let absolute = path.absolute_path();
        Box::pin(async move {
            let metadata =
                tokio::fs::symlink_metadata(&absolute)
                    .await
                    .map_err(|error| match error.kind() {
                        std::io::ErrorKind::NotFound => AppError::not_found("test file not found"),
                        _ => AppError::storage("test metadata failed", error.to_string(), false),
                    })?;
            let kind = if metadata.is_file() {
                FileKind::File
            } else if metadata.is_dir() {
                FileKind::Directory
            } else if metadata.file_type().is_symlink() {
                FileKind::SymbolicLink
            } else {
                FileKind::Other
            };
            Ok(FileMetadata {
                kind,
                byte_length: metadata.len(),
            })
        })
    }

    fn read_directory<'a>(
        &'a self,
        _path: &'a SafeWorkspacePath,
        _max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        Box::pin(async { Err(AppError::unsupported("unused test directory read")) })
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        let absolute = path.absolute_path();
        Box::pin(async move {
            let bytes = tokio::fs::read(&absolute)
                .await
                .map_err(|error| AppError::storage("test read failed", error.to_string(), false))?;
            if bytes.len() as u64 > max_bytes {
                return Err(AppError::validation("test read exceeded its bound"));
            }
            Ok(bytes)
        })
    }

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        let absolute = path.absolute_path();
        let bytes = bytes.to_vec();
        Box::pin(async move {
            if let Some(parent) = absolute.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|error| {
                    AppError::storage("test parent creation failed", error.to_string(), false)
                })?;
            }
            tokio::fs::write(&absolute, bytes)
                .await
                .map_err(|error| AppError::storage("test write failed", error.to_string(), false))
        })
    }
}

#[derive(Clone)]
struct ErrorAfterWriteFileSystem {
    inner: TestFileSystem,
}

#[derive(Clone)]
struct RedirectingFileSystem {
    inner: TestFileSystem,
    redirected_relative_path: PathBuf,
}

#[derive(Clone)]
struct ReadOnlyFileSystem {
    inner: TestFileSystem,
}

#[derive(Clone)]
struct MutatingOnThirdReadFileSystem {
    inner: TestFileSystem,
    target: PathBuf,
    replacement: Vec<u8>,
    reads: Arc<std::sync::atomic::AtomicUsize>,
}

#[derive(Clone)]
enum NthReadAction {
    Cancel(CancellationToken),
    Fail,
}

#[derive(Clone)]
struct NthReadFileSystem {
    inner: TestFileSystem,
    reads: Arc<std::sync::atomic::AtomicUsize>,
    action_on: usize,
    action: NthReadAction,
}

#[derive(Clone)]
enum NthResolveAction {
    Fail,
    Redirect(PathBuf),
}

#[derive(Clone)]
struct NthResolveFileSystem {
    inner: TestFileSystem,
    resolves: Arc<std::sync::atomic::AtomicUsize>,
    action_on: usize,
    action: NthResolveAction,
}

impl FileSystem for NthReadFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        self.inner.workspace_root()
    }

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        self.inner.resolve(requested)
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        self.inner.metadata(path)
    }

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        self.inner.read_directory(path, max_entries)
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        let inner = self.inner.clone();
        let reads = Arc::clone(&self.reads);
        let action_on = self.action_on;
        let action = self.action.clone();
        let path = path.clone();
        Box::pin(async move {
            let read_number = reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if read_number == action_on && matches!(&action, NthReadAction::Fail) {
                return Err(AppError::storage(
                    "injected mutation read failure",
                    "test fault before workspace commit",
                    false,
                ));
            }
            let bytes = inner.read_bounded(&path, max_bytes).await?;
            if read_number == action_on {
                if let NthReadAction::Cancel(cancellation) = action {
                    cancellation.cancel();
                }
            }
            Ok(bytes)
        })
    }

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        self.inner.write_atomic(path, bytes)
    }
}

impl FileSystem for NthResolveFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        self.inner.workspace_root()
    }

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        let resolve_number = self
            .resolves
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if resolve_number != self.action_on {
            return self.inner.resolve(requested);
        }
        match &self.action {
            NthResolveAction::Fail => Box::pin(async {
                Err(AppError::storage(
                    "injected mutation resolve failure",
                    "test fault before workspace commit",
                    false,
                ))
            }),
            NthResolveAction::Redirect(path) => {
                let root = self.inner.root.clone();
                let path = path.clone();
                Box::pin(async move {
                    SafeWorkspacePath::from_relative(&root, &path)
                        .map_err(|error| AppError::permission_denied(error.to_string()))
                })
            }
        }
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        self.inner.metadata(path)
    }

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        self.inner.read_directory(path, max_entries)
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        self.inner.read_bounded(path, max_bytes)
    }

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        self.inner.write_atomic(path, bytes)
    }
}

impl FileSystem for RedirectingFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        self.inner.workspace_root()
    }

    fn resolve<'a>(&'a self, _requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        Box::pin(async move {
            SafeWorkspacePath::from_relative(&self.inner.root, &self.redirected_relative_path)
                .map_err(|error| AppError::permission_denied(error.to_string()))
        })
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        self.inner.metadata(path)
    }

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        self.inner.read_directory(path, max_entries)
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        self.inner.read_bounded(path, max_bytes)
    }

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        self.inner.write_atomic(path, bytes)
    }
}

impl FileSystem for ErrorAfterWriteFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        self.inner.workspace_root()
    }

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        self.inner.resolve(requested)
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        self.inner.metadata(path)
    }

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        self.inner.read_directory(path, max_entries)
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        self.inner.read_bounded(path, max_bytes)
    }

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        let absolute = path.absolute_path();
        let bytes = bytes.to_vec();
        Box::pin(async move {
            tokio::fs::write(&absolute, bytes).await.map_err(|error| {
                AppError::storage("test write failed", error.to_string(), false)
            })?;
            Err(AppError::storage(
                "injected error after content replacement",
                "test fault after write",
                false,
            ))
        })
    }
}

impl FileSystem for ReadOnlyFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        self.inner.workspace_root()
    }

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        self.inner.resolve(requested)
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        self.inner.metadata(path)
    }

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        self.inner.read_directory(path, max_entries)
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        self.inner.read_bounded(path, max_bytes)
    }

    fn write_atomic<'a>(
        &'a self,
        _path: &'a SafeWorkspacePath,
        _bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        Box::pin(async { Err(AppError::permission_denied("test filesystem is read-only")) })
    }
}

impl FileSystem for MutatingOnThirdReadFileSystem {
    fn workspace_root(&self) -> &WorkspaceRoot {
        self.inner.workspace_root()
    }

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath> {
        self.inner.resolve(requested)
    }

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata> {
        self.inner.metadata(path)
    }

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing> {
        self.inner.read_directory(path, max_entries)
    }

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>> {
        let inner = self.inner.clone();
        let target = self.target.clone();
        let replacement = self.replacement.clone();
        let reads = Arc::clone(&self.reads);
        let path = path.clone();
        Box::pin(async move {
            let read_number = reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if read_number == 3 {
                tokio::fs::write(target, replacement)
                    .await
                    .map_err(|error| {
                        AppError::storage("test external write failed", error.to_string(), false)
                    })?;
            }
            inner.read_bounded(&path, max_bytes).await
        })
    }

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()> {
        self.inner.write_atomic(path, bytes)
    }
}

#[async_trait]
impl ToolExecutionPipelineContext for TestContext {
    fn catalog(&self) -> &ToolCatalogSnapshot {
        &self.catalog
    }

    fn exposure(&self) -> Option<&codez_runtime::tools::exposure::ToolExposurePlan> {
        None
    }

    fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    fn session_id(&self) -> Option<&str> {
        Some("session-1")
    }

    fn transaction_id(&self) -> Option<&str> {
        Some(&self.transaction_id)
    }

    fn file_services(&self) -> Option<ToolFileServices> {
        Some(self.file_services.clone())
    }

    fn agent_role(&self) -> &AgentRole {
        static ROLE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "main".to_string());
        &ROLE
    }

    fn journal_identity(&self) -> Option<ToolJournalIdentity> {
        Some(ToolJournalIdentity {
            session_id: Some("session-1".to_string()),
            ..ToolJournalIdentity::default()
        })
    }

    fn cancellation_token(&self, _call: &NormalizedToolCall) -> CancellationToken {
        self.cancellation.clone()
    }

    async fn authorize(
        &self,
        prepared: &PreparedToolCall,
        _binding: &AuthorizationBinding,
    ) -> ToolAuthorizationDecision {
        match self
            .permission
            .authorize(
                prepared,
                &self.workspace_root,
                self.session_id(),
                self.agent_role(),
                None,
                None,
                self.approval.as_deref(),
            )
            .await
        {
            Ok(mut decision) => {
                if let Some(receipt_ttl) = self.receipt_ttl {
                    decision.receipt_ttl = receipt_ttl;
                }
                decision
            }
            Err(error) => ToolAuthorizationDecision::deny(ToolExecutionError {
                code: "TOOL_PERMISSION_FAILED".to_string(),
                message: error.to_string(),
                recoverable: false,
                suggestion: None,
                retry_after_ms: None,
                details: None,
            }),
        }
    }
}

struct Harness {
    _workspace: TempDir,
    _data: TempDir,
    pipeline: ToolExecutionPipeline,
    context: TestContext,
    modes: Arc<WorkspacePermissionStore>,
    rules: Arc<PermissionRuleStore>,
    journal_path: PathBuf,
}

impl Harness {
    async fn new(
        handlers: Vec<Arc<dyn ToolHandler>>,
        approval: Option<Arc<dyn PermissionApprovalHandler>>,
    ) -> Self {
        let workspace = tempfile::tempdir().expect("temporary workspace must be available");
        let data = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(MemoryAtomicPersistence::default());
        let modes = Arc::new(
            WorkspacePermissionStore::new(data.path(), Arc::clone(&persistence))
                .expect("fixture mode store must be valid"),
        );
        let rules = Arc::new(
            PermissionRuleStore::new(data.path(), Arc::clone(&persistence))
                .expect("fixture rule store must be valid"),
        );
        let audit = Arc::new(
            PermissionAuditLog::new(data.path(), Arc::clone(&persistence))
                .expect("fixture audit log must be valid"),
        );
        let permission = PermissionService::new(Arc::clone(&modes), Arc::clone(&rules), audit);
        let catalog = ToolCatalogSnapshot::from_handlers("test-catalog", handlers)
            .expect("fixture catalog must be valid");
        let journal_path = data.path().join("tool-execution.jsonl");
        let pipeline = ToolExecutionPipeline::new(
            Arc::new(ToolInputValidator::new(Some(64 * 1024))),
            Arc::new(ToolScheduler),
            Arc::new(ToolResultProcessor::new(
                Arc::new(LargeToolResultStore::new(data.path().join("large-results"))),
                None,
                false,
            )),
            Arc::new(ToolExecutionJournal::new(journal_path.clone(), None, None)),
        );
        let canonical_workspace =
            std::fs::canonicalize(workspace.path()).expect("fixture workspace must canonicalize");
        let workspace_authority = WorkspaceRoot::from_canonical(canonical_workspace)
            .expect("fixture workspace authority must be valid");
        let paths = Arc::new(
            AppPaths::new(
                data.path().to_path_buf(),
                data.path().to_path_buf(),
                data.path().to_path_buf(),
                data.path().to_path_buf(),
                data.path().to_path_buf(),
                data.path().to_path_buf(),
            )
            .expect("fixture paths must be absolute"),
        );
        let edit_transaction_service = Arc::new(EditTransactionService::new(paths));
        let transaction_id = "tx-tools-test".to_string();
        edit_transaction_service
            .register_transaction(&transaction_id, "session-1")
            .await
            .expect("fixture transaction must register");
        let file_system: Arc<dyn FileSystem> = Arc::new(TestFileSystem {
            root: workspace_authority,
        });
        let context = TestContext {
            catalog,
            workspace_root: workspace.path().to_path_buf(),
            permission,
            approval,
            cancellation: CancellationToken::new(),
            receipt_ttl: None,
            file_services: ToolFileServices {
                file_system,
                fingerprint_store: Arc::new(ReadFingerprintStore::default()),
                mutation_coordinator: Arc::new(FileMutationCoordinator::default()),
                edit_transaction_service,
            },
            transaction_id,
        };
        Self {
            _workspace: workspace,
            _data: data,
            pipeline,
            context,
            modes,
            rules,
            journal_path,
        }
    }

    async fn execute(&self, name: &str, arguments: serde_json::Value) -> ToolExecutionResult {
        let mut results = self
            .pipeline
            .execute_batch(
                vec![NormalizedToolCall {
                    call_id: "call-1".to_string(),
                    position: 0,
                    name: name.to_string(),
                    raw_arguments: arguments.to_string(),
                    thought_signature: None,
                }],
                &self.context,
            )
            .await;
        results
            .pop()
            .expect("one input call must produce one terminal result")
            .result
    }
}

#[tokio::test]
async fn pipeline_executes_an_authorized_workspace_write() {
    let harness = Harness::new(vec![Arc::new(WriteTool::new())], None).await;

    let result = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "new.txt", "content": "written"}),
        )
        .await;
    assert!(
        matches!(result, ToolExecutionResult::Success { .. }),
        "unexpected pipeline result: {result:?}"
    );
    let content = tokio::fs::read_to_string(harness.context.workspace_root.join("new.txt"))
        .await
        .expect("authorized write must create the file");

    assert_eq!(content, "written");
}

#[tokio::test]
async fn pipeline_write_tracks_a_new_file_below_missing_parent_directories() {
    let harness = Harness::new(vec![Arc::new(WriteTool::new())], None).await;
    let target = harness
        .context
        .workspace_root
        .join("generated/deep/new.txt");

    let result = harness
        .execute(
            "Write",
            serde_json::json!({
                "file_path": "generated/deep/new.txt",
                "content": "nested"
            }),
        )
        .await;
    let rejected = harness
        .context
        .file_services
        .edit_transaction_service
        .reject_file(&harness.context.transaction_id, &target)
        .await
        .expect("nested new-file mutation must be rejectable");

    assert!(
        matches!(result, ToolExecutionResult::Success { .. }) && rejected && !target.exists(),
        "result={result:?}, rejected={rejected}, target_exists={}",
        target.exists()
    );
}

#[tokio::test]
async fn pipeline_write_then_edit_completes_without_a_transaction_lock_deadlock() {
    let harness = Harness::new(
        vec![Arc::new(WriteTool::new()), Arc::new(EditTool::new())],
        None,
    )
    .await;

    let write = tokio::time::timeout(
        Duration::from_secs(2),
        harness.execute(
            "Write",
            serde_json::json!({"file_path": "chain.txt", "content": "alpha"}),
        ),
    )
    .await
    .expect("write must not deadlock");
    let edit = tokio::time::timeout(
        Duration::from_secs(2),
        harness.execute(
            "Edit",
            serde_json::json!({
                "file_path": "chain.txt",
                "edits": [{"old_string": "alpha", "new_string": "beta"}]
            }),
        ),
    )
    .await
    .expect("edit must not deadlock");
    let statuses = harness
        .context
        .file_services
        .edit_transaction_service
        .get_file_statuses(&harness.context.transaction_id)
        .await
        .expect("transaction status must be readable");

    assert!(
        matches!(write, ToolExecutionResult::Success { .. })
            && matches!(edit, ToolExecutionResult::Success { .. })
            && statuses.len() == 1
    );
}

#[tokio::test]
async fn pipeline_overwrite_rejects_content_changed_after_read_delivery() {
    let harness = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(WriteTool::new())],
        None,
    )
    .await;
    let target = harness.context.workspace_root.join("stale.txt");
    tokio::fs::write(&target, "read version")
        .await
        .expect("fixture file must be written");
    let read = harness
        .execute("Read", serde_json::json!({"file_path": "stale.txt"}))
        .await;
    tokio::fs::write(&target, "external version")
        .await
        .expect("external edit must be written");

    let write = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "stale.txt", "content": "agent version"}),
        )
        .await;

    assert!(
        matches!(read, ToolExecutionResult::Success { .. })
            && matches!(
                write,
                ToolExecutionResult::Error { error, .. } if error.code == "TOOL_FILE_STALE"
            )
            && tokio::fs::read_to_string(target)
                .await
                .expect("external edit must remain readable")
                == "external version"
    );
}

#[tokio::test]
async fn pipeline_no_op_write_does_not_register_a_mutation() {
    let harness = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(WriteTool::new())],
        None,
    )
    .await;
    let target = harness.context.workspace_root.join("same.txt");
    tokio::fs::write(&target, "same")
        .await
        .expect("fixture file must be written");
    let _read = harness
        .execute("Read", serde_json::json!({"file_path": "same.txt"}))
        .await;

    let write = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "same.txt", "content": "same"}),
        )
        .await;
    let statuses = harness
        .context
        .file_services
        .edit_transaction_service
        .get_file_statuses(&harness.context.transaction_id)
        .await
        .expect("transaction status must be readable");

    assert!(matches!(write, ToolExecutionResult::Success { .. }) && statuses.is_empty());
}

#[tokio::test]
async fn pipeline_read_failures_after_staging_or_prepare_leave_no_stale_record() {
    let mut outcomes = Vec::new();
    for fail_on in [2, 3] {
        let mut harness = Harness::new(
            vec![Arc::new(ReadTool::new()), Arc::new(WriteTool::new())],
            None,
        )
        .await;
        let name = format!("read-failure-{fail_on}.txt");
        let target = harness.context.workspace_root.join(&name);
        tokio::fs::write(&target, "original")
            .await
            .expect("read failure fixture must be written");
        let _read = harness
            .execute("Read", serde_json::json!({"file_path": name}))
            .await;
        let root = WorkspaceRoot::from_canonical(
            std::fs::canonicalize(&harness.context.workspace_root)
                .expect("fixture workspace must canonicalize"),
        )
        .expect("fixture workspace authority must be valid");
        harness.context.file_services.file_system = Arc::new(NthReadFileSystem {
            inner: TestFileSystem { root },
            reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            action_on: fail_on,
            action: NthReadAction::Fail,
        });

        let result = harness
            .execute(
                "Write",
                serde_json::json!({
                    "file_path": name,
                    "content": "replacement"
                }),
            )
            .await;
        let statuses = harness
            .context
            .file_services
            .edit_transaction_service
            .get_file_statuses(&harness.context.transaction_id)
            .await
            .expect("transaction status must remain readable");
        outcomes.push(matches!(result, ToolExecutionResult::Error { .. }) && statuses.is_empty());
    }

    assert!(outcomes.into_iter().all(|outcome| outcome));
}

#[tokio::test]
async fn pipeline_resolve_and_authorization_failures_after_prepare_discard_backups() {
    let mut outcomes = Vec::new();
    for (name, action) in [
        ("resolve-failure.txt", NthResolveAction::Fail),
        (
            "authorization-failure.txt",
            NthResolveAction::Redirect(PathBuf::from("redirected.txt")),
        ),
    ] {
        let mut harness = Harness::new(
            vec![Arc::new(ReadTool::new()), Arc::new(WriteTool::new())],
            None,
        )
        .await;
        let target = harness.context.workspace_root.join(name);
        tokio::fs::write(&target, "original")
            .await
            .expect("resolve failure fixture must be written");
        let _read = harness
            .execute("Read", serde_json::json!({"file_path": name}))
            .await;
        let root = WorkspaceRoot::from_canonical(
            std::fs::canonicalize(&harness.context.workspace_root)
                .expect("fixture workspace must canonicalize"),
        )
        .expect("fixture workspace authority must be valid");
        harness.context.file_services.file_system = Arc::new(NthResolveFileSystem {
            inner: TestFileSystem { root },
            resolves: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            action_on: 2,
            action,
        });

        let result = harness
            .execute(
                "Write",
                serde_json::json!({"file_path": name, "content": "replacement"}),
            )
            .await;
        let statuses = harness
            .context
            .file_services
            .edit_transaction_service
            .get_file_statuses(&harness.context.transaction_id)
            .await
            .expect("transaction status must remain readable");
        outcomes.push(matches!(result, ToolExecutionResult::Error { .. }) && statuses.is_empty());
    }

    assert!(outcomes.into_iter().all(|outcome| outcome));
}

#[tokio::test]
async fn pipeline_cancelled_second_write_restores_previous_intent_across_restart() {
    let mut harness = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(WriteTool::new())],
        None,
    )
    .await;
    let target = harness.context.workspace_root.join("cancelled-second.txt");
    tokio::fs::write(&target, "original")
        .await
        .expect("cancellation fixture must be written");
    let _original_read = harness
        .execute(
            "Read",
            serde_json::json!({"file_path": "cancelled-second.txt"}),
        )
        .await;
    let first = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "cancelled-second.txt", "content": "first"}),
        )
        .await;
    let _first_read = harness
        .execute(
            "Read",
            serde_json::json!({"file_path": "cancelled-second.txt"}),
        )
        .await;
    let root = WorkspaceRoot::from_canonical(
        std::fs::canonicalize(&harness.context.workspace_root)
            .expect("fixture workspace must canonicalize"),
    )
    .expect("fixture workspace authority must be valid");
    harness.context.file_services.file_system = Arc::new(NthReadFileSystem {
        inner: TestFileSystem { root },
        reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        action_on: 2,
        action: NthReadAction::Cancel(harness.context.cancellation.clone()),
    });

    let cancelled = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "cancelled-second.txt", "content": "second"}),
        )
        .await;
    let data = harness._data.path().to_path_buf();
    let restarted = EditTransactionService::new(Arc::new(
        AppPaths::new(
            data.clone(),
            data.clone(),
            data.clone(),
            data.clone(),
            data.clone(),
            data,
        )
        .expect("restart paths must be valid"),
    ));
    restarted
        .get_provenance_for_session("session-1", &harness.context.transaction_id)
        .await
        .expect("restarted service must recover transaction provenance");
    let rejected = restarted
        .reject_file(&harness.context.transaction_id, &target)
        .await
        .expect("the first mutation must remain rejectable");
    let restored = tokio::fs::read_to_string(target)
        .await
        .expect("rejected file must be readable");

    assert!(
        matches!(first, ToolExecutionResult::Success { .. })
            && matches!(cancelled, ToolExecutionResult::Error { ref error, .. } if error.code == "TOOL_CANCELLED")
            && rejected
            && restored == "original",
        "first={first:?}, cancelled={cancelled:?}, rejected={rejected}, restored={restored:?}"
    );
}

#[tokio::test]
async fn pipeline_retains_rollback_state_when_writer_errors_after_replacement() {
    let mut harness = Harness::new(vec![Arc::new(WriteTool::new())], None).await;
    let root = WorkspaceRoot::from_canonical(
        std::fs::canonicalize(&harness.context.workspace_root)
            .expect("fixture workspace must canonicalize"),
    )
    .expect("fixture workspace authority must be valid");
    harness.context.file_services.file_system = Arc::new(ErrorAfterWriteFileSystem {
        inner: TestFileSystem { root },
    });
    let target = harness.context.workspace_root.join("post-error.txt");

    let result = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "post-error.txt", "content": "changed"}),
        )
        .await;
    let statuses = harness
        .context
        .file_services
        .edit_transaction_service
        .get_file_statuses(&harness.context.transaction_id)
        .await
        .expect("rollback status must be readable");

    assert!(
        matches!(result, ToolExecutionResult::Error { .. })
            && statuses
                .first()
                .is_some_and(|status| status.current_matches_expected == Some(true))
            && tokio::fs::read_to_string(target)
                .await
                .expect("changed file must remain readable")
                == "changed"
    );
}

#[tokio::test]
async fn pipeline_read_rejects_a_path_changed_after_authorization() {
    let mut harness = Harness::new(vec![Arc::new(ReadTool::new())], None).await;
    tokio::fs::write(
        harness.context.workspace_root.join("authorized.txt"),
        "allowed",
    )
    .await
    .expect("authorized fixture must be written");
    tokio::fs::write(
        harness.context.workspace_root.join("redirected.txt"),
        "secret",
    )
    .await
    .expect("redirect fixture must be written");
    let root = WorkspaceRoot::from_canonical(
        std::fs::canonicalize(&harness.context.workspace_root)
            .expect("fixture workspace must canonicalize"),
    )
    .expect("fixture workspace authority must be valid");
    harness.context.file_services.file_system = Arc::new(RedirectingFileSystem {
        inner: TestFileSystem { root },
        redirected_relative_path: PathBuf::from("redirected.txt"),
    });

    let result = harness
        .execute("Read", serde_json::json!({"file_path": "authorized.txt"}))
        .await;

    assert!(matches!(
        result,
        ToolExecutionResult::Error { error, .. } if error.code == "TOOL_PATH_CHANGED"
    ));
}

#[tokio::test]
async fn explicit_deny_prevents_side_effects_in_full_access_mode() {
    let harness = Harness::new(vec![Arc::new(WriteTool::new())], None).await;
    let canonical_workspace = tokio::fs::canonicalize(&harness.context.workspace_root)
        .await
        .expect("fixture workspace must canonicalize");
    harness
        .modes
        .set_mode(&canonical_workspace, PermissionMode::FullAccess)
        .await
        .expect("fixture mode must persist");
    let target = canonical_workspace.join("denied.txt");
    harness
        .rules
        .remember(RememberPermissionRuleInput {
            workspace_root: canonical_workspace,
            session_id: None,
            permission: PermissionCapability::Edit,
            pattern: target.to_string_lossy().to_string(),
            action: PermissionAction::Deny,
            scope: PermissionApprovalScope::Workspace,
            hardline: false,
        })
        .await
        .expect("fixture deny rule must persist");

    let result = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "denied.txt", "content": "must-not-exist"}),
        )
        .await;

    assert!(matches!(result, ToolExecutionResult::Denied { .. }) && !target.exists());
}

#[tokio::test]
async fn external_write_remains_outside_the_workspace_authority_after_approval() {
    let approval: Arc<dyn PermissionApprovalHandler> = Arc::new(StaticApproval {
        approved: true,
        scope: PermissionApprovalScope::Once,
    });
    let harness = Harness::new(vec![Arc::new(WriteTool::new())], Some(approval)).await;
    let external = tempfile::tempdir().expect("external fixture directory must be available");
    let target = external.path().join("approved.txt");

    let result = harness
        .execute(
            "Write",
            serde_json::json!({
                "file_path": target.to_string_lossy(),
                "content": "approved"
            }),
        )
        .await;
    assert!(
        matches!(result, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_PATH_NOT_AUTHORIZED")
            && !target.exists()
    );
}

#[tokio::test]
async fn full_access_does_not_bypass_an_absolute_shell_redline() {
    let harness = Harness::new(vec![Arc::new(BashTool::new())], None).await;
    harness
        .modes
        .set_mode(&harness.context.workspace_root, PermissionMode::FullAccess)
        .await
        .expect("fixture mode must persist");

    let result = harness
        .execute("Bash", serde_json::json!({"command": "sudo whoami"}))
        .await;

    assert!(matches!(
        result,
        ToolExecutionResult::Denied { error, .. } if error.code == "TOOL_APPROVAL_REQUIRED"
    ));
}

#[tokio::test]
async fn unknown_shell_command_requires_approval_in_auto_mode() {
    let harness = Harness::new(vec![Arc::new(BashTool::new())], None).await;

    let result = harness
        .execute(
            "Bash",
            serde_json::json!({"command": "unknown-codez-command argument"}),
        )
        .await;

    assert!(matches!(
        result,
        ToolExecutionResult::Denied { error, .. } if error.code == "TOOL_APPROVAL_REQUIRED"
    ));
}

#[tokio::test]
async fn cancellation_prevents_an_authorized_handler_from_starting() {
    let harness = Harness::new(vec![Arc::new(ReadTool::new())], None).await;
    tokio::fs::write(harness.context.workspace_root.join("read.txt"), "content")
        .await
        .expect("fixture file must be written");
    harness.context.cancellation.cancel();

    let result = harness
        .execute("Read", serde_json::json!({"file_path": "read.txt"}))
        .await;

    assert!(
        matches!(result, ToolExecutionResult::Cancelled { .. }),
        "unexpected pipeline result: {result:?}"
    );
}

#[tokio::test]
async fn read_rejects_the_removed_multi_file_input_contract() {
    let harness = Harness::new(vec![Arc::new(ReadTool::new())], None).await;

    let result = harness
        .execute(
            "Read",
            serde_json::json!({"files": [{"file_path": "one.txt"}]}),
        )
        .await;

    assert!(matches!(
        result,
        ToolExecutionResult::Error { error, .. } if error.code == "TOOL_INPUT_INVALID"
    ));
}

#[tokio::test]
async fn read_missing_file_reports_the_requested_path_and_discovery_hint() {
    let harness = Harness::new(vec![Arc::new(ReadTool::new())], None).await;

    let result = harness
        .execute(
            "Read",
            serde_json::json!({"file_path": "src/missing-entry.ts"}),
        )
        .await;

    assert!(matches!(
        result,
        ToolExecutionResult::Error { error, .. }
            if error.code == "TOOL_FILE_NOT_FOUND"
                && error.message.contains("src/missing-entry.ts")
                && error.suggestion.as_deref().is_some_and(|suggestion| {
                    suggestion.contains("Glob") && suggestion.contains("list_files")
                })
    ));
}

#[tokio::test]
async fn expired_authorization_receipt_fails_before_the_write() {
    let mut harness = Harness::new(vec![Arc::new(WriteTool::new())], None).await;
    harness.context.receipt_ttl = Some(Duration::ZERO);
    let target = harness.context.workspace_root.join("expired.txt");

    let result = harness
        .execute(
            "Write",
            serde_json::json!({"file_path": "expired.txt", "content": "blocked"}),
        )
        .await;

    assert!(
        matches!(result, ToolExecutionResult::Denied { ref error, .. } if error.code == "TOOL_AUTHORIZATION_EXPIRED")
            && !target.exists(),
        "unexpected pipeline result: {result:?}"
    );
}

#[tokio::test]
async fn unavailable_tool_returns_a_stable_typed_error() {
    let harness = Harness::new(vec![Arc::new(ReadTool::new())], None).await;

    let result = harness.execute("NotebookEdit", serde_json::json!({})).await;

    assert!(matches!(
        result,
        ToolExecutionResult::Error { error, .. } if error.code == "TOOL_UNAVAILABLE"
    ));
}

#[tokio::test]
async fn journal_contains_one_terminal_event_for_a_denied_call() {
    let harness = Harness::new(vec![Arc::new(BashTool::new())], None).await;

    let _result = harness
        .execute("Bash", serde_json::json!({"command": "sudo whoami"}))
        .await;
    let journal = tokio::fs::read_to_string(&harness.journal_path)
        .await
        .expect("tool journal must be readable");
    let terminal_count = journal
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|event| event["event"] == "tool.call.denied")
        .count();

    assert_eq!(terminal_count, 1);
}

#[tokio::test]
async fn permission_mode_and_workspace_rule_survive_store_recreation() {
    let workspace = tempfile::tempdir().expect("temporary workspace must be available");
    let data = tempfile::tempdir().expect("temporary data root must be available");
    let persistence: Arc<dyn AtomicPersistence> = Arc::new(MemoryAtomicPersistence::default());
    let modes = WorkspacePermissionStore::new(data.path(), Arc::clone(&persistence))
        .expect("mode store must be valid");
    let rules = PermissionRuleStore::new(data.path(), Arc::clone(&persistence))
        .expect("rule store must be valid");
    modes
        .set_mode(workspace.path(), PermissionMode::FullAccess)
        .await
        .expect("mode must persist atomically");
    rules
        .remember(RememberPermissionRuleInput {
            workspace_root: workspace.path().to_path_buf(),
            session_id: None,
            permission: PermissionCapability::Network,
            pattern: "https://example.test/*".to_string(),
            action: PermissionAction::Deny,
            scope: PermissionApprovalScope::Workspace,
            hardline: false,
        })
        .await
        .expect("rule must persist atomically");
    let recreated_modes = WorkspacePermissionStore::new(data.path(), Arc::clone(&persistence))
        .expect("recreated mode store must be valid");
    let recreated_rules = PermissionRuleStore::new(data.path(), persistence)
        .expect("recreated rule store must be valid");

    let mode = recreated_modes
        .get_mode(workspace.path())
        .await
        .expect("persisted mode must load");
    let action = recreated_rules
        .resolve(
            workspace.path(),
            None,
            &PermissionCapability::Network,
            "https://example.test/path",
        )
        .await
        .expect("persisted rule must load");

    assert_eq!(
        (mode, action),
        (PermissionMode::FullAccess, Some(PermissionAction::Deny))
    );
}

#[tokio::test]
async fn permission_mode_loads_the_legacy_unversioned_document() {
    let workspace = tempfile::tempdir().expect("temporary workspace must be available");
    let data = tempfile::tempdir().expect("temporary data root must be available");
    let persistence: Arc<dyn AtomicPersistence> = Arc::new(MemoryAtomicPersistence::default());
    let workspace_key = normalize_workspace_key(workspace.path())
        .await
        .expect("fixture workspace key must normalize");
    let document = serde_json::to_vec(&serde_json::json!({
        "workspaces": std::collections::BTreeMap::from([(
            workspace_key,
            PermissionMode::FullAccess,
        )]),
    }))
    .expect("legacy mode document must serialize");
    persistence
        .replace(&data.path().join("workspace-permissions.json"), &document)
        .await
        .expect("legacy mode document must persist");
    let modes =
        WorkspacePermissionStore::new(data.path(), persistence).expect("mode store must be valid");

    let mode = modes
        .get_mode(workspace.path())
        .await
        .expect("legacy mode must load");

    assert_eq!(mode, PermissionMode::FullAccess);
}

#[tokio::test]
async fn permission_rules_load_the_legacy_unversioned_document() {
    let workspace = tempfile::tempdir().expect("temporary workspace must be available");
    let data = tempfile::tempdir().expect("temporary data root must be available");
    let persistence: Arc<dyn AtomicPersistence> = Arc::new(MemoryAtomicPersistence::default());
    let workspace_key = normalize_workspace_key(workspace.path())
        .await
        .expect("fixture workspace key must normalize");
    let document = serde_json::to_vec(&serde_json::json!({
        "rules": [{
            "workspace": workspace_key,
            "permission": "network",
            "pattern": "https://example.test/*",
            "action": "allow",
        }],
    }))
    .expect("legacy rule document must serialize");
    persistence
        .replace(&data.path().join("permission-rules.json"), &document)
        .await
        .expect("legacy rule document must persist");
    let rules =
        PermissionRuleStore::new(data.path(), persistence).expect("rule store must be valid");

    let action = rules
        .resolve(
            workspace.path(),
            None,
            &PermissionCapability::Network,
            "https://example.test/path",
        )
        .await
        .expect("legacy rule must load");

    assert_eq!(action, Some(PermissionAction::Allow));
}

#[tokio::test]
async fn clearing_permission_session_removes_only_that_sessions_rules() {
    let workspace = tempfile::tempdir().expect("temporary workspace must be available");
    let data = tempfile::tempdir().expect("temporary data root must be available");
    let persistence: Arc<dyn AtomicPersistence> = Arc::new(MemoryAtomicPersistence::default());
    let modes = Arc::new(
        WorkspacePermissionStore::new(data.path(), Arc::clone(&persistence))
            .expect("fixture mode store must be valid"),
    );
    let rules = Arc::new(
        PermissionRuleStore::new(data.path(), Arc::clone(&persistence))
            .expect("fixture rule store must be valid"),
    );
    let audit = Arc::new(
        PermissionAuditLog::new(data.path(), persistence).expect("fixture audit log must be valid"),
    );
    let permission = PermissionService::new(modes, Arc::clone(&rules), audit);
    for (session_id, pattern) in [
        ("deleted-session", "session:deleted"),
        ("retained-session", "session:retained"),
    ] {
        rules
            .remember(RememberPermissionRuleInput {
                workspace_root: workspace.path().to_path_buf(),
                session_id: Some(session_id.to_string()),
                permission: PermissionCapability::Network,
                pattern: pattern.to_string(),
                action: PermissionAction::Allow,
                scope: PermissionApprovalScope::Session,
                hardline: false,
            })
            .await
            .expect("fixture session rule must be accepted");
    }
    rules
        .remember(RememberPermissionRuleInput {
            workspace_root: workspace.path().to_path_buf(),
            session_id: None,
            permission: PermissionCapability::Network,
            pattern: "workspace:retained".to_string(),
            action: PermissionAction::Deny,
            scope: PermissionApprovalScope::Workspace,
            hardline: false,
        })
        .await
        .expect("fixture workspace rule must persist");

    permission.clear_session("deleted-session").await;

    let deleted_session = rules
        .resolve(
            workspace.path(),
            Some("deleted-session"),
            &PermissionCapability::Network,
            "session:deleted",
        )
        .await
        .expect("deleted session rule lookup must succeed");
    let retained_session = rules
        .resolve(
            workspace.path(),
            Some("retained-session"),
            &PermissionCapability::Network,
            "session:retained",
        )
        .await
        .expect("retained session rule lookup must succeed");
    let workspace_rule = rules
        .resolve(
            workspace.path(),
            Some("deleted-session"),
            &PermissionCapability::Network,
            "workspace:retained",
        )
        .await
        .expect("workspace rule lookup must succeed");

    assert_eq!(
        (deleted_session, retained_session, workspace_rule),
        (
            None,
            Some(PermissionAction::Allow),
            Some(PermissionAction::Deny)
        )
    );
}

fn notebook_fixture(source: &str) -> String {
    serde_json::json!({
        "cells": [
            {
                "cell_type": "code",
                "execution_count": null,
                "id": "alpha",
                "metadata": {},
                "outputs": [],
                "source": [source]
            },
            {
                "cell_type": "markdown",
                "id": "beta",
                "metadata": {},
                "source": ["保留内容\n"]
            }
        ],
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 5
    })
    .to_string()
}

async fn deliver_notebook(harness: &Harness, relative_path: &str) -> ToolExecutionResult {
    harness
        .execute("Read", serde_json::json!({"file_path": relative_path}))
        .await
}

#[tokio::test]
async fn pipeline_notebook_edit_replaces_inserts_and_deletes_structured_cells() {
    let harness = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(NotebookEditTool::new())],
        None,
    )
    .await;
    let target = harness.context.workspace_root.join("unicode.ipynb");
    tokio::fs::write(&target, notebook_fixture("print('旧')\n"))
        .await
        .expect("notebook fixture must be written");
    let read = deliver_notebook(&harness, "unicode.ipynb").await;

    let replace = harness
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "unicode.ipynb",
                "cell_id": "alpha",
                "new_source": "print('新')\n",
                "edit_mode": "replace"
            }),
        )
        .await;
    let insert = harness
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "unicode.ipynb",
                "cell_id": "alpha",
                "cell_type": "raw",
                "new_source": "新增数据",
                "edit_mode": "insert"
            }),
        )
        .await;
    let delete = harness
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "unicode.ipynb",
                "cell_index": 2,
                "edit_mode": "delete"
            }),
        )
        .await;
    let notebook: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&target)
            .await
            .expect("edited notebook must be readable"),
    )
    .expect("edited notebook must remain valid JSON");

    assert!(
        matches!(read, ToolExecutionResult::Success { .. })
            && matches!(replace, ToolExecutionResult::Success { .. })
            && matches!(insert, ToolExecutionResult::Success { .. })
            && matches!(delete, ToolExecutionResult::Success { .. })
            && notebook["cells"]
                .as_array()
                .is_some_and(|cells| cells.len() == 2)
            && notebook["cells"][0]["source"][0] == "print('新')\n"
            && notebook["cells"][1]["source"][0] == "新增数据"
    );
}

#[tokio::test]
async fn pipeline_notebook_edit_rejects_invalid_json_and_stale_read_delivery() {
    let harness = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(NotebookEditTool::new())],
        None,
    )
    .await;
    let malformed = harness.context.workspace_root.join("malformed.ipynb");
    tokio::fs::write(&malformed, "{invalid")
        .await
        .expect("malformed fixture must be written");
    let _read_malformed = deliver_notebook(&harness, "malformed.ipynb").await;
    let invalid = harness
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "malformed.ipynb",
                "cell_index": 0,
                "new_source": "changed",
                "edit_mode": "replace"
            }),
        )
        .await;

    let stale = harness.context.workspace_root.join("stale.ipynb");
    tokio::fs::write(&stale, notebook_fixture("before\n"))
        .await
        .expect("stale fixture must be written");
    let _read_stale = deliver_notebook(&harness, "stale.ipynb").await;
    let external = notebook_fixture("external\n");
    tokio::fs::write(&stale, &external)
        .await
        .expect("external notebook update must be written");
    let stale_result = harness
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "stale.ipynb",
                "cell_id": "alpha",
                "new_source": "agent\n",
                "edit_mode": "replace"
            }),
        )
        .await;

    assert!(
        matches!(invalid, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_NOTEBOOK_INVALID")
            && matches!(stale_result, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_NOTEBOOK_STALE")
            && tokio::fs::read_to_string(stale)
                .await
                .expect("external notebook must remain readable")
                == external
    );
}

#[tokio::test]
async fn pipeline_notebook_edit_detects_a_concurrent_external_change_after_backup() {
    let mut harness = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(NotebookEditTool::new())],
        None,
    )
    .await;
    let target = harness.context.workspace_root.join("racing.ipynb");
    tokio::fs::write(&target, notebook_fixture("before\n"))
        .await
        .expect("race fixture must be written");
    let root = WorkspaceRoot::from_canonical(
        std::fs::canonicalize(&harness.context.workspace_root)
            .expect("fixture workspace must canonicalize"),
    )
    .expect("fixture workspace authority must be valid");
    let external = notebook_fixture("external\n");
    harness.context.file_services.file_system = Arc::new(MutatingOnThirdReadFileSystem {
        inner: TestFileSystem { root },
        target: target.clone(),
        replacement: external.as_bytes().to_vec(),
        reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    });
    let read = deliver_notebook(&harness, "racing.ipynb").await;

    let result = harness
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "racing.ipynb",
                "cell_id": "alpha",
                "new_source": "agent\n",
                "edit_mode": "replace"
            }),
        )
        .await;
    let statuses = harness
        .context
        .file_services
        .edit_transaction_service
        .get_file_statuses(&harness.context.transaction_id)
        .await
        .expect("transaction status must remain readable");

    assert!(
        matches!(read, ToolExecutionResult::Success { .. })
            && matches!(result, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_NOTEBOOK_STALE")
            && statuses.is_empty()
            && tokio::fs::read_to_string(target)
                .await
                .expect("external notebook must remain readable")
                == external
    );
}

#[tokio::test]
async fn pipeline_notebook_edit_preserves_rollback_across_service_restart() {
    let harness = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(NotebookEditTool::new())],
        None,
    )
    .await;
    let target = harness.context.workspace_root.join("restart.ipynb");
    let original = notebook_fixture("before\n");
    tokio::fs::write(&target, &original)
        .await
        .expect("restart fixture must be written");
    let _read = deliver_notebook(&harness, "restart.ipynb").await;
    let edit = harness
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "restart.ipynb",
                "cell_id": "alpha",
                "new_source": "after\n",
                "edit_mode": "replace"
            }),
        )
        .await;
    let data = harness._data.path().to_path_buf();
    let restarted = EditTransactionService::new(Arc::new(
        AppPaths::new(
            data.clone(),
            data.clone(),
            data.clone(),
            data.clone(),
            data.clone(),
            data,
        )
        .expect("restart paths must be valid"),
    ));
    let _provenance = restarted
        .get_provenance_for_session("session-1", &harness.context.transaction_id)
        .await
        .expect("restarted service must recover transaction provenance");
    let rejected = restarted
        .reject_file(&harness.context.transaction_id, &target)
        .await
        .expect("restarted service must roll back the notebook");

    assert!(
        matches!(edit, ToolExecutionResult::Success { .. })
            && rejected
            && tokio::fs::read_to_string(target)
                .await
                .expect("rolled-back notebook must be readable")
                == original
    );
}

#[tokio::test]
async fn pipeline_notebook_edit_fails_closed_on_read_only_or_changed_path_identity() {
    let mut read_only = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(NotebookEditTool::new())],
        None,
    )
    .await;
    let readonly_target = read_only.context.workspace_root.join("readonly.ipynb");
    let original = notebook_fixture("before\n");
    tokio::fs::write(&readonly_target, &original)
        .await
        .expect("read-only fixture must be written");
    let _read = deliver_notebook(&read_only, "readonly.ipynb").await;
    let root = WorkspaceRoot::from_canonical(
        std::fs::canonicalize(&read_only.context.workspace_root)
            .expect("fixture workspace must canonicalize"),
    )
    .expect("fixture workspace authority must be valid");
    read_only.context.file_services.file_system = Arc::new(ReadOnlyFileSystem {
        inner: TestFileSystem { root },
    });
    let readonly_result = read_only
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "readonly.ipynb",
                "cell_id": "alpha",
                "new_source": "after\n",
                "edit_mode": "replace"
            }),
        )
        .await;

    let mut redirected = Harness::new(
        vec![Arc::new(ReadTool::new()), Arc::new(NotebookEditTool::new())],
        None,
    )
    .await;
    for name in ["authorized.ipynb", "redirected.ipynb"] {
        tokio::fs::write(
            redirected.context.workspace_root.join(name),
            notebook_fixture(name),
        )
        .await
        .expect("redirect fixture must be written");
    }
    let _read = deliver_notebook(&redirected, "authorized.ipynb").await;
    let redirected_root = WorkspaceRoot::from_canonical(
        std::fs::canonicalize(&redirected.context.workspace_root)
            .expect("fixture workspace must canonicalize"),
    )
    .expect("fixture workspace authority must be valid");
    redirected.context.file_services.file_system = Arc::new(RedirectingFileSystem {
        inner: TestFileSystem {
            root: redirected_root,
        },
        redirected_relative_path: PathBuf::from("redirected.ipynb"),
    });
    let redirected_result = redirected
        .execute(
            "NotebookEdit",
            serde_json::json!({
                "notebook_path": "authorized.ipynb",
                "cell_id": "alpha",
                "new_source": "after\n",
                "edit_mode": "replace"
            }),
        )
        .await;

    assert!(
        matches!(readonly_result, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_PATH_NOT_AUTHORIZED")
            && tokio::fs::read_to_string(readonly_target)
                .await
                .expect("read-only notebook must remain readable")
                == original
            && matches!(redirected_result, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_NOTEBOOK_STALE")
    );
}
