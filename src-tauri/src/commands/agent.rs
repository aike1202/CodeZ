use codez_contracts::{
    CommandError,
    agent::{
        AgentArtifact, AgentDetail, AgentEventPage, AgentListPage, AgentSummary,
        AgentWorkspaceRecoveryDisposition, AgentWorkspaceRecoveryRecord, SpawnAgentHandle,
    },
};
use codez_core::agent::{AgentState, MessageKind};
use codez_core::{AgentAttemptId, AgentId, AppError, RootRunId, SessionId};
use codez_runtime::agent::{
    AgentArtifactStore, AgentControlStore, AgentExecutionContext, AgentExecutionEvent,
    AgentExecutionEventSink, AgentHandle, AgentRootSnapshot, SendAgentMessageInput,
    SpawnAgentInput, SupervisorError, WorkspaceBroker, WorkspaceRecoveryDisposition,
};
use tauri::{State, command};

use crate::{
    agent_boundary::{
        attempt_contract, node_contract, profile_contract, result_contract, state_contract,
    },
    error::command_result,
    state::AppState,
};

const MAX_AGENT_LIST_PAGE_SIZE: usize = 100;
const MAX_FOLLOWUP_BYTES: usize = 8 * 1024;
const MAX_ARTIFACT_PREVIEW_BYTES: usize = 128 * 1024;

#[command]
pub async fn agent_list(
    state: State<'_, AppState>,
    session_id: String,
    cursor: u64,
    limit: usize,
) -> Result<AgentListPage, CommandError> {
    let result = agent_list_data(&state.agent_control_store, session_id, cursor, limit).await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_inspect(
    state: State<'_, AppState>,
    root_run_id: String,
    agent_id: String,
) -> Result<AgentDetail, CommandError> {
    let result = agent_inspect_data(&state.agent_control_store, root_run_id, agent_id).await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_get_events(
    state: State<'_, AppState>,
    root_run_id: String,
    agent_id: String,
    attempt_id: String,
    after_cursor: u64,
    limit: usize,
) -> Result<AgentEventPage, CommandError> {
    let result = agent_events_data(
        &state.agent_control_store,
        &state.agent_ui_events,
        root_run_id,
        agent_id,
        attempt_id,
        after_cursor,
        limit,
    )
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_get_artifacts(
    state: State<'_, AppState>,
    root_run_id: String,
    agent_id: String,
) -> Result<Vec<AgentArtifact>, CommandError> {
    let result = agent_artifacts_data(
        &state.agent_control_store,
        &state.agent_artifacts,
        state.agent_workspace_broker.as_deref(),
        root_run_id,
        agent_id,
    )
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_workspace_recovery_list(
    state: State<'_, AppState>,
) -> Result<Vec<AgentWorkspaceRecoveryRecord>, CommandError> {
    let result = agent_workspace_recovery_data(state.agent_workspace_broker.as_deref()).await;
    command_result(&state.errors, result)
}

async fn agent_list_data(
    control: &AgentControlStore,
    session_id: String,
    cursor: u64,
    limit: usize,
) -> Result<AgentListPage, AppError> {
    if limit == 0 || limit > MAX_AGENT_LIST_PAGE_SIZE {
        return Err(AppError::validation(format!(
            "Agent list limit must be between 1 and {MAX_AGENT_LIST_PAGE_SIZE}"
        )));
    }
    let session_id = parse_session_id(session_id)?;
    let mut agents = Vec::new();
    for root_run_id in control
        .discover_root_run_ids()
        .await
        .map_err(|error| agent_operation_error("Agent roots could not be discovered", error))?
    {
        let snapshot = control
            .load(&root_run_id)
            .await
            .map_err(|error| agent_operation_error("Agent state could not be loaded", error))?;
        if snapshot
            .root_agent()
            .is_none_or(|root| root.root_session_id != session_id)
        {
            continue;
        }
        agents.extend(snapshot.nodes.values().filter_map(|node| {
            node.parent_id
                .as_ref()
                .and_then(|_| summary_contract(&snapshot, &node.id))
        }));
    }
    agents.sort_by(|left, right| {
        left.state
            .is_terminal()
            .cmp(&right.state.is_terminal())
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.agent_id.cmp(&right.agent_id))
    });
    let start = usize::try_from(cursor)
        .map_err(|_| AppError::validation("Agent list cursor is too large"))?
        .min(agents.len());
    let end = start.saturating_add(limit).min(agents.len());
    Ok(AgentListPage {
        agents: agents[start..end].to_vec(),
        next_cursor: u64::try_from(end)
            .map_err(|_| AppError::internal("Agent list cursor overflowed"))?,
        has_more: end < agents.len(),
    })
}

async fn agent_inspect_data(
    control: &AgentControlStore,
    root_run_id: String,
    agent_id: String,
) -> Result<AgentDetail, AppError> {
    let root_run_id = parse_root_run_id(root_run_id)?;
    let agent_id = parse_agent_id(agent_id)?;
    let snapshot = control
        .load(&root_run_id)
        .await
        .map_err(|error| agent_operation_error("Agent state could not be loaded", error))?;
    let node = snapshot
        .nodes
        .get(&agent_id)
        .ok_or_else(|| AppError::not_found("Agent was not found"))?;
    let mut attempts = snapshot
        .attempts
        .values()
        .filter(|attempt| attempt.agent_id == agent_id)
        .collect::<Vec<_>>();
    attempts.sort_by_key(|attempt| attempt.ordinal);
    let result = attempts
        .last()
        .and_then(|attempt| snapshot.results.get(&attempt.id))
        .map(result_contract);
    Ok(AgentDetail {
        node: node_contract(node),
        attempts: attempts.into_iter().map(attempt_contract).collect(),
        result,
    })
}

async fn agent_events_data(
    control: &AgentControlStore,
    events: &crate::agent_ui_runtime::AgentUiEventStore,
    root_run_id: String,
    agent_id: String,
    attempt_id: String,
    after_cursor: u64,
    limit: usize,
) -> Result<AgentEventPage, AppError> {
    let root_run_id = parse_root_run_id(root_run_id)?;
    let agent_id = parse_agent_id(agent_id)?;
    let attempt_id = parse_attempt_id(attempt_id)?;
    let snapshot = control
        .load(&root_run_id)
        .await
        .map_err(|error| agent_operation_error("Agent state could not be loaded", error))?;
    let attempt = snapshot
        .attempts
        .get(&attempt_id)
        .ok_or_else(|| AppError::not_found("Agent attempt was not found"))?;
    if attempt.agent_id != agent_id {
        return Err(AppError::validation(
            "Agent attempt does not belong to the requested Agent",
        ));
    }
    events
        .page(&root_run_id, &agent_id, &attempt_id, after_cursor, limit)
        .await
        .map_err(Into::into)
}

async fn agent_artifacts_data(
    control: &AgentControlStore,
    artifact_store: &AgentArtifactStore,
    broker: Option<&WorkspaceBroker>,
    root_run_id: String,
    agent_id: String,
) -> Result<Vec<AgentArtifact>, AppError> {
    let root_run_id = parse_root_run_id(root_run_id)?;
    let agent_id = parse_agent_id(agent_id)?;
    let snapshot = control
        .load(&root_run_id)
        .await
        .map_err(|error| agent_operation_error("Agent state could not be loaded", error))?;
    let node = snapshot
        .nodes
        .get(&agent_id)
        .ok_or_else(|| AppError::not_found("Agent was not found"))?;
    let mut artifacts = artifact_store
        .list_for_agent(&root_run_id, &agent_id, MAX_ARTIFACT_PREVIEW_BYTES)
        .await
        .map_err(|error| agent_operation_error("Agent artifacts could not be loaded", error))?
        .into_iter()
        .map(|artifact| {
            Ok(AgentArtifact {
                artifact_id: artifact.artifact_id.to_string(),
                name: artifact.name,
                kind: artifact.kind,
                path: path_text(&artifact.path)?,
                sha256: artifact.sha256,
                size_bytes: artifact.size_bytes,
                preview: artifact.preview,
                preview_truncated: artifact.preview_truncated,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    if node.workspace.mode == codez_core::agent::WorkspaceMode::IsolatedWorktree {
        let attempt = snapshot
            .current_attempt(&agent_id)
            .ok_or_else(|| AppError::not_found("Agent attempt was not found"))?;
        let broker = broker.ok_or_else(|| {
            AppError::conflict("Agent workspace artifacts are unavailable without Git isolation")
        })?;
        artifacts.extend(
            broker
                .artifacts(&attempt.id, MAX_ARTIFACT_PREVIEW_BYTES)
                .await
                .map_err(|error| {
                    agent_operation_error("Agent artifacts could not be loaded", error)
                })?
                .into_iter()
                .map(|artifact| {
                    Ok(AgentArtifact {
                        artifact_id: artifact.artifact_id.to_string(),
                        name: artifact.name,
                        kind: artifact.kind,
                        path: path_text(&artifact.path)?,
                        sha256: artifact.sha256,
                        size_bytes: artifact.size_bytes,
                        preview: artifact.preview,
                        preview_truncated: artifact.preview_truncated,
                    })
                })
                .collect::<Result<Vec<_>, AppError>>()?,
        );
    }
    artifacts.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.artifact_id.cmp(&right.artifact_id))
    });
    Ok(artifacts)
}

async fn agent_workspace_recovery_data(
    broker: Option<&WorkspaceBroker>,
) -> Result<Vec<AgentWorkspaceRecoveryRecord>, AppError> {
    let Some(broker) = broker else {
        return Ok(Vec::new());
    };
    broker
        .scan_recovery()
        .await
        .map_err(|error| {
            agent_operation_error("Agent workspace recovery state could not be scanned", error)
        })?
        .into_iter()
        .map(|record| {
            Ok(AgentWorkspaceRecoveryRecord {
                manifest_path: path_text(&record.manifest_path)?,
                root_run_id: record.root_run_id,
                agent_id: record.agent_id,
                attempt_id: record.attempt_id,
                status: record.status,
                disposition: match record.disposition {
                    WorkspaceRecoveryDisposition::Clean => AgentWorkspaceRecoveryDisposition::Clean,
                    WorkspaceRecoveryDisposition::Preserved => {
                        AgentWorkspaceRecoveryDisposition::Preserved
                    }
                    WorkspaceRecoveryDisposition::ManualIntervention => {
                        AgentWorkspaceRecoveryDisposition::ManualIntervention
                    }
                },
                detail: record.detail,
                workspace_paths: record
                    .workspace_paths
                    .iter()
                    .map(|path| path_text(path))
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .collect()
}

#[command]
pub async fn agent_send_user_message(
    state: State<'_, AppState>,
    root_run_id: String,
    agent_id: String,
    message: String,
) -> Result<(), CommandError> {
    let result = async {
        let root_run_id = parse_root_run_id(root_run_id)?;
        let agent_id = parse_agent_id(agent_id)?;
        let snapshot = state
            .agent_control_store
            .load(&root_run_id)
            .await
            .map_err(|error| agent_operation_error("Agent state could not be loaded", error))?;
        let target = snapshot
            .nodes
            .get(&agent_id)
            .ok_or_else(|| AppError::not_found("Agent was not found"))?;
        if target.state.is_terminal() {
            return Err(AppError::conflict(
                "The Agent is finished; use follow-up to start another attempt",
            ));
        }
        let from = target
            .parent_id
            .clone()
            .ok_or_else(|| AppError::validation("Messages cannot target the root Agent"))?;
        let message = state
            .agent_supervisor
            .send_message(SendAgentMessageInput {
                root_run_id,
                from: from.clone(),
                to: agent_id,
                kind: MessageKind::Instruction,
                summary: message,
                correlation_id: None,
                reply_to: None,
                idempotency_key: Some(format!("user:{}", uuid::Uuid::new_v4())),
                artifact_refs: Vec::new(),
            })
            .await
            .map_err(supervisor_error)?;
        let parent = snapshot
            .nodes
            .get(&from)
            .cloned()
            .ok_or_else(|| AppError::not_found("Parent Agent was not found"))?;
        let attempt = snapshot
            .current_attempt(&from)
            .cloned()
            .ok_or_else(|| AppError::not_found("Parent Agent attempt was not found"))?;
        state._agent_ui_projector.publish(
            &AgentExecutionContext {
                node: parent,
                attempt,
            },
            AgentExecutionEvent::MessageSent(message),
        );
        Ok(())
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_cancel(
    state: State<'_, AppState>,
    root_run_id: String,
    agent_id: String,
) -> Result<(), CommandError> {
    let result = async {
        state
            .agent_supervisor
            .cancel_subtree(&parse_root_run_id(root_run_id)?, &parse_agent_id(agent_id)?)
            .await
            .map(|_| ())
            .map_err(supervisor_error)
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_resume(
    state: State<'_, AppState>,
    root_run_id: String,
    agent_id: String,
) -> Result<SpawnAgentHandle, CommandError> {
    let result =
        async { start_user_attempt(&state, root_run_id, agent_id, None, true).await }.await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_followup(
    state: State<'_, AppState>,
    root_run_id: String,
    agent_id: String,
    message: String,
) -> Result<SpawnAgentHandle, CommandError> {
    let result =
        async { start_user_attempt(&state, root_run_id, agent_id, Some(message), false).await }
            .await;
    command_result(&state.errors, result)
}

async fn start_user_attempt(
    state: &AppState,
    root_run_id: String,
    agent_id: String,
    followup: Option<String>,
    resume_only: bool,
) -> Result<SpawnAgentHandle, AppError> {
    let root_run_id = parse_root_run_id(root_run_id)?;
    let agent_id = parse_agent_id(agent_id)?;
    if followup
        .as_ref()
        .is_some_and(|value| value.trim().is_empty() || value.len() > MAX_FOLLOWUP_BYTES)
    {
        return Err(AppError::validation(format!(
            "Follow-up must contain between 1 and {MAX_FOLLOWUP_BYTES} UTF-8 bytes"
        )));
    }
    let snapshot = state
        .agent_control_store
        .load(&root_run_id)
        .await
        .map_err(|error| agent_operation_error("Agent state could not be loaded", error))?;
    let node = snapshot
        .nodes
        .get(&agent_id)
        .ok_or_else(|| AppError::not_found("Agent was not found"))?;
    if !node.state.is_terminal() {
        return Err(AppError::conflict(
            "A follow-up requires the current Agent attempt to be finished",
        ));
    }
    if resume_only && !matches!(node.state, AgentState::Interrupted | AgentState::Failed) {
        return Err(AppError::validation(
            "Only interrupted or failed Agents can be resumed",
        ));
    }
    let attempt = snapshot
        .current_attempt(&agent_id)
        .ok_or_else(|| AppError::not_found("Agent attempt was not found"))?;
    let mut task = node.task.clone();
    if let Some(followup) = followup {
        task.known_facts
            .push(format!("User follow-up: {}", followup.trim()));
        task.objective = format!(
            "{}\n\nContinue with this user follow-up:\n{}",
            task.objective,
            followup.trim()
        );
    }
    let handle = state
        .agent_supervisor
        .start_user_followup_attempt(
            &root_run_id,
            &agent_id,
            &format!("ui:{}", uuid::Uuid::new_v4()),
            SpawnAgentInput {
                root_session_id: None,
                task,
                profile: node.profile,
                workspace: node.workspace.clone(),
                policy: node.policy.clone(),
                budget: node.budget,
                provider_id: attempt.provider_id.clone(),
                model_id: attempt.model_id.clone(),
            },
        )
        .await
        .map_err(supervisor_error)?;
    Ok(handle_contract(handle))
}

fn summary_contract(snapshot: &AgentRootSnapshot, agent_id: &AgentId) -> Option<AgentSummary> {
    let node = snapshot.nodes.get(agent_id)?;
    let attempt = snapshot.current_attempt(agent_id)?;
    let result = snapshot.results.get(&attempt.id);
    Some(AgentSummary {
        agent_id: agent_id.to_string(),
        attempt_id: attempt.id.to_string(),
        root_run_id: node.root_run_id.to_string(),
        parent_agent_id: node.parent_id.as_ref().map(ToString::to_string),
        title: node.task.title.clone(),
        profile: profile_contract(node.profile),
        depth: node.depth,
        state: state_contract(node.state),
        state_revision: node.state_revision,
        latest_summary: result.map_or_else(
            || node.task.objective.clone(),
            |result| result.summary.clone(),
        ),
        unread_event_count: 0,
        updated_at: node.updated_at.clone(),
        finished_at: attempt.finished_at.clone(),
    })
}

fn handle_contract(handle: AgentHandle) -> SpawnAgentHandle {
    SpawnAgentHandle {
        agent_id: handle.agent_id.to_string(),
        attempt_id: handle.attempt_id.to_string(),
        state: state_contract(handle.state),
        created: handle.created,
    }
}

fn parse_session_id(value: String) -> Result<SessionId, AppError> {
    SessionId::parse(value).map_err(|error| AppError::validation(error.to_string()))
}

fn parse_root_run_id(value: String) -> Result<RootRunId, AppError> {
    RootRunId::parse(value).map_err(|error| AppError::validation(error.to_string()))
}

fn parse_agent_id(value: String) -> Result<AgentId, AppError> {
    AgentId::parse(value).map_err(|error| AppError::validation(error.to_string()))
}

fn parse_attempt_id(value: String) -> Result<AgentAttemptId, AppError> {
    AgentAttemptId::parse(value).map_err(|error| AppError::validation(error.to_string()))
}

fn path_text(path: &std::path::Path) -> Result<String, AppError> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::validation("Agent workspace recovery path is not UTF-8"))
}

fn supervisor_error(error: SupervisorError) -> AppError {
    match error {
        SupervisorError::MessageAclDenied | SupervisorError::DelegationDenied => {
            AppError::permission_denied(error.to_string())
        }
        SupervisorError::MessageAgentNotFound
        | SupervisorError::WaitAgentNotFound
        | SupervisorError::Store(codez_runtime::agent::AgentStoreError::AgentNotFound(_))
        | SupervisorError::Store(codez_runtime::agent::AgentStoreError::AttemptNotFound(_)) => {
            AppError::not_found(error.to_string())
        }
        SupervisorError::ParentNotRunning
        | SupervisorError::ParentAttemptMismatch
        | SupervisorError::Budget(_) => AppError::conflict(error.to_string()),
        other => agent_operation_error("Agent operation failed", other),
    }
}

fn agent_operation_error(message: &str, error: impl std::fmt::Display) -> AppError {
    AppError::external(message, error.to_string(), false)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use codez_core::agent::{
        AGENT_SCHEMA_VERSION, AgentAttempt, AgentBudget, AgentNode, AgentPolicy, AgentProfile,
        AgentResult, AgentResultStatus, AgentState, AgentUsage, DelegatedTask, ResultSchema,
        WorkspaceAssignment, WorkspaceMode,
    };
    use codez_core::{AgentAttemptId, AgentId, AtomicPersistence, RootRunId, SessionId, TaskId};
    use codez_runtime::agent::{
        AgentArtifactStore, AgentControlStore, AgentRegistration, AgentTransitionRequest,
    };
    use codez_storage::AtomicFileStore;

    use crate::agent_ui_runtime::AgentUiEventStore;

    use super::{
        agent_artifacts_data, agent_events_data, agent_inspect_data, agent_list_data,
        agent_workspace_recovery_data,
    };

    struct AgentCommandFixture {
        _temp: tempfile::TempDir,
        control: Arc<AgentControlStore>,
        artifacts: AgentArtifactStore,
        events: AgentUiEventStore,
        persistence: Arc<dyn AtomicPersistence>,
        root_run_id: RootRunId,
        session_id: SessionId,
        first_agent_id: AgentId,
        first_attempt_id: AgentAttemptId,
        second_attempt_id: AgentAttemptId,
    }

    impl AgentCommandFixture {
        async fn new() -> Self {
            let temp = tempfile::tempdir().expect("temporary Agent command root must exist");
            let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
            let control = Arc::new(AgentControlStore::new(
                temp.path(),
                Arc::clone(&persistence),
            ));
            let artifacts =
                AgentArtifactStore::new(temp.path().join("artifacts"), Arc::clone(&persistence));
            let events = AgentUiEventStore::new(Arc::clone(&control), Arc::clone(&persistence));
            let root_run_id = RootRunId::parse("root-command").expect("root ID must parse");
            let session_id = SessionId::parse("session-command").expect("session ID must parse");
            let root_agent_id = AgentId::parse("agent-command-root").expect("Agent ID must parse");
            let root_attempt_id =
                AgentAttemptId::parse("attempt-command-root").expect("attempt ID must parse");
            control
                .register_root(
                    registration(
                        &root_run_id,
                        &session_id,
                        root_agent_id,
                        root_attempt_id.clone(),
                        None,
                        0,
                        "root-task",
                        "Root",
                    ),
                    "event-root".to_string(),
                    "2026-07-19T00:00:00Z".to_string(),
                )
                .await
                .expect("root registration must persist");
            let first_agent_id = AgentId::parse("agent-command-a").expect("Agent ID must parse");
            let first_attempt_id =
                AgentAttemptId::parse("attempt-command-a").expect("attempt ID must parse");
            let second_agent_id = AgentId::parse("agent-command-b").expect("Agent ID must parse");
            let second_attempt_id =
                AgentAttemptId::parse("attempt-command-b").expect("attempt ID must parse");
            let root_agent_id = AgentId::parse("agent-command-root").expect("Agent ID must parse");
            control
                .register_agents(
                    &root_run_id,
                    &root_attempt_id,
                    "spawn-command",
                    vec![
                        registration(
                            &root_run_id,
                            &session_id,
                            first_agent_id.clone(),
                            first_attempt_id.clone(),
                            Some(root_agent_id.clone()),
                            1,
                            "task-command-a",
                            "First",
                        ),
                        registration(
                            &root_run_id,
                            &session_id,
                            second_agent_id.clone(),
                            second_attempt_id.clone(),
                            Some(root_agent_id),
                            1,
                            "task-command-b",
                            "Second",
                        ),
                    ],
                    "event-children".to_string(),
                    "2026-07-19T00:00:01Z".to_string(),
                )
                .await
                .expect("child registrations must persist");
            Self {
                _temp: temp,
                control,
                artifacts,
                events,
                persistence,
                root_run_id,
                session_id,
                first_agent_id,
                first_attempt_id,
                second_attempt_id,
            }
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "test registrations keep identity and topology fields explicit"
    )]
    fn registration(
        root_run_id: &RootRunId,
        session_id: &SessionId,
        agent_id: AgentId,
        attempt_id: AgentAttemptId,
        parent_id: Option<AgentId>,
        depth: u16,
        task_id: &str,
        title: &str,
    ) -> AgentRegistration {
        let state = AgentState::Queued;
        let state_revision = 1;
        AgentRegistration {
            node: AgentNode {
                schema_version: AGENT_SCHEMA_VERSION,
                id: agent_id.clone(),
                root_run_id: root_run_id.clone(),
                root_session_id: session_id.clone(),
                parent_id,
                depth,
                profile: AgentProfile::Explore,
                task: DelegatedTask {
                    task_id: TaskId::parse(task_id).expect("task ID must parse"),
                    title: title.to_string(),
                    objective: format!("Inspect {title}"),
                    known_facts: Vec::new(),
                    success_criteria: vec!["Report evidence".to_string()],
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
                    root: "C:/workspace".to_string(),
                    read_scope: vec!["**/*".to_string()],
                    write_scope: Vec::new(),
                    baseline_revision: None,
                    baseline_manifest: None,
                    integration_policy: "none".to_string(),
                },
                state,
                state_revision,
                created_by_tool_call_id: Some("spawn-command".to_string()),
                created_at: "2026-07-19T00:00:00Z".to_string(),
                updated_at: "2026-07-19T00:00:01Z".to_string(),
            },
            attempt: AgentAttempt {
                id: attempt_id,
                agent_id,
                ordinal: 1,
                state,
                state_revision,
                mailbox_cursor: 0,
                prompt_schema_version: AGENT_SCHEMA_VERSION,
                prompt_module_hashes: Vec::new(),
                dynamic_snapshot_hash: String::new(),
                tool_catalog_fingerprint: String::new(),
                provider_id: "provider-command".to_string(),
                model_id: "model-command".to_string(),
                result_contract_version: AGENT_SCHEMA_VERSION,
                usage: AgentUsage::default(),
                started_at: None,
                finished_at: None,
            },
        }
    }

    #[tokio::test]
    async fn agent_list_boundary_should_filter_the_root_and_page_children() {
        let fixture = AgentCommandFixture::new().await;

        let page = agent_list_data(
            &fixture.control,
            fixture.session_id.as_str().to_string(),
            0,
            1,
        )
        .await
        .expect("Agent list page must load");

        assert_eq!(
            (page.agents.len(), page.next_cursor, page.has_more),
            (1, 1, true)
        );
    }

    #[tokio::test]
    async fn agent_inspect_boundary_should_return_the_requested_child_attempt() {
        let fixture = AgentCommandFixture::new().await;

        let detail = agent_inspect_data(
            &fixture.control,
            fixture.root_run_id.to_string(),
            fixture.first_agent_id.to_string(),
        )
        .await
        .expect("Agent detail must load");

        assert_eq!(detail.attempts[0].id, fixture.first_attempt_id.to_string());
    }

    #[tokio::test]
    async fn agent_events_boundary_should_reject_an_attempt_owned_by_another_agent() {
        let fixture = AgentCommandFixture::new().await;

        let error = agent_events_data(
            &fixture.control,
            &fixture.events,
            fixture.root_run_id.to_string(),
            fixture.first_agent_id.to_string(),
            fixture.second_attempt_id.to_string(),
            0,
            10,
        )
        .await
        .expect_err("cross-Agent attempt routing must be rejected");

        assert_eq!(error.kind(), codez_core::AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn agent_events_boundary_should_page_persisted_state_events() {
        let fixture = AgentCommandFixture::new().await;
        fixture
            .control
            .transition(AgentTransitionRequest {
                root_run_id: fixture.root_run_id.clone(),
                agent_id: fixture.first_agent_id.clone(),
                attempt_id: fixture.first_attempt_id.clone(),
                expected_revision: 1,
                next: AgentState::Starting,
                event_id: "event-starting".to_string(),
                occurred_at: "2026-07-19T00:00:02Z".to_string(),
            })
            .await
            .expect("Agent state transition must persist");

        let page = agent_events_data(
            &fixture.control,
            &fixture.events,
            fixture.root_run_id.to_string(),
            fixture.first_agent_id.to_string(),
            fixture.first_attempt_id.to_string(),
            0,
            10,
        )
        .await
        .expect("Agent event page must load");

        assert_eq!(page.events.len(), 1);
    }

    #[tokio::test]
    async fn agent_events_boundary_should_recover_usage_and_result_from_control_ledger() {
        let fixture = AgentCommandFixture::new().await;
        fixture
            .control
            .transition(AgentTransitionRequest {
                root_run_id: fixture.root_run_id.clone(),
                agent_id: fixture.first_agent_id.clone(),
                attempt_id: fixture.first_attempt_id.clone(),
                expected_revision: 1,
                next: AgentState::Starting,
                event_id: "event-recovery-starting".to_string(),
                occurred_at: "2026-07-19T00:00:02Z".to_string(),
            })
            .await
            .expect("Agent must enter starting");
        fixture
            .control
            .transition(AgentTransitionRequest {
                root_run_id: fixture.root_run_id.clone(),
                agent_id: fixture.first_agent_id.clone(),
                attempt_id: fixture.first_attempt_id.clone(),
                expected_revision: 2,
                next: AgentState::Running,
                event_id: "event-recovery-running".to_string(),
                occurred_at: "2026-07-19T00:00:03Z".to_string(),
            })
            .await
            .expect("Agent must enter running");
        let usage = AgentUsage {
            input_tokens: 12,
            ..AgentUsage::default()
        };
        fixture
            .control
            .record_usage(
                &fixture.root_run_id,
                &fixture.first_attempt_id,
                usage,
                AgentBudget::conservative_child().saturating_sub(&usage),
                "event-recovery-usage".to_string(),
                "2026-07-19T00:00:04Z".to_string(),
            )
            .await
            .expect("usage must persist before UI projection");
        fixture
            .control
            .submit_result(
                &fixture.root_run_id,
                &fixture.first_agent_id,
                &fixture.first_attempt_id,
                AgentResult {
                    status: AgentResultStatus::Completed,
                    summary: "Recovered result".to_string(),
                    conclusion: None,
                    changes: Vec::new(),
                    validations: Vec::new(),
                    findings: Vec::new(),
                    blockers: Vec::new(),
                    unresolved: Vec::new(),
                    recommended_next_actions: Vec::new(),
                    confidence: None,
                    review_verdict: None,
                    artifact_refs: Vec::new(),
                    usage,
                },
                "event-recovery-result".to_string(),
                "2026-07-19T00:00:05Z".to_string(),
            )
            .await
            .expect("result must persist before UI projection");

        let first = agent_events_data(
            &fixture.control,
            &fixture.events,
            fixture.root_run_id.to_string(),
            fixture.first_agent_id.to_string(),
            fixture.first_attempt_id.to_string(),
            0,
            10,
        )
        .await
        .expect("control events must backfill the UI ledger");
        let reconstructed = AgentUiEventStore::new(
            Arc::clone(&fixture.control),
            Arc::clone(&fixture.persistence),
        );
        let replayed = agent_events_data(
            &fixture.control,
            &reconstructed,
            fixture.root_run_id.to_string(),
            fixture.first_agent_id.to_string(),
            fixture.first_attempt_id.to_string(),
            0,
            10,
        )
        .await
        .expect("reconstructed UI store must not duplicate control projections");

        assert_eq!(first.events, replayed.events);
        assert_eq!(
            replayed
                .events
                .iter()
                .filter(|event| matches!(
                    &event.event,
                    codez_contracts::agent::AgentUiEvent::BudgetUpdated { .. }
                ))
                .count(),
            1
        );
        assert_eq!(
            replayed
                .events
                .iter()
                .filter(|event| matches!(
                    &event.event,
                    codez_contracts::agent::AgentUiEvent::ResultSubmitted(_)
                ))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn agent_artifacts_boundary_should_return_empty_for_a_readonly_agent() {
        let fixture = AgentCommandFixture::new().await;

        let artifacts = agent_artifacts_data(
            &fixture.control,
            &fixture.artifacts,
            None,
            fixture.root_run_id.to_string(),
            fixture.first_agent_id.to_string(),
        )
        .await
        .expect("readonly Agent artifact lookup must succeed");

        assert!(artifacts.is_empty());
    }

    #[tokio::test]
    async fn agent_artifacts_boundary_should_include_durable_message_payloads() {
        let fixture = AgentCommandFixture::new().await;
        let persisted = fixture
            .artifacts
            .persist_message(
                &fixture.root_run_id,
                &fixture.first_agent_id,
                &fixture.first_attempt_id,
                "long child evidence",
                "2026-07-19T00:00:03Z".to_string(),
            )
            .await
            .expect("message artifact must persist");

        let artifacts = agent_artifacts_data(
            &fixture.control,
            &fixture.artifacts,
            None,
            fixture.root_run_id.to_string(),
            fixture.first_agent_id.to_string(),
        )
        .await
        .expect("message artifact lookup must succeed");

        assert!(matches!(
            artifacts.as_slice(),
            [artifact]
                if artifact.artifact_id == persisted.artifact_id.to_string()
                    && artifact.kind == "message_payload"
                    && artifact.preview.as_deref() == Some("long child evidence")
        ));
    }

    #[tokio::test]
    async fn agent_recovery_boundary_should_return_empty_without_git_isolation() {
        let records = agent_workspace_recovery_data(None)
            .await
            .expect("missing Git isolation has no recovery records");

        assert!(records.is_empty());
    }
}
