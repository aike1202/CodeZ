use std::{path::Path, sync::Arc, time::Duration};

use codez_core::agent::{
    AgentBudget, AgentCompletionPolicy, AgentProfile, AgentReviewVerdict, AgentState,
    DelegatedTask, MessageKind, ResultSchema, WorkspaceAssignment, WorkspaceMode,
};
use codez_core::provider::{ToolDefinition, ToolDefinitionFunction};
use codez_core::{AgentId, ArtifactId, TaskId};
use codez_runtime::agent::{
    AgentHandle, AgentRootSnapshot, AgentSupervisor, SendAgentMessageInput, SpawnAgentInput,
    SpawnAgentRequest, WaitMode, WorkspaceBroker,
};
use codez_runtime::tools::types::{
    NormalizedToolCall, ToolExecutionError, ToolExecutionResult, ToolPipelineResult,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::chat_tool_runtime::ChatAgentRunIdentity;

pub(crate) const SPAWN_AGENT: &str = "spawn_agent";
pub(crate) const SPAWN_AGENTS: &str = "spawn_agents";
pub(crate) const SEND_AGENT_MESSAGE: &str = "send_agent_message";
pub(crate) const WAIT_AGENTS: &str = "wait_agents";
pub(crate) const INSPECT_AGENT: &str = "inspect_agent";
pub(crate) const LIST_AGENTS: &str = "list_agents";
pub(crate) const CANCEL_AGENT: &str = "cancel_agent";
pub(crate) const RESUME_AGENT: &str = "resume_agent";
pub(crate) const FOLLOWUP_AGENT: &str = "followup_agent";
pub(crate) const INTEGRATE_AGENT: &str = "integrate_agent";
pub(crate) const INTEGRATE_AGENTS: &str = "integrate_agents";
pub(crate) const REVIEW_AGENT: &str = "review_agent";

const MAX_MESSAGE_INPUT_CHARS: usize = 256 * 1024;
const MAX_WAIT_MS: u64 = 30_000;

pub(crate) fn is_agent_tool(name: &str) -> bool {
    matches!(
        name,
        SPAWN_AGENT
            | SPAWN_AGENTS
            | SEND_AGENT_MESSAGE
            | WAIT_AGENTS
            | INSPECT_AGENT
            | LIST_AGENTS
            | CANCEL_AGENT
            | RESUME_AGENT
            | FOLLOWUP_AGENT
            | REVIEW_AGENT
            | INTEGRATE_AGENT
            | INTEGRATE_AGENTS
    )
}

pub(crate) fn definitions(identity: &ChatAgentRunIdentity) -> Vec<ToolDefinition> {
    let mut definitions = Vec::new();
    if identity.policy.can_delegate && identity.depth < identity.policy.max_depth {
        definitions.push(definition(
            SPAWN_AGENT,
            "Create one durable full-context child Agent with inherited capabilities and return immediately after it is queued.",
            spawn_schema(),
        ));
        definitions.push(definition(
            REVIEW_AGENT,
            "Freeze a terminal writable child's patch and create a read-only Reviewer Agent against that immutable snapshot.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "agentId": { "type": "string" },
                    "objective": { "type": "string" },
                    "successCriteria": { "type": "array", "items": { "type": "string" } },
                    "budget": { "$ref": "#/$defs/budget" }
                },
                "$defs": spawn_schema()["$defs"].clone(),
                "required": ["agentId"]
            }),
        ));
        definitions.push(definition(
            SPAWN_AGENTS,
            "Atomically create up to three durable child Agents and return queued handles.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "agents": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 3,
                        "items": spawn_schema()
                    },
                    "completionPolicy": {
                        "type": "string",
                        "enum": ["collect_all", "fail_fast", "best_effort"]
                    }
                },
                "$defs": spawn_schema()["$defs"].clone(),
                "required": ["agents"]
            }),
        ));
    }
    if identity.policy.can_delegate {
        definitions.push(definition(
            RESUME_AGENT,
            "Create a new attempt for an interrupted or failed direct child Agent using its existing assignment.",
            agent_target_schema(),
        ));
        definitions.push(definition(
            FOLLOWUP_AGENT,
            "Create a new attempt for a terminal direct child Agent with a new self-contained assignment.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "agentId": { "type": "string" },
                    "assignment": spawn_schema()
                },
                "$defs": spawn_schema()["$defs"].clone(),
                "required": ["agentId", "assignment"]
            }),
        ));
    }
    if identity.policy.can_write {
        definitions.push(definition(
            INTEGRATE_AGENT,
            "Serially integrate a completed direct child's isolated worktree through a conflict-safe temporary merge workspace.",
            agent_target_schema(),
        ));
        definitions.push(definition(
            INTEGRATE_AGENTS,
            "Atomically integrate up to three reviewed child patches in one temporary merge workspace, then apply the combined patch once.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "agentIds": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 3,
                        "items": { "type": "string" }
                    }
                },
                "required": ["agentIds"]
            }),
        ));
    }
    definitions.extend([
        definition(
            SEND_AGENT_MESSAGE,
            "Send a concise durable message to an authorized parent or direct child Agent.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "agentId": { "type": "string" },
                    "kind": {
                        "type": "string",
                        "enum": ["instruction", "question", "answer", "progress", "finding", "result", "cancel_request", "contract_change", "system_notice"]
                    },
                    "summary": { "type": "string", "maxLength": MAX_MESSAGE_INPUT_CHARS },
                    "correlationId": { "type": "string" },
                    "replyTo": { "type": "string" },
                    "idempotencyKey": { "type": "string" },
                    "artifactRefs": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["agentId", "summary"]
            }),
        ),
        definition(
            WAIT_AGENTS,
            "Wait for any or all selected Agents using a durable event cursor and bounded timeout.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "agentIds": { "type": "array", "minItems": 1, "items": { "type": "string" } },
                    "mode": { "type": "string", "enum": ["any", "all"] },
                    "afterCursor": { "type": "integer", "minimum": 0 },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_MS },
                    "includeProgress": { "type": "boolean" }
                },
                "required": ["agentIds"]
            }),
        ),
        definition(
            INSPECT_AGENT,
            "Inspect one Agent's durable node, current attempt, and submitted result.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "agentId": { "type": "string" } },
                "required": ["agentId"]
            }),
        ),
        definition(
            LIST_AGENTS,
            "List the durable Agent tree for the current root task.",
            json!({ "type": "object", "additionalProperties": false, "properties": {} }),
        ),
        definition(
            CANCEL_AGENT,
            "Cancel an owned descendant Agent and its entire subtree.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "agentId": { "type": "string" } },
                "required": ["agentId"]
            }),
        ),
    ]);
    definitions
}

pub(crate) async fn execute(
    supervisor: &Arc<AgentSupervisor>,
    workspace_broker: Option<&Arc<WorkspaceBroker>>,
    call: NormalizedToolCall,
    identity: &ChatAgentRunIdentity,
    workspace_root: &Path,
) -> ToolPipelineResult {
    let canonical_name = call.name.clone();
    let result = execute_inner(
        supervisor,
        workspace_broker,
        &call,
        identity,
        workspace_root,
    )
    .await;
    match result {
        Ok(value) => success(canonical_name, call, value),
        Err(error) => failure(canonical_name, call, error),
    }
}

async fn execute_inner(
    supervisor: &Arc<AgentSupervisor>,
    workspace_broker: Option<&Arc<WorkspaceBroker>>,
    call: &NormalizedToolCall,
    identity: &ChatAgentRunIdentity,
    workspace_root: &Path,
) -> Result<Value, AgentToolError> {
    match call.name.as_str() {
        SPAWN_AGENT => {
            require_delegation(identity)?;
            let input: SpawnSpec = parse_arguments(call)?;
            let completion_policy = input.completion_policy.unwrap_or_default();
            let handles = spawn(
                supervisor,
                call,
                identity,
                workspace_root,
                vec![input],
                completion_policy,
            )
            .await?;
            serde_json::to_value(&handles[0]).map_err(AgentToolError::serialize)
        }
        SPAWN_AGENTS => {
            require_delegation(identity)?;
            let input: SpawnBatch = parse_arguments(call)?;
            let completion_policy = batch_completion_policy(&input)?;
            let handles = spawn(
                supervisor,
                call,
                identity,
                workspace_root,
                input.agents,
                completion_policy,
            )
            .await?;
            serde_json::to_value(handles).map_err(AgentToolError::serialize)
        }
        SEND_AGENT_MESSAGE => {
            let input: SendMessage = parse_arguments(call)?;
            let message = supervisor
                .send_message(SendAgentMessageInput {
                    root_run_id: identity.root_run_id.clone(),
                    from: identity.agent_id.clone(),
                    to: parse_agent_id(input.agent_id)?,
                    kind: input.kind.unwrap_or(MessageKind::Instruction),
                    summary: input.summary,
                    correlation_id: input.correlation_id,
                    reply_to: input
                        .reply_to
                        .map(codez_core::MessageId::parse)
                        .transpose()
                        .map_err(|error| AgentToolError::validation("AGENT_ID_INVALID", error))?,
                    idempotency_key: input.idempotency_key,
                    artifact_refs: parse_artifact_ids(input.artifact_refs)?,
                })
                .await
                .map_err(AgentToolError::supervisor)?;
            serde_json::to_value(message).map_err(AgentToolError::serialize)
        }
        WAIT_AGENTS => {
            let input: WaitAgents = parse_arguments(call)?;
            let mode = input.mode();
            let timeout_ms = input.timeout_ms.unwrap_or(1_000).min(MAX_WAIT_MS);
            let after_cursor = input.after_cursor.unwrap_or(0);
            let include_progress = input.include_progress.unwrap_or(false);
            let agent_ids = input
                .agent_ids
                .into_iter()
                .map(parse_agent_id)
                .collect::<Result<Vec<_>, _>>()?;
            let outcome = supervisor
                .wait_agents(
                    &identity.root_run_id,
                    &agent_ids,
                    mode,
                    after_cursor,
                    include_progress,
                    Duration::from_millis(timeout_ms),
                )
                .await
                .map_err(AgentToolError::supervisor)?;
            serde_json::to_value(json!({
                "cursor": outcome.cursor,
                "timedOut": outcome.timed_out,
                "agents": outcome.agents
            }))
            .map_err(AgentToolError::serialize)
        }
        INSPECT_AGENT => {
            let input: AgentTarget = parse_arguments(call)?;
            let target = parse_agent_id(input.agent_id)?;
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            ensure_visible(&snapshot, &target)?;
            let node = snapshot
                .nodes
                .get(&target)
                .ok_or_else(|| AgentToolError::not_found("Agent was not found."))?;
            let attempt = snapshot.current_attempt(&target);
            let result = attempt.and_then(|attempt| snapshot.results.get(&attempt.id));
            Ok(json!({ "agent": node, "attempt": attempt, "result": result }))
        }
        LIST_AGENTS => {
            let _: EmptyInput = parse_arguments(call)?;
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            let mut agents = snapshot.nodes.values().collect::<Vec<_>>();
            agents.sort_by(|left, right| {
                left.depth
                    .cmp(&right.depth)
                    .then_with(|| left.created_at.cmp(&right.created_at))
                    .then_with(|| left.id.cmp(&right.id))
            });
            Ok(json!({ "cursor": snapshot.through_sequence, "agents": agents }))
        }
        CANCEL_AGENT => {
            let input: AgentTarget = parse_arguments(call)?;
            let target = parse_agent_id(input.agent_id)?;
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            if target == identity.agent_id || !is_descendant(&snapshot, &target, &identity.agent_id)
            {
                return Err(AgentToolError::validation(
                    "AGENT_CANCEL_DENIED",
                    "An Agent can cancel only its descendants.",
                ));
            }
            let handles = supervisor
                .cancel_subtree(&identity.root_run_id, &target)
                .await
                .map_err(AgentToolError::supervisor)?;
            serde_json::to_value(handles).map_err(AgentToolError::serialize)
        }
        RESUME_AGENT => {
            require_delegation_authority(identity)?;
            let input: AgentTarget = parse_arguments(call)?;
            let target = parse_agent_id(input.agent_id)?;
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            let node = direct_child(&snapshot, &target, &identity.agent_id)?;
            if !matches!(node.state, AgentState::Interrupted | AgentState::Failed) {
                return Err(AgentToolError::validation(
                    "AGENT_RESUME_STATE_INVALID",
                    "Only interrupted or failed Agents can be resumed.",
                ));
            }
            let attempt = snapshot
                .current_attempt(&target)
                .ok_or_else(|| AgentToolError::not_found("Agent attempt was not found."))?;
            let handle = supervisor
                .start_followup_attempt(
                    &identity.root_run_id,
                    &target,
                    &call.call_id,
                    SpawnAgentInput {
                        root_session_id: None,
                        task: node.task.clone(),
                        profile: node.profile,
                        workspace: node.workspace.clone(),
                        policy: node.policy.clone(),
                        budget: node.budget,
                        provider_id: attempt.provider_id.clone(),
                        model_id: attempt.model_id.clone(),
                    },
                )
                .await
                .map_err(AgentToolError::supervisor)?;
            serde_json::to_value(handle).map_err(AgentToolError::serialize)
        }
        FOLLOWUP_AGENT => {
            require_delegation_authority(identity)?;
            let input: FollowupAgent = parse_arguments(call)?;
            let target = parse_agent_id(input.agent_id)?;
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            direct_child(&snapshot, &target, &identity.agent_id)?;
            let assignment = spawn_input(call, identity, workspace_root, input.assignment, 0)?;
            let handle = supervisor
                .start_followup_attempt(&identity.root_run_id, &target, &call.call_id, assignment)
                .await
                .map_err(AgentToolError::supervisor)?;
            serde_json::to_value(handle).map_err(AgentToolError::serialize)
        }
        REVIEW_AGENT => {
            require_delegation(identity)?;
            let input: ReviewAgent = parse_arguments(call)?;
            let target = parse_agent_id(input.agent_id)?;
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            let node = direct_child(&snapshot, &target, &identity.agent_id)?;
            if node.state != AgentState::Completed
                || node.workspace.mode != WorkspaceMode::IsolatedWorktree
            {
                return Err(AgentToolError::validation(
                    "AGENT_REVIEW_TARGET_INVALID",
                    "Only a completed isolated-worktree child can be frozen for review.",
                ));
            }
            let attempt = snapshot
                .current_attempt(&target)
                .ok_or_else(|| AgentToolError::not_found("Agent attempt was not found."))?;
            let broker = workspace_broker.ok_or_else(|| {
                AgentToolError::validation(
                    "AGENT_WORKSPACE_MODE_UNAVAILABLE",
                    "Git workspace isolation is unavailable.",
                )
            })?;
            let frozen = broker
                .freeze_review(&attempt.id, codez_core::CancellationToken::new())
                .await
                .map_err(|error| AgentToolError::validation("AGENT_REVIEW_FREEZE_FAILED", error))?;
            let review_task_id = TaskId::parse(stable_task_id(&call.call_id, 0))
                .map_err(|error| AgentToolError::validation("AGENT_TASK_ID_INVALID", error))?;
            let objective = input.objective.unwrap_or_else(|| {
                format!(
                    "Review the frozen patch from Agent {} against its original success criteria.",
                    target
                )
            });
            let success_criteria = input.success_criteria.unwrap_or_else(|| {
                vec![
                    "Report findings ordered by severity with file evidence.".to_string(),
                    "Submit an explicit reviewVerdict.".to_string(),
                ]
            });
            let handles = supervisor
                .spawn_agents(SpawnAgentRequest {
                    root_run_id: identity.root_run_id.clone(),
                    parent_agent_id: identity.agent_id.clone(),
                    parent_attempt_id: identity.attempt_id.clone(),
                    tool_call_id: call.call_id.clone(),
                    agents: vec![SpawnAgentInput {
                        root_session_id: None,
                        task: DelegatedTask {
                            task_id: review_task_id,
                            title: format!("Review {}", node.task.title),
                            objective,
                            known_facts: vec![
                                format!("Frozen patch SHA-256: {}", frozen.patch_sha256),
                                format!("Source Agent: {}", target),
                                format!("Source task: {}", node.task.task_id),
                            ],
                            success_criteria,
                            non_goals: vec![
                                "Do not modify the frozen review workspace.".to_string(),
                            ],
                            dependencies: vec![node.task.task_id.clone()],
                            context_refs: vec![frozen.artifact_id.clone()],
                            validation_expectations: vec![
                                "Inspect the frozen snapshot and patch, not the moving source workspace."
                                    .to_string(),
                            ],
                            expected_result_schema: ResultSchema::default(),
                        },
                        profile: AgentProfile::Review,
                        workspace: WorkspaceAssignment {
                            mode: WorkspaceMode::SharedReadonly,
                            root: frozen.snapshot_root.to_string_lossy().into_owned(),
                            read_scope: vec!["**/*".to_string()],
                            write_scope: Vec::new(),
                            baseline_revision: Some(frozen.baseline_revision.clone()),
                            baseline_manifest: Some(frozen.patch_sha256.clone()),
                            integration_policy: format!(
                                "frozen_review:{}",
                                frozen.artifact_id
                            ),
                        },
                        policy: codez_core::agent::AgentPolicy::readonly_child(),
                        budget: input
                            .budget
                            .unwrap_or_else(AgentBudget::conservative_child),
                        provider_id: identity.provider_id.clone(),
                        model_id: identity.model_id.clone(),
                    }],
                })
                .await
                .map_err(AgentToolError::supervisor)?;
            Ok(json!({ "reviewer": handles[0], "artifact": frozen }))
        }
        INTEGRATE_AGENT => {
            if !identity.policy.can_write {
                return Err(AgentToolError::validation(
                    "AGENT_INTEGRATION_DENIED",
                    "This Agent cannot integrate child workspace changes.",
                ));
            }
            let input: AgentTarget = parse_arguments(call)?;
            let target = parse_agent_id(input.agent_id)?;
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            let node = direct_child(&snapshot, &target, &identity.agent_id)?;
            if !node.state.is_terminal() {
                return Err(AgentToolError::validation(
                    "AGENT_INTEGRATION_STATE_INVALID",
                    "Only a terminal child Agent can be integrated.",
                ));
            }
            let attempt = snapshot
                .current_attempt(&target)
                .ok_or_else(|| AgentToolError::not_found("Agent attempt was not found."))?;
            let broker = workspace_broker.ok_or_else(|| {
                AgentToolError::validation(
                    "AGENT_WORKSPACE_MODE_UNAVAILABLE",
                    "Git workspace isolation is unavailable.",
                )
            })?;
            let frozen = broker
                .frozen_review(&attempt.id)
                .await
                .map_err(|error| AgentToolError::validation("AGENT_REVIEW_LOOKUP_FAILED", error))?
                .ok_or_else(|| {
                    AgentToolError::validation(
                        "AGENT_REVIEW_REQUIRED",
                        "Freeze and complete an independent Reviewer Agent before integration.",
                    )
                })?;
            require_approved_review(&snapshot, &frozen.artifact_id, &frozen.patch_sha256)?;
            let outcome = broker
                .integrate(&attempt.id, codez_core::CancellationToken::new())
                .await
                .map_err(|error| AgentToolError::validation("AGENT_INTEGRATION_FAILED", error))?;
            Ok(json!({
                "agentId": target.to_string(),
                "attemptId": attempt.id.to_string(),
                "changedFiles": outcome.changed_files,
                "childPatchPath": outcome.child_patch_path,
                "integrationPatchPath": outcome.integration_patch_path,
                "applied": outcome.applied
            }))
        }
        INTEGRATE_AGENTS => {
            if !identity.policy.can_write {
                return Err(AgentToolError::validation(
                    "AGENT_INTEGRATION_DENIED",
                    "This Agent cannot integrate child workspace changes.",
                ));
            }
            let input: AgentTargets = parse_arguments(call)?;
            if input.agent_ids.is_empty() || input.agent_ids.len() > 3 {
                return Err(AgentToolError::validation(
                    "AGENT_INTEGRATION_BATCH_INVALID",
                    "Integration batches require between one and three child Agents.",
                ));
            }
            let snapshot = supervisor
                .store()
                .load(&identity.root_run_id)
                .await
                .map_err(AgentToolError::supervisor)?;
            let broker = workspace_broker.ok_or_else(|| {
                AgentToolError::validation(
                    "AGENT_WORKSPACE_MODE_UNAVAILABLE",
                    "Git workspace isolation is unavailable.",
                )
            })?;
            let mut targets = Vec::with_capacity(input.agent_ids.len());
            let mut attempt_ids = Vec::with_capacity(input.agent_ids.len());
            for value in input.agent_ids {
                let target = parse_agent_id(value)?;
                let node = direct_child(&snapshot, &target, &identity.agent_id)?;
                if !node.state.is_terminal() {
                    return Err(AgentToolError::validation(
                        "AGENT_INTEGRATION_STATE_INVALID",
                        "Only terminal child Agents can be integrated.",
                    ));
                }
                let attempt = snapshot
                    .current_attempt(&target)
                    .ok_or_else(|| AgentToolError::not_found("Agent attempt was not found."))?;
                let frozen = broker
                    .frozen_review(&attempt.id)
                    .await
                    .map_err(|error| {
                        AgentToolError::validation("AGENT_REVIEW_LOOKUP_FAILED", error)
                    })?
                    .ok_or_else(|| {
                        AgentToolError::validation(
                            "AGENT_REVIEW_REQUIRED",
                            "Freeze and complete an independent Reviewer Agent before integration.",
                        )
                    })?;
                require_approved_review(&snapshot, &frozen.artifact_id, &frozen.patch_sha256)?;
                targets.push(target);
                attempt_ids.push(attempt.id.clone());
            }
            let outcome = broker
                .integrate_batch(&attempt_ids, codez_core::CancellationToken::new())
                .await
                .map_err(|error| AgentToolError::validation("AGENT_INTEGRATION_FAILED", error))?;
            Ok(json!({
                "agentIds": targets,
                "attemptIds": attempt_ids,
                "changedFiles": outcome.changed_files,
                "childPatchPaths": outcome.child_patch_paths,
                "integrationPatchPath": outcome.integration_patch_path,
                "applied": outcome.applied,
                "validation": "git diff --check"
            }))
        }
        _ => Err(AgentToolError::validation(
            "AGENT_TOOL_UNKNOWN",
            "Unknown Agent collaboration tool.",
        )),
    }
}

async fn spawn(
    supervisor: &Arc<AgentSupervisor>,
    call: &NormalizedToolCall,
    identity: &ChatAgentRunIdentity,
    workspace_root: &Path,
    specs: Vec<SpawnSpec>,
    completion_policy: AgentCompletionPolicy,
) -> Result<Vec<AgentHandle>, AgentToolError> {
    if specs.is_empty() || specs.len() > 3 {
        return Err(AgentToolError::validation(
            "AGENT_SPAWN_BATCH_INVALID",
            "Spawn batches require between one and three Agents.",
        ));
    }
    let mut agents = Vec::with_capacity(specs.len());
    for (index, spec) in specs.into_iter().enumerate() {
        agents.push(spawn_input(call, identity, workspace_root, spec, index)?);
    }
    supervisor
        .spawn_agents_with_policy(
            SpawnAgentRequest {
                root_run_id: identity.root_run_id.clone(),
                parent_agent_id: identity.agent_id.clone(),
                parent_attempt_id: identity.attempt_id.clone(),
                tool_call_id: call.call_id.clone(),
                agents,
            },
            completion_policy,
        )
        .await
        .map_err(AgentToolError::supervisor)
}

fn spawn_input(
    call: &NormalizedToolCall,
    identity: &ChatAgentRunIdentity,
    workspace_root: &Path,
    spec: SpawnSpec,
    index: usize,
) -> Result<SpawnAgentInput, AgentToolError> {
    let profile = spec.profile.unwrap_or(AgentProfile::General);
    let workspace_mode = spec.workspace_mode.unwrap_or({
        if identity.policy.can_write
            && !matches!(profile, AgentProfile::Explore | AgentProfile::Review)
        {
            WorkspaceMode::RootWorkspace
        } else {
            WorkspaceMode::SharedReadonly
        }
    });
    let write_scope = if matches!(
        workspace_mode,
        WorkspaceMode::RootWorkspace | WorkspaceMode::IsolatedWorktree
    ) && spec.write_scope.is_empty()
    {
        vec!["**/*".to_string()]
    } else {
        spec.write_scope
    };
    if workspace_mode == WorkspaceMode::SharedReadonly && !write_scope.is_empty() {
        return Err(AgentToolError::validation(
            "AGENT_WORKSPACE_SCOPE_INVALID",
            "A shared read-only Agent cannot receive write scopes.",
        ));
    }
    let task_id = TaskId::parse(
        spec.task_id
            .unwrap_or_else(|| stable_task_id(&call.call_id, index)),
    )
    .map_err(|error| AgentToolError::validation("AGENT_TASK_ID_INVALID", error))?;
    let dependencies = spec
        .depends_on
        .into_iter()
        .map(TaskId::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AgentToolError::validation("AGENT_TASK_ID_INVALID", error))?;
    let mut policy = identity.policy.clone();
    if workspace_mode == WorkspaceMode::SharedReadonly {
        policy.can_write = false;
        policy.can_delete = false;
        policy.can_install_dependencies = false;
        policy.can_git_push = false;
    }
    if let Some(can_delegate) = spec.can_delegate {
        policy.can_delegate &= can_delegate;
    }
    if let Some(can_use_network) = spec.can_use_network {
        policy.can_use_network &= can_use_network;
    }
    Ok(SpawnAgentInput {
        root_session_id: None,
        task: DelegatedTask {
            task_id,
            title: spec.title.unwrap_or_else(|| "Delegated task".to_string()),
            objective: spec.task,
            known_facts: spec.known_facts,
            success_criteria: spec.success_criteria,
            non_goals: spec.non_goals,
            dependencies,
            context_refs: parse_artifact_ids(spec.context_refs)?,
            validation_expectations: spec.validation_expectations,
            expected_result_schema: ResultSchema::default(),
        },
        profile,
        workspace: WorkspaceAssignment {
            mode: workspace_mode,
            root: workspace_root.to_string_lossy().into_owned(),
            read_scope: if spec.read_scope.is_empty() {
                vec!["**/*".to_string()]
            } else {
                spec.read_scope
            },
            write_scope,
            baseline_revision: None,
            baseline_manifest: None,
            integration_policy: if workspace_mode == WorkspaceMode::IsolatedWorktree {
                "serial_three_way".to_string()
            } else if workspace_mode == WorkspaceMode::RootWorkspace {
                "direct_serial".to_string()
            } else {
                "none".to_string()
            },
        },
        policy,
        budget: spec.budget.unwrap_or_else(AgentBudget::conservative_child),
        provider_id: identity.provider_id.clone(),
        model_id: identity.model_id.clone(),
    })
}

fn require_delegation(identity: &ChatAgentRunIdentity) -> Result<(), AgentToolError> {
    if !identity.policy.can_delegate || identity.depth >= identity.policy.max_depth {
        return Err(AgentToolError::validation(
            "AGENT_DELEGATION_DENIED",
            "This Agent cannot create another child at its current depth.",
        ));
    }
    Ok(())
}

fn require_delegation_authority(identity: &ChatAgentRunIdentity) -> Result<(), AgentToolError> {
    if identity.policy.can_delegate {
        Ok(())
    } else {
        Err(AgentToolError::validation(
            "AGENT_DELEGATION_DENIED",
            "This Agent cannot manage child attempts.",
        ))
    }
}

fn ensure_visible(snapshot: &AgentRootSnapshot, target: &AgentId) -> Result<(), AgentToolError> {
    if snapshot.nodes.contains_key(target) {
        Ok(())
    } else {
        Err(AgentToolError::not_found("Agent was not found."))
    }
}

fn direct_child<'a>(
    snapshot: &'a AgentRootSnapshot,
    target: &AgentId,
    parent: &AgentId,
) -> Result<&'a codez_core::agent::AgentNode, AgentToolError> {
    let node = snapshot
        .nodes
        .get(target)
        .ok_or_else(|| AgentToolError::not_found("Agent was not found."))?;
    if node.parent_id.as_ref() != Some(parent) {
        return Err(AgentToolError::validation(
            "AGENT_MANAGEMENT_DENIED",
            "An Agent can resume or follow up only its direct children.",
        ));
    }
    Ok(node)
}

fn require_approved_review(
    snapshot: &AgentRootSnapshot,
    artifact_id: &ArtifactId,
    patch_sha256: &str,
) -> Result<(), AgentToolError> {
    let verdicts = snapshot
        .nodes
        .values()
        .filter(|node| {
            node.profile == AgentProfile::Review
                && node.workspace.baseline_manifest.as_deref() == Some(patch_sha256)
                && node.task.context_refs.contains(artifact_id)
        })
        .filter_map(|reviewer| snapshot.current_attempt(&reviewer.id))
        .filter_map(|attempt| snapshot.results.get(&attempt.id))
        .map(|result| result.review_verdict);
    require_approved_verdicts(verdicts)
}

fn require_approved_verdicts(
    verdicts: impl IntoIterator<Item = Option<AgentReviewVerdict>>,
) -> Result<(), AgentToolError> {
    let mut approved = false;
    for verdict in verdicts {
        match verdict {
            Some(AgentReviewVerdict::Approved) => approved = true,
            Some(AgentReviewVerdict::ChangesRequested | AgentReviewVerdict::Blocked) => {
                return Err(AgentToolError::validation(
                    "AGENT_REVIEW_REJECTED",
                    "A Reviewer requested changes or could not approve the frozen patch.",
                ));
            }
            None => {}
        }
    }
    if approved {
        Ok(())
    } else {
        Err(AgentToolError::validation(
            "AGENT_REVIEW_PENDING",
            "No completed Reviewer Agent approved the frozen patch.",
        ))
    }
}

fn is_descendant(snapshot: &AgentRootSnapshot, target: &AgentId, ancestor: &AgentId) -> bool {
    let mut current = snapshot.nodes.get(target);
    while let Some(node) = current {
        let Some(parent_id) = node.parent_id.as_ref() else {
            return false;
        };
        if parent_id == ancestor {
            return true;
        }
        current = snapshot.nodes.get(parent_id);
    }
    false
}

fn parse_arguments<T: for<'de> Deserialize<'de>>(
    call: &NormalizedToolCall,
) -> Result<T, AgentToolError> {
    serde_json::from_str(&call.raw_arguments).map_err(|error| {
        AgentToolError::validation(
            "AGENT_TOOL_INPUT_INVALID",
            format!("Agent tool input must match its JSON schema: {error}"),
        )
    })
}

fn batch_completion_policy(input: &SpawnBatch) -> Result<AgentCompletionPolicy, AgentToolError> {
    let policy = input
        .completion_policy
        .or_else(|| {
            input
                .agents
                .iter()
                .find_map(|agent| agent.completion_policy)
        })
        .unwrap_or_default();
    if input
        .agents
        .iter()
        .filter_map(|agent| agent.completion_policy)
        .any(|candidate| candidate != policy)
    {
        return Err(AgentToolError::validation(
            "AGENT_COMPLETION_POLICY_INVALID",
            "All Agents in one spawn batch must use the same completion policy.",
        ));
    }
    Ok(policy)
}

fn parse_agent_id(value: String) -> Result<AgentId, AgentToolError> {
    AgentId::parse(value).map_err(|error| AgentToolError::validation("AGENT_ID_INVALID", error))
}

fn parse_artifact_ids(values: Vec<String>) -> Result<Vec<ArtifactId>, AgentToolError> {
    values
        .into_iter()
        .map(ArtifactId::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AgentToolError::validation("AGENT_ARTIFACT_ID_INVALID", error))
}

fn stable_task_id(call_id: &str, index: usize) -> String {
    format!(
        "task-{:x}",
        Sha256::digest(format!("{call_id}:{index}").as_bytes())
    )
}

fn definition(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        r#type: "function".to_string(),
        function: ToolDefinitionFunction {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
        },
    }
}

fn spawn_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "task": { "type": "string" },
            "taskId": { "type": "string" },
            "title": { "type": "string" },
            "knownFacts": { "type": "array", "items": { "type": "string" } },
            "successCriteria": { "type": "array", "items": { "type": "string" } },
            "nonGoals": { "type": "array", "items": { "type": "string" } },
            "validationExpectations": { "type": "array", "items": { "type": "string" } },
            "profile": { "type": "string", "enum": ["general", "explore", "review", "integration"] },
            "workspaceMode": { "type": "string", "enum": ["root_workspace", "shared_readonly", "isolated_worktree"] },
            "readScope": { "type": "array", "items": { "type": "string" } },
            "writeScope": { "type": "array", "maxItems": 64, "items": { "type": "string" } },
            "budget": { "$ref": "#/$defs/budget" },
            "dependsOn": { "type": "array", "items": { "type": "string" } },
            "contextRefs": { "type": "array", "items": { "type": "string" } },
            "completionPolicy": { "type": "string", "enum": ["collect_all", "fail_fast", "best_effort"] },
            "canDelegate": { "type": "boolean" },
            "canUseNetwork": { "type": "boolean" }
        },
        "$defs": {
            "budget": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "inputTokens": { "type": "integer", "minimum": 0 },
                    "outputTokens": { "type": "integer", "minimum": 0 },
                    "providerCostMicros": { "type": "integer", "minimum": 0 },
                    "toolCalls": { "type": "integer", "minimum": 0 },
                    "modelVisibleToolResultBytes": { "type": "integer", "minimum": 0 },
                    "commandWallTimeMs": { "type": "integer", "minimum": 0 },
                    "wallTimeMs": { "type": "integer", "minimum": 0 },
                    "filesRead": { "type": "integer", "minimum": 0 },
                    "filesWritten": { "type": "integer", "minimum": 0 },
                    "childAgents": { "type": "integer", "minimum": 0 }
                },
                "required": ["inputTokens", "outputTokens", "providerCostMicros", "toolCalls", "modelVisibleToolResultBytes", "commandWallTimeMs", "wallTimeMs", "filesRead", "filesWritten", "childAgents"]
            }
        },
        "required": ["task", "successCriteria"]
    })
}

fn agent_target_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": { "agentId": { "type": "string" } },
        "required": ["agentId"]
    })
}

fn success(canonical_name: String, call: NormalizedToolCall, value: Value) -> ToolPipelineResult {
    let content = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    ToolPipelineResult {
        canonical_name,
        call,
        result: ToolExecutionResult::Success {
            data: Some(value),
            model_content: content.clone(),
            ui_content: Some(content),
            effects: None,
        },
        max_result_chars: Some(32 * 1024),
    }
}

fn failure(
    canonical_name: String,
    call: NormalizedToolCall,
    error: AgentToolError,
) -> ToolPipelineResult {
    ToolPipelineResult {
        canonical_name,
        call,
        result: ToolExecutionResult::Error {
            error: ToolExecutionError {
                code: error.code,
                message: error.message.clone(),
                recoverable: error.recoverable,
                suggestion: None,
                retry_after_ms: None,
                details: None,
            },
            model_content: Some(format!("Error: {}", error.message)),
            ui_content: None,
            effects: None,
        },
        max_result_chars: Some(16 * 1024),
    }
}

struct AgentToolError {
    code: String,
    message: String,
    recoverable: bool,
}

impl AgentToolError {
    fn validation(code: &str, message: impl std::fmt::Display) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            recoverable: false,
        }
    }

    fn not_found(message: &str) -> Self {
        Self::validation("AGENT_NOT_FOUND", message)
    }

    fn supervisor(error: impl std::fmt::Display) -> Self {
        Self::validation("AGENT_RUNTIME_REJECTED", error)
    }

    fn serialize(error: serde_json::Error) -> Self {
        Self::validation("AGENT_RESULT_SERIALIZATION_FAILED", error)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpawnBatch {
    agents: Vec<SpawnSpec>,
    completion_policy: Option<AgentCompletionPolicy>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpawnSpec {
    task: String,
    task_id: Option<String>,
    title: Option<String>,
    #[serde(default)]
    known_facts: Vec<String>,
    success_criteria: Vec<String>,
    #[serde(default)]
    non_goals: Vec<String>,
    #[serde(default)]
    validation_expectations: Vec<String>,
    profile: Option<AgentProfile>,
    workspace_mode: Option<WorkspaceMode>,
    #[serde(default)]
    read_scope: Vec<String>,
    #[serde(default)]
    write_scope: Vec<String>,
    budget: Option<AgentBudget>,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    context_refs: Vec<String>,
    completion_policy: Option<AgentCompletionPolicy>,
    can_delegate: Option<bool>,
    can_use_network: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendMessage {
    agent_id: String,
    kind: Option<MessageKind>,
    summary: String,
    correlation_id: Option<String>,
    reply_to: Option<String>,
    idempotency_key: Option<String>,
    #[serde(default)]
    artifact_refs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentTarget {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentTargets {
    agent_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitAgents {
    agent_ids: Vec<String>,
    mode: Option<WaitModeInput>,
    after_cursor: Option<u64>,
    timeout_ms: Option<u64>,
    include_progress: Option<bool>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WaitModeInput {
    Any,
    All,
}

impl From<WaitModeInput> for WaitMode {
    fn from(value: WaitModeInput) -> Self {
        match value {
            WaitModeInput::Any => Self::Any,
            WaitModeInput::All => Self::All,
        }
    }
}

impl WaitAgents {
    fn mode(&self) -> WaitMode {
        self.mode.map_or(WaitMode::Any, Into::into)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FollowupAgent {
    agent_id: String,
    assignment: SpawnSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewAgent {
    agent_id: String,
    objective: Option<String>,
    success_criteria: Option<Vec<String>>,
    budget: Option<AgentBudget>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyInput {}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        time::{Duration, SystemTime},
    };

    use codez_core::{
        AgentAttemptId, AgentId, AtomicPersistence, Clock, IdGenerator, RootRunId, SessionId,
        agent::{
            AGENT_SCHEMA_VERSION, AgentBudget, AgentPolicy, AgentProfile, AgentResult,
            AgentResultStatus, AgentReviewVerdict, AgentUsage, DelegatedTask, ResultSchema,
            WorkspaceAssignment, WorkspaceMode,
        },
    };
    use codez_platform::{GitInstallation, NativeProcessRunner};
    use codez_runtime::agent::{
        AgentBudgetManager, AgentControlStore, AgentScheduler, AgentSupervisor,
        AgentSupervisorConfig, DurableMailbox, SchedulerConfig, SpawnAgentInput, WorkspaceBroker,
    };
    use codez_runtime::tools::types::{NormalizedToolCall, ToolExecutionResult};
    use codez_storage::AtomicFileStore;

    use super::{
        FOLLOWUP_AGENT, INTEGRATE_AGENTS, REVIEW_AGENT, SPAWN_AGENTS, SpawnSpec, definitions,
        execute, require_approved_verdicts, spawn_input,
    };
    use crate::chat_tool_runtime::ChatAgentRunIdentity;

    #[derive(Default)]
    struct SequenceIds {
        next: AtomicU64,
    }

    impl IdGenerator for SequenceIds {
        fn next_id(&self) -> String {
            self.next.fetch_add(1, Ordering::Relaxed).to_string()
        }
    }

    struct FixedClock;

    impl Clock for FixedClock {
        fn now(&self) -> SystemTime {
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_750_000_000)
        }
    }

    struct IntegrationToolFixture {
        _repository: tempfile::TempDir,
        _runtime: tempfile::TempDir,
        source_root: PathBuf,
        supervisor: Arc<AgentSupervisor>,
        broker: Arc<WorkspaceBroker>,
        identity: ChatAgentRunIdentity,
    }

    impl IntegrationToolFixture {
        async fn new() -> Self {
            let repository = tempfile::tempdir().expect("temporary Git repository must exist");
            let runtime = tempfile::tempdir().expect("temporary Agent runtime must exist");
            let source_root = repository.path().to_path_buf();
            let (git_program, git_environment) = GitInstallation::discover()
                .expect("Git must be available for Agent integration tests")
                .into_parts();
            run_git(&git_program, &git_environment, &source_root, ["init"]);
            run_git(
                &git_program,
                &git_environment,
                &source_root,
                ["config", "user.name", "CodeZ Test"],
            );
            run_git(
                &git_program,
                &git_environment,
                &source_root,
                ["config", "user.email", "codez-test@example.invalid"],
            );
            run_git(
                &git_program,
                &git_environment,
                &source_root,
                ["config", "core.autocrlf", "false"],
            );
            std::fs::create_dir_all(source_root.join("src")).expect("source directory must exist");
            std::fs::write(
                source_root.join("src/lib.rs"),
                "pub fn value() -> u8 { 1 }\n",
            )
            .expect("baseline source must exist");
            run_git(
                &git_program,
                &git_environment,
                &source_root,
                ["add", "src/lib.rs"],
            );
            run_git(
                &git_program,
                &git_environment,
                &source_root,
                ["commit", "-m", "baseline"],
            );

            let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
            let broker = Arc::new(WorkspaceBroker::new(
                runtime.path().join("workspace-broker"),
                git_program,
                git_environment,
                Arc::new(NativeProcessRunner::new()),
                Arc::clone(&persistence),
            ));
            let control_root = runtime.path().join("control");
            let store = Arc::new(AgentControlStore::new(
                &control_root,
                Arc::clone(&persistence),
            ));
            let mailbox = Arc::new(DurableMailbox::new(&control_root, Arc::clone(&persistence)));
            let supervisor = Arc::new(
                AgentSupervisor::new(
                    AgentSupervisorConfig {
                        max_direct_children: 8,
                        ..AgentSupervisorConfig::default()
                    },
                    store,
                    mailbox,
                    Arc::new(AgentScheduler::new(SchedulerConfig::default())),
                    Arc::new(AgentBudgetManager::new()),
                    Arc::new(FixedClock),
                    Arc::new(SequenceIds::default()),
                )
                .with_workspace_broker(Arc::clone(&broker)),
            );
            let root_run_id =
                RootRunId::parse("root-integration-tool").expect("root run ID must parse");
            let root_policy = writable_root_policy();
            let root = supervisor
                .start_root_attempt_direct(
                    root_run_id.clone(),
                    SpawnAgentInput {
                        root_session_id: Some(
                            SessionId::parse("session-integration-tool")
                                .expect("root session ID must parse"),
                        ),
                        task: delegated_task("root-integration-task"),
                        profile: AgentProfile::General,
                        workspace: WorkspaceAssignment {
                            mode: WorkspaceMode::RootWorkspace,
                            root: source_root.to_string_lossy().into_owned(),
                            read_scope: vec!["**/*".to_string()],
                            write_scope: vec!["**/*".to_string()],
                            baseline_revision: None,
                            baseline_manifest: None,
                            integration_policy: "serial_three_way".to_string(),
                        },
                        policy: root_policy.clone(),
                        budget: root_budget(),
                        provider_id: "provider".to_string(),
                        model_id: "model".to_string(),
                    },
                )
                .await
                .expect("root Agent must register");
            let starting = supervisor
                .transition(
                    &root_run_id,
                    &root.agent_id,
                    &root.attempt_id,
                    1,
                    codez_core::agent::AgentState::Starting,
                )
                .await
                .expect("root Agent must start");
            supervisor
                .transition(
                    &root_run_id,
                    &root.agent_id,
                    &root.attempt_id,
                    starting.state_revision,
                    codez_core::agent::AgentState::Running,
                )
                .await
                .expect("root Agent must run");
            let identity = ChatAgentRunIdentity {
                root_run_id,
                agent_id: root.agent_id,
                attempt_id: root.attempt_id,
                depth: 0,
                policy: root_policy,
                provider_id: "provider".to_string(),
                model_id: "model".to_string(),
            };
            Self {
                _repository: repository,
                _runtime: runtime,
                source_root,
                supervisor,
                broker,
                identity,
            }
        }

        async fn execute(
            &self,
            call_id: &str,
            name: &str,
            arguments: serde_json::Value,
        ) -> ToolExecutionResult {
            execute(
                &self.supervisor,
                Some(&self.broker),
                NormalizedToolCall {
                    call_id: call_id.to_string(),
                    position: 0,
                    name: name.to_string(),
                    raw_arguments: arguments.to_string(),
                    thought_signature: None,
                },
                &self.identity,
                &self.source_root,
            )
            .await
            .result
        }
    }

    #[test]
    fn review_approval_should_require_at_least_one_explicit_approval() {
        let result = require_approved_verdicts([None, Some(AgentReviewVerdict::Approved)]);

        assert!(result.is_ok());
    }

    #[test]
    fn review_approval_should_reject_when_any_reviewer_requests_changes() {
        let result = require_approved_verdicts([
            Some(AgentReviewVerdict::Approved),
            Some(AgentReviewVerdict::ChangesRequested),
        ]);

        assert!(result.is_err());
    }

    #[test]
    fn nested_spawn_schemas_should_publish_budget_definitions_at_the_tool_root() {
        let mut policy = AgentPolicy::readonly_child();
        policy.can_delegate = true;
        let identity = ChatAgentRunIdentity {
            root_run_id: RootRunId::parse("root-schema").expect("root ID must parse"),
            agent_id: AgentId::parse("agent-schema").expect("Agent ID must parse"),
            attempt_id: AgentAttemptId::parse("attempt-schema").expect("attempt ID must parse"),
            depth: 0,
            policy,
            provider_id: "provider".to_string(),
            model_id: "model".to_string(),
        };
        let tools = definitions(&identity);
        let has_budget_defs = [SPAWN_AGENTS, FOLLOWUP_AGENT].map(|name| {
            tools
                .iter()
                .find(|tool| tool.function.name == name)
                .and_then(|tool| tool.function.parameters.pointer("/$defs/budget"))
                .is_some()
        });

        assert_eq!(has_budget_defs, [true, true]);
    }

    #[test]
    fn default_spawn_should_inherit_parent_capabilities_in_the_main_workspace() {
        let mut parent_policy = writable_root_policy();
        parent_policy.can_use_network = true;
        parent_policy.can_delete = true;
        parent_policy.can_install_dependencies = true;
        parent_policy.can_git_push = true;
        parent_policy.can_ask_user = true;
        let identity = ChatAgentRunIdentity {
            root_run_id: RootRunId::parse("root-clone").expect("root ID must parse"),
            agent_id: AgentId::parse("agent-parent").expect("agent ID must parse"),
            attempt_id: AgentAttemptId::parse("attempt-parent").expect("attempt ID must parse"),
            depth: 0,
            policy: parent_policy.clone(),
            provider_id: "provider".to_string(),
            model_id: "model".to_string(),
        };
        let call = NormalizedToolCall {
            call_id: "spawn-clone".to_string(),
            position: 0,
            name: super::SPAWN_AGENT.to_string(),
            raw_arguments: "{}".to_string(),
            thought_signature: None,
        };
        let spec: SpawnSpec = serde_json::from_value(serde_json::json!({
            "task": "Inspect and implement the requested change.",
            "successCriteria": ["The change is verified."]
        }))
        .expect("spawn specification must parse");

        let Ok(input) = spawn_input(&call, &identity, Path::new("C:/workspace"), spec, 0) else {
            panic!("default full-capability clone must be valid");
        };

        assert_eq!(
            (
                input.profile,
                input.workspace.mode,
                input.workspace.read_scope,
                input.workspace.write_scope,
                input.policy,
            ),
            (
                AgentProfile::General,
                WorkspaceMode::RootWorkspace,
                vec!["**/*".to_string()],
                vec!["**/*".to_string()],
                parent_policy,
            )
        );
    }

    #[tokio::test]
    async fn integrate_agents_tool_should_require_frozen_approvals_and_apply_one_batch() {
        let fixture = IntegrationToolFixture::new().await;
        let spawn = fixture
            .execute(
                "call-spawn-writers",
                SPAWN_AGENTS,
                serde_json::json!({
                    "agents": [
                        {
                            "task": "Implement the frontend module.",
                            "taskId": "frontend-task",
                            "title": "Frontend implementation",
                            "successCriteria": ["Create src/frontend.rs"],
                            "profile": "general",
                            "workspaceMode": "isolated_worktree",
                            "readScope": ["**/*"],
                            "writeScope": ["src/**"]
                        },
                        {
                            "task": "Implement the backend module.",
                            "taskId": "backend-task",
                            "title": "Backend implementation",
                            "successCriteria": ["Create src/backend.rs"],
                            "profile": "general",
                            "workspaceMode": "isolated_worktree",
                            "readScope": ["**/*"],
                            "writeScope": ["src/**"]
                        }
                    ]
                }),
            )
            .await;
        assert!(matches!(spawn, ToolExecutionResult::Success { .. }));
        let snapshot = fixture
            .supervisor
            .store()
            .load(&fixture.identity.root_run_id)
            .await
            .expect("spawned children must persist");
        let mut writers = snapshot
            .nodes
            .values()
            .filter(|node| {
                node.parent_id.as_ref() == Some(&fixture.identity.agent_id)
                    && node.workspace.mode == WorkspaceMode::IsolatedWorktree
            })
            .cloned()
            .collect::<Vec<_>>();
        writers.sort_by(|left, right| left.task.task_id.cmp(&right.task.task_id));
        assert_eq!(writers.len(), 2);
        for writer in &writers {
            let (path, content) = if writer.task.task_id.as_str() == "frontend-task" {
                ("src/frontend.rs", "pub fn frontend() {}\n")
            } else {
                ("src/backend.rs", "pub fn backend() {}\n")
            };
            std::fs::write(Path::new(&writer.workspace.root).join(path), content)
                .expect("isolated child change must be written");
            complete_agent(
                &fixture.supervisor,
                &fixture.identity.root_run_id,
                &writer.id,
                None,
            )
            .await;
        }

        let unreviewed = fixture
            .execute(
                "call-integrate-unreviewed",
                INTEGRATE_AGENTS,
                serde_json::json!({
                    "agentIds": writers.iter().map(|writer| writer.id.to_string()).collect::<Vec<_>>()
                }),
            )
            .await;
        assert!(matches!(unreviewed, ToolExecutionResult::Error { .. }));

        for (index, writer) in writers.iter().enumerate() {
            let reviewed = fixture
                .execute(
                    &format!("call-review-{index}"),
                    REVIEW_AGENT,
                    serde_json::json!({ "agentId": writer.id.to_string() }),
                )
                .await;
            let ToolExecutionResult::Success {
                data: Some(reviewed),
                ..
            } = reviewed
            else {
                panic!("review tool must freeze the patch and create a Reviewer Agent");
            };
            let reviewer_id = AgentId::parse(
                reviewed["reviewer"]["agentId"]
                    .as_str()
                    .expect("Reviewer handle must contain an Agent ID"),
            )
            .expect("Reviewer Agent ID must parse");
            complete_agent(
                &fixture.supervisor,
                &fixture.identity.root_run_id,
                &reviewer_id,
                Some(AgentReviewVerdict::Approved),
            )
            .await;
        }

        let integrated = fixture
            .execute(
                "call-integrate-reviewed",
                INTEGRATE_AGENTS,
                serde_json::json!({
                    "agentIds": writers.iter().map(|writer| writer.id.to_string()).collect::<Vec<_>>()
                }),
            )
            .await;
        let ToolExecutionResult::Success {
            data: Some(integrated),
            ..
        } = integrated
        else {
            panic!("approved child patches must integrate through the Agent tool");
        };

        assert_eq!(integrated["applied"], true);
        assert_eq!(integrated["validation"], "git diff --check");
        assert_eq!(
            std::fs::read_to_string(fixture.source_root.join("src/frontend.rs"))
                .expect("integrated frontend source must exist"),
            "pub fn frontend() {}\n"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.source_root.join("src/backend.rs"))
                .expect("integrated backend source must exist"),
            "pub fn backend() {}\n"
        );
    }

    async fn complete_agent(
        supervisor: &Arc<AgentSupervisor>,
        root_run_id: &RootRunId,
        agent_id: &AgentId,
        review_verdict: Option<AgentReviewVerdict>,
    ) {
        let snapshot = supervisor
            .store()
            .load(root_run_id)
            .await
            .expect("Agent state must load before completion");
        let node = snapshot
            .nodes
            .get(agent_id)
            .expect("Agent must exist before completion");
        let attempt = snapshot
            .current_attempt(agent_id)
            .expect("Agent attempt must exist before completion");
        let starting = supervisor
            .transition(
                root_run_id,
                agent_id,
                &attempt.id,
                node.state_revision,
                codez_core::agent::AgentState::Starting,
            )
            .await
            .expect("queued Agent must start");
        let running = supervisor
            .transition(
                root_run_id,
                agent_id,
                &attempt.id,
                starting.state_revision,
                codez_core::agent::AgentState::Running,
            )
            .await
            .expect("starting Agent must run");
        assert_eq!(running.state, codez_core::agent::AgentState::Running);
        supervisor
            .submit_result(
                root_run_id,
                agent_id,
                &attempt.id,
                AgentResult {
                    status: AgentResultStatus::Completed,
                    summary: "Completed fixture task.".to_string(),
                    conclusion: Some("Completed fixture task.".to_string()),
                    changes: Vec::new(),
                    validations: Vec::new(),
                    findings: Vec::new(),
                    blockers: Vec::new(),
                    unresolved: Vec::new(),
                    recommended_next_actions: Vec::new(),
                    confidence: None,
                    review_verdict,
                    artifact_refs: Vec::new(),
                    usage: AgentUsage::default(),
                },
            )
            .await
            .expect("Agent result must complete");
    }

    fn writable_root_policy() -> AgentPolicy {
        let mut policy = AgentPolicy::readonly_child();
        policy.can_delegate = true;
        policy.can_write = true;
        policy.max_direct_children = 8;
        policy
    }

    fn root_budget() -> AgentBudget {
        let child = AgentBudget::conservative_child();
        AgentBudget {
            input_tokens: child.input_tokens * 12,
            output_tokens: child.output_tokens * 12,
            provider_cost_micros: child.provider_cost_micros * 12,
            tool_calls: child.tool_calls * 12,
            model_visible_tool_result_bytes: child.model_visible_tool_result_bytes * 12,
            command_wall_time_ms: child.command_wall_time_ms * 12,
            wall_time_ms: child.wall_time_ms * 12,
            files_read: child.files_read * 12,
            files_written: child.files_written * 12,
            child_agents: 12,
        }
    }

    fn delegated_task(id: &str) -> DelegatedTask {
        DelegatedTask {
            task_id: codez_core::TaskId::parse(id).expect("fixture task ID must parse"),
            title: id.to_string(),
            objective: "Exercise the integration tool boundary.".to_string(),
            known_facts: Vec::new(),
            success_criteria: vec!["Integrate reviewed child patches.".to_string()],
            non_goals: Vec::new(),
            dependencies: Vec::new(),
            context_refs: Vec::new(),
            validation_expectations: Vec::new(),
            expected_result_schema: ResultSchema {
                version: AGENT_SCHEMA_VERSION,
                required_fields: vec!["summary".to_string()],
            },
        }
    }

    fn run_git<const N: usize>(
        git_program: &Path,
        environment: &BTreeMap<std::ffi::OsString, std::ffi::OsString>,
        root: &Path,
        arguments: [&str; N],
    ) {
        let output = std::process::Command::new(git_program)
            .args(arguments)
            .current_dir(root)
            .env_clear()
            .envs(environment)
            .output()
            .expect("Git fixture command must start");
        assert!(
            output.status.success(),
            "Git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
