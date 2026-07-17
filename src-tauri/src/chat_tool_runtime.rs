use std::{
    borrow::Cow,
    collections::HashMap,
    fs,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
};

use codez_contracts::chat::{ChatAskUserAnswer, ChatAskUserQuestion, ChatAskUserRequest};
use codez_core::{
    AppError, AppPaths, AtomicPersistence, CancellationToken, FileSystem, ProcessRunner, SessionId,
    StreamId, WorkspaceRoot,
    context::ContextScopeId,
    provider::{ToolDefinition, ToolDefinitionFunction},
};
use codez_platform::{
    BashDiscoveryError, BashInstallation, NativeFileSystem, NativeProcessRunner, ResourceLocator,
};
use codez_runtime::{
    SearchService,
    edit_transaction::EditTransactionService,
    fingerprint::ReadFingerprintStore,
    mutation_coordinator::FileMutationCoordinator,
    permission::{
        audit::{PermissionAuditError, PermissionAuditLog},
        service::{PermissionApprovalHandler, PermissionService},
        store::{PermissionRuleStore, PermissionStoreError, WorkspacePermissionStore},
    },
    tools::{
        authorization::AuthorizationBinding,
        builtin::{
            bash::{BashHost, BashTool}, edit::EditTool, glob::GlobTool, grep::GrepTool,
            list_files::ListFilesTool, notebook_edit::NotebookEditTool, read::ReadTool,
            write::WriteTool,
        },
        exposure::{ToolCatalogError, ToolCatalogSnapshot},
        journal::{ToolExecutionJournal, ToolJournalIdentity},
        large_result::LargeToolResultStore,
        pipeline::{
            ToolAuthorizationDecision, ToolExecutionPipeline, ToolExecutionPipelineContext,
        },
        processor::ToolResultProcessor,
        registry::{ToolFileServices, ToolHandler},
        spawn::{CommandTaskError, CommandTaskRegistry},
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
    #[error(transparent)]
    Host(#[from] AppError),
    #[error(transparent)]
    CommandTasks(#[from] CommandTaskError),
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
    context_scope_id: ContextScopeId,
    transaction_id: String,
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
            context_scope_id: ContextScopeId::Main,
            transaction_id: format!("tx_{}", uuid::Uuid::new_v4()),
        })
    }

    #[must_use]
    pub(crate) fn has_active_tool(&self, call_id: &str) -> bool {
        self.active_tools.contains(call_id)
    }

    pub(crate) fn cancel_tool(&self, call_id: &str) -> bool {
        self.active_tools.cancel(call_id)
    }

    #[must_use]
    pub(crate) fn transaction_id(&self) -> &str {
        &self.transaction_id
    }

    #[must_use]
    pub(crate) fn context_scope_id(&self) -> &ContextScopeId {
        &self.context_scope_id
    }

    #[must_use]
    pub(crate) fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub(crate) fn run_id(&self) -> &StreamId {
        &self.run_id
    }

    #[must_use]
    pub(crate) fn workspace_root(&self) -> &WorkspaceRoot {
        &self.workspace_root
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
    fingerprint_store: Arc<ReadFingerprintStore>,
    mutation_coordinator: Arc<FileMutationCoordinator>,
    edit_transaction_service: Arc<EditTransactionService>,
    command_tasks: Arc<CommandTaskRegistry>,
    bash: Option<Arc<BashTool>>,
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
        fingerprint_store: Arc<ReadFingerprintStore>,
        mutation_coordinator: Arc<FileMutationCoordinator>,
        edit_transaction_service: Arc<EditTransactionService>,
        process_runner: Arc<NativeProcessRunner>,
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
        let resources = ResourceLocator::new(paths.resource_directory().to_path_buf());
        let process_port: Arc<dyn ProcessRunner> = process_runner.clone();
        let search = Arc::new(SearchService::new(
            resources.ripgrep_executable(),
            process_port,
        )?);
        let command_artifact_root = paths.temporary_directory().join("command-tasks");
        fs::create_dir_all(&command_artifact_root).map_err(|source| {
            AppError::storage(
                "The command task artifact directory could not be initialized",
                format!("create {}: {source}", command_artifact_root.display()),
                false,
            )
        })?;
        let spawned_process_runner = process_runner;
        let command_tasks = Arc::new(CommandTaskRegistry::new(
            spawned_process_runner,
            command_artifact_root,
        )?);
        let bash = compose_bash_tool(Arc::clone(&command_tasks))?;
        let catalog = builtin_catalog(search, bash.clone())?;
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
            fingerprint_store,
            mutation_coordinator,
            edit_transaction_service,
            command_tasks,
            bash,
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

    /// Clears commands, shell workspace state, and permission decisions owned by a session.
    pub(crate) async fn clear_session_state(&self, session_id: &str) -> Result<(), AppError> {
        let command_result = self.command_tasks.clear_session(session_id).await;
        if let Some(bash) = &self.bash {
            bash.clear_session(session_id);
        }
        self.permission.clear_session(session_id).await;
        command_result.map_err(AppError::from)
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
        let file_system =
            match NativeFileSystem::open(run.workspace_root.as_path().to_path_buf()).await {
                Ok(file_system) => file_system,
                Err(error) => {
                    tracing::warn!(error = %error, "chat tool workspace adapter could not open");
                    return calls
                        .into_iter()
                        .map(|call| self.workspace_unavailable_result(call))
                        .collect();
                }
            };
        let file_system: Arc<dyn FileSystem> = Arc::new(file_system);
        let context = PipelineContext {
            runtime: self,
            run,
            file_services: ToolFileServices {
                file_system,
                fingerprint_store: Arc::clone(&self.fingerprint_store),
                mutation_coordinator: Arc::clone(&self.mutation_coordinator),
                edit_transaction_service: Arc::clone(&self.edit_transaction_service),
            },
        };
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

    fn workspace_unavailable_result(&self, call: NormalizedToolCall) -> ToolPipelineResult {
        ToolPipelineResult {
            canonical_name: self.catalog.canonical_name(&call.name).to_string(),
            call,
            result: ToolExecutionResult::Error {
                error: tool_error(
                    "TOOL_WORKSPACE_INVALID",
                    "The workspace is no longer available for tool execution.",
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

fn compose_bash_tool(
    command_tasks: Arc<CommandTaskRegistry>,
) -> Result<Option<Arc<BashTool>>, ChatToolRuntimeError> {
    let installation = match BashInstallation::discover() {
        Ok(installation) => installation,
        Err(BashDiscoveryError::NotFound) => {
            tracing::warn!("Bash is unavailable; omitting it from the Provider tool catalog");
            return Ok(None);
        }
        Err(error) => return Err(AppError::from(error).into()),
    };
    let (executable, environment) = installation.into_parts();
    let host = BashHost::new(command_tasks, executable, environment)?;
    Ok(Some(Arc::new(BashTool::with_host(host))))
}

fn builtin_catalog(
    search: Arc<SearchService>,
    bash: Option<Arc<BashTool>>,
) -> Result<ToolCatalogSnapshot, ToolCatalogError> {
    let mut handlers: Vec<Arc<dyn ToolHandler>> = vec![
        Arc::new(ReadTool::new()),
        Arc::new(WriteTool::new()),
        Arc::new(EditTool::new()),
    ];
    if let Some(bash) = bash {
        handlers.push(bash);
    }
    handlers.extend([
        Arc::new(GlobTool::new(Arc::clone(&search))) as Arc<dyn ToolHandler>,
        Arc::new(GrepTool::new(search)),
        Arc::new(ListFilesTool::new()),
        Arc::new(NotebookEditTool::new()),
    ]);
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
    file_services: ToolFileServices,
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

    fn context_scope_id(&self) -> Cow<'_, str> {
        self.run.context_scope_id.as_key()
    }

    fn transaction_id(&self) -> Option<&str> {
        Some(&self.run.transaction_id)
    }

    fn file_services(&self) -> Option<ToolFileServices> {
        Some(self.file_services.clone())
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
        edit_transaction: Arc<codez_runtime::edit_transaction::EditTransactionService>,
    }

    impl Fixture {
        fn new() -> Self {
            let data = tempfile::tempdir().expect("temporary data directory must be available");
            let workspace =
                tempfile::tempdir().expect("temporary workspace directory must be available");
            let paths = Arc::new(app_paths(data.path()));
            fs::create_dir_all(paths.data_directory())
                .expect("fixture application data directory must be created");
            let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
            let modes = Arc::new(
                WorkspacePermissionStore::new(paths.data_directory(), Arc::clone(&persistence))
                    .expect("fixture permission mode store must be valid"),
            );
            let edit_transaction = Arc::new(
                codez_runtime::edit_transaction::EditTransactionService::new(Arc::clone(&paths)),
            );
            let runtime = ChatToolRuntime::new(
                paths.as_ref(),
                persistence,
                modes,
                Arc::new(codez_runtime::fingerprint::ReadFingerprintStore::default()),
                Arc::new(codez_runtime::mutation_coordinator::FileMutationCoordinator::default()),
                Arc::clone(&edit_transaction),
                Arc::new(NativeProcessRunner::new()),
            )
            .expect("fixture tool runtime must compose");
            Self {
                _data: data,
                workspace,
                runtime,
                edit_transaction,
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

        async fn registered_run_context(&self) -> ChatToolRunContext {
            let context = self.run_context();
            self.edit_transaction
                .register_chat_transaction(
                    context.transaction_id(),
                    codez_runtime::edit_transaction::EditTransactionRegistration {
                        session_id: context.session_id().clone(),
                        context_scope_id: context.context_scope_id().clone(),
                        turn_id: context.run_id().clone(),
                        workspace_root: context.workspace_root().clone(),
                    },
                )
                .await
                .expect("fixture chat transaction must register");
            context
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

        let mut expected = vec!["Read", "Write", "Edit"];
        if fixture.runtime.bash.is_some() {
            expected.push("Bash");
        }
        expected.extend([
            "Glob",
            "Grep",
            "list_files",
            "NotebookEdit",
            "AskUserQuestion",
        ]);
        assert_eq!(names, expected);
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

        assert!(
            matches!(
                results.as_slice(),
                [result] if matches!(result.result, ToolExecutionResult::Success { .. })
            ),
            "unexpected read result: {results:#?}"
        );
    }

    #[tokio::test]
    async fn search_tools_execute_through_the_real_chat_pipeline() {
        let fixture = Fixture::new();
        let source = fixture.workspace.path().join("源代码");
        tokio::fs::create_dir_all(&source)
            .await
            .expect("fixture source directory must be created");
        tokio::fs::write(source.join("z.rs"), "fn z() {}")
            .await
            .expect("fixture z file must be written");
        tokio::fs::write(source.join("a.rs"), "fn a() {}")
            .await
            .expect("fixture a file must be written");

        let results = fixture
            .runtime
            .execute(
                vec![
                    call(
                        0,
                        "Glob",
                        serde_json::json!({"pattern": "*.rs", "path": "源代码"}),
                    ),
                    call(1, "list_files", serde_json::json!({"dirPath": "源代码"})),
                ],
                &fixture.run_context(),
            )
            .await;

        assert!(
            matches!(
                results.as_slice(),
                [
                    codez_runtime::tools::types::ToolPipelineResult {
                        result: ToolExecutionResult::Success { model_content: glob, .. },
                        ..
                    },
                    codez_runtime::tools::types::ToolPipelineResult {
                        result: ToolExecutionResult::Success { model_content: listing, .. },
                        ..
                    }
                ] if glob == "源代码/a.rs\n源代码/z.rs"
                    && listing == "[FILE] a.rs\n[FILE] z.rs"
            ),
            "unexpected search results: {results:#?}"
        );
    }

    #[tokio::test]
    async fn missing_bundled_ripgrep_is_a_typed_tool_error() {
        let fixture = Fixture::new();
        let results = fixture
            .runtime
            .execute(
                vec![call(0, "Grep", serde_json::json!({"pattern": "needle"}))],
                &fixture.run_context(),
            )
            .await;

        assert!(matches!(
            results.as_slice(),
            [result] if error_code(&result.result) == Some("TOOL_SEARCH_UNAVAILABLE")
        ));
    }

    #[tokio::test]
    async fn write_then_edit_in_one_transaction_finishes_without_deadlock() {
        let fixture = Fixture::new();
        let context = fixture.registered_run_context().await;
        let write = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            fixture.runtime.execute(
                vec![call(
                    0,
                    "Write",
                    serde_json::json!({"file_path": "chain.txt", "content": "alpha"}),
                )],
                &context,
            ),
        )
        .await
        .expect("write pipeline must not deadlock");
        assert!(
            matches!(
                write.as_slice(),
                [result] if matches!(result.result, ToolExecutionResult::Success { .. })
            ),
            "unexpected write result: {write:#?}"
        );

        let edit = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            fixture.runtime.execute(
                vec![call(
                    0,
                    "Edit",
                    serde_json::json!({
                        "file_path": "chain.txt",
                        "edits": [{"old_string": "alpha", "new_string": "beta"}]
                    }),
                )],
                &context,
            ),
        )
        .await
        .expect("edit pipeline must not deadlock");
        let statuses = fixture
            .edit_transaction
            .get_file_statuses(context.transaction_id())
            .await
            .expect("transaction status must be readable");

        assert!(
            matches!(
                edit.as_slice(),
                [result] if matches!(result.result, ToolExecutionResult::Success { .. })
            ) && statuses.len() == 1
                && fs::read_to_string(fixture.workspace.path().join("chain.txt"))
                    .expect("mutated file must be readable")
                    == "beta"
        );
    }

    #[tokio::test]
    async fn edit_rejects_a_file_that_was_not_delivered_to_the_context() {
        let fixture = Fixture::new();
        let target = fixture.workspace.path().join("stale.txt");
        fs::write(&target, "original").expect("fixture file must be written");
        let context = fixture.registered_run_context().await;

        let results = fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "Edit",
                    serde_json::json!({
                        "file_path": "stale.txt",
                        "edits": [{"old_string": "original", "new_string": "changed"}]
                    }),
                )],
                &context,
            )
            .await;
        let statuses = fixture
            .edit_transaction
            .get_file_statuses(context.transaction_id())
            .await
            .expect("transaction status must be readable");

        assert!(
            matches!(results.as_slice(), [result] if error_code(&result.result) == Some("TOOL_EDIT_CONFLICT"))
                && statuses.is_empty()
                && fs::read_to_string(target).expect("fixture file must remain readable")
                    == "original"
        );
    }

    #[tokio::test]
    async fn write_rejects_an_external_change_after_read_delivery() {
        let fixture = Fixture::new();
        let target = fixture.workspace.path().join("changed-after-read.txt");
        fs::write(&target, "read version").expect("fixture file must be written");
        let context = fixture.registered_run_context().await;
        let read = fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "Read",
                    serde_json::json!({"files": [{"file_path": "changed-after-read.txt"}]}),
                )],
                &context,
            )
            .await;
        assert!(
            matches!(
                read.as_slice(),
                [result] if matches!(result.result, ToolExecutionResult::Success { .. })
            ),
            "unexpected read result: {read:#?}"
        );
        fs::write(&target, "external version").expect("external change must be written");

        let write = fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "Write",
                    serde_json::json!({
                        "file_path": "changed-after-read.txt",
                        "content": "agent version"
                    }),
                )],
                &context,
            )
            .await;

        assert!(
            matches!(write.as_slice(), [result] if error_code(&result.result) == Some("TOOL_FILE_STALE"))
                && fs::read_to_string(target).expect("external version must remain readable")
                    == "external version"
        );
    }

    #[tokio::test]
    async fn no_op_write_leaves_the_transaction_empty() {
        let fixture = Fixture::new();
        let target = fixture.workspace.path().join("unchanged.txt");
        fs::write(&target, "same").expect("fixture file must be written");
        let context = fixture.registered_run_context().await;
        fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "Read",
                    serde_json::json!({"files": [{"file_path": "unchanged.txt"}]}),
                )],
                &context,
            )
            .await;

        let write = fixture
            .runtime
            .execute(
                vec![call(
                    0,
                    "Write",
                    serde_json::json!({"file_path": "unchanged.txt", "content": "same"}),
                )],
                &context,
            )
            .await;
        let statuses = fixture
            .edit_transaction
            .get_file_statuses(context.transaction_id())
            .await
            .expect("transaction status must be readable");

        assert!(
            matches!(
                write.as_slice(),
                [result] if matches!(result.result, ToolExecutionResult::Success { .. })
            ) && statuses.is_empty(),
            "unexpected no-op write result: {write:#?}; statuses: {statuses:#?}"
        );
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
