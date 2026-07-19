use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{AgentAttemptId, AgentId, ArtifactId, MessageId, RootRunId, TaskId};

pub const AGENT_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentProfile {
    General,
    Explore,
    Review,
    Integration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

    #[must_use]
    pub const fn releases_provider_permit(self) -> bool {
        matches!(
            self,
            Self::Created
                | Self::Queued
                | Self::WaitingMessage
                | Self::WaitingChildren
                | Self::AwaitingApproval
                | Self::NeedsReplan
                | Self::NeedsResolution
                | Self::Completed
                | Self::Failed
                | Self::Cancelled
                | Self::Interrupted
        )
    }

    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        match self {
            Self::Created => matches!(next, Self::Queued | Self::Cancelled),
            Self::Queued => matches!(next, Self::Starting | Self::Cancelled),
            Self::Starting => matches!(
                next,
                Self::Running | Self::Failed | Self::Cancelled | Self::Interrupted
            ),
            Self::Running => matches!(
                next,
                Self::WaitingMessage
                    | Self::WaitingChildren
                    | Self::AwaitingApproval
                    | Self::NeedsReplan
                    | Self::NeedsResolution
                    | Self::Completed
                    | Self::Failed
                    | Self::Cancelled
                    | Self::Interrupted
            ),
            Self::WaitingMessage
            | Self::WaitingChildren
            | Self::AwaitingApproval
            | Self::NeedsReplan
            | Self::NeedsResolution => matches!(
                next,
                Self::Queued | Self::Failed | Self::Cancelled | Self::Interrupted
            ),
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AgentStateTransitionError {
    #[error("agent state revision changed: expected {expected}, found {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("agent state cannot transition from {from:?} to {to:?}")]
    InvalidTransition { from: AgentState, to: AgentState },
    #[error("agent state revision overflowed")]
    RevisionOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateSnapshot {
    pub state: AgentState,
    pub revision: u64,
}

impl AgentStateSnapshot {
    #[must_use]
    pub const fn new(state: AgentState) -> Self {
        Self { state, revision: 0 }
    }

    pub fn transition(
        self,
        expected_revision: u64,
        next: AgentState,
    ) -> Result<Self, AgentStateTransitionError> {
        if self.revision != expected_revision {
            return Err(AgentStateTransitionError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        if !self.state.can_transition_to(next) {
            return Err(AgentStateTransitionError::InvalidTransition {
                from: self.state,
                to: next,
            });
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(AgentStateTransitionError::RevisionOverflow)?;
        Ok(Self {
            state: next,
            revision,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSchema {
    pub version: u16,
    pub required_fields: Vec<String>,
}

impl Default for ResultSchema {
    fn default() -> Self {
        Self {
            version: AGENT_SCHEMA_VERSION,
            required_fields: vec![
                "status".to_string(),
                "summary".to_string(),
                "validations".to_string(),
                "blockers".to_string(),
                "unresolved".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatedTask {
    pub task_id: TaskId,
    pub title: String,
    pub objective: String,
    pub known_facts: Vec<String>,
    pub success_criteria: Vec<String>,
    pub non_goals: Vec<String>,
    pub dependencies: Vec<TaskId>,
    pub context_refs: Vec<ArtifactId>,
    pub validation_expectations: Vec<String>,
    pub expected_result_schema: ResultSchema,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    SharedReadonly,
    IsolatedWorktree,
    IsolatedSnapshotPatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAssignment {
    pub mode: WorkspaceMode,
    pub root: String,
    pub read_scope: Vec<String>,
    pub write_scope: Vec<String>,
    pub baseline_revision: Option<String>,
    pub baseline_manifest: Option<String>,
    pub integration_policy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

impl AgentPolicy {
    #[must_use]
    pub const fn readonly_child() -> Self {
        Self {
            can_delegate: false,
            can_write: false,
            can_use_network: false,
            can_delete: false,
            can_install_dependencies: false,
            can_git_push: false,
            can_ask_user: false,
            max_depth: 2,
            max_direct_children: 3,
            max_root_agents: 12,
        }
    }

    #[must_use]
    pub const fn intersect(&self, delegated: &Self) -> Self {
        Self {
            can_delegate: self.can_delegate && delegated.can_delegate,
            can_write: self.can_write && delegated.can_write,
            can_use_network: self.can_use_network && delegated.can_use_network,
            can_delete: self.can_delete && delegated.can_delete,
            can_install_dependencies: self.can_install_dependencies
                && delegated.can_install_dependencies,
            can_git_push: self.can_git_push && delegated.can_git_push,
            can_ask_user: self.can_ask_user && delegated.can_ask_user,
            max_depth: if self.max_depth < delegated.max_depth {
                self.max_depth
            } else {
                delegated.max_depth
            },
            max_direct_children: if self.max_direct_children < delegated.max_direct_children {
                self.max_direct_children
            } else {
                delegated.max_direct_children
            },
            max_root_agents: if self.max_root_agents < delegated.max_root_agents {
                self.max_root_agents
            } else {
                delegated.max_root_agents
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBudget {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub provider_cost_micros: u64,
    pub tool_calls: u64,
    pub model_visible_tool_result_bytes: u64,
    pub command_wall_time_ms: u64,
    pub wall_time_ms: u64,
    pub files_read: u64,
    pub files_written: u64,
    pub child_agents: u64,
}

impl AgentBudget {
    #[must_use]
    pub const fn conservative_child() -> Self {
        Self {
            input_tokens: 200_000,
            output_tokens: 50_000,
            provider_cost_micros: 10_000_000,
            tool_calls: 100,
            model_visible_tool_result_bytes: 2 * 1024 * 1024,
            command_wall_time_ms: 60 * 60 * 1_000,
            wall_time_ms: 2 * 60 * 60 * 1_000,
            files_read: 1_000,
            files_written: 200,
            child_agents: 3,
        }
    }

    #[must_use]
    pub const fn min(&self, requested: &Self) -> Self {
        Self {
            input_tokens: min_u64(self.input_tokens, requested.input_tokens),
            output_tokens: min_u64(self.output_tokens, requested.output_tokens),
            provider_cost_micros: min_u64(
                self.provider_cost_micros,
                requested.provider_cost_micros,
            ),
            tool_calls: min_u64(self.tool_calls, requested.tool_calls),
            model_visible_tool_result_bytes: min_u64(
                self.model_visible_tool_result_bytes,
                requested.model_visible_tool_result_bytes,
            ),
            command_wall_time_ms: min_u64(
                self.command_wall_time_ms,
                requested.command_wall_time_ms,
            ),
            wall_time_ms: min_u64(self.wall_time_ms, requested.wall_time_ms),
            files_read: min_u64(self.files_read, requested.files_read),
            files_written: min_u64(self.files_written, requested.files_written),
            child_agents: min_u64(self.child_agents, requested.child_agents),
        }
    }

    #[must_use]
    pub const fn saturating_sub(&self, used: &AgentUsage) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(used.input_tokens),
            output_tokens: self.output_tokens.saturating_sub(used.output_tokens),
            provider_cost_micros: self
                .provider_cost_micros
                .saturating_sub(used.provider_cost_micros),
            tool_calls: self.tool_calls.saturating_sub(used.tool_calls),
            model_visible_tool_result_bytes: self
                .model_visible_tool_result_bytes
                .saturating_sub(used.model_visible_tool_result_bytes),
            command_wall_time_ms: self
                .command_wall_time_ms
                .saturating_sub(used.command_wall_time_ms),
            wall_time_ms: self.wall_time_ms.saturating_sub(used.wall_time_ms),
            files_read: self.files_read.saturating_sub(used.files_read),
            files_written: self.files_written.saturating_sub(used.files_written),
            child_agents: self.child_agents.saturating_sub(used.child_agents),
        }
    }
}

const fn min_u64(left: u64, right: u64) -> u64 {
    if left < right { left } else { right }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub provider_cost_micros: u64,
    pub tool_calls: u64,
    pub model_visible_tool_result_bytes: u64,
    pub command_wall_time_ms: u64,
    pub wall_time_ms: u64,
    pub files_read: u64,
    pub files_written: u64,
    pub child_agents: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNode {
    pub schema_version: u16,
    pub id: AgentId,
    pub root_run_id: RootRunId,
    pub parent_id: Option<AgentId>,
    pub depth: u16,
    pub profile: AgentProfile,
    pub task: DelegatedTask,
    pub policy: AgentPolicy,
    pub budget: AgentBudget,
    pub workspace: WorkspaceAssignment,
    pub state: AgentState,
    pub state_revision: u64,
    pub created_by_tool_call_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttempt {
    pub id: AgentAttemptId,
    pub agent_id: AgentId,
    pub ordinal: u32,
    pub state: AgentState,
    pub state_revision: u64,
    pub mailbox_cursor: u64,
    pub prompt_schema_version: u16,
    pub prompt_module_hashes: Vec<String>,
    pub dynamic_snapshot_hash: String,
    pub tool_catalog_fingerprint: String,
    pub provider_id: String,
    pub model_id: String,
    pub result_contract_version: u16,
    pub usage: AgentUsage,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: MessageId,
    pub root_run_id: RootRunId,
    pub from: AgentId,
    pub to: AgentId,
    pub kind: MessageKind,
    pub correlation_id: Option<String>,
    pub reply_to: Option<MessageId>,
    pub idempotency_key: Option<String>,
    pub sequence: u64,
    pub summary: String,
    pub artifact_refs: Vec<ArtifactId>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentResultStatus {
    Completed,
    Partial,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedArtifact {
    pub path: String,
    pub kind: String,
    pub purpose: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentValidationResult {
    pub command_or_check: String,
    pub status: String,
    pub evidence_ref: Option<ArtifactId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFinding {
    pub severity: String,
    pub claim: String,
    pub evidence_refs: Vec<ArtifactId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    pub status: AgentResultStatus,
    pub summary: String,
    pub conclusion: Option<String>,
    pub changes: Vec<ChangedArtifact>,
    pub validations: Vec<AgentValidationResult>,
    pub findings: Vec<AgentFinding>,
    pub blockers: Vec<String>,
    pub unresolved: Vec<String>,
    pub recommended_next_actions: Vec<String>,
    pub confidence: Option<Confidence>,
    pub artifact_refs: Vec<ArtifactId>,
    pub usage: AgentUsage,
}

#[cfg(test)]
mod tests {
    use super::{AgentPolicy, AgentState, AgentStateSnapshot, AgentStateTransitionError};

    #[test]
    fn state_transition_should_reject_illegal_running_skip() {
        let state = AgentStateSnapshot::new(AgentState::Created);

        assert_eq!(
            state.transition(0, AgentState::Running),
            Err(AgentStateTransitionError::InvalidTransition {
                from: AgentState::Created,
                to: AgentState::Running,
            })
        );
    }

    #[test]
    fn state_transition_should_reject_a_second_terminal_choice() {
        let completed = AgentStateSnapshot {
            state: AgentState::Completed,
            revision: 4,
        };

        assert_eq!(
            completed.transition(4, AgentState::Cancelled),
            Err(AgentStateTransitionError::InvalidTransition {
                from: AgentState::Completed,
                to: AgentState::Cancelled,
            })
        );
    }

    #[test]
    fn state_transition_should_reject_stale_revisions() {
        let queued = AgentStateSnapshot {
            state: AgentState::Queued,
            revision: 2,
        };

        assert_eq!(
            queued.transition(1, AgentState::Starting),
            Err(AgentStateTransitionError::RevisionConflict {
                expected: 1,
                actual: 2,
            })
        );
    }

    #[test]
    fn policy_intersection_should_never_expand_parent_authority() {
        let parent = AgentPolicy::readonly_child();
        let mut requested = parent.clone();
        requested.can_write = true;
        requested.can_delegate = true;
        requested.max_root_agents = 99;

        assert_eq!(parent.intersect(&requested), parent);
    }
}
