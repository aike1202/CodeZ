use super::{ChatProvider, ChatProviderError, ChatRequestConfig};
use codez_contracts::chat::ChatStreamEvent;
use futures_util::stream::{BoxStream, StreamExt};
use tokio_util::sync::CancellationToken;
use reqwest::Client;
use tracing::{error, info};

pub struct GeminiProvider {
    client: Client,
}

impl GeminiProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

#[async_trait::async_trait]
impl ChatProvider for GeminiProvider {
    async fn stream_chat(
        &self,
        config: ChatRequestConfig,
        signal: CancellationToken,
    ) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError> {
        let url = format!("{}/models/{}:streamGenerateContent?key={}", config.base_url, config.model, config.api_key);
        
        info!("[GeminiProvider] Requesting {}", config.base_url);
        
        let payload = serde_json::json!({});
        
        let response = self.client.post(&url)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| ChatProviderError::Network(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(ChatProviderError::Unknown(format!("{} - {}", status, body)));
        }

        // Gemini uses a JSON array stream, but sometimes it uses SSE if requested.
        // Assuming we handle raw bytes stream manually.
        let mut stream = response.bytes_stream();

        let output_stream = async_stream::stream! {
            while let Some(chunk) = stream.next().await {
                if signal.is_cancelled() {
                    break;
                }

                match chunk {
                    Ok(_bytes) => {
                        // TODO: handle gemini parsing
                    }
                    Err(e) => {
                        yield Err(ChatProviderError::Parse(e.to_string()));
                    }
                }
            }
        };

        Ok(Box::pin(output_stream))
    }
}
