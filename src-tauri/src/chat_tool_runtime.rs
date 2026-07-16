use std::{
    collections::HashMap,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
};

use codez_contracts::chat::{ChatAskUserAnswer, ChatAskUserQuestion, ChatAskUserRequest};
use codez_core::{
    AppError, AppPaths, AtomicPersistence, CancellationToken, SessionId, StreamId, WorkspaceRoot,
    provider::{ToolDefinition, ToolDefinitionFunction},
};
use codez_runtime::{
    permission::{
        audit::{PermissionAuditError, PermissionAuditLog},
        service::{PermissionApprovalHandler, PermissionService},
        store::{PermissionRuleStore, PermissionStoreError, WorkspacePermissionStore},
    },
    tools::{
        authorization::AuthorizationBinding,
        builtin::{bash::BashTool, edit::EditTool, read::ReadTool, write::WriteTool},
        exposure::{ToolCatalogError, ToolCatalogSnapshot},
        journal::{ToolExecutionJournal, ToolJournalIdentity},
        large_result::LargeToolResultStore,
        pipeline::{
            ToolAuthorizationDecision, ToolExecutionPipeline, ToolExecutionPipelineContext,
        },
        processor::ToolResultProcessor,
        registry::ToolHandler,
        scheduler::ToolScheduler,
        types::{
            AgentRole, NormalizedToolCall, PreparedToolCall, ToolEffect, ToolExecutionError,
            ToolExecutionResult, ToolPipelineResult,
        },
        validation::ToolInputValidator,
    },
};
use serde::Deserialize;
use thiserror::Error;

const BUILTIN_CATALOG_ID: &str = "chat-builtin-v1";
const MAX_AGENT_ROLE_BYTES: usize = 160;
const ASK_USER_TOOL_NAME: &str = "AskUserQuestion";

#[async_trait::async_trait]
pub(crate) trait AskUserHandler: Send + Sync {
    async fn request(
        &self,
        request: ChatAskUserRequest,
    ) -> Result<Vec<ChatAskUserAnswer>, AppError>;
}

/// Errors raised while composing the desktop tool runtime from trusted host services.
#[derive(Debug, Error)]
pub(crate) enum ChatToolRuntimeError {
    #[error(transparent)]
    PermissionStore(#[from] PermissionStoreError),
    #[error(transparent)]
    PermissionAudit(#[from] PermissionAuditError),
    #[error(transparent)]
    Catalog(#[from] ToolCatalogError),
}

/// Invalid data rejected before it can become a per-run tool execution context.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub(crate) enum ChatToolRunContextError {
    #[error("agent role cannot be empty")]
    EmptyAgentRole,
    #[error("agent role exceeds the maximum length")]
    AgentRoleTooLong,
    #[error("agent role cannot contain control characters")]
    AgentRoleContainsControlCharacter,
}

/// Typed, upper-layer-verified authority for one chat run's tool calls.
///
/// The only workspace input is [`WorkspaceRoot`], so this composition layer never accepts an
/// untrusted path string as a filesystem authority.
pub(crate) struct ChatToolRunContext {
    workspace_root: WorkspaceRoot,
    session_id: SessionId,
    run_id: StreamId,
    cancellation: CancellationToken,
    agent_role: AgentRole,
    approval_handler: Option<Arc<dyn PermissionApprovalHandler>>,
    ask_user_handler: Option<Arc<dyn AskUserHandler>>,
    active_tools: Arc<ToolCancellationRegistry>,
}

#[derive(Default)]
struct ToolCancellationRegistry {
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl ChatToolRunContext {
    /// Creates a tool context from identities and workspace authority already verified upstream.
    ///
    /// # Errors
    ///
    /// Returns [`ChatToolRunContextError`] when the role cannot safely label audit and journal
    /// entries.
    pub(crate) fn new(
        workspace_root: WorkspaceRoot,
        session_id: SessionId,
        run_id: StreamId,
        cancellation: CancellationToken,
        agent_role: AgentRole,
        approval_handler: Option<Arc<dyn PermissionApprovalHandler>>,
        ask_user_handler: Option<Arc<dyn AskUserHandler>>,
    ) -> Result<Self, ChatToolRunContextError> {
        validate_agent_role(&agent_role)?;
        Ok(Self {
            workspace_root,
            session_id,
            run_id,
            cancellation,
            agent_role,
            approval_handler,
            ask_user_handler,
            active_tools: Arc::new(ToolCancellationRegistry::default()),
        })
    }

    #[must_use]
    pub(crate) fn has_active_tool(&self, call_id: &str) -> bool {
        self.active_tools.contains(call_id)
    }

    pub(crate) fn cancel_tool(&self, call_id: &str) -> bool {
        self.active_tools.cancel(call_id)
    }

    fn register_tool(&self, call_id: &str) -> CancellationToken {
        self.active_tools.register(call_id, &self.cancellation)
    }

    fn finish_tools(&self, results: &[ToolPipelineResult]) {
        self.active_tools
            .remove_all(results.iter().map(|result| result.call.call_id.as_str()));
    }
}

impl ToolCancellationRegistry {
    fn contains(&self, call_id: &str) -> bool {
        self.lock().contains_key(call_id)
    }

    fn register(&self, call_id: &str, parent: &CancellationToken) -> CancellationToken {
        let token = parent.child_token();
        if let Some(previous) = self.lock().insert(call_id.to_string(), token.clone()) {
            previous.cancel();
        }
        token
    }

    fn cancel(&self, call_id: &str) -> bool {
        let token = self.lock().get(call_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    fn remove_all<'a>(&self, call_ids: impl IntoIterator<Item = &'a str>) {
        let mut active = self.lock();
        for call_id in call_ids {
            active.remove(call_id);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Immutable built-in chat tools and their permission-backed execution pipeline.
pub(crate) struct ChatToolRuntime {
    catalog: ToolCatalogSnapshot,
    pipeline: ToolExecutionPipeline,
    permission: Arc<PermissionService>,
}

impl ChatToolRuntime {
    /// Composes the builtin chat tools from application-owned persistence and permission state.
    ///
    /// The caller supplies the same workspace permission store used by the desktop state. Rule
    /// and audit stores are rooted below the authoritative `~/.codez` data directory.
    ///
    /// # Errors
    ///
    /// Returns [`ChatToolRuntimeError`] when the persistent permission stores or immutable
    /// catalog cannot be initialized.
    pub(crate) fn new(
        paths: &AppPaths,
        persistence: Arc<dyn AtomicPersistence>,
        workspace_permissions: Arc<WorkspacePermissionStore>,
    ) -> Result<Self, ChatToolRuntimeError> {
        let data_root = paths.data_directory();
        let rules = Arc::new(PermissionRuleStore::new(
            data_root,
            Arc::clone(&persistence),
        )?);
        let audit = Arc::new(PermissionAuditLog::new(
            data_root,
            Arc::clone(&persistence),
        )?);
        let permission = Arc::new(PermissionService::new(workspace_permissions, rules, audit));
        let catalog = builtin_catalog()?;
        let result_store = Arc::new(LargeToolResultStore::new(data_root.join("tool-results")));
        let processor = Arc::new(ToolResultProcessor::new(result_store, None, true));
        let journal = Arc::new(ToolExecutionJournal::new(
            data_root.join("tool-execution.jsonl"),
            None,
            None,
        ));
        let pipeline = ToolExecutionPipeline::new(
            Arc::new(ToolInputValidator::new(None)),
            Arc::new(ToolScheduler),
            processor,
            journal,
        );

        Ok(Self {
            catalog,
            pipeline,
            permission,
        })
    }

    /// Returns the exact schemas exposed to a chat provider for this immutable catalog.
    #[must_use]
    pub(crate) fn provider_tool_definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions = self
            .catalog
            .descriptors
            .iter()
            .map(|descriptor| ToolDefinition {
                r#type: "function".to_string(),
                function: ToolDefinitionFunction {
                    name: descriptor.name().to_string(),
                    description: descriptor.description(),
                    parameters: descriptor.input_schema(),
                },
            })
            .collect::<Vec<_>>();
        definitions.push(ask_user_tool_definition());
        definitions
    }

    /// Executes normalized provider calls in deterministic position order.
    ///
    /// Every call enters the runtime pipeline and its `PermissionService`; an absent approval
    /// handler therefore denies any operation for which policy requires an explicit answer.
    pub(crate) async fn execute(
        &self,
        mut calls: Vec<NormalizedToolCall>,
        run: &ChatToolRunContext,
    ) -> Vec<ToolPipelineResult> {
        calls.sort_by_key(|call| call.position);
        if calls
            .windows(2)
            .any(|pair| pair[0].position == pair[1].position)
        {
            return calls
                .into_iter()
                .map(|call| self.invalid_call_result(call))
                .collect();
        }

        if calls.iter().any(|call| call.name == ASK_USER_TOOL_NAME) {
            let mut results = Vec::with_capacity(calls.len());
            for call in calls {
                if call.name == ASK_USER_TOOL_NAME {
                    results.push(self.execute_ask_user(call, run).await);
                } else {
                    results.extend(self.execute_pipeline(vec![call], run).await);
                }
            }
            results.sort_by_key(|result| result.call.position);
            return results;
        }
        self.execute_pipeline(calls, run).await
    }

    async fn execute_pipeline(
        &self,
        calls: Vec<NormalizedToolCall>,
        run: &ChatToolRunContext,
    ) -> Vec<ToolPipelineResult> {
        let context = PipelineContext { runtime: self, run };
        let mut results = self.pipeline.execute_batch(calls, &context).await;
        run.finish_tools(&results);
        results.sort_by_key(|result| result.call.position);
        results
    }

    async fn execute_ask_user(
        &self,
        call: NormalizedToolCall,
        run: &ChatToolRunContext,
    ) -> ToolPipelineResult {
        let arguments = match serde_json::from_str::<AskUserArguments>(&call.raw_arguments) {
            Ok(arguments) => arguments,
            Err(error) => {
                return ask_user_error_result(
                    call,
                    "ASK_USER_INPUT_INVALID",
                    format!("Ask-user tool input must be valid JSON: {error}"),
                );
            }
        };
        let Some(handler) = run.ask_user_handler.as_ref() else {
            return ask_user_error_result(
                call,
                "ASK_USER_HANDLER_UNAVAILABLE",
                "No chat user-interaction handler is registered.".to_string(),
            );
        };
        let request = ChatAskUserRequest {
            id: call.call_id.clone(),
            questions: arguments.questions,
        };
        match handler.request(request).await {
            Ok(answers) => match serde_json::to_string(&answers) {
                Ok(content) => ToolPipelineResult {
                    canonical_name: ASK_USER_TOOL_NAME.to_string(),
                    call,
                    result: ToolExecutionResult::Success {
                        data: None,
                        model_content: content.clone(),
                        ui_content: Some(content),
                        effects: Some(vec![ToolEffect::UserInteraction {
                            channel: "chat-ui".to_string(),
                        }]),
                    },
                    max_result_chars: Some(16 * 1024),
                },
                Err(error) => ask_user_error_result(
                    call,
                    "ASK_USER_RESPONSE_SERIALIZATION_FAILED",
                    format!("Ask-user answers could not be serialized: {error}"),
                ),
            },
            Err(error) => ask_user_error_result(
                call,
                "ASK_USER_REQUEST_FAILED",
                error.public_message().to_string(),
            ),
        }
    }

    fn invalid_call_result(&self, call: NormalizedToolCall) -> ToolPipelineResult {
        ToolPipelineResult {
            canonical_name: self.catalog.canonical_name(&call.name).to_string(),
            call,
            result: ToolExecutionResult::Error {
                error: tool_error(
                    "TOOL_CALL_INVALID",
                    "Each tool call in a batch requires a unique position.",
                    false,
                ),
                model_content: None,
                ui_content: None,
                effects: None,
            },
            max_result_chars: None,
        }
    }
}

#[derive(Deserialize)]
struct AskUserArguments {
    questions: Vec<ChatAskUserQuestion>,
}

fn ask_user_tool_definition() -> ToolDefinition {
    ToolDefinition {
        r#type: "function".to_string(),
        function: ToolDefinitionFunction {
            name: ASK_USER_TOOL_NAME.to_string(),
            description: "Ask the user a multiple-choice question only when their decision is required to continue.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "questions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "question": { "type": "string" },
                                "header": { "type": "string" },
                                "options": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 4,
                                    "items": {
                                        "type": "object",
                                        "additionalProperties": false,
                                        "properties": {
                                            "label": { "type": "string" },
                                            "description": { "type": "string" },
                                            "detail": { "type": "string" }
                                        },
                                        "required": ["label"]
                                    }
                                },
                                "multiSelect": { "type": "boolean" },
                                "ignoreLabel": { "type": "string" },
                                "submitLabel": { "type": "string" }
                            },
                            "required": ["question", "header", "options"]
                        }
                    }
                },
                "required": ["questions"]
            }),
        },
    }
}

fn ask_user_error_result(
    call: NormalizedToolCall,
    code: &str,
    message: String,
) -> ToolPipelineResult {
    ToolPipelineResult {
        canonical_name: ASK_USER_TOOL_NAME.to_string(),
        call,
        result: ToolExecutionResult::Error {
            error: tool_error(code, &message, false),
            model_content: Some(format!("Error: {message}")),
            ui_content: None,
            effects: Some(vec![ToolEffect::UserInteraction {
                channel: "chat-ui".to_string(),
            }]),
        },
        max_result_chars: Some(16 * 1024),
    }
}

fn builtin_catalog() -> Result<ToolCatalogSnapshot, ToolCatalogError> {
    let handlers: Vec<Arc<dyn ToolHandler>> = vec![
        Arc::new(ReadTool::new()),
        Arc::new(WriteTool::new()),
        Arc::new(EditTool::new()),
        Arc::new(BashTool::new()),
    ];
    ToolCatalogSnapshot::from_handlers(BUILTIN_CATALOG_ID, handlers)
}

fn validate_agent_role(agent_role: &str) -> Result<(), ChatToolRunContextError> {
    if agent_role.trim().is_empty() {
        return Err(ChatToolRunContextError::EmptyAgentRole);
    }
    if agent_role.len() > MAX_AGENT_ROLE_BYTES {
        return Err(ChatToolRunContextError::AgentRoleTooLong);
    }
    if agent_role.chars().any(char::is_control) {
        return Err(ChatToolRunContextError::AgentRoleContainsControlCharacter);
    }
    Ok(())
}

fn tool_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionError {
    ToolExecutionError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    }
}

struct PipelineContext<'a> {
    runtime: &'a ChatToolRuntime,
    run: &'a ChatToolRunContext,
}

impl ToolExecutionPipelineContext for PipelineContext<'_> {
    fn catalog(&self) -> &ToolCatalogSnapshot {
        &self.runtime.catalog
    }

    fn exposure(&self) -> Option<&codez_runtime::tools::exposure::ToolExposurePlan> {
        None
    }

    fn workspace_root(&self) -> &Path {
        self.run.workspace_root.as_path()
    }

    fn session_id(&self) -> Option<&str> {
        Some(self.run.session_id.as_str())
    }

    fn agent_role(&self) -> &AgentRole {
        &self.run.agent_role
    }

    fn journal_identity(&self) -> Option<ToolJournalIdentity> {
        Some(ToolJournalIdentity {
            session_id: Some(self.run.session_id.as_str().to_string()),
            turn_id: Some(self.run.run_id.as_str().to_string()),
            ..ToolJournalIdentity::default()
        })
    }

    fn cancellation_token(&self, call: &NormalizedToolCall) -> CancellationToken {
        self.run.register_tool(&call.call_id)
    }

    fn authorize<'life0, 'life1, 'life2, 'async_trait>(
        &'life0 self,
        prepared: &'life1 PreparedToolCall,
        _binding: &'life2 AuthorizationBinding,
    ) -> Pin<Box<dyn Future<Output = ToolAuthorizationDecision> + Send + 'async_trait>>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        'life2: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            match self
                .runtime
                .permission
                .authorize(
                    prepared,
                    self.run.workspace_root.as_path(),
                    Some(self.run.session_id.as_str()),
                    &self.run.agent_role,
                    None,
                    self.run.approval_handler.as_deref(),
                )
                .await
            {
                Ok(decision) => decision,
                Err(error) => {
                    tracing::warn!(error = %error, "tool permission evaluation failed");
                    ToolAuthorizationDecision::deny(tool_error(
                        "TOOL_PERMISSION_FAILED",
                        "The permission policy could not be evaluated.",
                        false,
                    ))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, sync::Arc};

    use codez_contracts::chat::{ChatAskUserAnswer, ChatAskUserAnswerValue, ChatAskUserRequest};
    use codez_core::{
        AppPaths, AtomicPersistence, CancellationToken, SessionId, StreamId, WorkspaceRoot,
    };
    use codez_runtime::{
        permission::store::WorkspacePermissionStore,
        tools::types::{NormalizedToolCall, ToolExecutionResult},
    };
    use codez_storage::AtomicFileStore;

    use super::{AskUserHandler, ChatToolRunContext, ChatToolRuntime};

    struct Fixture {
        _data: tempfile::TempDir,
        workspace: tempfile::TempDir,
        runtime: ChatToolRuntime,
    }

    impl Fixture {
        fn new() -> Self {
            let data = tempfile::tempdir().expect("temporary data directory must be available");
            let workspace =
                tempfile::tempdir().expect("temporary workspace directory must be available");
            let paths = app_paths(data.path());
            fs::create_dir_all(paths.data_directory())
                .expect("fixture application data directory must be created");
            let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
            let modes = Arc::new(
                WorkspacePermissionStore::new(paths.data_directory(), Arc::clone(&persistence))
                    .expect("fixture permission mode store must be valid"),
            );
            let runtime = ChatToolRuntime::new(&paths, persistence, modes)
                .expect("fixture tool runtime must compose");
            Self {
                _data: data,
                workspace,
                runtime,
            }
        }

        fn run_context(&self) -> ChatToolRunContext {
            self.run_context_with_ask_user(None)
        }

        fn run_context_with_ask_user(
            &self,
            ask_user_handler: Option<Arc<dyn AskUserHandler>>,
        ) -> ChatToolRunContext {
            let root = WorkspaceRoot::from_canonical(
                fs::canonicalize(self.workspace.path())
                    .expect("fixture workspace must canonicalize"),
            )
            .expect("fixture workspace must be a valid authority");
            ChatToolRunContext::new(
                root,
                SessionId::parse("session-1").expect("fixture session id must be valid"),
                StreamId::parse("run-1").expect("fixture run id must be valid"),
                CancellationToken::new(),
                "main".to_string(),
                None,
                ask_user_handler,
            )
            .expect("fixture run context must be valid")
        }
    }

    struct StaticAskUser;

    #[async_trait::async_trait]
    impl AskUserHandler for StaticAskUser {
        async fn request(
            &self,
            request: ChatAskUserRequest,
        ) -> Result<Vec<ChatAskUserAnswer>, codez_core::AppError> {
            Ok(vec![ChatAskUserAnswer {
                question: request.questions[0].question.clone(),
                answer: ChatAskUserAnswerValue::Text("approved".to_string()),
            }])
        }
    }

    fn app_paths(root: &Path) -> AppPaths {
        AppPaths::new(
            root.join("data"),
            root.join("cache"),
            root.join("logs"),
            root.join("resources"),
            root.join("temp"),
            root.join("home"),
        )
        .expect("fixture paths must be absolute")
    }

    fn call(position: usize, name: &str, arguments: serde_json::Value) -> NormalizedToolCall {
        NormalizedToolCall {
            call_id: format!("call-{position}"),
            position,
            name: name.to_string(),
            raw_arguments: arguments.to_string(),
            thought_signature: None,
        }
    }

    fn error_code(result: &ToolExecutionResult) -> Option<&str> {
        match result {
            ToolExecutionResult::Success { .. } => None,
            ToolExecutionResult::Error { error, .. }
            | ToolExecutionResult::Denied { error, .. }
            | ToolExecutionResult::Cancelled { error, .. } => Some(&error.code),
        }
    }

    #[test]
    fn provider_catalog_exposes_only_the_stable_builtin_schemas() {
        let fixture = Fixture::new();
        let definitions = fixture.runtime.provider_tool_definitions();
        let names = definitions
            .iter()
            .map(|definition| definition.function.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["Read", "Write", "Edit", "Bash", "AskUserQuestion"]
        );
        assert!(definitions.iter().all(|definition| {
            definition.r#type == "function"
                && definition.function.parameters.get("type") == Some(&serde_json::json!("object"))
        }));
    }

    #[test]
    fn interrupting_one_active_tool_cancels_only_its_child_token() {
        let fixture = Fixture::new();
        let context = fixture.run_context();
        let read = context.register_tool("call-read");
        let bash = context.register_tool("call-bash");

        let interrupted = context.cancel_tool("call-bash");

        assert!(interrupted && !read.is_cancelled() && bash.is_cancelled());
    }

    #[tokio::test]
    async fn read_is_auto_allowed_without_an_approval_handler() {
        let fixture = Fixture::new();
        let target = fixture.workspace.path().join("read.txt");
        tokio::fs::write(&target, "readable content")
            .await
            .expect("fixture file must be written");

        let results = fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "Read",
                    serde_json::json!({"files": [{"file_path": "read.txt"}]}),
                )],
                &fixture.run_context(),
            )
            .await;

        assert!(matches!(
            results.as_slice(),
            [result] if matches!(result.result, ToolExecutionResult::Success { .. })
        ));
    }

    #[tokio::test]
    async fn ask_user_returns_the_renderer_answers_to_the_model() {
        let fixture = Fixture::new();
        let context = fixture.run_context_with_ask_user(Some(Arc::new(StaticAskUser)));

        let results = fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "AskUserQuestion",
                    serde_json::json!({
                        "questions": [{
                            "question": "Proceed?",
                            "header": "Confirm",
                            "options": [{"label": "Yes"}, {"label": "No"}]
                        }]
                    }),
                )],
                &context,
            )
            .await;

        assert!(matches!(
            results.as_slice(),
            [result] if matches!(
                &result.result,
                ToolExecutionResult::Success { model_content, .. }
                    if model_content.contains("approved")
            )
        ));
    }

    #[tokio::test]
    async fn invalid_workspace_returns_terminal_pipeline_errors() {
        let fixture = Fixture::new();
        let missing_root = WorkspaceRoot::from_canonical(fixture.workspace.path().join("missing"))
            .expect("absolute missing path can model an invalid upstream authority");
        let context = ChatToolRunContext::new(
            missing_root,
            SessionId::parse("session-1").expect("fixture session id must be valid"),
            StreamId::parse("run-1").expect("fixture run id must be valid"),
            CancellationToken::new(),
            "main".to_string(),
            None,
            None,
        )
        .expect("fixture run context must be valid");

        let results = fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "Read",
                    serde_json::json!({"files": [{"file_path": "read.txt"}]}),
                )],
                &context,
            )
            .await;

        assert!(matches!(
            results.as_slice(),
            [result] if error_code(&result.result) == Some("TOOL_WORKSPACE_INVALID")
        ));
    }

    #[tokio::test]
    async fn effectful_and_unknown_calls_fail_closed_without_an_approval_handler() {
        let fixture = Fixture::new();
        let external = tempfile::tempdir().expect("external fixture directory must be available");
        let external_target = external.path().join("must-not-exist.txt");
        let context = fixture.run_context();
        let results = fixture
            .runtime
            .execute(
                vec![
                    call(
                        1,
                        "Bash",
                        serde_json::json!({"command": "unknown-codez-command argument"}),
                    ),
                    call(
                        0,
                        "Write",
                        serde_json::json!({
                            "file_path": external_target.to_string_lossy(),
                            "content": "blocked"
                        }),
                    ),
                ],
                &context,
            )
            .await;

        assert_eq!(
            results
                .iter()
                .map(|result| error_code(&result.result))
                .collect::<Vec<_>>(),
            vec![
                Some("TOOL_APPROVAL_REQUIRED"),
                Some("TOOL_APPROVAL_REQUIRED")
            ]
        );
        assert!(!external_target.exists());
    }

    #[tokio::test]
    async fn results_are_sorted_by_normalized_call_position() {
        let fixture = Fixture::new();
        let results = fixture
            .runtime
            .execute(
                vec![
                    call(2, "UnknownTwo", serde_json::json!({})),
                    call(0, "UnknownZero", serde_json::json!({})),
                    call(1, "UnknownOne", serde_json::json!({})),
                ],
                &fixture.run_context(),
            )
            .await;

        assert_eq!(
            results
                .iter()
                .map(|result| result.call.position)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }
}
