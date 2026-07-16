use codez_core::provider::{
    ChatMessage, ChatStreamEvent, SecretValue, ThinkingConfig, ToolDefinition,
};
use futures_util::stream::BoxStream;
use tokio_util::sync::CancellationToken;

pub mod anthropic;
pub mod gemini;
pub mod openai;

mod common;

#[derive(Debug, thiserror::Error)]
pub enum ChatProviderError {
    #[error("Authentication failed: {0}")]
    Auth(String),
    #[error("Context overflow: {0}")]
    ContextOverflow(String),
    #[error("Rate limit: {0}")]
    RateLimit(String),
    #[error("API Not Found: {0}")]
    NotFound(String),
    #[error("Network error: {0}")]
    Network(String),
    #[error("Stream parsing error: {0}")]
    Parse(String),
    #[error("Provider request was cancelled")]
    Cancelled,
    #[error("Unknown error: {0}")]
    Unknown(String),
}

pub struct ChatRequestConfig {
    pub base_url: String,
    pub api_key: SecretValue,
    pub model: String,
    pub api_format: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub tools: Option<Vec<ToolDefinition>>,
    pub thinking: Option<ThinkingConfig>,
    pub max_output_tokens: Option<u32>,
    pub resolve_image: bool,
}

#[async_trait::async_trait]
pub trait ChatProvider: Send + Sync {
    async fn stream_chat(
        &self,
        config: ChatRequestConfig,
        signal: CancellationToken,
    ) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError>;
}

#[cfg(test)]
fn protocol_fixture(provider: &str) -> serde_json::Value {
    let document: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../src/tests/fixtures/migration/provider-protocol-golden.json"
    ))
    .expect("frozen provider protocol fixture must be valid JSON");
    document["fixtures"]
        .as_array()
        .and_then(|fixtures| {
            fixtures
                .iter()
                .find(|fixture| fixture["provider"].as_str() == Some(provider))
        })
        .cloned()
        .expect("requested provider must exist in the frozen protocol fixture")
}
