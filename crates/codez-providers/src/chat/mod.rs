use codez_contracts::chat::{ChatMessage, ChatStreamEvent, ToolDefinition};
use codez_contracts::provider::ThinkingConfig;
use futures_util::stream::BoxStream;
use tokio_util::sync::CancellationToken;

pub mod openai;
pub mod anthropic;
pub mod gemini;

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
    #[error("Unknown error: {0}")]
    Unknown(String),
}

#[derive(Debug, Clone)]
pub struct ChatRequestConfig {
    pub base_url: String,
    pub api_key: String,
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
