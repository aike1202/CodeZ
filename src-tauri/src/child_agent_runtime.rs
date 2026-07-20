use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use async_trait::async_trait;
use chrono::Utc;
use codez_core::agent::{
    AgentFinding, AgentMessage, AgentResult, AgentResultStatus, AgentUsage, AgentValidationResult,
    ChangedArtifact, Confidence,
};
use codez_core::context::{
    AssistantMessagePayload, ContextForkedPayload, ContextScopeId, LedgerAppendRequest,
    LedgerEventType, NormalizedModelMessage, NormalizedToolCall as LedgerToolCall,
    SessionRuntimeScopeSnapshot, ToolResultPayload, UserMessagePayload,
};
use codez_core::provider::{
    ChatMessage, ChatStreamEvent, ProviderTokenUsage, Role, ToolCall, ToolDefinition,
};
use codez_core::{CancellationToken, StreamId, WorkspaceRoot};
use codez_providers::service::ProviderService;
use codez_runtime::agent::{
    AgentExecutionContext, AgentExecutionEvent, AgentExecutionEventSink, AgentExecutor,
    AgentFileChange, AgentLedgerPort, AgentPortError, AgentPromptPort, AgentPromptRequest,
    AgentPromptSnapshot, AgentProviderPort, AgentProviderRequest, AgentProviderTurn,
    AgentScheduler, AgentSupervisor, AgentToolBatchResult, AgentToolPort, AgentToolResult,
    WorkspaceAccess, WorkspaceBroker,
};
use codez_runtime::chat::prompt::types::{
    PromptAgentContext, PromptAgentIdentity, PromptAgentLimits,
};
use codez_runtime::context::{
    budget::{ContextBudgetService, ContextPressureLevel},
    builder::{BuildModelContextItemsInput, build_model_context_items},
    compaction::CompactionStatus,
    ledger::ModelLedgerStore,
    normalizer::ModelHistoryNormalizer,
    provider_adapter::model_context_items_to_chat_messages,
};
use codez_runtime::permission::ai_classifier::PermissionAiContext;
use codez_runtime::permission::service::{
    PermissionApprovalHandler, PermissionApprovalRequest, PermissionApprovalResponse,
};
use codez_runtime::tools::types::{
    DeferredToolSummary, NormalizedToolCall, ToolEffect, ToolExecutionResult, ToolPipelineResult,
};
use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::chat_compaction::{AutoCompactionRequest, compact_active_chat_context};
use crate::chat_runtime::{
    ChatPromptAssembler, ChatPromptBuildInput, MAX_PROVIDER_OPEN_ATTEMPTS, agent_tool_usage,
    is_retryable_provider_open_error, model_context_capabilities, open_provider_stream,
    provider_open_retry_delay, provider_open_retry_reason, render_compaction_summary,
    tool_result_for_model,
};
use crate::chat_tool_runtime::{ChatAgentRunIdentity, ChatToolRunContext, ChatToolRuntime};

const WORKER_COUNT: usize = 4;
const SUBMIT_AGENT_RESULT: &str = "submit_agent_result";

pub(crate) struct ChildAgentRuntime {
    supervisor: Arc<AgentSupervisor>,
    executor: Arc<AgentExecutor>,
    events: Arc<dyn AgentExecutionEventSink>,
    scheduler: Arc<AgentScheduler>,
    cancellation: CancellationToken,
    started: AtomicBool,
}

pub(crate) struct ChildAgentRuntimeDependencies {
    pub(crate) providers: Arc<ProviderService>,
    pub(crate) tools: Arc<ChatToolRuntime>,
    pub(crate) ledger: Arc<ModelLedgerStore>,
    pub(crate) prompt: Arc<ChatPromptAssembler>,
    pub(crate) events: Arc<dyn AgentExecutionEventSink>,
    pub(crate) workspace_broker: Option<Arc<WorkspaceBroker>>,
    pub(crate) cancellation: CancellationToken,
    pub(crate) interaction: Option<ChildAgentInteractionDependencies>,
}

#[derive(Clone)]
pub(crate) struct ChildAgentInteractionDependencies {
    pub(crate) app: AppHandle,
    pub(crate) chat_runtime: Arc<crate::chat_runtime::ChatRuntime>,
}

impl ChildAgentRuntime {
    #[must_use]
    pub(crate) fn new(
        supervisor: Arc<AgentSupervisor>,
        dependencies: ChildAgentRuntimeDependencies,
    ) -> Self {
        let ChildAgentRuntimeDependencies {
            providers,
            tools,
            ledger,
            prompt,
            events,
            workspace_broker,
            cancellation,
            interaction,
        } = dependencies;
        let context_factory = Arc::new(ChildRunContextFactory::new(
            Arc::clone(&tools),
            interaction,
            Arc::clone(&events),
        ));
        let executor = Arc::new(AgentExecutor::new(
            Arc::clone(&supervisor),
            Arc::new(DesktopAgentProvider {
                providers: Arc::clone(&providers),
                ledger: Arc::clone(&ledger),
            }),
            Arc::new(DesktopAgentTools {
                tools,
                contexts: Arc::clone(&context_factory),
                workspace_broker,
                observed_validations: Mutex::new(HashMap::new()),
            }),
            Arc::new(DesktopAgentLedger {
                store: Arc::clone(&ledger),
            }),
            Arc::new(DesktopAgentPrompt {
                prompt,
                supervisor: Arc::clone(&supervisor),
                contexts: context_factory,
                providers,
                store: Arc::clone(&ledger),
            }),
            Arc::clone(&events),
        ));
        Self {
            scheduler: Arc::clone(supervisor.scheduler()),
            supervisor,
            executor,
            events,
            cancellation,
            started: AtomicBool::new(false),
        }
    }

    pub(crate) fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        for worker_index in 0..WORKER_COUNT {
            let runtime = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                runtime.run_worker(worker_index).await;
            });
        }
    }

    async fn run_worker(self: &Arc<Self>, worker_index: usize) {
        let runtime = Arc::clone(self);
        run_dispatch_worker(
            Arc::clone(&self.scheduler),
            self.cancellation.clone(),
            worker_index,
            Arc::new(move |worker_index, scheduled, cancellation| {
                let runtime = Arc::clone(&runtime);
                async move {
                    runtime
                        .execute_scheduled(worker_index, scheduled, cancellation)
                        .await;
                }
            }),
        )
        .await;
    }

    async fn execute_scheduled(
        &self,
        worker_index: usize,
        scheduled: codez_runtime::agent::ScheduledAgent,
        cancellation: CancellationToken,
    ) {
        if let Err(error) = self.executor.execute(scheduled.clone(), cancellation).await {
            let snapshot = self.supervisor.store().load(&scheduled.root_run_id).await;
            if let Ok(snapshot) = &snapshot
                && let (Some(node), Some(attempt)) = (
                    snapshot.nodes.get(&scheduled.agent_id),
                    snapshot.attempts.get(&scheduled.attempt_id),
                )
            {
                self.events.publish(
                    &AgentExecutionContext {
                        node: node.clone(),
                        attempt: attempt.clone(),
                    },
                    AgentExecutionEvent::ErrorRaised {
                        code: "AGENT_EXECUTION_FAILED".to_string(),
                        message: error.to_string(),
                    },
                );
            }
            let terminal = snapshot.as_ref().ok().and_then(|snapshot| {
                snapshot
                    .nodes
                    .get(&scheduled.agent_id)
                    .map(|node| node.state.is_terminal())
            });
            if terminal != Some(true) {
                tracing::error!(
                    worker_index,
                    root_run_id = %scheduled.root_run_id,
                    agent_id = %scheduled.agent_id,
                    attempt_id = %scheduled.attempt_id,
                    diagnostic = %error,
                    "child Agent execution failed before a terminal state was persisted"
                );
            }
        }
    }
}

async fn run_dispatch_worker<F, Fut>(
    scheduler: Arc<AgentScheduler>,
    cancellation: CancellationToken,
    worker_index: usize,
    dispatch: Arc<F>,
) where
    F: Fn(usize, codez_runtime::agent::ScheduledAgent, CancellationToken) -> Fut
        + Send
        + Sync
        + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    loop {
        let scheduled = tokio::select! {
            () = cancellation.cancelled() => break,
            scheduled = scheduler.next() => scheduled,
        };
        let future = dispatch(worker_index, scheduled, cancellation.child_token());
        tokio::spawn(future);
    }
}

struct DesktopAgentProvider {
    providers: Arc<ProviderService>,
    ledger: Arc<ModelLedgerStore>,
}

#[async_trait]
impl AgentProviderPort for DesktopAgentProvider {
    async fn run_turn(
        &self,
        request: AgentProviderRequest,
        events: &dyn AgentExecutionEventSink,
        cancellation: CancellationToken,
    ) -> Result<AgentProviderTurn, AgentPortError> {
        let AgentProviderRequest {
            context,
            system_prompt,
            messages,
            tools,
        } = request;
        let mut history_messages = messages;
        let mut overflow_retried = false;
        let mut threshold_checked = false;
        'provider_turn: loop {
            let mut open_attempt = 1_u32;
            let (mut stream, overflow) = loop {
                let resolved = self
                    .providers
                    .resolve_chat_config(
                        Some(&context.attempt.provider_id),
                        Some(&context.attempt.model_id),
                    )
                    .await
                    .map_err(|error| port_error("AGENT_PROVIDER_RESOLVE_FAILED", error, false))?;
                let overflow = ChildOverflowCompaction::from_resolved(&resolved);
                if !threshold_checked {
                    threshold_checked = true;
                    if child_request_requires_compaction(
                        &system_prompt.text,
                        &history_messages,
                        &tools,
                        &overflow,
                    )? && self
                        .compact_context(
                            &context,
                            &overflow,
                            "auto_threshold",
                            events,
                            cancellation.clone(),
                        )
                        .await?
                    {
                        history_messages = load_agent_messages(&self.ledger, &context).await?;
                        continue 'provider_turn;
                    }
                }
                let mut provider_messages = Vec::with_capacity(history_messages.len() + 1);
                provider_messages.push(ChatMessage {
                    role: Role::System,
                    content: Some(system_prompt.text.clone()),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    images: Vec::new(),
                });
                provider_messages.extend(history_messages.clone());
                match open_provider_stream(
                    resolved,
                    provider_messages,
                    (!tools.is_empty()).then(|| tools.clone()),
                    cancellation.clone(),
                )
                .await
                {
                    Ok(stream) => break (stream, overflow),
                    Err(error @ codez_providers::chat::ChatProviderError::ContextOverflow(_))
                        if !overflow_retried =>
                    {
                        overflow_retried = true;
                        if self
                            .compact_context(
                                &context,
                                &overflow,
                                "provider_overflow",
                                events,
                                cancellation.clone(),
                            )
                            .await?
                        {
                            history_messages = load_agent_messages(&self.ledger, &context).await?;
                            continue 'provider_turn;
                        }
                        return Err(port_error("AGENT_PROVIDER_OPEN_FAILED", error, false));
                    }
                    Err(error) => {
                        let Some(delay) = provider_open_retry_delay(
                            &error,
                            open_attempt,
                            context.attempt.id.as_str(),
                        ) else {
                            let retryable = is_retryable_provider_open_error(&error);
                            return Err(port_error("AGENT_PROVIDER_OPEN_FAILED", error, retryable));
                        };
                        events.publish(
                            &context,
                            AgentExecutionEvent::ProviderRetryScheduled {
                                attempt: open_attempt,
                                max_attempts: MAX_PROVIDER_OPEN_ATTEMPTS,
                                delay_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                                reason: provider_open_retry_reason(&error).to_string(),
                            },
                        );
                        tracing::warn!(
                            provider_id = context.attempt.provider_id.as_str(),
                            model = context.attempt.model_id.as_str(),
                            attempt = open_attempt,
                            delay_ms = delay.as_millis(),
                            diagnostic = %error,
                            "transient child Agent Provider open failure; retrying"
                        );
                        tokio::select! {
                            biased;
                            () = cancellation.cancelled() => {
                                return Err(AgentPortError::new(
                                    "AGENT_PROVIDER_CANCELLED",
                                    "Agent Provider request was cancelled",
                                    false,
                                ));
                            }
                            () = tokio::time::sleep(delay) => {}
                        }
                        open_attempt = open_attempt.saturating_add(1);
                    }
                }
            };
            let mut content = String::new();
            let mut tool_calls = Vec::new();
            let mut usage = None;
            loop {
                let event = tokio::select! {
                    () = cancellation.cancelled() => {
                        return Err(AgentPortError::new(
                            "AGENT_PROVIDER_CANCELLED",
                            "Agent Provider request was cancelled",
                            false,
                        ));
                    }
                    event = stream.next() => event,
                };
                match event {
                    Some(Ok(ChatStreamEvent::Chunk {
                        delta,
                        reasoning_delta,
                        tool_calls: emitted_calls,
                        ..
                    })) => {
                        content.push_str(&delta);
                        if !delta.is_empty() {
                            events.publish(&context, AgentExecutionEvent::AssistantDelta(delta));
                        }
                        if let Some(reasoning) = reasoning_delta.filter(|value| !value.is_empty()) {
                            events
                                .publish(&context, AgentExecutionEvent::ReasoningDelta(reasoning));
                        }
                        if let Some(calls) = emitted_calls {
                            tool_calls.extend(calls);
                        }
                    }
                    Some(Ok(ChatStreamEvent::Usage(next))) => {
                        usage = Some(merge_usage(usage.take(), &next));
                    }
                    Some(Ok(ChatStreamEvent::Done {
                        full_content,
                        stop_reason,
                        ..
                    })) => {
                        if !full_content.is_empty() {
                            content = full_content;
                        }
                        return Ok(AgentProviderTurn {
                            content,
                            tool_calls,
                            usage,
                            stop_reason,
                        });
                    }
                    Some(Err(
                        error @ codez_providers::chat::ChatProviderError::ContextOverflow(_),
                    )) if !overflow_retried && content.is_empty() => {
                        overflow_retried = true;
                        if self
                            .compact_context(
                                &context,
                                &overflow,
                                "provider_overflow",
                                events,
                                cancellation.clone(),
                            )
                            .await?
                        {
                            history_messages = load_agent_messages(&self.ledger, &context).await?;
                            continue 'provider_turn;
                        }
                        return Err(port_error("AGENT_PROVIDER_STREAM_FAILED", error, false));
                    }
                    Some(Err(error)) => {
                        let retryable = is_retryable_provider_open_error(&error);
                        return Err(port_error("AGENT_PROVIDER_STREAM_FAILED", error, retryable));
                    }
                    None => {
                        return Err(AgentPortError::new(
                            "AGENT_PROVIDER_STREAM_INCOMPLETE",
                            "Agent Provider stream ended without a terminal event",
                            true,
                        ));
                    }
                }
            }
        }
    }
}

struct ChildOverflowCompaction {
    capabilities: codez_runtime::context::budget::ModelContextCapabilities,
    reasoning_budget_tokens: Option<u32>,
    provider_id: String,
    model_id: String,
}

impl ChildOverflowCompaction {
    fn from_resolved(resolved: &codez_providers::service::ResolvedProviderChatConfig) -> Self {
        Self {
            capabilities: model_context_capabilities(resolved),
            reasoning_budget_tokens: resolved.thinking.budget_tokens,
            provider_id: resolved.provider_id.clone(),
            model_id: resolved.model.id.clone(),
        }
    }
}

fn child_request_requires_compaction(
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    context: &ChildOverflowCompaction,
) -> Result<bool, AgentPortError> {
    let limits = ContextBudgetService::resolve_limits(
        &context.capabilities,
        context.reasoning_budget_tokens.unwrap_or_default(),
    );
    let message_tokens = ContextBudgetService::estimate_value_tokens(&messages)
        .map_err(|error| port_error("AGENT_CONTEXT_MEASURE_FAILED", error, false))?;
    let tool_tokens = ContextBudgetService::estimate_value_tokens(&tools)
        .map_err(|error| port_error("AGENT_CONTEXT_MEASURE_FAILED", error, false))?;
    let total_tokens = ContextBudgetService::estimate_string_tokens(system_prompt)
        .saturating_add(message_tokens)
        .saturating_add(tool_tokens);
    Ok(matches!(
        ContextBudgetService::pressure_level_for_tokens(
            total_tokens,
            limits.usable_input_budget,
            total_tokens,
        ),
        ContextPressureLevel::Compact | ContextPressureLevel::Overflow
    ))
}

impl DesktopAgentProvider {
    async fn compact_context(
        &self,
        context: &AgentExecutionContext,
        overflow: &ChildOverflowCompaction,
        trigger: &'static str,
        events: &dyn AgentExecutionEventSink,
        cancellation: CancellationToken,
    ) -> Result<bool, AgentPortError> {
        let scope = load_agent_scope(&self.ledger, context).await?;
        let required_message_id = scope
            .active_messages
            .iter()
            .rev()
            .find(|message| matches!(message.role.as_str(), "user" | "system"))
            .map(|message| message.id.clone())
            .ok_or_else(|| {
                AgentPortError::new(
                    "AGENT_CONTEXT_INPUT_MISSING",
                    "Agent context has no durable input message for overflow recovery",
                    false,
                )
            })?;
        events.publish(
            context,
            AgentExecutionEvent::ContextCompactionStarted {
                trigger: trigger.to_string(),
                history_version: scope.history_version,
            },
        );
        let scope_id = ContextScopeId::Agent(context.node.id.clone());
        let result = compact_active_chat_context(
            Arc::clone(&self.providers),
            Arc::clone(&self.ledger),
            cancellation,
            AutoCompactionRequest {
                session_id: &context.node.root_session_id,
                context_scope_id: &scope_id,
                trigger,
                capabilities: overflow.capabilities.clone(),
                reasoning_budget_tokens: overflow.reasoning_budget_tokens,
                provider_id: &overflow.provider_id,
                model: &overflow.model_id,
                required_message_id: &required_message_id,
            },
        )
        .await
        .map_err(|error| port_error("AGENT_CONTEXT_COMPACTION_FAILED", error, false))?;
        match result.status {
            CompactionStatus::Completed => {
                events.publish(
                    context,
                    AgentExecutionEvent::ContextCompactionCompleted {
                        trigger: trigger.to_string(),
                        tokens_before: result.tokens_before,
                        tokens_after: result.tokens_after,
                        history_version: result.history_version,
                    },
                );
                Ok(true)
            }
            CompactionStatus::Failed => {
                events.publish(
                    context,
                    AgentExecutionEvent::ContextCompactionFailed {
                        trigger: trigger.to_string(),
                        code: result
                            .error_code
                            .as_ref()
                            .map_or_else(|| "COMPACTION_FAILED".to_string(), ToString::to_string),
                        message: result.message.unwrap_or_else(|| {
                            "Context compaction failed without a durable reason".to_string()
                        }),
                        retryable: result.retryable.unwrap_or(false),
                        history_version: result.history_version,
                    },
                );
                Ok(false)
            }
        }
    }
}

struct ChildRunContextFactory {
    tools: Arc<ChatToolRuntime>,
    interaction: Option<ChildAgentInteractionDependencies>,
    events: Arc<dyn AgentExecutionEventSink>,
}

impl ChildRunContextFactory {
    fn new(
        tools: Arc<ChatToolRuntime>,
        interaction: Option<ChildAgentInteractionDependencies>,
        events: Arc<dyn AgentExecutionEventSink>,
    ) -> Self {
        Self {
            tools,
            interaction,
            events,
        }
    }

    fn create(
        &self,
        context: &AgentExecutionContext,
        cancellation: CancellationToken,
    ) -> Result<ChatToolRunContext, AgentPortError> {
        let canonical = dunce::canonicalize(&context.node.workspace.root)
            .map_err(|error| port_error("AGENT_WORKSPACE_UNAVAILABLE", error, false))?;
        let workspace_root = WorkspaceRoot::from_canonical(canonical)
            .map_err(|error| port_error("AGENT_WORKSPACE_INVALID", error, false))?;
        let run_id = StreamId::parse(context.attempt.id.to_string())
            .map_err(|error| port_error("AGENT_ATTEMPT_ID_INVALID", error, false))?;
        let (approval_handler, ask_user_handler) =
            self.interaction
                .as_ref()
                .map_or((None, None), |interaction| {
                    let approval = interaction.chat_runtime.agent_permission_handler(
                        interaction.app.clone(),
                        run_id.clone(),
                        cancellation.clone(),
                    );
                    let approval: Arc<dyn PermissionApprovalHandler> =
                        Arc::new(ProjectedPermissionApprovalHandler {
                            inner: approval,
                            context: context.clone(),
                            events: Arc::clone(&self.events),
                        });
                    let ask_user = interaction.chat_runtime.agent_ask_user_handler(
                        interaction.app.clone(),
                        run_id.clone(),
                        cancellation.clone(),
                    );
                    (Some(approval), Some(ask_user))
                });
        ChatToolRunContext::new(
            workspace_root,
            context.node.root_session_id.clone(),
            run_id,
            cancellation,
            format!("agent:{}", context.node.id),
            PermissionAiContext {
                provider_id: Some(context.attempt.provider_id.clone()),
                model: Some(context.attempt.model_id.clone()),
                user_intent: Some(context.node.task.objective.clone()),
            },
            Some(ChatAgentRunIdentity {
                root_run_id: context.node.root_run_id.clone(),
                agent_id: context.node.id.clone(),
                attempt_id: context.attempt.id.clone(),
                depth: context.node.depth,
                policy: context.node.policy.clone(),
                provider_id: context.attempt.provider_id.clone(),
                model_id: context.attempt.model_id.clone(),
            }),
            approval_handler,
            ask_user_handler,
        )
        .map_err(|error| port_error("AGENT_TOOL_CONTEXT_INVALID", error, false))
    }

    fn surface(
        &self,
        context: &AgentExecutionContext,
    ) -> Result<(Vec<ToolDefinition>, Vec<DeferredToolSummary>), AgentPortError> {
        let run = self.create(context, CancellationToken::new())?;
        let surface = self.tools.provider_tool_surface_for_run(&run);
        Ok((surface.definitions, surface.deferred_tools))
    }
}

struct ProjectedPermissionApprovalHandler {
    inner: Arc<dyn PermissionApprovalHandler>,
    context: AgentExecutionContext,
    events: Arc<dyn AgentExecutionEventSink>,
}

#[async_trait]
impl PermissionApprovalHandler for ProjectedPermissionApprovalHandler {
    async fn request(
        &self,
        request: &PermissionApprovalRequest,
    ) -> Result<PermissionApprovalResponse, Box<dyn std::error::Error + Send + Sync>> {
        self.events.publish(
            &self.context,
            AgentExecutionEvent::PermissionRequested {
                request_id: request.id.clone(),
                summary: bounded_permission_summary(&format!(
                    "{}: {}",
                    request.tool_name, request.description
                )),
            },
        );
        let response = self.inner.request(request).await;
        self.events.publish(
            &self.context,
            AgentExecutionEvent::PermissionResolved {
                request_id: request.id.clone(),
                approved: response.as_ref().is_ok_and(|response| response.approved),
            },
        );
        response
    }
}

fn bounded_permission_summary(value: &str) -> String {
    const MAX_CHARS: usize = 512;
    value.chars().take(MAX_CHARS).collect()
}

struct DesktopAgentTools {
    tools: Arc<ChatToolRuntime>,
    contexts: Arc<ChildRunContextFactory>,
    workspace_broker: Option<Arc<WorkspaceBroker>>,
    observed_validations: Mutex<HashMap<String, Vec<ObservedValidationCheck>>>,
}

#[derive(Clone)]
struct ObservedValidationCheck {
    command_or_check: String,
    status: String,
    tool_call_id: String,
}

#[async_trait]
impl AgentToolPort for DesktopAgentTools {
    async fn definitions(
        &self,
        context: &AgentExecutionContext,
        _finalization_required: bool,
    ) -> Result<Vec<ToolDefinition>, AgentPortError> {
        let (mut definitions, _) = self.contexts.surface(context)?;
        definitions.push(submit_result_definition());
        Ok(definitions)
    }

    async fn execute(
        &self,
        context: &AgentExecutionContext,
        calls: Vec<ToolCall>,
        cancellation: CancellationToken,
    ) -> Result<AgentToolBatchResult, AgentPortError> {
        if let Some(submit) = calls
            .iter()
            .find(|call| call.function.name == SUBMIT_AGENT_RESULT)
        {
            if calls.len() != 1 {
                return Err(AgentPortError::new(
                    "AGENT_RESULT_BATCH_INVALID",
                    "submit_agent_result must be the only tool call in its batch",
                    false,
                ));
            }
            let submitted: SubmittedAgentResult = serde_json::from_str(&submit.function.arguments)
                .map_err(|error| port_error("AGENT_RESULT_INPUT_INVALID", error, false))?;
            let mut submitted = submitted.into_result();
            submitted.validations = reconcile_submitted_validations(
                submitted.validations,
                &self.validation_snapshot(context)?,
            );
            submitted.changes = if context.node.workspace.mode
                == codez_core::agent::WorkspaceMode::IsolatedWorktree
            {
                let broker = self.workspace_broker.as_ref().ok_or_else(|| {
                    AgentPortError::new(
                        "AGENT_WORKSPACE_BROKER_UNAVAILABLE",
                        "Agent workspace change verification is unavailable",
                        false,
                    )
                })?;
                let changes = broker
                    .workspace_changes(&context.attempt.id, cancellation)
                    .await
                    .map_err(|error| {
                        port_error("AGENT_WORKSPACE_CHANGE_SCAN_FAILED", error, false)
                    })?
                    .into_iter()
                    .map(|change| ChangedArtifact {
                        path: change.path,
                        kind: change.kind,
                        purpose: "Runtime-observed isolated workspace change".to_string(),
                    })
                    .collect();
                let artifact = broker
                    .artifacts(&context.attempt.id, 0)
                    .await
                    .map_err(|error| port_error("AGENT_WORKSPACE_ARTIFACT_FAILED", error, false))?
                    .into_iter()
                    .find(|artifact| artifact.kind == "child_patch")
                    .ok_or_else(|| {
                        AgentPortError::new(
                            "AGENT_WORKSPACE_ARTIFACT_MISSING",
                            "Runtime-observed child patch was not persisted",
                            false,
                        )
                    })?;
                if !submitted.artifact_refs.contains(&artifact.artifact_id) {
                    submitted.artifact_refs.push(artifact.artifact_id);
                }
                changes
            } else {
                Vec::new()
            };
            return Ok(AgentToolBatchResult {
                results: vec![AgentToolResult {
                    call_id: submit.id.clone(),
                    name: SUBMIT_AGENT_RESULT.to_string(),
                    model_content: "Agent result accepted.".to_string(),
                    status: "success".to_string(),
                    file_changes: Vec::new(),
                    usage: Default::default(),
                }],
                submitted_result: Some(submitted),
            });
        }
        self.authorize_workspace_calls(context, &calls).await?;
        let normalized = calls
            .into_iter()
            .enumerate()
            .map(|(position, call)| NormalizedToolCall {
                call_id: call.id,
                position,
                name: call.function.name,
                raw_arguments: call.function.arguments,
                thought_signature: call.thought_signature,
            })
            .collect();
        let run = self.contexts.create(context, cancellation)?;
        let results = self.tools.execute(normalized, &run).await;
        self.record_observed_validations(context, &results)?;
        let transaction_id = run.transaction_id().to_string();
        Ok(AgentToolBatchResult {
            results: results
                .into_iter()
                .map(|result| {
                    let (model_content, status) = tool_result_for_model(&result);
                    if result.canonical_name == crate::agent_tool_runtime::SEND_AGENT_MESSAGE
                        && status == "success"
                    {
                        match serde_json::from_str::<AgentMessage>(&model_content) {
                            Ok(message) => self
                                .contexts
                                .events
                                .publish(context, AgentExecutionEvent::MessageSent(message)),
                            Err(error) => tracing::warn!(
                                diagnostic = %error,
                                "durable Agent message result could not be projected"
                            ),
                        }
                    }
                    let file_changes = tool_file_changes(&result, &transaction_id);
                    AgentToolResult {
                        usage: agent_tool_usage(&result),
                        call_id: result.call.call_id,
                        name: result.canonical_name,
                        model_content,
                        status: status.to_string(),
                        file_changes,
                    }
                })
                .collect(),
            submitted_result: None,
        })
    }
}

impl DesktopAgentTools {
    fn record_observed_validations(
        &self,
        context: &AgentExecutionContext,
        results: &[ToolPipelineResult],
    ) -> Result<(), AgentPortError> {
        let observed = results
            .iter()
            .filter_map(observed_validation_check)
            .collect::<Vec<_>>();
        if observed.is_empty() {
            return Ok(());
        }
        let mut by_attempt = self.observed_validations.lock().map_err(|_| {
            AgentPortError::new(
                "AGENT_VALIDATION_INDEX_UNAVAILABLE",
                "Agent validation evidence index is unavailable",
                false,
            )
        })?;
        let checks = by_attempt
            .entry(context.attempt.id.to_string())
            .or_default();
        for check in observed {
            if let Some(previous) = checks
                .iter_mut()
                .find(|previous| previous.command_or_check == check.command_or_check)
            {
                *previous = check;
            } else {
                checks.push(check);
            }
        }
        Ok(())
    }

    fn validation_snapshot(
        &self,
        context: &AgentExecutionContext,
    ) -> Result<Vec<ObservedValidationCheck>, AgentPortError> {
        self.observed_validations
            .lock()
            .map_err(|_| {
                AgentPortError::new(
                    "AGENT_VALIDATION_INDEX_UNAVAILABLE",
                    "Agent validation evidence index is unavailable",
                    false,
                )
            })
            .map(|by_attempt| {
                by_attempt
                    .get(&context.attempt.id.to_string())
                    .cloned()
                    .unwrap_or_default()
            })
    }
}

fn observed_validation_check(result: &ToolPipelineResult) -> Option<ObservedValidationCheck> {
    if !matches!(
        result.canonical_name.as_str(),
        "Bash" | "PowerShell" | "run_command"
    ) {
        return None;
    }
    let raw_arguments = serde_json::from_str::<serde_json::Value>(&result.call.raw_arguments).ok();
    let ToolExecutionResult::Success { data, .. } = &result.result else {
        let command = raw_arguments
            .as_ref()
            .and_then(|arguments| arguments.get("command"))
            .and_then(serde_json::Value::as_str)?
            .trim();
        return (!command.is_empty()).then(|| ObservedValidationCheck {
            command_or_check: command.to_string(),
            status: "not_run".to_string(),
            tool_call_id: result.call.call_id.clone(),
        });
    };
    let data = data.as_ref();
    let command = data
        .and_then(|data| data.get("command"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            raw_arguments
                .as_ref()
                .and_then(|arguments| arguments.get("command"))
                .and_then(serde_json::Value::as_str)
        })?
        .trim();
    if command.is_empty() {
        return None;
    }
    let status = match data
        .and_then(|data| data.get("status"))
        .and_then(serde_json::Value::as_str)
    {
        Some("completed") => "passed",
        Some("failed" | "interrupted") => "failed",
        Some("running") => "not_run",
        _ => match data
            .and_then(|data| data.get("exitCode"))
            .and_then(serde_json::Value::as_i64)
        {
            Some(0) => "passed",
            Some(_) => "failed",
            None => "not_run",
        },
    };
    Some(ObservedValidationCheck {
        command_or_check: command.to_string(),
        status: status.to_string(),
        tool_call_id: result.call.call_id.clone(),
    })
}

fn reconcile_submitted_validations(
    submitted: Vec<AgentValidationResult>,
    observed: &[ObservedValidationCheck],
) -> Vec<AgentValidationResult> {
    submitted
        .into_iter()
        .map(|submitted| {
            let command_or_check = submitted.command_or_check.trim().to_string();
            let matched = observed
                .iter()
                .rev()
                .find(|check| check.command_or_check.trim() == command_or_check);
            AgentValidationResult {
                command_or_check,
                status: matched
                    .map_or("not_run", |check| check.status.as_str())
                    .to_string(),
                tool_call_id: matched.map(|check| check.tool_call_id.clone()),
                evidence_ref: None,
            }
        })
        .collect()
}

fn tool_file_changes(result: &ToolPipelineResult, transaction_id: &str) -> Vec<AgentFileChange> {
    let ToolExecutionResult::Success { effects, .. } = &result.result else {
        return Vec::new();
    };
    effects
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|effect| match effect {
            ToolEffect::WriteFile { path, mode } => Some(AgentFileChange {
                path: path.clone(),
                change_kind: mode.clone(),
                transaction_id: transaction_id.to_string(),
            }),
            ToolEffect::DeleteFile { path } => Some(AgentFileChange {
                path: path.clone(),
                change_kind: "delete".to_string(),
                transaction_id: transaction_id.to_string(),
            }),
            _ => None,
        })
        .collect()
}

impl DesktopAgentTools {
    async fn authorize_workspace_calls(
        &self,
        context: &AgentExecutionContext,
        calls: &[ToolCall],
    ) -> Result<(), AgentPortError> {
        if context.node.workspace.mode == codez_core::agent::WorkspaceMode::RootWorkspace {
            return Ok(());
        }
        for call in calls {
            let Some(access) = tool_workspace_access(&call.function.name) else {
                continue;
            };
            if matches!(
                call.function.name.as_str(),
                "Bash" | "PowerShell" | "run_command"
            ) {
                if access == WorkspaceAccess::Write
                    && context.node.workspace.write_scope.as_slice() != ["**/*"]
                {
                    return Err(AgentPortError::new(
                        "AGENT_WORKSPACE_COMMAND_SCOPE_DENIED",
                        "Shell tools require a full isolated-worktree write scope",
                        false,
                    ));
                }
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(&call.function.arguments)
                .map_err(|error| port_error("AGENT_TOOL_INPUT_INVALID", error, false))?;
            let paths = workspace_paths(&value);
            if access == WorkspaceAccess::Write && paths.is_empty() {
                return Err(AgentPortError::new(
                    "AGENT_WORKSPACE_PATH_REQUIRED",
                    format!(
                        "{} did not expose a verifiable target path",
                        call.function.name
                    ),
                    false,
                ));
            }
            for path in paths {
                let requested = std::path::Path::new(&path);
                let authorized = if let Some(broker) = self.workspace_broker.as_ref() {
                    broker
                        .authorize_path(&context.node.workspace, requested, access)
                        .await
                } else {
                    WorkspaceBroker::authorize_assignment_path(
                        &context.node.workspace,
                        requested,
                        access,
                    )
                    .await
                };
                authorized
                    .map_err(|error| port_error("AGENT_WORKSPACE_SCOPE_DENIED", error, false))?;
            }
        }
        Ok(())
    }
}

fn tool_workspace_access(name: &str) -> Option<WorkspaceAccess> {
    if matches!(
        name,
        "Edit"
            | "Write"
            | "NotebookEdit"
            | "apply_patch"
            | "write_to_file"
            | "replace_file_content"
            | "multi_replace_file_content"
            | "Bash"
            | "PowerShell"
            | "run_command"
    ) {
        return Some(WorkspaceAccess::Write);
    }
    if matches!(
        name,
        "Read"
            | "read_file"
            | "read_files"
            | "Grep"
            | "Glob"
            | "list_files"
            | "list_dir"
            | "search_text"
            | "search_code"
    ) {
        return Some(WorkspaceAccess::Read);
    }
    None
}

fn workspace_paths(value: &serde_json::Value) -> Vec<String> {
    const PATH_KEYS: &[&str] = &[
        "file_path",
        "filePath",
        "path",
        "notebook_path",
        "targetFile",
        "TargetFile",
        "directoryPath",
        "DirectoryPath",
        "searchPath",
        "SearchPath",
    ];
    const PATH_ARRAY_KEYS: &[&str] = &[
        "filePaths",
        "targetPaths",
        "TargetPaths",
        "dirPaths",
        "files",
    ];
    let mut paths = Vec::new();
    let Some(object) = value.as_object() else {
        return paths;
    };
    for key in PATH_KEYS {
        if let Some(path) = object
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .filter(|path| !path.trim().is_empty())
        {
            paths.push(path.to_string());
        }
    }
    for key in PATH_ARRAY_KEYS {
        let Some(values) = object.get(*key).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for value in values {
            if let Some(path) = value.as_str().filter(|path| !path.trim().is_empty()) {
                paths.push(path.to_string());
            } else {
                paths.extend(workspace_paths(value));
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

struct DesktopAgentPrompt {
    prompt: Arc<ChatPromptAssembler>,
    supervisor: Arc<AgentSupervisor>,
    contexts: Arc<ChildRunContextFactory>,
    providers: Arc<ProviderService>,
    store: Arc<ModelLedgerStore>,
}

#[async_trait]
impl AgentPromptPort for DesktopAgentPrompt {
    async fn compose(
        &self,
        request: AgentPromptRequest,
    ) -> Result<AgentPromptSnapshot, AgentPortError> {
        let resolved = self
            .providers
            .resolve_chat_config(
                Some(&request.context.attempt.provider_id),
                Some(&request.context.attempt.model_id),
            )
            .await
            .map_err(|error| port_error("AGENT_PROMPT_PROVIDER_FAILED", error, false))?;
        let run = self
            .contexts
            .create(&request.context, CancellationToken::new())?;
        let mut surface = self.contexts.tools.provider_tool_surface_for_run(&run);
        surface.definitions.push(submit_result_definition());
        let loaded = self
            .store
            .load(&request.context.node.root_session_id)
            .await
            .map_err(|error| port_error("AGENT_PROMPT_LEDGER_FAILED", error, false))?;
        let scope_id = ContextScopeId::Agent(request.context.node.id.clone());
        let scope_key = scope_id.as_key();
        let scope = loaded
            .as_ref()
            .and_then(|loaded| loaded.snapshot.scopes.get(scope_key.as_ref()))
            .cloned()
            .unwrap_or_else(empty_scope);
        let snapshot = self
            .supervisor
            .store()
            .load(&request.context.node.root_run_id)
            .await
            .map_err(|error| port_error("AGENT_PROMPT_CONTROL_FAILED", error, false))?;
        let direct_children = snapshot.children_of(&request.context.node.id).len();
        let remaining_direct_children = request
            .context
            .node
            .policy
            .max_direct_children
            .saturating_sub(saturating_u16(direct_children));
        let prompt_agent = PromptAgentContext {
            identity: PromptAgentIdentity {
                root_run_id: request.context.node.root_run_id.to_string(),
                agent_id: request.context.node.id.to_string(),
                attempt_id: request.context.attempt.id.to_string(),
                parent_agent_id: request
                    .context
                    .node
                    .parent_id
                    .as_ref()
                    .map(ToString::to_string),
                depth: request.context.node.depth,
            },
            task: request.context.node.task.clone(),
            profile: request.context.node.profile,
            effective_policy: request.context.node.policy.clone(),
            workspace: request.context.node.workspace.clone(),
            budget: request.context.node.budget,
            usage: request.context.attempt.usage,
            limits: PromptAgentLimits {
                max_depth: request.context.node.policy.max_depth,
                remaining_direct_children,
                remaining_root_agents: request
                    .context
                    .node
                    .policy
                    .max_root_agents
                    .saturating_sub(saturating_u16(snapshot.nodes.len())),
                available_parallel_slots: remaining_direct_children.min(3),
            },
            mailbox_delta: request.mailbox_delta,
            finalization_required: request.finalization_required,
        };
        let todo_state = self
            .contexts
            .tools
            .todo_prompt_state(&request.context.node.root_session_id)
            .await
            .map_err(|error| port_error("AGENT_TODO_PROMPT_FAILED", error, false))?;
        let now = Utc::now();
        let cancellation = CancellationToken::new();
        let text = self
            .prompt
            .build(ChatPromptBuildInput {
                resolved: &resolved,
                session_id: &request.context.node.root_session_id,
                workspace_root: Some(run.workspace_root()),
                tool_schemas: &surface.definitions,
                deferred_tools: &surface.deferred_tools,
                scope: &scope,
                now: &now,
                cancellation: &cancellation,
                system_addendum: None,
                todo_state: todo_state.as_deref(),
                agent: Some(&prompt_agent),
            })
            .await
            .map_err(|error| port_error("AGENT_PROMPT_BUILD_FAILED", error, false))?;
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        Ok(AgentPromptSnapshot {
            text,
            schema_version: codez_core::agent::AGENT_SCHEMA_VERSION,
            module_hashes: vec![hash.clone()],
            dynamic_snapshot_hash: hash,
            result_contract_version: codez_core::agent::AGENT_SCHEMA_VERSION,
        })
    }
}

struct DesktopAgentLedger {
    store: Arc<ModelLedgerStore>,
}

#[async_trait]
impl AgentLedgerPort for DesktopAgentLedger {
    async fn load_messages(
        &self,
        context: &AgentExecutionContext,
    ) -> Result<Vec<ChatMessage>, AgentPortError> {
        self.ensure_seed(context).await?;
        load_agent_messages(&self.store, context).await
    }

    async fn append_assistant(
        &self,
        context: &AgentExecutionContext,
        turn: &AgentProviderTurn,
    ) -> Result<(), AgentPortError> {
        let now = Utc::now().to_rfc3339();
        let event_id = unique_ledger_event_id(context, "assistant");
        let tool_calls = (!turn.tool_calls.is_empty()).then(|| {
            turn.tool_calls
                .iter()
                .map(|call| LedgerToolCall {
                    id: call.id.clone(),
                    name: call.function.name.clone(),
                    arguments: call.function.arguments.clone(),
                    thought_signature: call.thought_signature.clone(),
                })
                .collect()
        });
        let message = NormalizedModelMessage {
            id: event_id.clone(),
            client_message_id: None,
            turn_id: context.attempt.id.to_string(),
            role: "assistant".to_string(),
            content: turn.content.clone(),
            tool_calls,
            tool_call_id: None,
            name: None,
            status: "complete".to_string(),
            created_at: now.clone(),
            source_sequence: None,
            attachments: None,
            file_references: None,
        };
        self.append(
            context,
            event_id,
            now,
            LedgerEventType::AssistantMessage,
            AssistantMessagePayload {
                message,
                usage: turn.usage.clone(),
                request_fingerprint: None,
            },
        )
        .await
    }

    async fn append_tool_result(
        &self,
        context: &AgentExecutionContext,
        result: &AgentToolResult,
    ) -> Result<(), AgentPortError> {
        let now = Utc::now().to_rfc3339();
        let event_id = unique_ledger_event_id(context, "tool");
        let message = NormalizedModelMessage {
            id: event_id.clone(),
            client_message_id: None,
            turn_id: context.attempt.id.to_string(),
            role: "tool".to_string(),
            content: result.model_content.clone(),
            tool_calls: None,
            tool_call_id: Some(result.call_id.clone()),
            name: Some(result.name.clone()),
            status: result.status.clone(),
            created_at: now.clone(),
            source_sequence: None,
            attachments: None,
            file_references: None,
        };
        self.append(
            context,
            event_id,
            now,
            LedgerEventType::ToolResult,
            ToolResultPayload {
                message,
                status: result.status.clone(),
                full_result_sha256: None,
            },
        )
        .await
    }
}

async fn load_agent_scope(
    store: &ModelLedgerStore,
    context: &AgentExecutionContext,
) -> Result<SessionRuntimeScopeSnapshot, AgentPortError> {
    let loaded = store
        .load(&context.node.root_session_id)
        .await
        .map_err(|error| port_error("AGENT_LEDGER_LOAD_FAILED", error, false))?
        .ok_or_else(|| {
            AgentPortError::new(
                "AGENT_LEDGER_MISSING",
                "Agent ledger was not created",
                false,
            )
        })?;
    let scope_id = ContextScopeId::Agent(context.node.id.clone());
    let key = scope_id.as_key();
    loaded
        .snapshot
        .scopes
        .get(key.as_ref())
        .cloned()
        .ok_or_else(|| {
            AgentPortError::new(
                "AGENT_LEDGER_SCOPE_MISSING",
                "Agent ledger scope was not created",
                false,
            )
        })
}

async fn load_agent_messages(
    store: &ModelLedgerStore,
    context: &AgentExecutionContext,
) -> Result<Vec<ChatMessage>, AgentPortError> {
    let scope = load_agent_scope(store, context).await?;
    agent_messages_from_scope(scope)
}

fn agent_messages_from_scope(
    scope: SessionRuntimeScopeSnapshot,
) -> Result<Vec<ChatMessage>, AgentPortError> {
    let history = ModelHistoryNormalizer::normalize_recovered_history(&scope.active_messages);
    let current_input_message_id = history
        .iter()
        .rev()
        .find(|message| matches!(message.role.as_str(), "user" | "system"))
        .map(|message| message.id.clone())
        .ok_or_else(|| {
            AgentPortError::new(
                "AGENT_CONTEXT_INPUT_MISSING",
                "Agent context has no durable input message",
                false,
            )
        })?;
    let summary = scope
        .latest_compaction
        .as_ref()
        .map(render_compaction_summary);
    let resume = scope
        .resume_state
        .as_ref()
        .filter(|resume| Some(resume.revision) != scope.latest_compaction_resume_revision)
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| port_error("AGENT_CONTEXT_RESUME_INVALID", error, false))?;
    let session_skill_state = scope
        .skill_states
        .as_deref()
        .filter(|states| states.iter().any(|state| state.status == "active"))
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| port_error("AGENT_CONTEXT_SKILL_STATE_INVALID", error, false))?;
    let items = build_model_context_items(BuildModelContextItemsInput {
        system_prompt: String::new(),
        instructions: Vec::new(),
        summary,
        resume,
        skill_context: scope.post_compaction_skill_context,
        session_skill_state,
        file_context: scope.post_compaction_file_context,
        current_input_message_id,
        history,
    })
    .map_err(|error| port_error("AGENT_CONTEXT_BUILD_FAILED", error, false))?;
    model_context_items_to_chat_messages(&items)
        .map_err(|error| port_error("AGENT_LEDGER_PROTOCOL_INVALID", error, false))
}

impl DesktopAgentLedger {
    async fn ensure_seed(&self, context: &AgentExecutionContext) -> Result<(), AgentPortError> {
        let scope_id = ContextScopeId::Agent(context.node.id.clone());
        let key = scope_id.as_key();
        let task_event_id = format!("{}:seed:user", context.attempt.id);
        let loaded = self
            .store
            .load(&context.node.root_session_id)
            .await
            .map_err(|error| port_error("AGENT_LEDGER_LOAD_FAILED", error, false))?;
        let child_scope = loaded
            .as_ref()
            .and_then(|loaded| loaded.snapshot.scopes.get(key.as_ref()));
        if child_scope.is_some_and(|scope| {
            scope
                .active_messages
                .iter()
                .any(|message| message.id == task_event_id)
        }) {
            return Ok(());
        }
        if child_scope.is_none() {
            if let Some(loaded) = loaded {
                let source_scope_id = parent_context_scope(context)?;
                let source_key = source_scope_id.as_key();
                if let Some(source_scope) = loaded.snapshot.scopes.get(source_key.as_ref()).cloned()
                {
                    let now = Utc::now().to_rfc3339();
                    let payload = serde_json::to_value(ContextForkedPayload {
                        source_context_scope_id: source_scope_id,
                        source_history_version: source_scope.history_version,
                        scope: source_scope,
                    })
                    .map_err(|error| port_error("AGENT_LEDGER_SERIALIZE_FAILED", error, false))?;
                    self.store
                        .append_event_if_history_version(
                            &context.node.root_session_id,
                            0,
                            LedgerAppendRequest {
                                event_id: format!("{}:seed:context", context.node.id),
                                session_id: context.node.root_session_id.as_str().to_string(),
                                context_scope_id: scope_id,
                                turn_id: Some(context.attempt.id.to_string()),
                                created_at: now,
                                r#type: LedgerEventType::ContextForked,
                                payload,
                            },
                        )
                        .await
                        .map_err(|error| port_error("AGENT_CONTEXT_FORK_FAILED", error, false))?;
                }
            }
        }
        let now = Utc::now().to_rfc3339();
        let message = NormalizedModelMessage {
            id: task_event_id.clone(),
            client_message_id: None,
            turn_id: context.attempt.id.to_string(),
            role: "user".to_string(),
            content: delegated_task_prompt(context),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            status: "complete".to_string(),
            created_at: now.clone(),
            source_sequence: None,
            attachments: None,
            file_references: None,
        };
        self.append(
            context,
            task_event_id,
            now,
            LedgerEventType::UserMessage,
            UserMessagePayload {
                message,
                provider_id: Some(context.attempt.provider_id.clone()),
                model: Some(context.attempt.model_id.clone()),
                command_metadata: None,
            },
        )
        .await
    }

    async fn append<T: serde::Serialize>(
        &self,
        context: &AgentExecutionContext,
        event_id: String,
        created_at: String,
        event_type: LedgerEventType,
        payload: T,
    ) -> Result<(), AgentPortError> {
        let payload = serde_json::to_value(payload)
            .map_err(|error| port_error("AGENT_LEDGER_SERIALIZE_FAILED", error, false))?;
        self.store
            .append_event_for(
                &context.node.root_session_id,
                LedgerAppendRequest {
                    event_id,
                    session_id: context.node.root_session_id.as_str().to_string(),
                    context_scope_id: ContextScopeId::Agent(context.node.id.clone()),
                    turn_id: Some(context.attempt.id.to_string()),
                    created_at,
                    r#type: event_type,
                    payload,
                },
            )
            .await
            .map(|_| ())
            .map_err(|error| port_error("AGENT_LEDGER_APPEND_FAILED", error, false))
    }
}

fn parent_context_scope(context: &AgentExecutionContext) -> Result<ContextScopeId, AgentPortError> {
    if context.node.depth == 1 {
        return Ok(ContextScopeId::Main);
    }
    context
        .node
        .parent_id
        .clone()
        .map(ContextScopeId::Agent)
        .ok_or_else(|| {
            AgentPortError::new(
                "AGENT_PARENT_CONTEXT_MISSING",
                "Child Agent has no parent context identity",
                false,
            )
        })
}

fn delegated_task_prompt(context: &AgentExecutionContext) -> String {
    format!(
        "Task: {}\n\nObjective:\n{}\n\nSuccess criteria:\n{}",
        context.node.task.title,
        context.node.task.objective,
        context.node.task.success_criteria.join("\n- ")
    )
}

fn unique_ledger_event_id(context: &AgentExecutionContext, kind: &str) -> String {
    format!("{}:{}:{}", context.attempt.id, uuid::Uuid::new_v4(), kind)
}

fn merge_usage(
    previous: Option<ProviderTokenUsage>,
    next: &ProviderTokenUsage,
) -> ProviderTokenUsage {
    ProviderTokenUsage {
        input_tokens: previous.as_ref().map_or(next.input_tokens, |usage| {
            usage.input_tokens.max(next.input_tokens)
        }),
        output_tokens: previous.as_ref().map_or(next.output_tokens, |usage| {
            usage.output_tokens.max(next.output_tokens)
        }),
        reasoning_tokens: Some(
            previous
                .as_ref()
                .and_then(|usage| usage.reasoning_tokens)
                .unwrap_or_default()
                .max(next.reasoning_tokens.unwrap_or_default()),
        )
        .filter(|value| *value > 0),
        total_tokens: Some(
            previous
                .as_ref()
                .and_then(|usage| usage.total_tokens)
                .unwrap_or_default()
                .max(next.total_tokens.unwrap_or_default()),
        )
        .filter(|value| *value > 0),
    }
}

fn submit_result_definition() -> ToolDefinition {
    ToolDefinition {
        r#type: "function".to_string(),
        function: codez_core::provider::ToolDefinitionFunction {
            name: SUBMIT_AGENT_RESULT.to_string(),
            description: "Submit the final structured child Agent result exactly once.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "status": { "type": "string", "enum": ["completed", "partial", "blocked", "failed"] },
                    "summary": { "type": "string" },
                    "conclusion": { "type": "string" },
                    "changes": { "type": "array", "items": { "type": "object" } },
                    "validations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "commandOrCheck": { "type": "string", "minLength": 1 },
                                "status": { "type": "string", "enum": ["passed", "failed", "not_run"] },
                                "evidenceRef": { "type": "string" }
                            },
                            "required": ["commandOrCheck", "status"]
                        }
                    },
                    "findings": { "type": "array", "items": { "type": "object" } },
                    "blockers": { "type": "array", "items": { "type": "string" } },
                    "unresolved": { "type": "array", "items": { "type": "string" } },
                    "recommendedNextActions": { "type": "array", "items": { "type": "string" } },
                    "confidence": { "type": "string", "enum": ["low", "medium", "high"] },
                    "reviewVerdict": { "type": "string", "enum": ["approved", "changes_requested", "blocked"] },
                    "artifactRefs": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["status", "summary", "validations", "blockers", "unresolved"]
            }),
        },
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmittedAgentResult {
    status: AgentResultStatus,
    summary: String,
    conclusion: Option<String>,
    #[serde(default)]
    changes: Vec<ChangedArtifact>,
    #[serde(default)]
    validations: Vec<AgentValidationResult>,
    #[serde(default)]
    findings: Vec<AgentFinding>,
    #[serde(default)]
    blockers: Vec<String>,
    #[serde(default)]
    unresolved: Vec<String>,
    #[serde(default)]
    recommended_next_actions: Vec<String>,
    confidence: Option<Confidence>,
    review_verdict: Option<codez_core::agent::AgentReviewVerdict>,
    #[serde(default)]
    artifact_refs: Vec<codez_core::ArtifactId>,
}

impl SubmittedAgentResult {
    fn into_result(self) -> AgentResult {
        AgentResult {
            status: self.status,
            summary: self.summary,
            conclusion: self.conclusion,
            changes: self.changes,
            validations: self.validations,
            findings: self.findings,
            blockers: self.blockers,
            unresolved: self.unresolved,
            recommended_next_actions: self.recommended_next_actions,
            confidence: self.confidence,
            review_verdict: self.review_verdict,
            artifact_refs: self.artifact_refs,
            usage: AgentUsage::default(),
        }
    }
}

fn empty_scope() -> SessionRuntimeScopeSnapshot {
    SessionRuntimeScopeSnapshot {
        history_version: 0,
        active_messages: Vec::new(),
        latest_compaction: None,
        observed_provider_input_limit: None,
        resume_state: None,
        last_completed_turn_id: None,
        last_interrupted_turn_id: None,
        legacy_import: None,
        latest_compaction_resume_revision: None,
        last_provider_id: None,
        last_model: None,
        last_provider_usage: None,
        last_provider_usage_message_id: None,
        last_provider_usage_provider_id: None,
        last_provider_usage_model: None,
        last_provider_usage_request_fingerprint: None,
        post_compaction_file_context: None,
        post_compaction_skill_context: None,
        skill_states: None,
        post_compaction_skill_states: None,
    }
}

fn port_error(code: &str, error: impl std::fmt::Display, retryable: bool) -> AgentPortError {
    AgentPortError::new(code, error.to_string(), retryable)
}

fn saturating_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use codez_core::agent::{
        AGENT_SCHEMA_VERSION, AgentAttempt, AgentBudget, AgentNode, AgentPolicy, AgentProfile,
        AgentState, AgentUsage, AgentValidationResult, DelegatedTask, ResultSchema,
        WorkspaceAssignment, WorkspaceMode,
    };
    use codez_core::context::{
        ContextScopeId, LedgerAppendRequest, LedgerEventType, NormalizedModelMessage,
        UserMessagePayload,
    };
    use codez_core::provider::{ChatMessage, Role};
    use codez_core::{
        AgentAttemptId, AgentId, AtomicPersistence, CancellationToken, RootRunId, SessionId, TaskId,
    };
    use codez_providers::chat::ChatProviderError;
    use codez_runtime::agent::{AgentScheduler, ScheduledAgent, SchedulerConfig};
    use codez_runtime::context::budget::ModelContextCapabilities;
    use codez_runtime::context::ledger::ModelLedgerStore;
    use codez_runtime::tools::types::{
        NormalizedToolCall, ToolEffect, ToolExecutionError, ToolExecutionResult, ToolPipelineResult,
    };
    use codez_storage::AtomicFileStore;

    use super::{
        ChildOverflowCompaction, DesktopAgentLedger, ObservedValidationCheck,
        agent_messages_from_scope, child_request_requires_compaction, empty_scope,
        observed_validation_check, reconcile_submitted_validations, run_dispatch_worker,
        tool_file_changes, workspace_paths,
    };
    use crate::chat_runtime::{agent_tool_usage, provider_open_retry_delay};

    fn result(result: ToolExecutionResult) -> ToolPipelineResult {
        ToolPipelineResult {
            call: NormalizedToolCall {
                call_id: "call-edit".to_string(),
                position: 0,
                name: "Edit".to_string(),
                raw_arguments: "{}".to_string(),
                thought_signature: None,
            },
            canonical_name: "Edit".to_string(),
            result,
            max_result_chars: None,
        }
    }

    fn write_effect() -> Vec<ToolEffect> {
        vec![ToolEffect::WriteFile {
            path: "C:/workspace/src/lib.rs".to_string(),
            mode: "modify".to_string(),
        }]
    }

    #[test]
    fn file_projection_should_include_successful_write_effects() {
        let result = result(ToolExecutionResult::Success {
            data: None,
            model_content: "updated".to_string(),
            ui_content: None,
            effects: Some(write_effect()),
        });

        let changes = tool_file_changes(&result, "transaction-agent");

        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn file_projection_should_not_treat_denied_effects_as_file_changes() {
        let result = result(ToolExecutionResult::Denied {
            error: ToolExecutionError {
                code: "TOOL_DENIED".to_string(),
                message: "denied".to_string(),
                recoverable: false,
                suggestion: None,
                retry_after_ms: None,
                details: None,
            },
            model_content: None,
            ui_content: None,
            effects: Some(write_effect()),
        });

        let changes = tool_file_changes(&result, "transaction-agent");

        assert!(changes.is_empty());
    }

    #[test]
    fn child_provider_open_retry_policy_should_be_transient_and_bounded() {
        let rate_limit = ChatProviderError::RateLimit("slow down".to_string());
        let network = ChatProviderError::Network("connection reset".to_string());
        let auth = ChatProviderError::Auth("invalid credential".to_string());

        let delays = (1..=5)
            .map(|attempt| provider_open_retry_delay(&rate_limit, attempt, "attempt-retry-a"))
            .collect::<Vec<_>>();

        for (delay, ceiling_ms) in delays.iter().take(4).zip([250_u64, 500, 1_000, 2_000]) {
            let delay = delay.expect("transient failures must retry before the fifth attempt");
            assert!(delay >= Duration::from_millis(ceiling_ms / 2));
            assert!(delay <= Duration::from_millis(ceiling_ms));
        }
        assert_eq!(delays[4], None);
        assert_eq!(
            provider_open_retry_delay(&network, 1, "attempt-retry-a"),
            provider_open_retry_delay(&network, 1, "attempt-retry-a")
        );
        assert_ne!(
            provider_open_retry_delay(&network, 1, "attempt-retry-a"),
            provider_open_retry_delay(&network, 1, "attempt-retry-b")
        );
        assert_eq!(provider_open_retry_delay(&auth, 1, "attempt-retry-a"), None);
    }

    #[tokio::test]
    async fn dispatch_workers_should_not_block_later_attempts_while_earlier_attempts_wait() {
        let scheduler = Arc::new(AgentScheduler::new(SchedulerConfig::default()));
        for index in 0..5 {
            scheduler.enqueue(scheduled_agent(index));
        }
        let cancellation = CancellationToken::new();
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let dispatch = Arc::new(
            move |_worker_index: usize,
                  scheduled: ScheduledAgent,
                  attempt_cancellation: CancellationToken| {
                let started_tx = started_tx.clone();
                async move {
                    started_tx
                        .send(scheduled.agent_id)
                        .expect("started-attempt receiver must remain available");
                    attempt_cancellation.cancelled().await;
                }
            },
        );
        let mut workers = Vec::new();
        for worker_index in 0..4 {
            workers.push(tokio::spawn(run_dispatch_worker(
                Arc::clone(&scheduler),
                cancellation.clone(),
                worker_index,
                Arc::clone(&dispatch),
            )));
        }

        let all_attempts_started = tokio::time::timeout(Duration::from_secs(1), async {
            let mut started = Vec::new();
            for _ in 0..5 {
                started.push(
                    started_rx
                        .recv()
                        .await
                        .expect("dispatch workers must report every queued attempt"),
                );
            }
            started
        })
        .await
        .expect("a fifth attempt must start while four earlier attempts remain pending");

        assert_eq!(all_attempts_started.len(), 5);
        assert_eq!(scheduler.queued_len(), 0);
        cancellation.cancel();
        for worker in workers {
            worker.await.expect("dispatch worker must stop cleanly");
        }
    }

    fn scheduled_agent(index: usize) -> ScheduledAgent {
        ScheduledAgent {
            root_run_id: RootRunId::parse("root-dispatch-regression")
                .expect("fixture root ID must parse"),
            agent_id: AgentId::parse(format!("agent-dispatch-{index}"))
                .expect("fixture Agent ID must parse"),
            attempt_id: AgentAttemptId::parse(format!("attempt-dispatch-{index}"))
                .expect("fixture attempt ID must parse"),
            provider_id: "provider-dispatch-regression".to_string(),
        }
    }

    #[test]
    fn shell_result_should_produce_authoritative_validation_evidence() {
        let result = ToolPipelineResult {
            call: NormalizedToolCall {
                call_id: "call-cargo-test".to_string(),
                position: 0,
                name: "PowerShell".to_string(),
                raw_arguments: r#"{"command":"cargo test -p codez-runtime"}"#.to_string(),
                thought_signature: None,
            },
            canonical_name: "PowerShell".to_string(),
            result: ToolExecutionResult::Success {
                data: Some(serde_json::json!({
                    "command": "cargo test -p codez-runtime",
                    "status": "completed",
                    "exitCode": 0,
                    "taskId": "command-task-1",
                    "elapsedMs": 1_250
                })),
                model_content: "completed".to_string(),
                ui_content: None,
                effects: Some(vec![ToolEffect::ReadFile {
                    path: "C:/workspace".to_string(),
                    scope: "workspace".to_string(),
                }]),
            },
            max_result_chars: None,
        };

        let observed =
            observed_validation_check(&result).expect("completed command must be indexed");

        assert_eq!(observed.command_or_check, "cargo test -p codez-runtime");
        assert_eq!(observed.status, "passed");
        assert_eq!(observed.tool_call_id, "call-cargo-test");
        assert_eq!(
            agent_tool_usage(&result),
            codez_runtime::agent::AgentToolUsage {
                command_task_id: Some("PowerShell:command-task-1".to_string()),
                command_elapsed_total_ms: Some(1_250),
                files_read: 1,
            }
        );
    }

    #[test]
    fn submitted_validation_should_be_downgraded_without_matching_tool_evidence() {
        let submitted = vec![
            AgentValidationResult {
                command_or_check: "cargo test -p codez-runtime".to_string(),
                status: "passed".to_string(),
                tool_call_id: Some("invented-call".to_string()),
                evidence_ref: None,
            },
            AgentValidationResult {
                command_or_check: "npm test".to_string(),
                status: "passed".to_string(),
                tool_call_id: None,
                evidence_ref: None,
            },
        ];
        let observed = vec![ObservedValidationCheck {
            command_or_check: "cargo test -p codez-runtime".to_string(),
            status: "failed".to_string(),
            tool_call_id: "actual-call".to_string(),
        }];

        let reconciled = reconcile_submitted_validations(submitted, &observed);

        assert_eq!(reconciled[0].status, "failed");
        assert_eq!(reconciled[0].tool_call_id.as_deref(), Some("actual-call"));
        assert_eq!(reconciled[1].status, "not_run");
        assert_eq!(reconciled[1].tool_call_id, None);
    }

    #[test]
    fn compacted_agent_scope_should_restore_the_durable_summary_for_the_provider() {
        let mut scope = empty_scope();
        scope.history_version = 4;
        scope.latest_compaction = Some(serde_json::json!({
            "version": 2,
            "content": "Durable child Agent findings.",
            "coveredThroughSequence": 8
        }));
        scope.active_messages = vec![message("input-1", "user", "Continue the delegated task.")];

        let messages = agent_messages_from_scope(scope).expect("compacted scope must rebuild");

        assert!(matches!(
            messages.as_slice(),
            [summary, input]
                if summary.role == Role::System
                    && summary.content.as_deref().is_some_and(|content| {
                        content.contains("Durable child Agent findings.")
                            && content.contains("Covered through sequence: 8")
                    })
                    && input.role == Role::User
                    && input.content.as_deref() == Some("Continue the delegated task.")
        ));
    }

    #[test]
    fn workspace_path_projection_should_ignore_blank_optional_paths() {
        let paths = workspace_paths(&serde_json::json!({
            "path": " ",
            "file_path": "",
            "dirPaths": ["", ".", "src"]
        }));

        assert_eq!(paths, [".".to_string(), "src".to_string()]);
    }

    #[test]
    fn child_context_should_request_compaction_at_the_model_threshold() {
        let context = ChildOverflowCompaction {
            capabilities: ModelContextCapabilities {
                context_window_tokens: Some(10_000),
                max_output_tokens: Some(1_000),
                max_input_tokens: None,
                reasoning_counts_against_context: Some(false),
            },
            reasoning_budget_tokens: None,
            provider_id: "provider".to_string(),
            model_id: "model".to_string(),
        };
        let message = |content: String| ChatMessage {
            role: Role::User,
            content: Some(content),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: Vec::new(),
        };
        let small = child_request_requires_compaction(
            "system",
            &[message("small".to_string())],
            &[],
            &context,
        )
        .expect("small context must measure");
        let large = child_request_requires_compaction(
            "system",
            &[message("x".repeat(50_000))],
            &[],
            &context,
        )
        .expect("large context must measure");

        assert_eq!([small, large], [false, true]);
    }

    #[tokio::test]
    async fn child_seed_should_fork_main_context_before_the_delegated_task() {
        let data = tempfile::tempdir().expect("temporary ledger root must exist");
        let workspace = tempfile::tempdir().expect("temporary workspace must exist");
        let storage = Arc::new(AtomicFileStore::default());
        let persistence: Arc<dyn AtomicPersistence> = storage;
        let store = Arc::new(ModelLedgerStore::new(
            data.path().join("session-runtime"),
            persistence,
        ));
        let session_id = SessionId::parse("session-context-fork").expect("session ID must parse");
        let parent_message = message("parent-input", "user", "Original user context.");
        store
            .append_event_for(
                &session_id,
                LedgerAppendRequest {
                    event_id: "parent-input-event".to_string(),
                    session_id: session_id.as_str().to_string(),
                    context_scope_id: ContextScopeId::Main,
                    turn_id: Some("root-turn".to_string()),
                    created_at: "2026-07-20T00:00:00Z".to_string(),
                    r#type: LedgerEventType::UserMessage,
                    payload: serde_json::to_value(UserMessagePayload {
                        message: parent_message,
                        provider_id: Some("provider".to_string()),
                        model: Some("model".to_string()),
                        command_metadata: None,
                    })
                    .expect("parent payload must serialize"),
                },
            )
            .await
            .expect("parent context must persist");
        let child_id = AgentId::parse("agent-context-child").expect("child ID must parse");
        let attempt_id =
            AgentAttemptId::parse("attempt-context-child").expect("attempt ID must parse");
        let context = codez_runtime::agent::AgentExecutionContext {
            node: AgentNode {
                schema_version: AGENT_SCHEMA_VERSION,
                id: child_id.clone(),
                root_run_id: RootRunId::parse("root-context").expect("root ID must parse"),
                root_session_id: session_id.clone(),
                parent_id: Some(AgentId::parse("agent-root").expect("parent ID must parse")),
                depth: 1,
                profile: AgentProfile::General,
                task: DelegatedTask {
                    task_id: TaskId::parse("task-context-child").expect("task ID must parse"),
                    title: "Inherited task".to_string(),
                    objective: "Use the inherited context.".to_string(),
                    known_facts: Vec::new(),
                    success_criteria: vec!["Report the result.".to_string()],
                    non_goals: Vec::new(),
                    dependencies: Vec::new(),
                    context_refs: Vec::new(),
                    validation_expectations: Vec::new(),
                    expected_result_schema: ResultSchema::default(),
                },
                policy: AgentPolicy::readonly_child(),
                budget: AgentBudget::conservative_child(),
                workspace: WorkspaceAssignment {
                    mode: WorkspaceMode::SharedReadonly,
                    root: workspace.path().to_string_lossy().into_owned(),
                    read_scope: vec!["**/*".to_string()],
                    write_scope: Vec::new(),
                    baseline_revision: None,
                    baseline_manifest: None,
                    integration_policy: "none".to_string(),
                },
                state: AgentState::Running,
                state_revision: 1,
                created_by_tool_call_id: Some("spawn-context-child".to_string()),
                created_at: "2026-07-20T00:00:00Z".to_string(),
                updated_at: "2026-07-20T00:00:00Z".to_string(),
            },
            attempt: AgentAttempt {
                id: attempt_id,
                agent_id: child_id.clone(),
                ordinal: 1,
                state: AgentState::Running,
                state_revision: 1,
                mailbox_cursor: 0,
                prompt_schema_version: AGENT_SCHEMA_VERSION,
                prompt_module_hashes: Vec::new(),
                dynamic_snapshot_hash: String::new(),
                tool_catalog_fingerprint: String::new(),
                provider_id: "provider".to_string(),
                model_id: "model".to_string(),
                result_contract_version: AGENT_SCHEMA_VERSION,
                usage: AgentUsage::default(),
                started_at: Some("2026-07-20T00:00:00Z".to_string()),
                finished_at: None,
            },
        };

        DesktopAgentLedger {
            store: Arc::clone(&store),
        }
        .ensure_seed(&context)
        .await
        .expect("child seed must persist");
        let loaded = store
            .load(&session_id)
            .await
            .expect("child ledger must load")
            .expect("child ledger must exist");
        let child = &loaded.snapshot.scopes[&format!("agent:{child_id}")];

        assert_eq!(
            child
                .active_messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            [
                "Original user context.",
                "Task: Inherited task\n\nObjective:\nUse the inherited context.\n\nSuccess criteria:\nReport the result.",
            ]
        );
    }

    fn message(id: &str, role: &str, content: &str) -> NormalizedModelMessage {
        NormalizedModelMessage {
            id: id.to_string(),
            client_message_id: None,
            turn_id: "attempt-context".to_string(),
            role: role.to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            status: "complete".to_string(),
            created_at: "2026-07-19T00:00:00Z".to_string(),
            source_sequence: None,
            attachments: None,
            file_references: None,
        }
    }
}
