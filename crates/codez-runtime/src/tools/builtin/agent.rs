use std::{sync::Arc, time::Duration};

use codez_core::{AppError, AppErrorKind, SessionId, WorkspaceRoot};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    agent::collaboration::{
        AgentDepth, AgentExpectations, AgentLaunchPolicy, AgentRuntime, AgentScope,
        AgentWaitOutcome, SpawnAgentInput,
    },
    tools::{
        registry::{
            BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext,
            ToolDescriptor, ToolHandler,
        },
        types::{
            ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
            ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
            ToolPlanningContext, ToolSource,
        },
    },
};

const DEFAULT_WAIT_MS: u64 = 30_000;
const MAX_WAIT_MS: u64 = 300_000;

#[derive(Clone, Copy)]
enum AgentToolKind {
    Spawn,
    Followup,
    Send,
    List,
    Wait,
    Interrupt,
}

/// One of the durable Agent collaboration handlers exposed to model tool loops.
pub struct AgentTool {
    descriptor: DefaultToolDescriptor,
    kind: AgentToolKind,
    runtime: Arc<AgentRuntime>,
}

impl AgentTool {
    #[must_use]
    pub fn spawn(runtime: Arc<AgentRuntime>) -> Self {
        Self::new(
            AgentToolKind::Spawn,
            "spawn_agent",
            "Start a durable Explore or Reviewer Agent.",
            "Creates a session-owned child Agent and returns after its supervised attempt starts.",
            spawn_schema(),
            runtime,
        )
    }

    #[must_use]
    pub fn followup(runtime: Arc<AgentRuntime>) -> Self {
        Self::new(
            AgentToolKind::Followup,
            "followup_task",
            "Start a new attempt for a completed Agent.",
            "Sends a follow-up task to a direct child Agent using a new durable attempt ID.",
            target_message_schema(),
            runtime,
        )
    }

    #[must_use]
    pub fn send(runtime: Arc<AgentRuntime>) -> Self {
        Self::new(
            AgentToolKind::Send,
            "send_message",
            "Send a durable Agent mailbox message.",
            "Posts a stable session-scoped message to an Agent ID, Agent path, or /root.",
            target_message_schema(),
            runtime,
        )
    }

    #[must_use]
    pub fn list(runtime: Arc<AgentRuntime>) -> Self {
        Self::new(
            AgentToolKind::List,
            "list_agents",
            "List Agents owned by the active session.",
            "Returns the durable Agent records and active attempt IDs for the active session.",
            empty_schema(),
            runtime,
        )
    }

    #[must_use]
    pub fn wait(runtime: Arc<AgentRuntime>) -> Self {
        Self::new(
            AgentToolKind::Wait,
            "wait_agent",
            "Wait for durable Agent mailbox updates.",
            "Waits for unread messages from selected Agents without losing concurrent wakeups.",
            wait_schema(),
            runtime,
        )
    }

    #[must_use]
    pub fn interrupt(runtime: Arc<AgentRuntime>) -> Self {
        Self::new(
            AgentToolKind::Interrupt,
            "interrupt_agent",
            "Interrupt an active Agent attempt.",
            "Cancels the selected Agent attempt and all descendant attempt tokens.",
            target_schema(),
            runtime,
        )
    }

    fn new(
        kind: AgentToolKind,
        name: &'static str,
        summary: &str,
        description: &str,
        input_schema: Value,
        runtime: Arc<AgentRuntime>,
    ) -> Self {
        let concurrency = if matches!(kind, AgentToolKind::List) {
            ToolConcurrency::Safe
        } else {
            ToolConcurrency::ResourceLocked
        };
        let timeout_ms = if matches!(kind, AgentToolKind::Wait) {
            Some((MAX_WAIT_MS + 5_000) as u32)
        } else {
            Some(30_000)
        };
        Self {
            descriptor: DefaultToolDescriptor {
                name,
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: format!("builtin:{name}"),
                summary: summary.to_string(),
                description: description.to_string(),
                input_schema,
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Always,
                },
                behavior: ToolBehavior {
                    concurrency,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 512 * 1024,
                    timeout_ms,
                },
            },
            kind,
            runtime,
        }
    }

    fn effect(&self, input: &Value, session_id: Option<&str>) -> ToolEffect {
        match self.kind {
            AgentToolKind::Spawn => {
                let role = input
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unavailable")
                    .to_string();
                ToolEffect::SpawnAgent {
                    read_only: role == "Explore"
                        && !input
                            .get("allowShell")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        && input
                            .get("allowedWriteFiles")
                            .and_then(Value::as_array)
                            .is_none_or(Vec::is_empty),
                    role,
                    isolation: Some("session".to_string()),
                }
            }
            AgentToolKind::List | AgentToolKind::Wait => ToolEffect::ReadMemory {
                path: agent_resource(session_id),
            },
            AgentToolKind::Followup => ToolEffect::ControlExecution {
                execution_id: target_for_effect(input),
                action: "followup".to_string(),
            },
            AgentToolKind::Send => ToolEffect::Internal {
                target: agent_resource(session_id),
            },
            AgentToolKind::Interrupt => ToolEffect::ControlExecution {
                execution_id: target_for_effect(input),
                action: "interrupt".to_string(),
            },
        }
    }
}

impl ToolHandler for AgentTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            ToolEffectPlan {
                effects: vec![self.effect(input, context.session_id.as_deref())],
                analysis_status: "parsed".to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move { vec![agent_resource(context.session_id.as_deref())] })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let effect = self.effect(input, context.session_id.as_deref());
            if context.cancellation.is_cancelled() {
                return cancelled_result(effect);
            }
            let session_id = match parse_session_id(context.session_id.as_deref()) {
                Ok(session_id) => session_id,
                Err(error) => return error_result(error, effect),
            };
            let result = match self.kind {
                AgentToolKind::Spawn => {
                    execute_spawn(&self.runtime, &session_id, input, context).await
                }
                AgentToolKind::Followup => {
                    execute_followup(&self.runtime, &session_id, input, context).await
                }
                AgentToolKind::Send => {
                    execute_send(&self.runtime, &session_id, input, context).await
                }
                AgentToolKind::List => execute_list(&self.runtime, &session_id).await,
                AgentToolKind::Wait => {
                    execute_wait(&self.runtime, &session_id, input, context).await
                }
                AgentToolKind::Interrupt => {
                    execute_interrupt(&self.runtime, &session_id, input).await
                }
            };
            match result {
                Ok(value) => success_result(value, effect),
                Err(error) if error.kind() == AppErrorKind::Cancelled => {
                    cancelled_error_result(error, effect)
                }
                Err(error) => error_result(error, effect),
            }
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpawnArguments {
    role: String,
    task_name: String,
    #[serde(default)]
    description: String,
    message: String,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    expectations: Option<AgentExpectations>,
    #[serde(default)]
    scope: Option<AgentScope>,
    #[serde(default)]
    depth: Option<AgentDepth>,
    #[serde(default)]
    allowed_write_files: Vec<String>,
    #[serde(default)]
    allow_shell: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetMessageArguments {
    target: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetArguments {
    target: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitArguments {
    #[serde(default)]
    targets: Vec<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

async fn execute_spawn(
    runtime: &Arc<AgentRuntime>,
    session_id: &SessionId,
    input: &Value,
    context: &ToolContext,
) -> Result<Value, AppError> {
    let arguments: SpawnArguments = parse_arguments("spawn_agent", input)?;
    let record = runtime
        .spawn(
            session_id,
            SpawnAgentInput {
                workspace_root: workspace_root(context)?,
                parent_context_scope_id: context.context_scope_id.clone(),
                role: arguments.role,
                task_name: arguments.task_name,
                description: arguments.description,
                message: arguments.message,
                launch: AgentLaunchPolicy {
                    context: arguments.context,
                    expectations: arguments.expectations,
                    scope: arguments.scope,
                    depth: arguments.depth,
                    allowed_write_files: arguments.allowed_write_files,
                    allow_shell: arguments.allow_shell,
                },
            },
            context.cancellation.clone(),
        )
        .await?;
    Ok(serde_json::json!({ "agent": record }))
}

async fn execute_followup(
    runtime: &Arc<AgentRuntime>,
    session_id: &SessionId,
    input: &Value,
    context: &ToolContext,
) -> Result<Value, AppError> {
    let arguments: TargetMessageArguments = parse_arguments("followup_task", input)?;
    let record = runtime
        .followup(
            session_id,
            &context.context_scope_id,
            &arguments.target,
            arguments.message,
            workspace_root(context)?,
            context.cancellation.clone(),
        )
        .await?;
    Ok(serde_json::json!({ "agent": record }))
}

async fn execute_send(
    runtime: &AgentRuntime,
    session_id: &SessionId,
    input: &Value,
    context: &ToolContext,
) -> Result<Value, AppError> {
    let arguments: TargetMessageArguments = parse_arguments("send_message", input)?;
    let message = runtime
        .send_message(
            session_id,
            &context.context_scope_id,
            &arguments.target,
            arguments.message,
        )
        .await?;
    Ok(serde_json::json!({ "message": message }))
}

async fn execute_list(runtime: &AgentRuntime, session_id: &SessionId) -> Result<Value, AppError> {
    let snapshot = runtime.snapshot(session_id).await?;
    let active_ids = snapshot
        .agents
        .iter()
        .filter(|agent| agent.status.is_active())
        .map(|agent| agent.agent_id.clone())
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "agents": snapshot.agents,
        "activeIds": active_ids,
        "revision": snapshot.revision
    }))
}

async fn execute_wait(
    runtime: &AgentRuntime,
    session_id: &SessionId,
    input: &Value,
    context: &ToolContext,
) -> Result<Value, AppError> {
    let arguments: WaitArguments = parse_arguments("wait_agent", input)?;
    let timeout_ms = arguments.timeout_ms.unwrap_or(DEFAULT_WAIT_MS);
    if timeout_ms > MAX_WAIT_MS {
        return Err(AppError::validation(format!(
            "wait_agent timeoutMs cannot exceed {MAX_WAIT_MS}"
        )));
    }
    let wait = runtime.wait_for_update(
        session_id,
        &context.context_scope_id,
        &arguments.targets,
        Duration::from_millis(timeout_ms),
    );
    let result = tokio::select! {
        result = wait => result?,
        () = context.cancellation.cancelled() => {
            return Err(AppError::cancelled("The Agent wait was cancelled"));
        }
    };
    let outcome = match result.outcome {
        AgentWaitOutcome::Updated => "updated",
        AgentWaitOutcome::NoActiveAgents => "no_active_agents",
        AgentWaitOutcome::Timeout => "timeout",
    };
    Ok(serde_json::json!({
        "outcome": outcome,
        "messages": result.messages
    }))
}

async fn execute_interrupt(
    runtime: &AgentRuntime,
    session_id: &SessionId,
    input: &Value,
) -> Result<Value, AppError> {
    let arguments: TargetArguments = parse_arguments("interrupt_agent", input)?;
    let interrupted = runtime.interrupt(session_id, &arguments.target).await?;
    Ok(serde_json::json!({
        "target": arguments.target,
        "interrupted": interrupted
    }))
}

fn parse_arguments<T>(tool: &str, input: &Value) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(input.clone())
        .map_err(|source| AppError::validation(format!("{tool} input is invalid: {source}")))
}

fn parse_session_id(value: Option<&str>) -> Result<SessionId, AppError> {
    let value = value.ok_or_else(|| AppError::validation("The Agent tool requires a session"))?;
    SessionId::parse(value.to_string())
        .map_err(|source| AppError::validation(format!("The Agent session is invalid: {source}")))
}

fn workspace_root(context: &ToolContext) -> Result<WorkspaceRoot, AppError> {
    WorkspaceRoot::from_canonical(context.workspace_root.clone()).map_err(|source| {
        AppError::validation(format!(
            "The Agent workspace authority is invalid: {source}"
        ))
    })
}

fn target_for_effect(input: &Value) -> String {
    input
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("unavailable")
        .to_string()
}

fn agent_resource(session_id: Option<&str>) -> String {
    format!("session:{}:agents", session_id.unwrap_or("unavailable"))
}

fn success_result(value: Value, effect: ToolEffect) -> ToolExecutionResult {
    let content = value.to_string();
    ToolExecutionResult::Success {
        data: Some(value),
        model_content: content.clone(),
        ui_content: Some(content),
        effects: Some(vec![effect]),
    }
}

fn error_result(error: AppError, effect: ToolEffect) -> ToolExecutionResult {
    let (code, recoverable) = match error.kind() {
        AppErrorKind::Validation => ("AGENT_INPUT_INVALID", true),
        AppErrorKind::NotFound => ("AGENT_NOT_FOUND", true),
        AppErrorKind::Conflict | AppErrorKind::RunActive => ("AGENT_CONFLICT", true),
        AppErrorKind::Timeout => ("AGENT_TIMEOUT", true),
        AppErrorKind::Storage => ("AGENT_STORAGE_FAILED", error.retryable()),
        _ => ("AGENT_OPERATION_FAILED", false),
    };
    let message = error.public_message().to_string();
    ToolExecutionResult::Error {
        error: tool_error(code, &message, recoverable),
        model_content: Some(format!("Error: {message}")),
        ui_content: None,
        effects: Some(vec![effect]),
    }
}

fn cancelled_result(effect: ToolEffect) -> ToolExecutionResult {
    cancelled_error_result(AppError::cancelled("The Agent tool was cancelled"), effect)
}

fn cancelled_error_result(error: AppError, effect: ToolEffect) -> ToolExecutionResult {
    let message = error.public_message().to_string();
    ToolExecutionResult::Cancelled {
        error: tool_error("AGENT_CANCELLED", &message, false),
        model_content: Some(format!("Cancelled: {message}")),
        ui_content: None,
        effects: Some(vec![effect]),
    }
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

fn empty_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {}
    })
}

fn target_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["target"],
        "properties": {
            "target": { "type": "string", "minLength": 1, "maxLength": 512 }
        }
    })
}

fn target_message_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["target", "message"],
        "properties": {
            "target": { "type": "string", "minLength": 1, "maxLength": 512 },
            "message": { "type": "string", "minLength": 1, "maxLength": 131072 }
        }
    })
}

fn wait_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "targets": {
                "type": "array",
                "maxItems": 128,
                "items": { "type": "string", "minLength": 1, "maxLength": 512 }
            },
            "timeoutMs": {
                "type": "integer",
                "minimum": 0,
                "maximum": MAX_WAIT_MS
            }
        }
    })
}

fn spawn_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["role", "taskName", "message"],
        "properties": {
            "role": { "type": "string", "enum": ["Explore", "Reviewer"] },
            "taskName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]*$"
            },
            "description": { "type": "string", "maxLength": 4096 },
            "message": { "type": "string", "minLength": 1, "maxLength": 131072 },
            "context": { "type": "string", "minLength": 1, "maxLength": 262144 },
            "expectations": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "questions": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
                    "outOfScope": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }
                }
            },
            "scope": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "directories": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
                    "excludeGlobs": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } }
                }
            },
            "depth": { "type": "string", "enum": ["quick", "normal", "exhaustive"] },
            "allowedWriteFiles": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
            "allowShell": { "type": "boolean" }
        }
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use codez_core::{AppError, CancellationToken};
    use codez_storage::AtomicFileStore;

    use super::AgentTool;
    use crate::{
        agent::collaboration::{
            AgentAttemptExecutor, AgentAttemptOutput, AgentAttemptRequest, AgentRuntime,
        },
        tools::{
            registry::{ToolContext, ToolHandler},
            types::{ToolEffect, ToolEffectPlan, ToolExecutionResult, ToolPlanningContext},
        },
    };

    struct ImmediateExecutor;

    #[async_trait]
    impl AgentAttemptExecutor for ImmediateExecutor {
        async fn execute(
            &self,
            request: AgentAttemptRequest,
            _cancellation: CancellationToken,
        ) -> Result<AgentAttemptOutput, AppError> {
            Ok(AgentAttemptOutput {
                report: format!("completed {}", request.task),
                conclusion: None,
            })
        }
    }

    fn context(root: &std::path::Path, context_scope_id: &str) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            call_id: "call-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            session_id: Some("session-1".to_string()),
            context_scope_id: context_scope_id.to_string(),
            transaction_id: None,
            workspace_root: root.to_path_buf(),
            cancellation: CancellationToken::new(),
            authorized_effects: ToolEffectPlan {
                effects: Vec::new(),
                analysis_status: "parsed".to_string(),
            },
            file_services: None,
            deferred_tools: Vec::new(),
        }
    }

    #[tokio::test]
    async fn spawn_planning_marks_shell_disabled_agents_without_write_files_as_read_only() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            Arc::new(AtomicFileStore::default()),
            Arc::new(ImmediateExecutor),
        ));
        let spawn = AgentTool::spawn(runtime);
        let input = serde_json::json!({
            "role": "Explore",
            "taskName": "architecture_analysis",
            "message": "Inspect without modifying files",
            "allowShell": false
        });
        let plan = spawn
            .plan_effects(
                &input,
                &ToolPlanningContext {
                    workspace_root: directory.path().to_path_buf(),
                    session_id: Some("session-1".to_string()),
                    agent_role: "main".to_string(),
                },
            )
            .await;

        assert!(matches!(
            plan.effects.as_slice(),
            [ToolEffect::SpawnAgent {
                role,
                read_only: true,
                ..
            }] if role == "Explore"
        ));
    }

    #[tokio::test]
    async fn spawn_planning_does_not_call_reviewer_read_only_when_its_role_exposes_shell() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            Arc::new(AtomicFileStore::default()),
            Arc::new(ImmediateExecutor),
        ));
        let spawn = AgentTool::spawn(runtime);
        let input = serde_json::json!({
            "role": "Reviewer",
            "taskName": "review",
            "message": "Review the workspace",
            "allowShell": false
        });
        let plan = spawn
            .plan_effects(
                &input,
                &ToolPlanningContext {
                    workspace_root: directory.path().to_path_buf(),
                    session_id: Some("session-1".to_string()),
                    agent_role: "main".to_string(),
                },
            )
            .await;

        assert!(matches!(
            plan.effects.as_slice(),
            [ToolEffect::SpawnAgent {
                role,
                read_only: false,
                ..
            }] if role == "Reviewer"
        ));
    }

    #[tokio::test]
    async fn spawn_and_wait_tools_share_the_durable_runtime() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            Arc::new(AtomicFileStore::default()),
            Arc::new(ImmediateExecutor),
        ));
        let spawn = AgentTool::spawn(Arc::clone(&runtime));
        let wait = AgentTool::wait(runtime);
        let context = context(directory.path(), "main");
        let spawned = spawn
            .execute(
                &serde_json::json!({
                    "role": "Explore",
                    "taskName": "inspect",
                    "message": "Inspect the workspace"
                }),
                &context,
            )
            .await;
        let agent_id = match spawned {
            ToolExecutionResult::Success {
                data: Some(data), ..
            } => data["agent"]["agentId"]
                .as_str()
                .expect("spawn result must include an Agent ID")
                .to_string(),
            other => panic!("spawn tool must succeed, got {other:?}"),
        };

        let waited = wait
            .execute(
                &serde_json::json!({ "targets": [agent_id], "timeoutMs": 2_000 }),
                &context,
            )
            .await;

        assert!(matches!(
            waited,
            ToolExecutionResult::Success { data: Some(data), .. }
                if data["outcome"] == "updated"
                    && data["messages"][0]["messageType"] == "FINAL_ANSWER"
        ));
    }

    #[tokio::test]
    async fn subagent_context_cannot_follow_up_a_sibling() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let runtime = Arc::new(AgentRuntime::new(
            directory.path(),
            Arc::new(AtomicFileStore::default()),
            Arc::new(ImmediateExecutor),
        ));
        let spawn = AgentTool::spawn(Arc::clone(&runtime));
        let root = context(directory.path(), "main");
        let first = spawn
            .execute(
                &serde_json::json!({
                    "role": "Explore",
                    "taskName": "first",
                    "message": "Inspect first"
                }),
                &root,
            )
            .await;
        let second = spawn
            .execute(
                &serde_json::json!({
                    "role": "Explore",
                    "taskName": "second",
                    "message": "Inspect second"
                }),
                &root,
            )
            .await;
        let (first_scope, second_id) = match (first, second) {
            (
                ToolExecutionResult::Success {
                    data: Some(first), ..
                },
                ToolExecutionResult::Success {
                    data: Some(second), ..
                },
            ) => (
                first["agent"]["contextScopeId"]
                    .as_str()
                    .expect("first Agent scope must exist")
                    .to_string(),
                second["agent"]["agentId"]
                    .as_str()
                    .expect("second Agent ID must exist")
                    .to_string(),
            ),
            other => panic!("both Agent spawns must succeed, got {other:?}"),
        };
        let session =
            codez_core::SessionId::parse("session-1").expect("test session identity must parse");
        runtime
            .wait_for_update(&session, "main", &[], std::time::Duration::from_secs(2))
            .await
            .expect("both immediate Agents must finish");
        runtime
            .wait_for_update(&session, "main", &[], std::time::Duration::from_secs(2))
            .await
            .expect("both immediate Agent messages must be consumed");
        let followup = AgentTool::followup(runtime);

        let result = followup
            .execute(
                &serde_json::json!({ "target": second_id, "message": "Retry sibling" }),
                &context(directory.path(), &first_scope),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. } if error.code == "AGENT_NOT_FOUND"
        ));
    }
}
