use codez_contracts::{
    CommandError,
    agent::{
        AGENT_EVENT_VERSION, AGENT_UPDATED_EVENT, AgentActiveIdsRequest, AgentActiveIdsResult,
        AgentDepth, AgentExpectations, AgentLaunchPolicy, AgentMailboxMessage,
        AgentMessageDeliveryState, AgentMessageType, AgentRecord, AgentRuntimeSnapshot,
        AgentRuntimeStatus, AgentScope, AgentSnapshotRequest, AgentTerminalResult,
        AgentUpdatedEvent,
    },
};
use codez_core::{AppError, SessionId};
use codez_runtime::agent::collaboration::{
    AgentDepth as RuntimeDepth, AgentExpectations as RuntimeExpectations,
    AgentLaunchPolicy as RuntimeLaunchPolicy, AgentMailboxMessage as RuntimeMailboxMessage,
    AgentMessageDeliveryState as RuntimeDeliveryState, AgentMessageType as RuntimeMessageType,
    AgentRecord as RuntimeRecord, AgentRuntimeEventSink, AgentRuntimeSnapshot as RuntimeSnapshot,
    AgentRuntimeStatus as RuntimeStatus, AgentScope as RuntimeScope,
    AgentTerminalResult as RuntimeTerminalResult,
};
use tauri::{AppHandle, Emitter, State, command};

use crate::{error::command_result, state::AppState};

pub(crate) struct DesktopAgentEventSink {
    app: AppHandle,
}

impl DesktopAgentEventSink {
    #[must_use]
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl AgentRuntimeEventSink for DesktopAgentEventSink {
    fn emit(&self, snapshot: &RuntimeSnapshot) -> Result<(), AppError> {
        let snapshot = snapshot_contract(snapshot);
        let event = AgentUpdatedEvent {
            version: AGENT_EVENT_VERSION,
            session_id: snapshot.session_id.clone(),
            revision: snapshot.revision,
            snapshot,
        };
        self.app.emit(AGENT_UPDATED_EVENT, event).map_err(|source| {
            AppError::external(
                "The Agent update event could not be delivered",
                format!("emit {AGENT_UPDATED_EVENT}: {source}"),
                true,
            )
        })
    }
}

#[command]
pub async fn agent_snapshot(
    state: State<'_, AppState>,
    request: AgentSnapshotRequest,
) -> Result<AgentRuntimeSnapshot, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        state
            .agent_runtime
            .snapshot(&session_id)
            .await
            .map(|snapshot| snapshot_contract(&snapshot))
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn agent_active_ids(
    state: State<'_, AppState>,
    request: AgentActiveIdsRequest,
) -> Result<AgentActiveIdsResult, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        let snapshot = state.agent_runtime.snapshot(&session_id).await?;
        Ok(AgentActiveIdsResult {
            agent_ids: snapshot
                .agents
                .iter()
                .filter(|agent| agent.status.is_active())
                .map(|agent| agent.agent_id.clone())
                .collect(),
            revision: snapshot.revision,
        })
    }
    .await;
    command_result(&state.errors, result)
}

fn parse_session_id(value: String) -> Result<SessionId, AppError> {
    SessionId::parse(value)
        .map_err(|source| AppError::validation(format!("The Agent session is invalid: {source}")))
}

pub(crate) fn snapshot_contract(snapshot: &RuntimeSnapshot) -> AgentRuntimeSnapshot {
    AgentRuntimeSnapshot {
        version: snapshot.version,
        session_id: snapshot.session_id.as_str().to_string(),
        revision: snapshot.revision,
        agents: snapshot.agents.iter().map(record_contract).collect(),
        messages: snapshot.messages.iter().map(message_contract).collect(),
    }
}

fn record_contract(record: &RuntimeRecord) -> AgentRecord {
    AgentRecord {
        agent_id: record.agent_id.clone(),
        session_id: record.session_id.as_str().to_string(),
        parent_agent_id: record.parent_agent_id.clone(),
        parent_path: record.parent_path.clone(),
        path: record.path.clone(),
        role: record.role.clone(),
        task_name: record.task_name.clone(),
        description: record.description.clone(),
        context_scope_id: record.context_scope_id.clone(),
        status: status_contract(record.status),
        attempt_id: record.attempt_id.clone(),
        run_count: record.run_count,
        created_at: record.created_at.to_rfc3339(),
        updated_at: record.updated_at.to_rfc3339(),
        started_at: record.started_at.map(|value| value.to_rfc3339()),
        completed_at: record.completed_at.map(|value| value.to_rfc3339()),
        launch: launch_contract(&record.launch),
        result: record.result.as_ref().map(terminal_contract),
    }
}

fn message_contract(message: &RuntimeMailboxMessage) -> AgentMailboxMessage {
    AgentMailboxMessage {
        message_id: message.message_id.clone(),
        message_type: message_type_contract(message.message_type),
        attempt_id: message.attempt_id.clone(),
        author: message.author.clone(),
        recipient: message.recipient.clone(),
        payload: message.payload.clone(),
        delivery_state: delivery_contract(message.delivery_state),
        created_at: message.created_at.to_rfc3339(),
        read_at: message.read_at.map(|value| value.to_rfc3339()),
    }
}

fn launch_contract(launch: &RuntimeLaunchPolicy) -> AgentLaunchPolicy {
    AgentLaunchPolicy {
        context: launch.context.clone(),
        expectations: launch.expectations.as_ref().map(expectations_contract),
        scope: launch.scope.as_ref().map(scope_contract),
        depth: launch.depth.map(depth_contract),
        allowed_write_files: launch.allowed_write_files.clone(),
        allow_shell: launch.allow_shell,
    }
}

fn expectations_contract(expectations: &RuntimeExpectations) -> AgentExpectations {
    AgentExpectations {
        questions: expectations.questions.clone(),
        out_of_scope: expectations.out_of_scope.clone(),
    }
}

fn scope_contract(scope: &RuntimeScope) -> AgentScope {
    AgentScope {
        directories: scope.directories.clone(),
        exclude_globs: scope.exclude_globs.clone(),
    }
}

fn terminal_contract(result: &RuntimeTerminalResult) -> AgentTerminalResult {
    AgentTerminalResult {
        status: status_contract(result.status),
        report: result.report.clone(),
        conclusion: result.conclusion.clone(),
    }
}

const fn status_contract(status: RuntimeStatus) -> AgentRuntimeStatus {
    match status {
        RuntimeStatus::Queued => AgentRuntimeStatus::Queued,
        RuntimeStatus::Running => AgentRuntimeStatus::Running,
        RuntimeStatus::Completed => AgentRuntimeStatus::Completed,
        RuntimeStatus::Failed => AgentRuntimeStatus::Failed,
        RuntimeStatus::Interrupted => AgentRuntimeStatus::Interrupted,
    }
}

const fn message_type_contract(message_type: RuntimeMessageType) -> AgentMessageType {
    match message_type {
        RuntimeMessageType::NewTask => AgentMessageType::NewTask,
        RuntimeMessageType::Message => AgentMessageType::Message,
        RuntimeMessageType::FinalAnswer => AgentMessageType::FinalAnswer,
    }
}

const fn delivery_contract(state: RuntimeDeliveryState) -> AgentMessageDeliveryState {
    match state {
        RuntimeDeliveryState::Unread => AgentMessageDeliveryState::Unread,
        RuntimeDeliveryState::Read => AgentMessageDeliveryState::Read,
    }
}

const fn depth_contract(depth: RuntimeDepth) -> AgentDepth {
    match depth {
        RuntimeDepth::Quick => AgentDepth::Quick,
        RuntimeDepth::Normal => AgentDepth::Normal,
        RuntimeDepth::Exhaustive => AgentDepth::Exhaustive,
    }
}

#[cfg(test)]
mod tests {
    use codez_core::SessionId;
    use codez_runtime::agent::collaboration::AgentRuntimeSnapshot as RuntimeSnapshot;

    use super::snapshot_contract;

    #[test]
    fn snapshot_conversion_preserves_revision_and_session_identity() {
        let snapshot = RuntimeSnapshot {
            version: 1,
            session_id: SessionId::parse("session-1").expect("session fixture must parse"),
            revision: 11,
            agents: Vec::new(),
            messages: Vec::new(),
        };

        let contract = snapshot_contract(&snapshot);

        assert_eq!(
            (contract.session_id.as_str(), contract.revision),
            ("session-1", 11)
        );
    }
}
