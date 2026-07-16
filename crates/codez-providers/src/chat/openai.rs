use super::{ChatProvider, ChatProviderError, ChatRequestConfig};
use codez_contracts::chat::ChatStreamEvent;
use futures_util::stream::{BoxStream, StreamExt};
use tokio_util::sync::CancellationToken;
use reqwest::Client;
use eventsource_stream::Eventsource;
use tracing::{error, info};

pub struct OpenAiProvider {
    client: Client,
}

impl OpenAiProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

#[async_trait::async_trait]
impl ChatProvider for OpenAiProvider {
    async fn stream_chat(
        &self,
        config: ChatRequestConfig,
        signal: CancellationToken,
    ) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError> {
        let url = format!("{}/chat/completions", config.base_url);
        
        info!("[OpenAiProvider] Requesting {}", url);
        
        // Temporarily empty payload
        let payload = serde_json::json!({});
        
        let response = self.client.post(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| ChatProviderError::Network(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            
            if status == 401 || status == 403 {
                return Err(ChatProviderError::Auth(format!("{} - {}", status, body)));
            } else if status == 429 {
                return Err(ChatProviderError::RateLimit(format!("{} - {}", status, body)));
            } else if status == 404 {
                return Err(ChatProviderError::NotFound(format!("{} - {}", status, body)));
            }
            return Err(ChatProviderError::Unknown(format!("{} - {}", status, body)));
        }

        let mut stream = response.bytes_stream().eventsource();

        let output_stream = async_stream::stream! {
            while let Some(event) = stream.next().await {
                if signal.is_cancelled() {
                    break;
                }

                match event {
                    Ok(event) => {
                        let data = event.data;
                        if data == "[DONE]" {
                            break;
                        }
                        
                        match serde_json::from_str::<serde_json::Value>(&data) {
                            Ok(json) => {
                                // Extract usage if present
                                if let Some(usage) = json.get("usage") {
                                    if !usage.is_null() {
                                        let input = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                        let output = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                        let total = usage.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                        yield Ok(ChatStreamEvent::Usage(codez_contracts::provider::ProviderTokenUsage {
                                            input_tokens: input,
                                            output_tokens: output,
                                            reasoning_tokens: None,
                                            total_tokens: Some(total),
                                        }));
                                    }
                                }

                                if let Some(choices) = json.get("choices").and_then(|c| c.as_array()) {
                                    if let Some(choice) = choices.first() {
                                        let delta = choice.get("delta");
                                        let finish_reason = choice.get("finish_reason").and_then(|v| v.as_str());
                                        
                                        if let Some(delta) = delta {
                                            let content = delta.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                            let reasoning = delta.get("reasoning_content").and_then(|v| v.as_str()).map(|s| s.to_string());
                                            
                                            // Handle tool calls
                                            let mut parsed_tool_calls = None;
                                            if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                                                let mut tc_list = Vec::new();
                                                for tc in tcs {
                                                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                    let fn_obj = tc.get("function");
                                                    let name = fn_obj.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                    let args = fn_obj.and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                    tc_list.push(codez_contracts::chat::ToolCall {
                                                        id,
                                                        r#type: "function".to_string(),
                                                        function: codez_contracts::chat::ToolCallFunction {
                                                            name,
                                                            arguments: args,
                                                        },
                                                        thought_signature: None,
                                                    });
                                                }
                                                if !tc_list.is_empty() {
                                                    parsed_tool_calls = Some(tc_list);
                                                }
                                            }

                                            if !content.is_empty() || reasoning.is_some() || parsed_tool_calls.is_some() {
                                                yield Ok(ChatStreamEvent::Chunk {
                                                    delta: content,
                                                    reasoning_delta: reasoning,
                                                    tool_calls: parsed_tool_calls,
                                                    thought_signature: None,
                                                });
                                            }
                                        }

                                        if let Some(reason) = finish_reason {
                                            if !reason.is_empty() && reason != "null" {
                                                let stop_reason = match reason {
                                                    "stop" => codez_contracts::chat::AgentStopReason::Stop,
                                                    "length" => codez_contracts::chat::AgentStopReason::Length,
                                                    "tool_calls" => codez_contracts::chat::AgentStopReason::ToolCalls,
                                                    "content_filter" => codez_contracts::chat::AgentStopReason::ContentFilter,
                                                    _ => codez_contracts::chat::AgentStopReason::Unknown,
                                                };
                                                // Normally DONE event is emitted here, but the client might wait for `data: [DONE]`.
                                                // We can emit a Done here, or just let it finish.
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                yield Err(ChatProviderError::Parse(e.to_string()));
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
