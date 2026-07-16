use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use codez_core::{AtomicPersistence, CancellationToken};
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
};
use codez_runtime::tools::authorization::AuthorizationBinding;
use codez_runtime::tools::builtin::bash::BashTool;
use codez_runtime::tools::builtin::read::ReadTool;
use codez_runtime::tools::builtin::write::WriteTool;
use codez_runtime::tools::exposure::ToolCatalogSnapshot;
use codez_runtime::tools::journal::{ToolExecutionJournal, ToolJournalIdentity};
use codez_runtime::tools::large_result::LargeToolResultStore;
use codez_runtime::tools::pipeline::{
    ToolAuthorizationDecision, ToolExecutionPipeline, ToolExecutionPipelineContext,
};
use codez_runtime::tools::processor::ToolResultProcessor;
use codez_runtime::tools::registry::ToolHandler;
use codez_runtime::tools::scheduler::ToolScheduler;
use codez_runtime::tools::types::{
    AgentRole, NormalizedToolCall, PreparedToolCall, ToolExecutionError, ToolExecutionResult,
};
use codez_runtime::tools::validation::ToolInputValidator;
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
    fn new(
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
        let context = TestContext {
            catalog,
            workspace_root: workspace.path().to_path_buf(),
            permission,
            approval,
            cancellation: CancellationToken::new(),
            receipt_ttl: None,
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
    let harness = Harness::new(vec![Arc::new(WriteTool::new())], None);

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
async fn explicit_deny_prevents_side_effects_in_full_access_mode() {
    let harness = Harness::new(vec![Arc::new(WriteTool::new())], None);
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
async fn external_write_requires_and_honors_a_once_only_approval() {
    let approval: Arc<dyn PermissionApprovalHandler> = Arc::new(StaticApproval {
        approved: true,
        scope: PermissionApprovalScope::Once,
    });
    let harness = Harness::new(vec![Arc::new(WriteTool::new())], Some(approval));
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
    let content = tokio::fs::read_to_string(&target)
        .await
        .expect("once-approved external write must execute");

    assert!(matches!(result, ToolExecutionResult::Success { .. }) && content == "approved");
}

#[tokio::test]
async fn full_access_does_not_bypass_an_absolute_shell_redline() {
    let harness = Harness::new(vec![Arc::new(BashTool::new())], None);
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
    let harness = Harness::new(vec![Arc::new(BashTool::new())], None);

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
    let harness = Harness::new(vec![Arc::new(ReadTool::new())], None);
    tokio::fs::write(harness.context.workspace_root.join("read.txt"), "content")
        .await
        .expect("fixture file must be written");
    harness.context.cancellation.cancel();

    let result = harness
        .execute(
            "Read",
            serde_json::json!({"files": [{"file_path": "read.txt"}]}),
        )
        .await;

    assert!(
        matches!(result, ToolExecutionResult::Cancelled { .. }),
        "unexpected pipeline result: {result:?}"
    );
}

#[tokio::test]
async fn expired_authorization_receipt_fails_before_the_write() {
    let mut harness = Harness::new(vec![Arc::new(WriteTool::new())], None);
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
    let harness = Harness::new(vec![Arc::new(ReadTool::new())], None);

    let result = harness.execute("NotebookEdit", serde_json::json!({})).await;

    assert!(matches!(
        result,
        ToolExecutionResult::Error { error, .. } if error.code == "TOOL_UNAVAILABLE"
    ));
}

#[tokio::test]
async fn journal_contains_one_terminal_event_for_a_denied_call() {
    let harness = Harness::new(vec![Arc::new(BashTool::new())], None);

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
