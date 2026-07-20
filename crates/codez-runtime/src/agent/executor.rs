use std::{collections::HashMap, sync::Arc, time::Instant};

use async_trait::async_trait;
use codez_core::agent::{
    AgentAttempt, AgentBudget, AgentFinding, AgentMessage, AgentNode, AgentResult,
    AgentResultStatus, AgentUsage, AgentValidationResult, ChangedArtifact,
};
use codez_core::provider::{
    AgentStopReason, ChatMessage, ProviderTokenUsage, ToolCall, ToolDefinition,
};
use codez_core::{AppError, CancellationToken};
use thiserror::Error;

use super::scheduler::ScheduledAgent;
use super::store::AgentStoreError;
use super::supervisor::{AgentSupervisor, SupervisorError};

const MAX_EXECUTOR_TURNS: usize = 64;
const MAX_MAILBOX_MESSAGES_PER_TURN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentExecutionContext {
    pub node: AgentNode,
    pub attempt: AgentAttempt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPromptRequest {
    pub context: AgentExecutionContext,
    pub mailbox_delta: Vec<AgentMessage>,
    pub finalization_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPromptSnapshot {
    pub text: String,
    pub schema_version: u16,
    pub module_hashes: Vec<String>,
    pub dynamic_snapshot_hash: String,
    pub result_contract_version: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProviderRequest {
    pub context: AgentExecutionContext,
    pub system_prompt: AgentPromptSnapshot,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProviderTurn {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<ProviderTokenUsage>,
    pub stop_reason: Option<AgentStopReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToolResult {
    pub call_id: String,
    pub name: String,
    pub model_content: String,
    pub status: String,
    pub file_changes: Vec<AgentFileChange>,
    pub usage: AgentToolUsage,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentToolUsage {
    pub command_task_id: Option<String>,
    pub command_elapsed_total_ms: Option<u64>,
    pub files_read: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentFileChange {
    pub path: String,
    pub change_kind: String,
    pub transaction_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToolBatchResult {
    pub results: Vec<AgentToolResult>,
    pub submitted_result: Option<AgentResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTurnDirective {
    Finish,
    Continue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentExecutionOutcome {
    pub result: AgentResult,
    pub final_content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentExecutionEvent {
    StateChanged,
    AssistantDelta(String),
    ReasoningDelta(String),
    MailboxReceived(Vec<AgentMessage>),
    MessageSent(AgentMessage),
    ToolBatchStarted(Vec<ToolCall>),
    ToolBatchCompleted(Vec<AgentToolResult>),
    PermissionRequested {
        request_id: String,
        summary: String,
    },
    PermissionResolved {
        request_id: String,
        approved: bool,
    },
    ProviderRetryScheduled {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        reason: String,
    },
    ContextCompactionStarted {
        trigger: String,
        history_version: u32,
    },
    ContextCompactionCompleted {
        trigger: String,
        tokens_before: Option<u32>,
        tokens_after: Option<u32>,
        history_version: Option<u32>,
    },
    ContextCompactionFailed {
        trigger: String,
        code: String,
        message: String,
        retryable: bool,
        history_version: Option<u32>,
    },
    UsageUpdated {
        usage: AgentUsage,
        remaining: AgentBudget,
    },
    ResultSubmitted(AgentResult),
    ErrorRaised {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{code}: {message}")]
pub struct AgentPortError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl AgentPortError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

#[derive(Debug, Error)]
pub enum AgentExecutionError {
    #[error("scheduled agent is no longer queued or resumable")]
    InvalidScheduledState,
    #[error("scheduled attempt does not match the current agent attempt")]
    AttemptMismatch,
    #[error("agent executor exceeded the maximum number of turns")]
    TurnLimit,
    #[error("agent execution was cancelled")]
    Cancelled,
    #[error("agent prompt composition failed: {0}")]
    Prompt(AgentPortError),
    #[error("agent provider failed: {0}")]
    Provider(AgentPortError),
    #[error("agent tool execution failed: {0}")]
    Tool(AgentPortError),
    #[error("agent ledger operation failed: {0}")]
    Ledger(AgentPortError),
    #[error("agent turn control failed: {0}")]
    Control(AgentPortError),
    #[error(transparent)]
    Supervisor(#[from] SupervisorError),
    #[error(transparent)]
    Store(#[from] AgentStoreError),
}

#[async_trait]
pub trait AgentProviderPort: Send + Sync {
    async fn run_turn(
        &self,
        request: AgentProviderRequest,
        events: &dyn AgentExecutionEventSink,
        cancellation: CancellationToken,
    ) -> Result<AgentProviderTurn, AgentPortError>;
}

#[async_trait]
pub trait AgentToolPort: Send + Sync {
    async fn definitions(
        &self,
        context: &AgentExecutionContext,
        finalization_required: bool,
    ) -> Result<Vec<ToolDefinition>, AgentPortError>;

    async fn execute(
        &self,
        context: &AgentExecutionContext,
        calls: Vec<ToolCall>,
        cancellation: CancellationToken,
    ) -> Result<AgentToolBatchResult, AgentPortError>;
}

#[async_trait]
pub trait AgentLedgerPort: Send + Sync {
    async fn load_messages(
        &self,
        context: &AgentExecutionContext,
    ) -> Result<Vec<ChatMessage>, AgentPortError>;

    async fn append_assistant(
        &self,
        context: &AgentExecutionContext,
        turn: &AgentProviderTurn,
    ) -> Result<(), AgentPortError>;

    async fn append_tool_result(
        &self,
        context: &AgentExecutionContext,
        result: &AgentToolResult,
    ) -> Result<(), AgentPortError>;
}

#[async_trait]
pub trait AgentPromptPort: Send + Sync {
    async fn compose(
        &self,
        request: AgentPromptRequest,
    ) -> Result<AgentPromptSnapshot, AgentPortError>;
}

#[async_trait]
pub trait AgentTurnControlPort: Send + Sync {
    async fn after_assistant(
        &self,
        context: &AgentExecutionContext,
        turn: &AgentProviderTurn,
    ) -> Result<AgentTurnDirective, AgentPortError>;
}

pub trait AgentExecutionEventSink: Send + Sync {
    fn publish(&self, context: &AgentExecutionContext, event: AgentExecutionEvent);
}

pub struct NoopAgentExecutionEventSink;

impl AgentExecutionEventSink for NoopAgentExecutionEventSink {
    fn publish(&self, _context: &AgentExecutionContext, _event: AgentExecutionEvent) {}
}

struct FinishAgentTurnControl;

#[async_trait]
impl AgentTurnControlPort for FinishAgentTurnControl {
    async fn after_assistant(
        &self,
        _context: &AgentExecutionContext,
        _turn: &AgentProviderTurn,
    ) -> Result<AgentTurnDirective, AgentPortError> {
        Ok(AgentTurnDirective::Finish)
    }
}

pub struct AgentExecutor {
    supervisor: Arc<AgentSupervisor>,
    provider: Arc<dyn AgentProviderPort>,
    tools: Arc<dyn AgentToolPort>,
    ledger: Arc<dyn AgentLedgerPort>,
    prompt: Arc<dyn AgentPromptPort>,
    turn_control: Arc<dyn AgentTurnControlPort>,
    events: Arc<dyn AgentExecutionEventSink>,
}

impl AgentExecutor {
    #[must_use]
    pub fn new(
        supervisor: Arc<AgentSupervisor>,
        provider: Arc<dyn AgentProviderPort>,
        tools: Arc<dyn AgentToolPort>,
        ledger: Arc<dyn AgentLedgerPort>,
        prompt: Arc<dyn AgentPromptPort>,
        events: Arc<dyn AgentExecutionEventSink>,
    ) -> Self {
        Self {
            supervisor,
            provider,
            tools,
            ledger,
            prompt,
            turn_control: Arc::new(FinishAgentTurnControl),
            events,
        }
    }

    #[must_use]
    pub fn with_turn_control(mut self, turn_control: Arc<dyn AgentTurnControlPort>) -> Self {
        self.turn_control = turn_control;
        self
    }

    pub async fn execute(
        &self,
        scheduled: ScheduledAgent,
        cancellation: CancellationToken,
    ) -> Result<AgentExecutionOutcome, AgentExecutionError> {
        self.supervisor
            .register_active_attempt(scheduled.attempt_id.clone(), cancellation.clone());
        let _active_attempt = ActiveAttemptGuard {
            supervisor: self.supervisor.as_ref(),
            attempt_id: &scheduled.attempt_id,
        };
        let mut context = self.start_context(&scheduled).await?;
        self.events
            .publish(&context, AgentExecutionEvent::StateChanged);
        let mut cumulative_usage = context.attempt.usage;
        let mut command_elapsed_by_task = HashMap::new();
        let mut final_content = String::new();
        let execution_started = Instant::now();

        for _ in 0..MAX_EXECUTOR_TURNS {
            if cancellation.is_cancelled() {
                self.cancel(&mut context).await?;
                return Err(AgentExecutionError::Cancelled);
            }
            let mailbox_delta = self
                .supervisor
                .mailbox_delta(
                    &context.node.root_run_id,
                    &context.node.id,
                    &context.attempt.id,
                    MAX_MAILBOX_MESSAGES_PER_TURN,
                )
                .await?;
            if !mailbox_delta.is_empty() {
                self.events.publish(
                    &context,
                    AgentExecutionEvent::MailboxReceived(mailbox_delta.clone()),
                );
            }
            let finalization_required =
                finalization_required(&context.node.budget, &cumulative_usage);
            let prompt = match self
                .prompt
                .compose(AgentPromptRequest {
                    context: context.clone(),
                    mailbox_delta: mailbox_delta.clone(),
                    finalization_required,
                })
                .await
            {
                Ok(prompt) => prompt,
                Err(error) => {
                    self.fail(&mut context, &error.message, cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Prompt(error));
                }
            };
            let messages = match self.ledger.load_messages(&context).await {
                Ok(messages) => messages,
                Err(error) => {
                    self.fail(&mut context, &error.message, cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Ledger(error));
                }
            };
            let definitions = match self
                .tools
                .definitions(&context, finalization_required)
                .await
            {
                Ok(definitions) => definitions,
                Err(error) => {
                    self.fail(&mut context, &error.message, cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Tool(error));
                }
            };
            let permit = self
                .supervisor
                .scheduler()
                .acquire_provider(&context.node.root_run_id, &scheduled.provider_id)
                .await
                .map_err(|_| AgentExecutionError::Cancelled)?;
            let turn = self
                .provider
                .run_turn(
                    AgentProviderRequest {
                        context: context.clone(),
                        system_prompt: prompt,
                        messages,
                        tools: definitions,
                    },
                    self.events.as_ref(),
                    cancellation.clone(),
                )
                .await;
            drop(permit);
            let turn = match turn {
                Ok(turn) => turn,
                Err(error) => {
                    if cancellation.is_cancelled() {
                        self.cancel(&mut context).await?;
                        return Err(AgentExecutionError::Cancelled);
                    }
                    self.fail(&mut context, &error.message, cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Provider(error));
                }
            };
            final_content.clone_from(&turn.content);
            merge_provider_usage(&mut cumulative_usage, turn.usage.as_ref());
            record_wall_time(&mut cumulative_usage, execution_started);
            let remaining = match self
                .supervisor
                .record_usage(
                    &context.node.root_run_id,
                    &context.node.id,
                    &context.attempt.id,
                    cumulative_usage,
                )
                .await
            {
                Ok(remaining) => remaining,
                Err(error) => {
                    self.fail(&mut context, &error.to_string(), cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Supervisor(error));
                }
            };
            context.attempt.usage = cumulative_usage;
            self.events.publish(
                &context,
                AgentExecutionEvent::UsageUpdated {
                    usage: cumulative_usage,
                    remaining,
                },
            );
            if let Err(error) = self.ledger.append_assistant(&context, &turn).await {
                self.fail(&mut context, &error.message, cumulative_usage)
                    .await?;
                return Err(AgentExecutionError::Ledger(error));
            }
            if !mailbox_delta.is_empty() {
                let cursor = self
                    .supervisor
                    .consume_mailbox(
                        &context.node.root_run_id,
                        &context.attempt.id,
                        &mailbox_delta,
                    )
                    .await?;
                context.attempt.mailbox_cursor = cursor;
            }
            if turn.tool_calls.is_empty() {
                match self.turn_control.after_assistant(&context, &turn).await {
                    Ok(AgentTurnDirective::Continue) => continue,
                    Ok(AgentTurnDirective::Finish) => {}
                    Err(error) => {
                        self.fail(&mut context, &error.message, cumulative_usage)
                            .await?;
                        return Err(AgentExecutionError::Control(error));
                    }
                }
                if cancellation.is_cancelled() {
                    self.cancel(&mut context).await?;
                    return Err(AgentExecutionError::Cancelled);
                }
                let result = implicit_result(&context, &turn.content, cumulative_usage);
                return self.finish(context, result, turn.content).await;
            }
            self.events.publish(
                &context,
                AgentExecutionEvent::ToolBatchStarted(turn.tool_calls.clone()),
            );
            cumulative_usage.tool_calls = cumulative_usage
                .tool_calls
                .saturating_add(turn.tool_calls.len() as u64);
            record_wall_time(&mut cumulative_usage, execution_started);
            let remaining = match self
                .supervisor
                .record_usage(
                    &context.node.root_run_id,
                    &context.node.id,
                    &context.attempt.id,
                    cumulative_usage,
                )
                .await
            {
                Ok(remaining) => remaining,
                Err(error) => {
                    self.fail(&mut context, &error.to_string(), cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Supervisor(error));
                }
            };
            self.events.publish(
                &context,
                AgentExecutionEvent::UsageUpdated {
                    usage: cumulative_usage,
                    remaining,
                },
            );
            let batch = match self
                .tools
                .execute(&context, turn.tool_calls, cancellation.clone())
                .await
            {
                Ok(batch) => batch,
                Err(error) => {
                    self.fail(&mut context, &error.message, cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Tool(error));
                }
            };
            record_tool_result_usage(
                &mut cumulative_usage,
                &batch.results,
                &mut command_elapsed_by_task,
            );
            record_wall_time(&mut cumulative_usage, execution_started);
            for result in &batch.results {
                if let Err(error) = self.ledger.append_tool_result(&context, result).await {
                    self.fail(&mut context, &error.message, cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Ledger(error));
                }
            }
            self.events.publish(
                &context,
                AgentExecutionEvent::ToolBatchCompleted(batch.results),
            );
            let remaining = match self
                .supervisor
                .record_usage(
                    &context.node.root_run_id,
                    &context.node.id,
                    &context.attempt.id,
                    cumulative_usage,
                )
                .await
            {
                Ok(remaining) => remaining,
                Err(error) => {
                    self.fail(&mut context, &error.to_string(), cumulative_usage)
                        .await?;
                    return Err(AgentExecutionError::Supervisor(error));
                }
            };
            self.events.publish(
                &context,
                AgentExecutionEvent::UsageUpdated {
                    usage: cumulative_usage,
                    remaining,
                },
            );
            if let Some(mut result) = batch.submitted_result {
                if cancellation.is_cancelled() {
                    self.cancel(&mut context).await?;
                    return Err(AgentExecutionError::Cancelled);
                }
                result.usage = cumulative_usage;
                return self.finish(context, result, final_content).await;
            }
        }

        self.fail(
            &mut context,
            "Agent executor exceeded the maximum number of turns",
            cumulative_usage,
        )
        .await?;
        Err(AgentExecutionError::TurnLimit)
    }

    async fn start_context(
        &self,
        scheduled: &ScheduledAgent,
    ) -> Result<AgentExecutionContext, AgentExecutionError> {
        let snapshot = self.supervisor.store().load(&scheduled.root_run_id).await?;
        let mut node = snapshot
            .nodes
            .get(&scheduled.agent_id)
            .cloned()
            .ok_or_else(|| AgentStoreError::AgentNotFound(scheduled.agent_id.to_string()))?;
        let mut attempt = snapshot
            .current_attempt(&scheduled.agent_id)
            .cloned()
            .ok_or_else(|| AgentStoreError::AttemptNotFound(scheduled.attempt_id.to_string()))?;
        if attempt.id != scheduled.attempt_id {
            return Err(AgentExecutionError::AttemptMismatch);
        }
        if node.state == codez_core::agent::AgentState::Queued {
            node = self
                .supervisor
                .transition(
                    &scheduled.root_run_id,
                    &scheduled.agent_id,
                    &scheduled.attempt_id,
                    node.state_revision,
                    codez_core::agent::AgentState::Starting,
                )
                .await?;
            node = self
                .supervisor
                .transition(
                    &scheduled.root_run_id,
                    &scheduled.agent_id,
                    &scheduled.attempt_id,
                    node.state_revision,
                    codez_core::agent::AgentState::Running,
                )
                .await?;
        } else if node.state == codez_core::agent::AgentState::Starting {
            node = self
                .supervisor
                .transition(
                    &scheduled.root_run_id,
                    &scheduled.agent_id,
                    &scheduled.attempt_id,
                    node.state_revision,
                    codez_core::agent::AgentState::Running,
                )
                .await?;
        } else if node.state != codez_core::agent::AgentState::Running {
            return Err(AgentExecutionError::InvalidScheduledState);
        }
        attempt.state = node.state;
        attempt.state_revision = node.state_revision;
        Ok(AgentExecutionContext { node, attempt })
    }

    async fn finish(
        &self,
        context: AgentExecutionContext,
        result: AgentResult,
        final_content: String,
    ) -> Result<AgentExecutionOutcome, AgentExecutionError> {
        let result = self
            .supervisor
            .submit_result(
                &context.node.root_run_id,
                &context.node.id,
                &context.attempt.id,
                result,
            )
            .await?;
        self.events.publish(
            &context,
            AgentExecutionEvent::ResultSubmitted(result.clone()),
        );
        Ok(AgentExecutionOutcome {
            result,
            final_content,
        })
    }

    async fn fail(
        &self,
        context: &mut AgentExecutionContext,
        message: &str,
        usage: AgentUsage,
    ) -> Result<(), AgentExecutionError> {
        let result = AgentResult {
            status: AgentResultStatus::Failed,
            summary: bounded_summary(message),
            conclusion: None,
            changes: Vec::<ChangedArtifact>::new(),
            validations: Vec::<AgentValidationResult>::new(),
            findings: Vec::<AgentFinding>::new(),
            blockers: vec![message.to_string()],
            unresolved: Vec::new(),
            recommended_next_actions: Vec::new(),
            confidence: None,
            review_verdict: (context.node.profile == codez_core::agent::AgentProfile::Review)
                .then_some(codez_core::agent::AgentReviewVerdict::Blocked),
            artifact_refs: Vec::new(),
            usage,
        };
        self.supervisor
            .submit_result(
                &context.node.root_run_id,
                &context.node.id,
                &context.attempt.id,
                result,
            )
            .await?;
        Ok(())
    }

    async fn cancel(&self, context: &mut AgentExecutionContext) -> Result<(), AgentExecutionError> {
        self.supervisor
            .cancel_subtree(&context.node.root_run_id, &context.node.id)
            .await?;
        Ok(())
    }
}

struct ActiveAttemptGuard<'a> {
    supervisor: &'a AgentSupervisor,
    attempt_id: &'a codez_core::AgentAttemptId,
}

impl Drop for ActiveAttemptGuard<'_> {
    fn drop(&mut self) {
        self.supervisor.unregister_active_attempt(self.attempt_id);
    }
}

fn implicit_result(
    context: &AgentExecutionContext,
    content: &str,
    usage: AgentUsage,
) -> AgentResult {
    let is_root = context.node.parent_id.is_none();
    let is_reviewer = context.node.profile == codez_core::agent::AgentProfile::Review;
    AgentResult {
        status: if is_reviewer {
            AgentResultStatus::Blocked
        } else if is_root {
            AgentResultStatus::Completed
        } else {
            AgentResultStatus::Partial
        },
        summary: bounded_summary(content),
        conclusion: (!content.trim().is_empty()).then(|| content.to_string()),
        changes: Vec::new(),
        validations: Vec::new(),
        findings: Vec::new(),
        blockers: if is_reviewer {
            vec!["Reviewer ended without submitting an explicit verdict".to_string()]
        } else {
            Vec::new()
        },
        unresolved: if is_root {
            Vec::new()
        } else {
            vec!["Child attempt ended without calling submit_agent_result".to_string()]
        },
        recommended_next_actions: Vec::new(),
        confidence: None,
        review_verdict: is_reviewer.then_some(codez_core::agent::AgentReviewVerdict::Blocked),
        artifact_refs: Vec::new(),
        usage,
    }
}

fn merge_provider_usage(cumulative: &mut AgentUsage, usage: Option<&ProviderTokenUsage>) {
    let Some(usage) = usage else {
        return;
    };
    cumulative.input_tokens = cumulative
        .input_tokens
        .saturating_add(u64::from(usage.input_tokens));
    cumulative.output_tokens = cumulative
        .output_tokens
        .saturating_add(u64::from(usage.output_tokens));
}

fn record_tool_result_usage(
    cumulative: &mut AgentUsage,
    results: &[AgentToolResult],
    command_elapsed_by_task: &mut HashMap<String, u64>,
) {
    for result in results {
        cumulative.model_visible_tool_result_bytes = cumulative
            .model_visible_tool_result_bytes
            .saturating_add(u64::try_from(result.model_content.len()).unwrap_or(u64::MAX));
        cumulative.files_written = cumulative
            .files_written
            .saturating_add(u64::try_from(result.file_changes.len()).unwrap_or(u64::MAX));
        cumulative.files_read = cumulative
            .files_read
            .saturating_add(result.usage.files_read);
        if let (Some(task_id), Some(total_ms)) = (
            result.usage.command_task_id.as_ref(),
            result.usage.command_elapsed_total_ms,
        ) {
            let previous = command_elapsed_by_task.entry(task_id.clone()).or_default();
            cumulative.command_wall_time_ms = cumulative
                .command_wall_time_ms
                .saturating_add(total_ms.saturating_sub(*previous));
            *previous = (*previous).max(total_ms);
        }
    }
}

fn record_wall_time(cumulative: &mut AgentUsage, started: Instant) {
    cumulative.wall_time_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
}

fn finalization_required(budget: &AgentBudget, usage: &AgentUsage) -> bool {
    ratio_at_least(usage.input_tokens, budget.input_tokens, 75)
        || ratio_at_least(usage.output_tokens, budget.output_tokens, 75)
        || ratio_at_least(usage.provider_cost_micros, budget.provider_cost_micros, 75)
        || ratio_at_least(usage.tool_calls, budget.tool_calls, 75)
        || ratio_at_least(
            usage.model_visible_tool_result_bytes,
            budget.model_visible_tool_result_bytes,
            75,
        )
        || ratio_at_least(usage.command_wall_time_ms, budget.command_wall_time_ms, 75)
        || ratio_at_least(usage.wall_time_ms, budget.wall_time_ms, 75)
        || ratio_at_least(usage.files_read, budget.files_read, 75)
        || ratio_at_least(usage.files_written, budget.files_written, 75)
        || ratio_at_least(usage.child_agents, budget.child_agents, 75)
}

fn ratio_at_least(used: u64, limit: u64, percent: u64) -> bool {
    limit > 0 && used.saturating_mul(100) >= limit.saturating_mul(percent)
}

fn bounded_summary(content: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let trimmed = content.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(MAX_CHARS).collect()
}

impl From<AgentExecutionError> for AppError {
    fn from(error: AgentExecutionError) -> Self {
        match error {
            AgentExecutionError::Cancelled => AppError::cancelled("Agent execution was cancelled"),
            AgentExecutionError::InvalidScheduledState | AgentExecutionError::AttemptMismatch => {
                AppError::conflict(error.to_string())
            }
            AgentExecutionError::Prompt(_)
            | AgentExecutionError::Provider(_)
            | AgentExecutionError::Tool(_)
            | AgentExecutionError::Ledger(_)
            | AgentExecutionError::Control(_)
            | AgentExecutionError::TurnLimit
            | AgentExecutionError::Supervisor(_)
            | AgentExecutionError::Store(_) => AppError::internal(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use codez_core::agent::AgentUsage;

    use super::{AgentToolResult, AgentToolUsage, record_tool_result_usage};

    #[test]
    fn command_usage_should_charge_only_elapsed_deltas_for_the_same_task() {
        let first = tool_result("call-start", 30_000, 2);
        let completed = tool_result("call-wait", 42_000, 1);
        let mut usage = AgentUsage::default();
        let mut elapsed_by_task = HashMap::new();

        record_tool_result_usage(&mut usage, &[first], &mut elapsed_by_task);
        record_tool_result_usage(&mut usage, &[completed], &mut elapsed_by_task);

        assert_eq!(usage.command_wall_time_ms, 42_000);
        assert_eq!(usage.files_read, 3);
    }

    fn tool_result(call_id: &str, elapsed_ms: u64, files_read: u64) -> AgentToolResult {
        AgentToolResult {
            call_id: call_id.to_string(),
            name: "PowerShell".to_string(),
            model_content: "command result".to_string(),
            status: "success".to_string(),
            file_changes: Vec::new(),
            usage: AgentToolUsage {
                command_task_id: Some("PowerShell:task-1".to_string()),
                command_elapsed_total_ms: Some(elapsed_ms),
                files_read,
            },
        }
    }
}
