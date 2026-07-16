use super::{ChatProvider, ChatProviderError, ChatRequestConfig};
use codez_contracts::chat::ChatStreamEvent;
use futures_util::stream::{BoxStream, StreamExt};
use tokio_util::sync::CancellationToken;
use reqwest::Client;
use eventsource_stream::Eventsource;
use tracing::{error, info};

pub struct AnthropicProvider {
    client: Client,
}

impl AnthropicProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

#[async_trait::async_trait]
impl ChatProvider for AnthropicProvider {
    async fn stream_chat(
        &self,
        config: ChatRequestConfig,
        signal: CancellationToken,
    ) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError> {
        let url = format!("{}/messages", config.base_url);
        
        info!("[AnthropicProvider] Requesting {}", url);
        
        let payload = serde_json::json!({});
        
        let response = self.client.post(&url)
            .header("x-api-key", config.api_key)
            .header("anthropic-version", "2023-06-01")
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

        let mut stream = response.bytes_stream().eventsource();

        let output_stream = async_stream::stream! {
            let mut current_tool_call_id = String::new();
            let mut current_tool_call_name = String::new();
            let mut current_tool_call_args = String::new();

            while let Some(event) = stream.next().await {
                if signal.is_cancelled() {
                    break;
                }

                match event {
                    Ok(event) => {
                        let event_type = event.event;
                        let data = event.data;
                        
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
                            if event_type == "message_start" {
                                if let Some(usage) = json.get("message").and_then(|m| m.get("usage")) {
                                    let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                    let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                    yield Ok(ChatStreamEvent::Usage(codez_contracts::provider::ProviderTokenUsage {
                                        input_tokens: input,
                                        output_tokens: output,
                                        reasoning_tokens: None,
                                        total_tokens: Some(input + output),
                                    }));
                                }
                            } else if event_type == "message_delta" {
                                if let Some(usage) = json.get("usage") {
                                    let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                    let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                    yield Ok(ChatStreamEvent::Usage(codez_contracts::provider::ProviderTokenUsage {
                                        input_tokens: input,
                                        output_tokens: output,
                                        reasoning_tokens: None,
                                        total_tokens: Some(input + output),
                                    }));
                                }
                            } else if event_type == "content_block_start" {
                                if let Some(cb) = json.get("content_block") {
                                    if cb.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                        current_tool_call_id = cb.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        current_tool_call_name = cb.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        current_tool_call_args = String::new();
                                    }
                                }
                            } else if event_type == "content_block_delta" {
                                if let Some(delta) = json.get("delta") {
                                    let typ = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    let mut text_delta = String::new();
                                    let mut reasoning_delta = None;
                                    
                                    if typ == "text_delta" {
                                        text_delta = delta.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    } else if typ == "reasoning_delta" {
                                        reasoning_delta = Some(delta.get("reasoning").and_then(|v| v.as_str()).unwrap_or("").to_string());
                                    } else if typ == "input_json_delta" {
                                        current_tool_call_args.push_str(delta.get("partial_json").and_then(|v| v.as_str()).unwrap_or(""));
                                    }

                                    if !text_delta.is_empty() || reasoning_delta.is_some() {
                                        yield Ok(ChatStreamEvent::Chunk {
                                            delta: text_delta,
                                            reasoning_delta,
                                            tool_calls: None,
                                            thought_signature: None,
                                        });
                                    }
                                }
                            } else if event_type == "content_block_stop" {
                                if !current_tool_call_id.is_empty() {
                                    let tc = codez_contracts::chat::ToolCall {
                                        id: current_tool_call_id.clone(),
                                        r#type: "function".to_string(),
                                        function: codez_contracts::chat::ToolCallFunction {
                                            name: current_tool_call_name.clone(),
                                            arguments: current_tool_call_args.clone(),
                                        },
                                        thought_signature: None,
                                    };
                                    yield Ok(ChatStreamEvent::Chunk {
                                        delta: String::new(),
                                        reasoning_delta: None,
                                        tool_calls: Some(vec![tc]),
                                        thought_signature: None,
                                    });
                                    current_tool_call_id.clear();
                                    current_tool_call_name.clear();
                                    current_tool_call_args.clear();
                                }
                            }
                        }
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
