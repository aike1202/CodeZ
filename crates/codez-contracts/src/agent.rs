use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const AGENT_CONTRACT_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentProfile {
    General,
    Explore,
    Review,
    Integration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentState {
    Created,
    Queued,
    Starting,
    Running,
    WaitingMessage,
    WaitingChildren,
    AwaitingApproval,
    NeedsReplan,
    NeedsResolution,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl AgentState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum WorkspaceMode {
    SharedReadonly,
    IsolatedWorktree,
    IsolatedSnapshotPatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentMessageKind {
    Instruction,
    Question,
    Answer,
    Progress,
    Finding,
    Result,
    CancelRequest,
    ContractChange,
    SystemNotice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentResultStatus {
    Completed,
    Partial,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentWaitMode {
    Any,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentCompletionPolicy {
    CollectAll,
    FailFast,
    BestEffort,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentResultSchema {
    pub version: u16,
    pub required_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DelegatedTask {
    pub task_id: String,
    pub title: String,
    pub objective: String,
    pub known_facts: Vec<String>,
    pub success_criteria: Vec<String>,
    pub non_goals: Vec<String>,
    pub dependencies: Vec<String>,
    pub context_refs: Vec<String>,
    pub validation_expectations: Vec<String>,
    pub expected_result_schema: AgentResultSchema,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentPolicy {
    pub can_delegate: bool,
    pub can_write: bool,
    pub can_use_network: bool,
    pub can_delete: bool,
    pub can_install_dependencies: bool,
    pub can_git_push: bool,
    pub can_ask_user: bool,
    pub max_depth: u16,
    pub max_direct_children: u16,
    pub max_root_agents: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentBudget {
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    #[ts(type = "number")]
    pub provider_cost_micros: u64,
    #[ts(type = "number")]
    pub tool_calls: u64,
    #[ts(type = "number")]
    pub model_visible_tool_result_bytes: u64,
    #[ts(type = "number")]
    pub command_wall_time_ms: u64,
    #[ts(type = "number")]
    pub wall_time_ms: u64,
    #[ts(type = "number")]
    pub files_read: u64,
    #[ts(type = "number")]
    pub files_written: u64,
    #[ts(type = "number")]
    pub child_agents: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentUsage {
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    #[ts(type = "number")]
    pub provider_cost_micros: u64,
    #[ts(type = "number")]
    pub tool_calls: u64,
    #[ts(type = "number")]
    pub model_visible_tool_result_bytes: u64,
    #[ts(type = "number")]
    pub command_wall_time_ms: u64,
    #[ts(type = "number")]
    pub wall_time_ms: u64,
    #[ts(type = "number")]
    pub files_read: u64,
    #[ts(type = "number")]
    pub files_written: u64,
    #[ts(type = "number")]
    pub child_agents: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct WorkspaceAssignment {
    pub mode: WorkspaceMode,
    pub root: String,
    pub read_scope: Vec<String>,
    pub write_scope: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_manifest: Option<String>,
    pub integration_policy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentNode {
    pub schema_version: u16,
    pub id: String,
    pub root_run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub depth: u16,
    pub profile: AgentProfile,
    pub task: DelegatedTask,
    pub policy: AgentPolicy,
    pub budget: AgentBudget,
    pub workspace: WorkspaceAssignment,
    pub state: AgentState,
    #[ts(type = "number")]
    pub state_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_tool_call_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentAttempt {
    pub id: String,
    pub agent_id: String,
    pub ordinal: u32,
    pub state: AgentState,
    #[ts(type = "number")]
    pub state_revision: u64,
    #[ts(type = "number")]
    pub mailbox_cursor: u64,
    pub prompt_schema_version: u16,
    pub prompt_module_hashes: Vec<String>,
    pub dynamic_snapshot_hash: String,
    pub tool_catalog_fingerprint: String,
    pub provider_id: String,
    pub model_id: String,
    pub result_contract_version: u16,
    pub usage: AgentUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentMessage {
    pub id: String,
    pub root_run_id: String,
    pub from: String,
    pub to: String,
    pub kind: AgentMessageKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[ts(type = "number")]
    pub sequence: u64,
    pub summary: String,
    pub artifact_refs: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentChangedArtifact {
    pub path: String,
    pub kind: String,
    pub purpose: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentValidationResult {
    pub command_or_check: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentFinding {
    pub severity: String,
    pub claim: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentResult {
    pub status: AgentResultStatus,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
    pub changes: Vec<AgentChangedArtifact>,
    pub validations: Vec<AgentValidationResult>,
    pub findings: Vec<AgentFinding>,
    pub blockers: Vec<String>,
    pub unresolved: Vec<String>,
    pub recommended_next_actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<AgentConfidence>,
    pub artifact_refs: Vec<String>,
    pub usage: AgentUsage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SpawnAgentSpec {
    pub task: DelegatedTask,
    pub profile: AgentProfile,
    pub workspace: WorkspaceAssignment,
    pub policy: AgentPolicy,
    pub budget: AgentBudget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SpawnAgentRequest {
    pub root_run_id: String,
    pub parent_agent_id: String,
    pub parent_attempt_id: String,
    pub tool_call_id: String,
    pub agent: SpawnAgentSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SpawnAgentsRequest {
    pub root_run_id: String,
    pub parent_agent_id: String,
    pub parent_attempt_id: String,
    pub tool_call_id: String,
    pub agents: Vec<SpawnAgentSpec>,
    pub completion_policy: AgentCompletionPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SpawnAgentHandle {
    pub agent_id: String,
    pub attempt_id: String,
    pub state: AgentState,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WaitAgentsRequest {
    pub mode: AgentWaitMode,
    pub agent_ids: Vec<String>,
    #[ts(type = "number")]
    pub after_cursor: u64,
    #[ts(type = "number")]
    pub timeout_ms: u64,
    pub include_progress: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentSummary {
    pub agent_id: String,
    pub attempt_id: String,
    pub root_run_id: String,
    pub parent_agent_id: Option<String>,
    pub title: String,
    pub profile: AgentProfile,
    pub depth: u16,
    pub state: AgentState,
    #[ts(type = "number")]
    pub state_revision: u64,
    pub latest_summary: String,
    pub unread_event_count: u32,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WaitAgentsResponse {
    #[ts(type = "number")]
    pub cursor: u64,
    pub timed_out: bool,
    pub agents: Vec<AgentSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SendAgentMessageRequest {
    pub from_agent_id: String,
    pub to_agent_id: String,
    pub kind: AgentMessageKind,
    pub summary: String,
    pub correlation_id: Option<String>,
    pub reply_to: Option<String>,
    pub idempotency_key: Option<String>,
    pub artifact_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
#[ts(tag = "kind", content = "payload", rename_all = "camelCase")]
pub enum AgentUiEvent {
    AssistantDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    ToolStarted {
        tool_call_id: String,
        name: String,
        summary: String,
    },
    ToolUpdated {
        tool_call_id: String,
        summary: String,
    },
    ToolCompleted {
        tool_call_id: String,
        status: String,
        summary: String,
    },
    FileChanged {
        path: String,
        change_kind: String,
        transaction_id: String,
    },
    AgentMessageSent(AgentMessage),
    AgentMessageReceived(AgentMessage),
    PermissionRequested {
        request_id: String,
        summary: String,
    },
    PermissionResolved {
        request_id: String,
        approved: bool,
    },
    BudgetUpdated {
        usage: AgentUsage,
        remaining: AgentBudget,
    },
    StateChanged {
        previous: AgentState,
        next: AgentState,
    },
    ResultSubmitted(AgentResult),
    ErrorRaised {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentUiEventEnvelope {
    pub root_run_id: String,
    pub agent_id: String,
    pub attempt_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub state_revision: u64,
    pub occurred_at: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub event: AgentUiEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentEventPage {
    pub events: Vec<AgentUiEventEnvelope>,
    #[ts(type = "number")]
    pub next_cursor: u64,
    pub has_more: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AgentState, AgentUiEvent, AgentUiEventEnvelope};

    #[test]
    fn ui_event_envelope_should_keep_agent_routing_identity() {
        let event = AgentUiEventEnvelope {
            root_run_id: "root-1".to_string(),
            agent_id: "agent-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            sequence: 7,
            state_revision: 3,
            occurred_at: "2026-07-19T00:00:00Z".to_string(),
            event: AgentUiEvent::StateChanged {
                previous: AgentState::Starting,
                next: AgentState::Running,
            },
        };

        assert_eq!(
            serde_json::to_value(event).expect("agent event fixture must serialize"),
            json!({
                "rootRunId": "root-1",
                "agentId": "agent-1",
                "attemptId": "attempt-1",
                "sequence": 7,
                "stateRevision": 3,
                "occurredAt": "2026-07-19T00:00:00Z",
                "kind": "stateChanged",
                "payload": { "previous": "starting", "next": "running" }
            })
        );
    }
}
