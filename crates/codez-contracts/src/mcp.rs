use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Transport selected for one MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

const fn default_stdio_transport() -> McpTransport {
    McpTransport::Stdio
}

/// Scope from which an effective MCP server configuration was loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum McpConfigScope {
    Managed,
    User,
    Project,
    Local,
    Dynamic,
}

/// User policy for an MCP reverse request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum McpApprovalPolicy {
    Deny,
    Ask,
    Allow,
}

/// User decision returned for a pending MCP elicitation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum McpElicitationAction {
    Accept,
    Decline,
    Cancel,
}

/// Sanitized details of one MCP request that requires desktop mediation.
///
/// Sampling deliberately exposes only request metadata. The untrusted message
/// bodies stay in the Rust host and are sent to a Provider only after the
/// configured policy allows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum McpReverseRequest {
    Sampling {
        max_tokens: u32,
        #[ts(type = "number")]
        message_count: usize,
        has_system_prompt: bool,
    },
    ElicitationUrl {
        message: String,
        origin: String,
    },
    ElicitationForm {
        message: String,
        #[ts(type = "unknown")]
        requested_schema: Value,
    },
}

/// One bounded reverse request emitted to the desktop interface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct McpReverseRequestEvent {
    pub request_id: String,
    pub server_name: String,
    pub fingerprint: String,
    pub policy: McpApprovalPolicy,
    pub request: McpReverseRequest,
}

/// Response supplied by the desktop interface for a pending MCP request.
///
/// The Rust mediator verifies that the discriminant matches the pending
/// request and validates form content against the original MCP schema before
/// forwarding anything to the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum McpReverseRequestResponse {
    Sampling {
        approved: bool,
    },
    ElicitationUrl {
        action: McpElicitationAction,
    },
    ElicitationForm {
        action: McpElicitationAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "unknown")]
        content: Option<Value>,
    },
}

/// Policy for incorporating untrusted server instructions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum McpInstructionsPolicy {
    Ignore,
    ToolHints,
    Approved,
}

/// Bounded reconnect policy for one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct McpReconnectPolicy {
    pub enabled: bool,
    pub max_attempts: u32,
    pub base_delay_ms: u32,
    pub max_delay_ms: u32,
}

/// Non-secret OAuth client preferences for a remote MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpOAuthConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// Normalized MCP server configuration accepted by the desktop boundary.
///
/// A missing legacy `type` field deserializes as `stdio`; command validation
/// still requires a non-empty executable before the value can be persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpServerConfig {
    #[serde(rename = "type", default = "default_stdio_transport")]
    #[ts(rename = "type")]
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handshake_timeout_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_load_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_start: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconnect: Option<McpReconnectPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions_policy: Option<McpInstructionsPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling_policy: Option<McpApprovalPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elicitation_policy: Option<McpApprovalPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling_max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_subscriptions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<McpOAuthConfig>,
    #[serde(default, flatten)]
    #[ts(skip)]
    pub extensions: BTreeMap<String, Value>,
}

/// One MCP configuration after scope selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct ScopedMcpServerConfig {
    pub name: String,
    pub scope: McpConfigScope,
    pub config: McpServerConfig,
    pub fingerprint: String,
    pub trusted: bool,
    pub effective: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_by: Option<McpConfigScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_disabled: Option<bool>,
}

/// Runtime state reported for one configured MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum McpServerState {
    Disabled,
    TrustRequired,
    Connecting,
    Connected,
    NeedsAuth,
    Reconnecting,
    Failed,
    Stopped,
}

/// Public severity for a bounded MCP runtime log record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum McpLogLevel {
    Debug,
    Info,
    Notice,
    Warning,
    Error,
    Critical,
    Alert,
    Emergency,
}

/// One redacted MCP runtime log record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpLogEntry {
    pub timestamp: String,
    pub level: McpLogLevel,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub data: Option<Value>,
}

/// Stable runtime error shown for one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct McpStatusError {
    pub code: String,
    pub message: String,
}

/// Public server identity returned by the MCP initialize handshake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpServerIdentity {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Current runtime status for one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpServerStatus {
    pub name: String,
    pub scope: McpConfigScope,
    pub state: McpServerState,
    pub fingerprint: String,
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub capabilities: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_info: Option<McpServerIdentity>,
    #[ts(type = "number")]
    pub tool_count: usize,
    #[ts(type = "number")]
    pub resource_count: usize,
    #[ts(type = "number")]
    pub prompt_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<McpStatusError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_retry_at: Option<String>,
    pub updated_at: String,
    pub logs: Vec<McpLogEntry>,
}

/// Tool metadata discovered from one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpToolSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[ts(type = "unknown")]
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub annotations: Option<Value>,
}

/// Resource or resource-template metadata discovered from one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpResourceSummary {
    pub server: String,
    pub uri: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<bool>,
}

/// One argument accepted by a discovered MCP prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpPromptArgument {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

/// Prompt metadata discovered from one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpPromptSummary {
    pub server: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<McpPromptArgument>>,
}

/// Fully discovered catalog for one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpServerCatalog {
    pub server: String,
    pub tools: Vec<McpToolSummary>,
    pub resources: Vec<McpResourceSummary>,
    pub prompts: Vec<McpPromptSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub stale: bool,
}

/// Bounded content returned after an explicit MCP resource read.
///
/// The `contents` value preserves the MCP `text` or `blob` variants without
/// exposing protocol metadata across the desktop boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct McpResourceReadResult {
    pub server: String,
    #[ts(type = "unknown")]
    pub contents: Value,
}

/// Bounded messages returned after an explicit MCP prompt request.
///
/// The `messages` value preserves all protocol content block variants while
/// protocol metadata is removed at the desktop boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct McpPromptGetResult {
    pub server: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[ts(type = "unknown")]
    pub messages: Value,
}

/// MCP settings payload returned by list and configuration mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct McpListPayload {
    pub configs: Vec<ScopedMcpServerConfig>,
    pub statuses: Vec<McpServerStatus>,
}

#[cfg(test)]
mod tests {
    use super::{McpServerConfig, McpTransport};

    #[test]
    fn legacy_stdio_configuration_infers_the_missing_transport() {
        let config = serde_json::from_str::<McpServerConfig>(r#"{"command":"node"}"#)
            .expect("legacy fixture must deserialize");

        assert_eq!(config.transport, McpTransport::Stdio);
    }

    #[test]
    fn normalized_configuration_serializes_the_transport_under_type() {
        let config = serde_json::from_str::<McpServerConfig>(
            r#"{"type":"http","url":"https://example.test/mcp"}"#,
        )
        .expect("remote fixture must deserialize");
        let value = serde_json::to_value(config).expect("fixture must serialize");

        assert_eq!(value["type"], "http");
    }
}
