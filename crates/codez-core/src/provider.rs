use std::{fmt, future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::PortFuture;

const MAX_CREDENTIAL_KEY_BYTES: usize = 192;
const CREDENTIAL_PREFIX: &str = "provider-api-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingMode {
    Auto,
    None,
    Openai,
    Deepseek,
    Qwen,
    Anthropic,
    Gemini,
    Grok,
    Openrouter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingEffort {
    Auto,
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingConfig {
    pub enabled: bool,
    pub mode: ThinkingMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<ThinkingEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiFormat {
    Openai,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub max_context_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_counts_against_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_vision: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_format: Option<ApiFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<ThinkingEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_budget_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_format: Option<ApiFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    pub models: Vec<ModelConfig>,
    pub thinking: ThinkingConfig,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_format: Option<ApiFormat>,
    pub api_key_configured: bool,
    pub models: Vec<ModelConfig>,
    pub thinking: ThinkingConfig,
    pub enabled: bool,
    pub created_at: String,
}

pub struct ProviderFormData {
    pub name: String,
    pub base_url: String,
    pub api_format: Option<ApiFormat>,
    pub api_key: Option<SecretValue>,
    pub models: Vec<ModelConfig>,
    pub thinking: ThinkingConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionTestResult {
    pub success: bool,
    pub message: String,
    pub models: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersFile {
    pub providers: Vec<ProviderConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStopReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Verified image content used only while building a provider request.
    ///
    /// The desktop runtime rehydrates these bytes from the session attachment
    /// store. They are deliberately excluded from persisted and generic wire
    /// representations.
    #[serde(skip, default)]
    pub images: Vec<ChatImage>,
}

/// Verified image content available to a provider request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatImage {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub r#type: String,
    pub function: ToolCallFunction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub r#type: String,
    pub function: ToolDefinitionFunction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinitionFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CredentialId {
    provider_id: String,
}

impl CredentialId {
    pub fn new(provider_id: impl Into<String>) -> Result<Self, CredentialError> {
        let provider_id = provider_id.into();
        if provider_id.is_empty()
            || provider_id.len() > MAX_CREDENTIAL_KEY_BYTES
            || !provider_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(CredentialError::InvalidIdentifier);
        }
        Ok(Self { provider_id })
    }

    pub fn parse(value: &str) -> Result<Self, CredentialError> {
        let (prefix, provider_id) = value
            .split_once(':')
            .ok_or(CredentialError::InvalidIdentifier)?;
        if prefix != CREDENTIAL_PREFIX {
            return Err(CredentialError::InvalidIdentifier);
        }
        Self::new(provider_id)
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn account_name(&self) -> String {
        format!("{CREDENTIAL_PREFIX}:{}", self.provider_id)
    }
}

impl fmt::Display for CredentialId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.account_name())
    }
}

pub struct SecretValue(Zeroizing<String>);

impl SecretValue {
    pub fn new(value: impl Into<String>) -> Result<Self, CredentialError> {
        let value = value.into();
        if value.is_empty() {
            return Err(CredentialError::EmptySecret);
        }
        Ok(Self(Zeroizing::new(value)))
    }

    #[must_use]
    pub fn expose_secret(&self) -> &str {
        self.0.as_str()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CredentialError {
    #[error("credential identifier is invalid")]
    InvalidIdentifier,
    #[error("credential secret must not be empty")]
    EmptySecret,
    #[error("credential was not found: {id}")]
    NotFound { id: CredentialId },
    #[error("credential store denied access while attempting to {operation}")]
    AccessDenied { operation: &'static str },
    #[error("credential store is unavailable while attempting to {operation}")]
    Unavailable { operation: &'static str },
    #[error("stored credential is corrupt: {id}")]
    Corrupt { id: CredentialId },
    #[error("credential secret exceeds the platform length limit of {platform_limit}")]
    SecretTooLarge { platform_limit: u32 },
}

pub type CredentialFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, CredentialError>> + Send + 'a>>;

pub trait CredentialStore: Send + Sync {
    fn get(&self, id: CredentialId) -> CredentialFuture<'_, SecretValue>;
    fn set(&self, id: CredentialId, value: SecretValue) -> CredentialFuture<'_, ()>;
    fn delete(&self, id: CredentialId) -> CredentialFuture<'_, ()>;
}

pub trait ProviderRepository: Send + Sync {
    fn load(&self) -> PortFuture<'_, Option<ProvidersFile>>;
    fn save(&self, data: ProvidersFile) -> PortFuture<'_, ()>;
}
