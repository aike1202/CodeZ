use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const AGENT_UPDATED_EVENT: &str = "agent:updated";
pub const AGENT_EVENT_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentRuntimeStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentMessageType {
    NewTask,
    Message,
    FinalAnswer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentMessageDeliveryState {
    Unread,
    Read,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentDepth {
    Quick,
    Normal,
    Exhaustive,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AgentExpectations {
    #[serde(default)]
    pub questions: Vec<String>,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AgentScope {
    #[serde(default)]
    pub directories: Vec<String>,
    #[serde(default)]
    pub exclude_globs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentLaunchPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expectations: Option<AgentExpectations>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<AgentScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<AgentDepth>,
    #[serde(default)]
    pub allowed_write_files: Vec<String>,
    #[serde(default)]
    pub allow_shell: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentTerminalResult {
    pub status: AgentRuntimeStatus,
    pub report: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentRecord {
    pub agent_id: String,
    pub session_id: String,
    pub parent_agent_id: String,
    pub parent_path: String,
    pub path: String,
    pub role: String,
    pub task_name: String,
    pub description: String,
    pub context_scope_id: String,
    pub status: AgentRuntimeStatus,
    pub attempt_id: String,
    pub run_count: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub launch: AgentLaunchPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AgentTerminalResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct AgentMailboxMessage {
    pub message_id: String,
    pub message_type: AgentMessageType,
    pub attempt_id: String,
    pub author: String,
    pub recipient: String,
    pub payload: String,
    pub delivery_state: AgentMessageDeliveryState,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentRuntimeSnapshot {
    pub version: u16,
    pub session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub agents: Vec<AgentRecord>,
    pub messages: Vec<AgentMailboxMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AgentSnapshotRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AgentActiveIdsRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentActiveIdsResult {
    pub agent_ids: Vec<String>,
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentUpdatedEvent {
    pub version: u16,
    pub session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub snapshot: AgentRuntimeSnapshot,
}

#[cfg(test)]
mod tests {
    use super::{
        AGENT_EVENT_VERSION, AgentRuntimeSnapshot, AgentSnapshotRequest, AgentUpdatedEvent,
    };

    #[test]
    fn agent_events_repeat_session_and_revision_for_gap_detection() {
        let snapshot = AgentRuntimeSnapshot {
            version: 1,
            session_id: "session-1".to_string(),
            revision: 7,
            agents: Vec::new(),
            messages: Vec::new(),
        };
        let event = AgentUpdatedEvent {
            version: AGENT_EVENT_VERSION,
            session_id: snapshot.session_id.clone(),
            revision: snapshot.revision,
            snapshot,
        };
        let value = serde_json::to_value(event).expect("Agent event fixture must serialize");

        assert_eq!(
            (value["sessionId"].as_str(), value["revision"].as_u64()),
            (Some("session-1"), Some(7))
        );
    }

    #[test]
    fn snapshot_requests_reject_unknown_fields() {
        let error = serde_json::from_str::<AgentSnapshotRequest>(
            r#"{"sessionId":"session-1","unexpected":true}"#,
        )
        .expect_err("Agent command extensions must be rejected");

        assert!(error.to_string().contains("unexpected"));
    }
}
