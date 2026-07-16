use std::{borrow::Cow, collections::HashMap, fmt};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use thiserror::Error;

use crate::{
    ComposerImageAttachment,
    provider::{AgentStopReason, ProviderTokenUsage},
};

pub const MAIN_CONTEXT_SCOPE: &str = "main";
pub const CONTEXT_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ContextScopeId {
    Main,
    Subagent(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("context scope must be 'main' or a non-empty 'subagent:<id>' value")]
pub struct ContextScopeIdError;

impl ContextScopeId {
    pub fn parse(value: &str) -> Result<Self, ContextScopeIdError> {
        if value == MAIN_CONTEXT_SCOPE {
            return Ok(Self::Main);
        }
        let Some(identifier) = value.strip_prefix("subagent:") else {
            return Err(ContextScopeIdError);
        };
        if identifier.is_empty()
            || identifier.len() > 160
            || identifier.chars().any(char::is_control)
        {
            return Err(ContextScopeIdError);
        }
        Ok(Self::Subagent(identifier.to_string()))
    }

    #[must_use]
    pub fn as_key(&self) -> Cow<'_, str> {
        match self {
            Self::Main => Cow::Borrowed(MAIN_CONTEXT_SCOPE),
            Self::Subagent(identifier) => Cow::Owned(format!("subagent:{identifier}")),
        }
    }
}

impl fmt::Display for ContextScopeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_key())
    }
}

impl Serialize for ContextScopeId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ContextScopeId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(D::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerEventType {
    UserMessage,
    AssistantMessage,
    ToolResult,
    SkillStateUpdated,
    TurnCompleted,
    TurnInterrupted,
    ResumeStateUpdated,
    CompactionStarted,
    CompactionCompleted,
    CompactionFailed,
    HistoryReverted,
    LegacyImportCompleted,
}

impl LedgerEventType {
    #[must_use]
    pub const fn changes_history(self) -> bool {
        matches!(
            self,
            Self::UserMessage
                | Self::AssistantMessage
                | Self::ToolResult
                | Self::SkillStateUpdated
                | Self::TurnInterrupted
                | Self::ResumeStateUpdated
                | Self::CompactionCompleted
                | Self::HistoryReverted
                | Self::LegacyImportCompleted
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSnapshot {
    pub id: Option<String>,
    pub title: Option<String>,
    pub original_prompt: String,
    pub normalized_goal: Option<String>,
    pub key_requirements: Vec<String>,
    pub non_goals: Option<Vec<String>>,
    pub success_criteria: Option<Vec<String>>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPlan {
    pub current_step: String,
    pub completed_steps: Vec<String>,
    pub pending_steps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    pub current_goal_id: String,
    pub current_phase: String,
    pub current_step: String,
    pub last_completed_step: Option<String>,
    pub next_action: String,
    pub open_questions: Vec<String>,
    pub blocked_by: Vec<String>,
    pub files_touched: Vec<String>,
    pub files_to_inspect_next: Vec<String>,
    pub validation_pending: Vec<String>,
    pub validation_results: Option<Vec<ValidationResult>>,
    pub goal: Option<GoalSnapshot>,
    pub plan: Option<TaskPlan>,
    pub context_files: Option<Vec<String>>,
    pub last_trimmed_at: Option<u64>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub command_or_check: String,
    pub status: String,
    pub result: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedResumeState {
    pub revision: u32,
    pub covered_through_sequence: u32,
    pub source: String,
    pub updated_at: String,
    pub state: ResumeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContextReference {
    pub path: String,
    pub sha256: String,
    pub operation: String,
    pub content_included: bool,
    pub content_sha256: Option<String>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
    pub character_offset: Option<u64>,
    pub access_sequence: Option<u64>,
    pub result_block_start: Option<u32>,
    pub result_block_end: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCompactionFileBlock {
    pub reference: FileContextReference,
    pub content: String,
    pub stat_signature: String,
    pub real_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCompactionFileContext {
    pub content: String,
    pub file_references: Vec<FileContextReference>,
    pub blocks: Option<Vec<PostCompactionFileBlock>>,
    pub created_at: String,
    pub source_sequence: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokedSkillContextEntry {
    pub name: String,
    pub content: String,
    pub invoked_sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkillState {
    pub name: String,
    pub status: String,
    pub content: Option<String>,
    pub content_hash: Option<String>,
    pub args: Option<String>,
    pub source: String,
    pub reason: Option<String>,
    pub updated_at: String,
    pub updated_sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostCompactionSkillContext {
    pub content: String,
    pub skills: Vec<InvokedSkillContextEntry>,
    pub created_at: String,
    pub source_sequence: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedModelMessage {
    pub id: String,
    pub client_message_id: Option<String>,
    pub turn_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<Vec<NormalizedToolCall>>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub status: String,
    pub created_at: String,
    pub source_sequence: Option<u32>,
    pub attachments: Option<Vec<ComposerImageAttachment>>,
    pub file_references: Option<Vec<FileContextReference>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEvent {
    pub schema_version: u16,
    pub event_id: String,
    pub session_id: String,
    pub context_scope_id: ContextScopeId,
    pub sequence: u32,
    pub history_version: u32,
    pub turn_id: Option<String>,
    pub created_at: String,
    pub r#type: LedgerEventType,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAppendRequest {
    pub event_id: String,
    pub session_id: String,
    pub context_scope_id: ContextScopeId,
    pub turn_id: Option<String>,
    pub created_at: String,
    pub r#type: LedgerEventType,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeScopeSnapshot {
    pub history_version: u32,
    pub active_messages: Vec<NormalizedModelMessage>,
    pub latest_compaction: Option<serde_json::Value>,
    pub observed_provider_input_limit: Option<serde_json::Value>,
    pub resume_state: Option<VersionedResumeState>,
    pub last_completed_turn_id: Option<String>,
    pub last_interrupted_turn_id: Option<String>,
    pub legacy_import: Option<serde_json::Value>,
    pub latest_compaction_resume_revision: Option<u32>,
    pub last_provider_id: Option<String>,
    pub last_model: Option<String>,
    pub last_provider_usage: Option<ProviderTokenUsage>,
    pub last_provider_usage_message_id: Option<String>,
    pub last_provider_usage_provider_id: Option<String>,
    pub last_provider_usage_model: Option<String>,
    pub last_provider_usage_request_fingerprint: Option<String>,
    pub post_compaction_file_context: Option<PostCompactionFileContext>,
    pub post_compaction_skill_context: Option<PostCompactionSkillContext>,
    pub skill_states: Option<Vec<SessionSkillState>>,
    pub post_compaction_skill_states: Option<Vec<SessionSkillState>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeSnapshot {
    pub schema_version: u16,
    pub session_id: String,
    pub through_sequence: u32,
    pub created_at: String,
    pub scopes: HashMap<String, SessionRuntimeScopeSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelContextItemMessage {
    Normalized(Box<NormalizedModelMessage>),
    System {
        role: String,
        content: String,
        file_references: Option<Vec<FileContextReference>>,
        source_sequence: Option<u32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelContextItem {
    pub kind: String,
    pub message: ModelContextItemMessage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessagePayload {
    pub message: NormalizedModelMessage,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub command_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessagePayload {
    pub message: NormalizedModelMessage,
    pub usage: Option<ProviderTokenUsage>,
    pub request_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultPayload {
    pub message: NormalizedModelMessage,
    pub status: String,
    pub full_result_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStateUpdatedPayload {
    pub name: String,
    pub status: String,
    pub content: Option<String>,
    pub content_hash: Option<String>,
    pub args: Option<String>,
    pub source: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedPayload {
    pub stop_reason: AgentStopReason,
    pub usage: Option<ProviderTokenUsage>,
    pub completed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptedPayload {
    pub reason: String,
    pub interrupted_messages: Vec<NormalizedModelMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeStateUpdatedPayload {
    pub resume_state: VersionedResumeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionCompletedPayload {
    pub trigger: String,
    pub source_history_version: u32,
    pub covered_through_sequence: u32,
    pub retained_from_sequence: Option<u32>,
    pub tokens_before: u32,
    pub tokens_after: u32,
    pub source_hash: String,
    pub summary: serde_json::Value,
    pub observed_provider_input_limit: Option<serde_json::Value>,
    pub resume_state: Option<VersionedResumeState>,
    pub active_messages: Vec<NormalizedModelMessage>,
    pub post_compaction_file_context: Option<PostCompactionFileContext>,
    pub post_compaction_skill_context: Option<PostCompactionSkillContext>,
    pub skill_states: Option<Vec<SessionSkillState>>,
    pub post_compaction_skill_states: Option<Vec<SessionSkillState>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionStartedPayload {
    pub trigger: String,
    pub source_history_version: u32,
    pub candidate_through_sequence: u32,
    pub tokens_before: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionFailedPayload {
    pub trigger: String,
    pub stage: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRevertedPayload {
    pub source_history_version: u32,
    pub target_ui_message_id: String,
    pub target_message_id: String,
    pub active_messages: Vec<NormalizedModelMessage>,
    pub skill_states: Option<Vec<SessionSkillState>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportCompletedPayload {
    pub source_hash: String,
    pub mode: String,
    pub active_messages: Vec<NormalizedModelMessage>,
    pub summary: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::{ContextScopeId, LedgerEventType};

    #[test]
    fn context_scope_uses_the_stable_string_wire_format() {
        let serialized = serde_json::to_string(&ContextScopeId::Subagent("run-7".to_string()))
            .expect("fixed scope must serialize");

        assert_eq!(serialized, r#""subagent:run-7""#);
    }

    #[test]
    fn only_model_visible_events_advance_history() {
        assert!(LedgerEventType::UserMessage.changes_history());
        assert!(!LedgerEventType::TurnCompleted.changes_history());
    }
}
