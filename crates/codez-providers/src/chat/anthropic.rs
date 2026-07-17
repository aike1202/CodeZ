use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};

use codez_core::provider::{
    AgentStopReason, ChatMessage, ChatStreamEvent, ProviderTokenUsage, Role, ThinkingEffort,
    ThinkingMode, ToolCall, ToolCallFunction,
};
use eventsource_stream::Eventsource;
use futures_util::stream::{BoxStream, StreamExt};
use reqwest::{Client, Url};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use tracing::info;

use super::{ChatProvider, ChatProviderError, ChatRequestConfig};
use crate::chat::common::{response_error, saturating_u32, send_request, split_system_prompt};

pub struct AnthropicProvider {
    client: Client,
}

impl Default for AnthropicProvider {
    fn default() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl AnthropicProvider {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl ChatProvider for AnthropicProvider {
    async fn stream_chat(
        &self,
        config: ChatRequestConfig,
        cancellation: CancellationToken,
    ) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError>
    {
        let url = anthropic_endpoint(&config.base_url)?;
        let payload = build_request_payload(&config)?;
        info!(provider = "anthropic", model = %config.model, "starting provider stream");

        let request = self
            .client
            .post(url)
            .header("x-api-key", config.api_key.expose_secret())
            .header("anthropic-version", "2023-06-01")
            .json(&payload);
        let response = send_request(request, &cancellation).await?;
        if !response.status().is_success() {
            return Err(response_error(response, &cancellation).await);
        }

        let mut source = response.bytes_stream().eventsource();
        let output = async_stream::stream! {
            let mut state = AnthropicStreamState::default();
            loop {
                let next = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        for event in state.finish() {
                            yield Ok(event);
                        }
                        break;
                    }
                    event = source.next() => event,
                };
                match next {
                    Some(Ok(event)) => match state.handle_event(&event.event, &event.data) {
                        Ok((events, finished)) => {
                            for event in events {
                                yield Ok(event);
                            }
                            if finished {
                                break;
                            }
                        }
                        Err(error) => {
                            yield Err(error);
                            break;
                        }
                    },
                    Some(Err(error)) => {
                        yield Err(ChatProviderError::Parse(error.to_string()));
                        break;
                    }
                    None => {
                        for event in state.finish() {
                            yield Ok(event);
                        }
                        break;
                    }
                }
            }
        };
        Ok(Box::pin(output))
    }
}

fn anthropic_endpoint(base_url: &str) -> Result<Url, ChatProviderError> {
    let mut url = Url::parse(base_url)
        .map_err(|_| ChatProviderError::Parse("invalid Anthropic base URL".to_string()))?;
    if url.cannot_be_a_base() || url.query().is_some() || url.fragment().is_some() {
        return Err(ChatProviderError::Parse(
            "invalid Anthropic base URL".to_string(),
        ));
    }
    let path = url.path().trim_end_matches('/');
    if !path.ends_with("/v1/messages") {
        let prefix = path.strip_suffix("/v1").unwrap_or(path);
        url.set_path(&format!("{prefix}/v1/messages"));
    }
    Ok(url)
}

fn build_request_payload(config: &ChatRequestConfig) -> Result<Value, ChatProviderError> {
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(config.model.clone()));
    body.insert(
        "messages".to_string(),
        build_anthropic_messages(&config.messages)?,
    );
    body.insert("stream".to_string(), Value::Bool(true));

    let thinking = anthropic_thinking_payload(config);
    let reasoning_tokens = thinking
        .get("thinking")
        .and_then(|value| value.get("budget_tokens"))
        .and_then(Value::as_u64)
        .map(saturating_u32)
        .unwrap_or(0);
    let visible_tokens = config.max_output_tokens.unwrap_or(8_192).max(1);
    body.insert(
        "max_tokens".to_string(),
        Value::from(visible_tokens.saturating_add(reasoning_tokens)),
    );
    body.extend(thinking);

    let system_prompt = config
        .messages
        .iter()
        .filter(|message| message.role == Role::System)
        .filter_map(|message| message.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    let system = build_system_blocks(&system_prompt);
    if !system.is_empty() {
        body.insert("system".to_string(), Value::Array(system));
    }
    if let Some(tools) = build_anthropic_tools(config) {
        body.insert("tools".to_string(), Value::Array(tools));
    }
    Ok(Value::Object(body))
}

fn build_system_blocks(prompt: &str) -> Vec<Value> {
    let (stable, dynamic) = split_system_prompt(prompt);
    [stable, dynamic]
        .into_iter()
        .filter(|section| !section.is_empty())
        .map(|text| {
            json!({
                "type": "text",
                "text": text,
                "cache_control": { "type": "ephemeral" }
            })
        })
        .collect()
}

fn build_anthropic_tools(config: &ChatRequestConfig) -> Option<Vec<Value>> {
    let tools = config.tools.as_ref().filter(|tools| !tools.is_empty())?;
    let last = tools.len().saturating_sub(1);
    Some(
        tools
            .iter()
            .enumerate()
            .map(|(index, tool)| {
                let mut value = json!({
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "input_schema": tool.function.parameters
                });
                if index == last {
                    value["cache_control"] = json!({ "type": "ephemeral" });
                }
                value
            })
            .collect(),
    )
}

fn build_anthropic_messages(messages: &[ChatMessage]) -> Result<Value, ChatProviderError> {
    let mut output = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        let message = &messages[index];
        if !message.images.is_empty() && message.role != Role::User {
            return Err(ChatProviderError::Parse(
                "only user messages can include image input".to_string(),
            ));
        }
        match message.role {
            Role::System => index += 1,
            Role::User => {
                if message.images.is_empty() {
                    output.push(json!({
                        "role": "user",
                        "content": message.content.as_deref().unwrap_or("")
                    }));
                } else {
                    let mut content = Vec::with_capacity(message.images.len().saturating_add(1));
                    if let Some(text) = message
                        .content
                        .as_deref()
                        .filter(|text| !text.trim().is_empty())
                    {
                        content.push(json!({ "type": "text", "text": text }));
                    }
                    for image in &message.images {
                        content.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image.mime_type,
                                "data": BASE64_STANDARD.encode(&image.bytes)
                            }
                        }));
                    }
                    output.push(json!({ "role": "user", "content": content }));
                }
                index += 1;
            }
            Role::Assistant => {
                let mut content = Vec::new();
                if let Some(text) = message.content.as_deref().filter(|text| !text.is_empty()) {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for tool_call in message.tool_calls.as_deref().unwrap_or_default() {
                    let input = if tool_call.function.arguments.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&tool_call.function.arguments).map_err(|_| {
                            ChatProviderError::Parse(
                                "assistant tool call arguments are not valid JSON".to_string(),
                            )
                        })?
                    };
                    content.push(json!({
                        "type": "tool_use",
                        "id": tool_call.id,
                        "name": tool_call.function.name,
                        "input": input
                    }));
                }
                output.push(json!({ "role": "assistant", "content": content }));
                index += 1;
            }
            Role::Tool => {
                let mut results = Vec::new();
                while index < messages.len() && messages[index].role == Role::Tool {
                    let tool = &messages[index];
                    let tool_use_id = tool.tool_call_id.as_deref().ok_or_else(|| {
                        ChatProviderError::Parse(
                            "tool result is missing its tool call identifier".to_string(),
                        )
                    })?;
                    results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": tool.content.as_deref().unwrap_or("")
                    }));
                    index += 1;
                }
                output.push(json!({ "role": "user", "content": results }));
            }
        }
    }
    Ok(Value::Array(output))
}

fn anthropic_thinking_payload(config: &ChatRequestConfig) -> Map<String, Value> {
    let Some(thinking) = config
        .thinking
        .as_ref()
        .filter(|thinking| thinking.enabled && thinking.mode != ThinkingMode::None)
    else {
        return Map::new();
    };
    let mut output = Map::new();
    if is_adaptive_model(&config.model) {
        output.insert(
            "thinking".to_string(),
            json!({ "type": "adaptive", "display": "summarized" }),
        );
    } else if let Some(tokens) = thinking.budget_tokens.filter(|tokens| *tokens > 0) {
        output.insert(
            "thinking".to_string(),
            json!({ "type": "enabled", "budget_tokens": tokens.max(1_024) }),
        );
    }
    if let Some(effort) = thinking.effort.and_then(thinking_effort_name) {
        output.insert("output_config".to_string(), json!({ "effort": effort }));
    }
    output
}

fn is_adaptive_model(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    [
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-mythos-5",
        "claude-mythos-preview",
    ]
    .iter()
    .any(|candidate| model.contains(candidate))
}

fn thinking_effort_name(effort: ThinkingEffort) -> Option<&'static str> {
    match effort {
        ThinkingEffort::Minimal => Some("minimal"),
        ThinkingEffort::Low => Some("low"),
        ThinkingEffort::Medium => Some("medium"),
        ThinkingEffort::High => Some("high"),
        ThinkingEffort::Xhigh => Some("xhigh"),
        ThinkingEffort::Max => Some("max"),
        ThinkingEffort::Auto | ThinkingEffort::None | ThinkingEffort::Custom => None,
    }
}

#[derive(Default)]
struct AnthropicToolAccumulator {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct AnthropicStreamState {
    full_content: String,
    stop_reason: Option<AgentStopReason>,
    tools: BTreeMap<u64, AnthropicToolAccumulator>,
    finished: bool,
}

impl AnthropicStreamState {
    fn handle_event(
        &mut self,
        event_type: &str,
        data: &str,
    ) -> Result<(Vec<ChatStreamEvent>, bool), ChatProviderError> {
        if data.trim() == "[DONE]" {
            return Ok((self.finish(), true));
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| ChatProviderError::Parse(error.to_string()))?;
        let mut events = Vec::new();
        match event_type {
            "message_start" => {
                if let Some(usage) = value.pointer("/message/usage") {
                    events.push(ChatStreamEvent::Usage(anthropic_usage(usage)));
                }
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage") {
                    events.push(ChatStreamEvent::Usage(anthropic_usage(usage)));
                }
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(map_anthropic_stop_reason(reason));
                }
            }
            "content_block_start"
                if value.pointer("/content_block/type").and_then(Value::as_str)
                    == Some("tool_use") =>
            {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
                self.tools.insert(
                    index,
                    AnthropicToolAccumulator {
                        id: value
                            .pointer("/content_block/id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        name: value
                            .pointer("/content_block/name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        arguments: String::new(),
                    },
                );
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
                let delta = value.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                        self.full_content.push_str(text);
                        if !text.is_empty() {
                            events.push(ChatStreamEvent::Chunk {
                                delta: text.to_string(),
                                reasoning_delta: None,
                                tool_calls: None,
                                thought_signature: None,
                            });
                        }
                    }
                    "thinking_delta" | "reasoning_delta" => {
                        let reasoning = delta
                            .get("thinking")
                            .or_else(|| delta.get("reasoning"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if !reasoning.is_empty() {
                            events.push(ChatStreamEvent::Chunk {
                                delta: String::new(),
                                reasoning_delta: Some(reasoning.to_string()),
                                tool_calls: None,
                                thought_signature: None,
                            });
                        }
                    }
                    "input_json_delta" | "tool_use_input_delta" => {
                        if let Some(tool) = self.tools.get_mut(&index) {
                            tool.arguments.push_str(
                                delta
                                    .get("partial_json")
                                    .and_then(Value::as_str)
                                    .unwrap_or(""),
                            );
                        }
                    }
                    "signature_delta" => {
                        if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                            events.push(ChatStreamEvent::Chunk {
                                delta: String::new(),
                                reasoning_delta: None,
                                tool_calls: None,
                                thought_signature: Some(signature.to_string()),
                            });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
                events.extend(self.flush_tool(index));
            }
            "message_stop" => return Ok((self.finish(), true)),
            _ => {}
        }
        Ok((events, false))
    }

    fn flush_tool(&mut self, index: u64) -> Vec<ChatStreamEvent> {
        let Some(tool) = self.tools.remove(&index) else {
            return Vec::new();
        };
        if tool.id.is_empty() && tool.name.is_empty() {
            return Vec::new();
        }
        vec![ChatStreamEvent::Chunk {
            delta: String::new(),
            reasoning_delta: None,
            tool_calls: Some(vec![ToolCall {
                id: tool.id,
                r#type: "function".to_string(),
                function: ToolCallFunction {
                    name: tool.name,
                    arguments: tool.arguments,
                },
                thought_signature: None,
            }]),
            thought_signature: None,
        }]
    }

    fn finish(&mut self) -> Vec<ChatStreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let indexes = self.tools.keys().copied().collect::<Vec<_>>();
        let mut events = indexes
            .into_iter()
            .flat_map(|index| self.flush_tool(index))
            .collect::<Vec<_>>();
        events.push(ChatStreamEvent::Done {
            full_content: self.full_content.clone(),
            stop_reason: self.stop_reason.clone(),
            tx_id: None,
        });
        events
    }
}

fn anthropic_usage(value: &Value) -> ProviderTokenUsage {
    let input = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .filter_map(|key| value.get(*key).and_then(Value::as_u64))
    .fold(0_u64, u64::saturating_add);
    let output = value
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    ProviderTokenUsage {
        input_tokens: saturating_u32(input),
        output_tokens: saturating_u32(output),
        reasoning_tokens: None,
        total_tokens: Some(saturating_u32(input.saturating_add(output))),
    }
}

fn map_anthropic_stop_reason(reason: &str) -> AgentStopReason {
    match reason {
        "end_turn" | "stop_sequence" => AgentStopReason::Stop,
        "max_tokens" => AgentStopReason::Length,
        "tool_use" | "pause_turn" => AgentStopReason::ToolCalls,
        "refusal" | "safety" => AgentStopReason::ContentFilter,
        _ => AgentStopReason::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use codez_core::provider::{
        AgentStopReason, ChatImage, ChatMessage, ChatStreamEvent, Role, SecretValue,
        ThinkingConfig, ThinkingMode, ToolDefinition, ToolDefinitionFunction,
    };
    use serde_json::{Value, json};

    use super::{
        AnthropicStreamState, ChatRequestConfig, anthropic_endpoint, build_request_payload,
    };
    use crate::chat::protocol_fixture;

    fn fixture_config() -> ChatRequestConfig {
        ChatRequestConfig {
            base_url: "https://provider.example".to_string(),
            api_key: SecretValue::new("fixture-secret").expect("fixture secret is valid"),
            model: "model-fixture".to_string(),
            api_format: Some("anthropic".to_string()),
            messages: vec![
                ChatMessage {
                    role: Role::System,
                    content: Some("You are a fixture.".to_string()),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    images: Vec::new(),
                },
                ChatMessage {
                    role: Role::User,
                    content: Some("use a tool".to_string()),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    images: Vec::new(),
                },
            ],
            tools: Some(vec![ToolDefinition {
                r#type: "function".to_string(),
                function: ToolDefinitionFunction {
                    name: "Glob".to_string(),
                    description: "Find files".to_string(),
                    parameters: json!({
                        "type": "object",
                        "properties": { "pattern": { "type": "string" } },
                        "required": ["pattern"],
                        "additionalProperties": false
                    }),
                },
            }]),
            thinking: Some(ThinkingConfig {
                enabled: false,
                mode: ThinkingMode::None,
                effort: None,
                budget_tokens: None,
            }),
            max_output_tokens: Some(256),
            resolve_image: false,
        }
    }

    #[test]
    fn request_matches_the_frozen_anthropic_protocol_shape() {
        let config = fixture_config();
        let frozen = protocol_fixture("anthropic");
        let payload = build_request_payload(&config).expect("fixture payload is valid");
        assert_eq!(
            anthropic_endpoint(&config.base_url)
                .expect("fixture endpoint is valid")
                .as_str(),
            "https://provider.example/v1/messages"
        );
        assert_eq!(payload, frozen["expectedRequest"]["body"]);
        assert_eq!(
            payload,
            json!({
                "model": "model-fixture",
                "messages": [{ "role": "user", "content": "use a tool" }],
                "max_tokens": 256,
                "stream": true,
                "system": [{
                    "type": "text",
                    "text": "You are a fixture.",
                    "cache_control": { "type": "ephemeral" }
                }],
                "tools": [{
                    "name": "Glob",
                    "description": "Find files",
                    "input_schema": {
                        "type": "object",
                        "properties": { "pattern": { "type": "string" } },
                        "required": ["pattern"],
                        "additionalProperties": false
                    },
                    "cache_control": { "type": "ephemeral" }
                }]
            })
        );
    }

    #[test]
    fn request_encodes_verified_user_images_as_anthropic_source_blocks() {
        let mut config = fixture_config();
        config.tools = None;
        config.messages = vec![ChatMessage {
            role: Role::User,
            content: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: vec![ChatImage {
                mime_type: "image/webp".to_string(),
                bytes: vec![1, 2, 3],
            }],
        }];

        let payload = build_request_payload(&config).expect("image payload is valid");

        assert_eq!(
            payload["messages"][0]["content"],
            json!([{
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/webp",
                    "data": "AQID"
                }
            }])
        );
    }

    #[test]
    fn stream_state_assembles_tool_input_and_stop_reason() {
        let mut state = AnthropicStreamState::default();
        state
            .handle_event(
                "content_block_start",
                r#"{"index":0,"content_block":{"type":"tool_use","id":"anthropic-call","name":"Glob"}}"#,
            )
            .expect("tool start parses");
        state
            .handle_event(
                "content_block_delta",
                r#"{"index":0,"delta":{"type":"input_json_delta","partial_json":"{\"pattern\":\"**/*.ts\"}"}}"#,
            )
            .expect("tool delta parses");
        let events = state
            .handle_event("content_block_stop", r#"{"index":0}"#)
            .expect("tool stop parses")
            .0;
        let call = events
            .iter()
            .find_map(|event| match event {
                ChatStreamEvent::Chunk {
                    tool_calls: Some(calls),
                    ..
                } => calls.first(),
                _ => None,
            })
            .expect("tool call is emitted");
        assert_eq!(call.id, "anthropic-call");
        assert_eq!(call.function.name, "Glob");
        assert_eq!(
            serde_json::from_str::<Value>(&call.function.arguments)
                .expect("tool arguments are valid JSON"),
            json!({ "pattern": "**/*.ts" })
        );

        state
            .handle_event("message_delta", r#"{"delta":{"stop_reason":"tool_use"}}"#)
            .expect("message delta parses");
        assert!(state.finish().iter().any(|event| matches!(
            event,
            ChatStreamEvent::Done {
                stop_reason: Some(AgentStopReason::ToolCalls),
                ..
            }
        )));
    }
}
