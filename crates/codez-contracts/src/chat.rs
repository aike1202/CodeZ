use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{CommandError, SessionImageAttachment, provider::ProviderTokenUsage};

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
pub struct ChatStreamInput {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<SessionImageAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_system: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub command_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ChatStreamRequest {
    pub stream_id: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: String,
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
    pub active_sub_agent_ids: Vec<String>,
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
#[ts(rename_all = "camelCase")]
pub struct ChatFileDiff {
    pub path: String,
    pub diff: String,
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
    ToolCalls {
        calls: Vec<ToolCall>,
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
    },
    Interrupted {
        reason: String,
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
