use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    CommandError, SessionImageAttachment, context::ContextBudgetSnapshot,
    provider::ProviderTokenUsage,
};

pub const CHAT_STREAM_CONTRACT_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatProviderErrorCode {
    ContextOverflow,
    Authentication,
    RateLimit,
    NotFound,
    Network,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum AgentStopReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Error,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    // TODO: pub attachments: Option<Vec<ImageAttachment>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub r#type: String, // e.g. "function"
    pub function: ToolCallFunction,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub r#type: String, // e.g. "function"
    pub function: ToolDefinitionFunction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ToolDefinitionFunction {
    pub name: String,
    pub description: String,
    #[ts(type = "Record<string, any>")]
    pub parameters: serde_json::Value, // JSON Schema
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChatStreamEvent {
    Chunk {
        delta: String,
        reasoning_delta: Option<String>,
        tool_calls: Option<Vec<ToolCall>>,
        thought_signature: Option<String>,
    },
    Done {
        full_content: String,
        stop_reason: Option<AgentStopReason>,
        tx_id: Option<String>,
    },
    Usage(ProviderTokenUsage),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatCommandMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ui_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub referenced_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatStreamInput {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<SessionImageAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_system: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command_metadata: Option<ChatCommandMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatStreamRequest {
    pub stream_id: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: String,
    /// Workspace selected by the desktop UI for this run.
    ///
    /// The Tauri command canonicalizes this untrusted string before it can
    /// become tool execution authority. Omitting it keeps tool exposure off.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_root: Option<String>,
    pub input: ChatStreamInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatRunState {
    Starting,
    Running,
    Stopping,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatRuntimeStatus {
    pub session_id: String,
    pub main_runner_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ChatRunState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatRuntimeStatusChanged {
    #[ts(type = "number")]
    pub version: u64,
    pub status: ChatRuntimeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatSteerInput {
    pub queue_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attachments: Option<Vec<SessionImageAttachment>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatSteerRejection {
    NoActiveRunner,
    RunnerFinishing,
    InvalidInput,
    AttachmentsUnsupported,
    QueueFull,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatSteerResult {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ChatSteerRejection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatStreamStopResult {
    pub stopped: bool,
    pub state: ChatRunState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatToolInterruptResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatCompactionResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tokens_before: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tokens_after: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snapshot_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history_version: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatCompactionResponse {
    pub accepted: bool,
    pub result: ChatCompactionResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatFileDiff {
    pub path: String,
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatHistoryRevertResult {
    pub history_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatHistoryRevertPreview {
    pub to_delete: Vec<String>,
    pub to_restore: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum ChatPermissionApprovalScope {
    Once,
    Session,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatPermissionApprovalResponse {
    pub approved: bool,
    pub scope: ChatPermissionApprovalScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatPermissionCheck {
    pub permission: String,
    pub pattern: String,
    pub action: String,
    pub reason: String,
    pub absolute_redline: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatPermissionApprovalRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<String>,
    pub agent_role: String,
    pub tool_name: String,
    pub description: String,
    #[ts(type = "Record<string, any>")]
    pub input: serde_json::Value,
    pub checks: Vec<ChatPermissionCheck>,
    pub allowed_scopes: Vec<ChatPermissionApprovalScope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatPermissionApprovalEvent {
    pub run_id: String,
    pub request: ChatPermissionApprovalRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(untagged)]
pub enum ChatAskUserAnswerValue {
    Text(String),
    Selection(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatAskUserAnswer {
    pub question: String,
    pub answer: ChatAskUserAnswerValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatAskUserOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ChatAskUserQuestion {
    pub question: String,
    pub header: String,
    pub options: Vec<ChatAskUserOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignore_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submit_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatAskUserRequest {
    pub id: String,
    pub questions: Vec<ChatAskUserQuestion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatAskUserRequestEvent {
    pub run_id: String,
    pub request: ChatAskUserRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum PromptPredictionRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PromptPredictionContextMessage {
    pub role: PromptPredictionRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PromptPredictionRequest {
    pub provider_id: String,
    pub model: String,
    pub context: Vec<PromptPredictionContextMessage>,
    pub draft: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PromptPredictionResponse {
    pub suggestion: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ContextCompactionStarted {
    pub trigger: String,
    pub tokens_before: u32,
    pub history_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ContextCompactionCompleted {
    pub trigger: String,
    pub tokens_before: u32,
    pub tokens_after: u32,
    pub history_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ContextCompactionFailed {
    pub trigger: String,
    pub error_code: String,
    pub message: String,
    pub retryable: bool,
    pub history_version: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
#[ts(tag = "kind", content = "payload", rename_all = "camelCase")]
pub enum ChatStreamFrameEvent {
    Delta {
        delta: String,
        #[serde(rename = "reasoningDelta")]
        #[ts(rename = "reasoningDelta")]
        reasoning_delta: Option<String>,
    },
    Usage {
        usage: ProviderTokenUsage,
    },
    ContextBudget(ContextBudgetSnapshot),
    ContextCompactionStarted(ContextCompactionStarted),
    ContextCompactionCompleted(ContextCompactionCompleted),
    ContextCompactionFailed(ContextCompactionFailed),
    ToolCalls {
        calls: Vec<ToolCall>,
    },
    ToolResult {
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        result: String,
    },
    SteerConsumed {
        input: ChatSteerInput,
    },
    Completed {
        #[serde(rename = "fullContent")]
        #[ts(rename = "fullContent")]
        full_content: String,
        #[serde(rename = "stopReason")]
        #[ts(rename = "stopReason")]
        stop_reason: Option<AgentStopReason>,
        #[serde(rename = "txId")]
        #[ts(rename = "txId")]
        tx_id: Option<String>,
    },
    Failed {
        error: CommandError,
        #[serde(rename = "providerCode")]
        #[ts(rename = "providerCode")]
        provider_code: Option<ChatProviderErrorCode>,
        #[serde(rename = "txId")]
        #[ts(rename = "txId")]
        tx_id: Option<String>,
    },
    Interrupted {
        reason: String,
        #[serde(rename = "txId")]
        #[ts(rename = "txId")]
        tx_id: Option<String>,
    },
}

impl ChatStreamFrameEvent {
    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed { .. } | Self::Failed { .. } | Self::Interrupted { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatStreamFrame {
    pub version: u16,
    pub run_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub event: ChatStreamFrameEvent,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ChatStreamFrameEvent, CommandError};

    #[test]
    fn failed_terminal_frame_serializes_a_retained_transaction_id() {
        let event = ChatStreamFrameEvent::Failed {
            error: CommandError::internal("provider failed"),
            provider_code: None,
            tx_id: Some("tx-failed".to_string()),
        };

        assert_eq!(
            serde_json::to_value(event).expect("terminal frame must serialize"),
            json!({
                "kind": "failed",
                "payload": {
                    "error": {
                        "code": "INTERNAL",
                        "message": "provider failed",
                        "retryable": false,
                        "correlationId": null
                    },
                    "providerCode": null,
                    "txId": "tx-failed"
                }
            })
        );
    }

    #[test]
    fn interrupted_terminal_frame_serializes_a_retained_transaction_id() {
        let event = ChatStreamFrameEvent::Interrupted {
            reason: "stopped".to_string(),
            tx_id: Some("tx-interrupted".to_string()),
        };

        assert_eq!(
            serde_json::to_value(event).expect("terminal frame must serialize"),
            json!({
                "kind": "interrupted",
                "payload": { "reason": "stopped", "txId": "tx-interrupted" }
            })
        );
    }

    #[test]
    fn interrupted_terminal_frame_keeps_an_empty_transaction_absent() {
        let event = ChatStreamFrameEvent::Interrupted {
            reason: "stopped".to_string(),
            tx_id: None,
        };
        let value = serde_json::to_value(event).expect("terminal frame must serialize");

        assert_eq!(value["payload"]["txId"], serde_json::Value::Null);
    }
}
