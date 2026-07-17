use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use codez_core::provider::{
    AgentStopReason, ChatMessage, ChatStreamEvent, ProviderTokenUsage, Role, ThinkingEffort,
    ThinkingMode, ToolCall, ToolCallFunction,
};
use eventsource_stream::Eventsource;
use futures_util::stream::{BoxStream, StreamExt};
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use tracing::info;

use super::{ChatProvider, ChatProviderError, ChatRequestConfig};
use crate::chat::common::{
    response_error, saturating_u32, send_request, strip_system_prompt_marker,
};

pub struct OpenAiProvider {
    client: Client,
}

impl Default for OpenAiProvider {
    fn default() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl OpenAiProvider {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl ChatProvider for OpenAiProvider {
    async fn stream_chat(
        &self,
        config: ChatRequestConfig,
        cancellation: CancellationToken,
    ) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError>
    {
        let url = openai_endpoint(&config.base_url)?;
        let payload = build_request_payload(&config)?;
        info!(provider = "openai", model = %config.model, "starting provider stream");

        let request = self
            .client
            .post(url)
            .bearer_auth(config.api_key.expose_secret())
            .json(&payload);
        let response = send_request(request, &cancellation).await?;
        if !response.status().is_success() {
            return Err(response_error(response, &cancellation).await);
        }

        let mut source = response.bytes_stream().eventsource();
        let output = async_stream::stream! {
            let mut state = OpenAiStreamState::default();
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
                    Some(Ok(event)) => match state.handle_data(&event.data) {
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

fn openai_endpoint(base_url: &str) -> Result<Url, ChatProviderError> {
    let mut url = Url::parse(base_url)
        .map_err(|_| ChatProviderError::Parse("invalid OpenAI base URL".to_string()))?;
    if url.cannot_be_a_base() || url.query().is_some() || url.fragment().is_some() {
        return Err(ChatProviderError::Parse(
            "invalid OpenAI base URL".to_string(),
        ));
    }
    if !url
        .path()
        .trim_end_matches('/')
        .ends_with("/chat/completions")
    {
        let path = format!("{}/chat/completions", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }
    Ok(url)
}

#[derive(Serialize)]
struct OpenAiToolCall<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    r#type: &'a str,
    function: &'a ToolCallFunction,
    #[serde(skip_serializing_if = "Option::is_none", rename = "thought_signature")]
    thought_signature: Option<&'a str>,
}

fn openai_message_value(message: &ChatMessage) -> Result<Value, ChatProviderError> {
    if !message.images.is_empty() && message.role != Role::User {
        return Err(ChatProviderError::Parse(
            "only user messages can include image input".to_string(),
        ));
    }

    let mut value = Map::new();
    value.insert(
        "role".to_string(),
        serde_json::to_value(message.role)
            .map_err(|error| ChatProviderError::Parse(error.to_string()))?,
    );
    if message.images.is_empty() {
        if let Some(content) = message.content.as_deref() {
            let content = if message.role == Role::System {
                strip_system_prompt_marker(content)
            } else {
                content.to_string()
            };
            value.insert("content".to_string(), Value::String(content));
        }
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
                "type": "image_url",
                "image_url": {
                    "url": format!(
                        "data:{};base64,{}",
                        image.mime_type,
                        BASE64_STANDARD.encode(&image.bytes)
                    )
                }
            }));
        }
        value.insert("content".to_string(), Value::Array(content));
    }
    if let Some(calls) = message.tool_calls.as_ref() {
        let calls = calls
            .iter()
            .map(|call| OpenAiToolCall {
                id: &call.id,
                r#type: &call.r#type,
                function: &call.function,
                thought_signature: call.thought_signature.as_deref(),
            })
            .collect::<Vec<_>>();
        value.insert(
            "tool_calls".to_string(),
            serde_json::to_value(calls)
                .map_err(|error| ChatProviderError::Parse(error.to_string()))?,
        );
    }
    if let Some(tool_call_id) = message.tool_call_id.as_deref() {
        value.insert(
            "tool_call_id".to_string(),
            Value::String(tool_call_id.to_string()),
        );
    }
    if let Some(name) = message.name.as_deref() {
        value.insert("name".to_string(), Value::String(name.to_string()));
    }
    Ok(Value::Object(value))
}

fn build_request_payload(config: &ChatRequestConfig) -> Result<Value, ChatProviderError> {
    let messages = config
        .messages
        .iter()
        .map(openai_message_value)
        .collect::<Result<Vec<_>, _>>()?;

    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(config.model.clone()));
    body.insert("messages".to_string(), Value::Array(messages));
    if let Some(tools) = config.tools.as_ref().filter(|tools| !tools.is_empty()) {
        body.insert(
            "tools".to_string(),
            serde_json::to_value(tools)
                .map_err(|error| ChatProviderError::Parse(error.to_string()))?,
        );
    }
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert(
        "stream_options".to_string(),
        json!({ "include_usage": true }),
    );
    if let Some(limit) = config.max_output_tokens.filter(|limit| *limit > 0) {
        body.insert(
            openai_output_limit_key(&config.model, &config.base_url).to_string(),
            Value::from(limit),
        );
    }
    body.extend(openai_thinking_payload(config));
    Ok(Value::Object(body))
}

fn openai_output_limit_key(model: &str, base_url: &str) -> &'static str {
    let official_host = Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| {
            host == "openai.com"
                || host.ends_with(".openai.com")
                || host.ends_with(".openai.azure.com")
        });
    let normalized = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase();
    let requires_modern_limit = normalized.starts_with("gpt-5")
        || ["o1", "o3", "o4"]
            .iter()
            .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix}-")));
    if official_host && requires_modern_limit {
        "max_completion_tokens"
    } else {
        "max_tokens"
    }
}

fn openai_thinking_payload(config: &ChatRequestConfig) -> Map<String, Value> {
    let Some(thinking) = config
        .thinking
        .as_ref()
        .filter(|thinking| thinking.enabled && thinking.mode != ThinkingMode::None)
    else {
        return Map::new();
    };
    let mut payload = Map::new();
    let effort = thinking.effort.and_then(thinking_effort_name);

    match thinking.mode {
        ThinkingMode::Deepseek => {
            payload.insert("thinking".to_string(), json!({ "type": "enabled" }));
            if let Some(effort) = effort {
                payload.insert(
                    "reasoning_effort".to_string(),
                    Value::String(effort.to_string()),
                );
            }
        }
        ThinkingMode::Qwen => {
            payload.insert("enable_thinking".to_string(), Value::Bool(true));
            if let Some(tokens) = thinking.budget_tokens.filter(|tokens| *tokens > 0) {
                payload.insert("thinking_budget".to_string(), Value::from(tokens));
            }
        }
        ThinkingMode::Openrouter => {
            let reasoning =
                if let Some(tokens) = thinking.budget_tokens.filter(|tokens| *tokens > 0) {
                    json!({ "max_tokens": tokens })
                } else if let Some(effort) = effort {
                    json!({ "effort": effort })
                } else {
                    json!({ "enabled": true })
                };
            payload.insert("reasoning".to_string(), reasoning);
        }
        ThinkingMode::Auto
        | ThinkingMode::Openai
        | ThinkingMode::Gemini
        | ThinkingMode::Grok
        | ThinkingMode::Anthropic => {
            if let Some(effort) = effort {
                payload.insert(
                    "reasoning_effort".to_string(),
                    Value::String(effort.to_string()),
                );
            }
        }
        ThinkingMode::None => {}
    }
    payload
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
struct OpenAiToolAccumulator {
    id: String,
    name: String,
    arguments: String,
    thought_signature: Option<String>,
}

#[derive(Default)]
struct OpenAiStreamState {
    full_content: String,
    stop_reason: Option<AgentStopReason>,
    tools: BTreeMap<u64, OpenAiToolAccumulator>,
    think_tags: ThinkTagParser,
    finished: bool,
}

impl OpenAiStreamState {
    fn handle_data(
        &mut self,
        data: &str,
    ) -> Result<(Vec<ChatStreamEvent>, bool), ChatProviderError> {
        if data.trim() == "[DONE]" {
            return Ok((self.finish(), true));
        }

        let value: Value = serde_json::from_str(data)
            .map_err(|error| ChatProviderError::Parse(error.to_string()))?;
        let mut events = Vec::new();
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            events.push(ChatStreamEvent::Usage(openai_usage(usage)));
        }

        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Ok((events, false));
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.stop_reason = Some(map_openai_stop_reason(reason));
        }

        let delta = choice.get("delta").unwrap_or(&Value::Null);
        self.accumulate_tool_calls(delta);
        let content = delta.get("content").and_then(Value::as_str).unwrap_or("");
        let explicit_reasoning = [
            "reasoning_content",
            "reasoning",
            "thinking",
            "thinking_content",
        ]
        .iter()
        .find_map(|key| delta.get(*key).and_then(Value::as_str));
        let (text, reasoning) = if let Some(reasoning) = explicit_reasoning {
            (content.to_string(), reasoning.to_string())
        } else {
            self.think_tags.push(content)
        };
        self.full_content.push_str(&text);

        let thought_signature = extract_thought_signature(&value, delta);
        if let Some(signature) = &thought_signature {
            for tool in self.tools.values_mut() {
                if tool.thought_signature.is_none() {
                    tool.thought_signature = Some(signature.clone());
                }
            }
        }
        if !text.is_empty() || !reasoning.is_empty() || thought_signature.is_some() {
            events.push(ChatStreamEvent::Chunk {
                delta: text,
                reasoning_delta: (!reasoning.is_empty()).then_some(reasoning),
                tool_calls: None,
                thought_signature,
            });
        }

        if choice
            .get("finish_reason")
            .is_some_and(|reason| !reason.is_null())
        {
            events.extend(self.flush_tools());
        }
        Ok((events, false))
    }

    fn accumulate_tool_calls(&mut self, delta: &Value) {
        let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) else {
            return;
        };
        for tool_call in tool_calls {
            let index = tool_call.get("index").and_then(Value::as_u64).unwrap_or(0);
            let accumulator = self.tools.entry(index).or_default();
            if let Some(id) = tool_call.get("id").and_then(Value::as_str) {
                accumulator.id = id.to_string();
            }
            if let Some(kind) = tool_call.get("type").and_then(Value::as_str) {
                if kind != "function" {
                    continue;
                }
            }
            if let Some(function) = tool_call.get("function") {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    accumulator.name.push_str(name);
                }
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                    accumulator.arguments.push_str(arguments);
                }
                if let Some(signature) = function.get("thought_signature").and_then(Value::as_str) {
                    accumulator.thought_signature = Some(signature.to_string());
                }
            }
            if let Some(signature) = tool_call.get("thought_signature").and_then(Value::as_str) {
                accumulator.thought_signature = Some(signature.to_string());
            }
        }
    }

    fn flush_tools(&mut self) -> Vec<ChatStreamEvent> {
        if self.tools.is_empty() {
            return Vec::new();
        }
        let tool_calls = std::mem::take(&mut self.tools)
            .into_values()
            .filter(|tool| !tool.id.is_empty() || !tool.name.is_empty())
            .map(|tool| ToolCall {
                id: tool.id,
                r#type: "function".to_string(),
                function: ToolCallFunction {
                    name: tool.name,
                    arguments: tool.arguments,
                },
                thought_signature: tool.thought_signature,
            })
            .collect::<Vec<_>>();
        if tool_calls.is_empty() {
            Vec::new()
        } else {
            vec![ChatStreamEvent::Chunk {
                delta: String::new(),
                reasoning_delta: None,
                tool_calls: Some(tool_calls),
                thought_signature: None,
            }]
        }
    }

    fn finish(&mut self) -> Vec<ChatStreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut events = Vec::new();
        let (text, reasoning) = self.think_tags.flush();
        self.full_content.push_str(&text);
        if !text.is_empty() || !reasoning.is_empty() {
            events.push(ChatStreamEvent::Chunk {
                delta: text,
                reasoning_delta: (!reasoning.is_empty()).then_some(reasoning),
                tool_calls: None,
                thought_signature: None,
            });
        }
        events.extend(self.flush_tools());
        events.push(ChatStreamEvent::Done {
            full_content: self.full_content.clone(),
            stop_reason: self.stop_reason.clone(),
            tx_id: None,
        });
        events
    }
}

fn openai_usage(value: &Value) -> ProviderTokenUsage {
    let completion = value
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = value
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64);
    ProviderTokenUsage {
        input_tokens: saturating_u32(
            value
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        ),
        output_tokens: saturating_u32(completion.saturating_sub(reasoning.unwrap_or(0))),
        reasoning_tokens: reasoning.map(saturating_u32),
        total_tokens: value
            .get("total_tokens")
            .and_then(Value::as_u64)
            .map(saturating_u32),
    }
}

fn map_openai_stop_reason(reason: &str) -> AgentStopReason {
    match reason {
        "stop" => AgentStopReason::Stop,
        "length" => AgentStopReason::Length,
        "tool_calls" | "function_call" => AgentStopReason::ToolCalls,
        "content_filter" => AgentStopReason::ContentFilter,
        _ => AgentStopReason::Unknown,
    }
}

fn extract_thought_signature(value: &Value, delta: &Value) -> Option<String> {
    [
        delta.pointer("/extra_content/google/thought_signature"),
        delta.pointer("/provider_specific_fields/thought_signature"),
        delta.get("thought_signature"),
        value.pointer("/google/thought_signature"),
        value.get("thought_signature"),
        value.get("thoughtSignature"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(str::to_string)
}

#[derive(Default)]
struct ThinkTagParser {
    in_reasoning: bool,
    buffer: String,
}

impl ThinkTagParser {
    fn push(&mut self, input: &str) -> (String, String) {
        self.buffer.push_str(input);
        let mut text = String::new();
        let mut reasoning = String::new();
        loop {
            let tag = if self.in_reasoning {
                "</think>"
            } else {
                "<think>"
            };
            if let Some(index) = self.buffer.find(tag) {
                let prefix = self.buffer[..index].to_string();
                if self.in_reasoning {
                    reasoning.push_str(&prefix);
                } else {
                    text.push_str(&prefix);
                }
                self.buffer.drain(..index + tag.len());
                self.in_reasoning = !self.in_reasoning;
                continue;
            }

            let retained = longest_tag_prefix_suffix(&self.buffer, tag);
            let emit_until = self.buffer.len().saturating_sub(retained);
            let emitted = self.buffer[..emit_until].to_string();
            if self.in_reasoning {
                reasoning.push_str(&emitted);
            } else {
                text.push_str(&emitted);
            }
            self.buffer.drain(..emit_until);
            break;
        }
        (text, reasoning)
    }

    fn flush(&mut self) -> (String, String) {
        let remaining = std::mem::take(&mut self.buffer);
        if self.in_reasoning {
            (String::new(), remaining)
        } else {
            (remaining, String::new())
        }
    }
}

fn longest_tag_prefix_suffix(value: &str, tag: &str) -> usize {
    (1..tag.len())
        .rev()
        .find(|length| value.ends_with(&tag[..*length]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use codez_core::provider::{
        AgentStopReason, ChatImage, ChatMessage, ChatStreamEvent, Role, SecretValue,
        ThinkingConfig, ThinkingMode, ToolCall, ToolCallFunction, ToolDefinition,
        ToolDefinitionFunction,
    };
    use serde_json::{Value, json};

    use super::{
        ChatRequestConfig, OpenAiStreamState, ThinkTagParser, build_request_payload,
        openai_endpoint,
    };
    use crate::chat::protocol_fixture;

    fn fixture_config() -> ChatRequestConfig {
        ChatRequestConfig {
            base_url: "https://provider.example/v1".to_string(),
            api_key: SecretValue::new("fixture-secret").expect("fixture secret is valid"),
            model: "model-fixture".to_string(),
            api_format: Some("openai".to_string()),
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
                    name: "Read".to_string(),
                    description: "Read files".to_string(),
                    parameters: json!({
                        "type": "object",
                        "properties": { "files": { "type": "array" } },
                        "required": ["files"],
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
    fn request_matches_the_frozen_openai_protocol_shape() {
        let config = fixture_config();
        let frozen = protocol_fixture("openai");
        let payload = build_request_payload(&config).expect("fixture payload is valid");

        assert_eq!(
            openai_endpoint(&config.base_url)
                .expect("fixture endpoint is valid")
                .as_str(),
            "https://provider.example/v1/chat/completions"
        );
        assert_eq!(payload, frozen["expectedRequest"]["body"]);
        assert_eq!(
            payload,
            json!({
                "model": "model-fixture",
                "messages": [
                    { "role": "system", "content": "You are a fixture." },
                    { "role": "user", "content": "use a tool" }
                ],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "Read",
                        "description": "Read files",
                        "parameters": {
                            "type": "object",
                            "properties": { "files": { "type": "array" } },
                            "required": ["files"],
                            "additionalProperties": false
                        }
                    }
                }],
                "stream": true,
                "stream_options": { "include_usage": true },
                "max_tokens": 256
            })
        );
    }

    #[test]
    fn request_uses_openai_tool_continuation_field_names() {
        let mut config = fixture_config();
        config.tools = None;
        config.messages = vec![
            ChatMessage {
                role: Role::Assistant,
                content: Some("I will inspect the file.".to_string()),
                tool_calls: Some(vec![ToolCall {
                    id: "call-read".to_string(),
                    r#type: "function".to_string(),
                    function: ToolCallFunction {
                        name: "Read".to_string(),
                        arguments: r#"{"files":[{"file_path":"src/lib.rs"}]}"#.to_string(),
                    },
                    thought_signature: Some("provider-signature".to_string()),
                }]),
                tool_call_id: None,
                name: None,
                images: Vec::new(),
            },
            ChatMessage {
                role: Role::Tool,
                content: Some("file contents".to_string()),
                tool_calls: None,
                tool_call_id: Some("call-read".to_string()),
                name: Some("Read".to_string()),
                images: Vec::new(),
            },
        ];

        let payload = build_request_payload(&config).expect("tool continuation payload is valid");
        let messages = payload["messages"]
            .as_array()
            .expect("OpenAI payload contains messages");

        assert_eq!(
            messages[0]["tool_calls"][0]["thought_signature"],
            "provider-signature"
        );
        assert_eq!(messages[1]["tool_call_id"], "call-read");
        assert!(messages[0].get("toolCalls").is_none());
        assert!(messages[1].get("toolCallId").is_none());
    }

    #[test]
    fn request_encodes_verified_user_images_as_openai_data_urls() {
        let mut config = fixture_config();
        config.tools = None;
        config.messages = vec![ChatMessage {
            role: Role::User,
            content: Some("inspect this image".to_string()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: vec![ChatImage {
                mime_type: "image/png".to_string(),
                bytes: vec![1, 2, 3],
            }],
        }];

        let payload = build_request_payload(&config).expect("image payload is valid");

        assert_eq!(
            payload["messages"][0]["content"],
            json!([
                { "type": "text", "text": "inspect this image" },
                {
                    "type": "image_url",
                    "image_url": { "url": "data:image/png;base64,AQID" }
                }
            ])
        );
    }

    #[test]
    fn stream_state_assembles_indexed_tool_call_deltas_and_terminal_reason() {
        let mut state = OpenAiStreamState::default();
        let first = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"openai-call","function":{"name":"Read","arguments":"{\"files\":"}}]}}]}"#;
        let second = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[{\"file_path\":\"a.ts\"}]}"}}]},"finish_reason":"tool_calls"}]}"#;

        assert!(
            state
                .handle_data(first)
                .expect("first delta parses")
                .0
                .is_empty()
        );
        let events = state.handle_data(second).expect("second delta parses").0;
        let calls = events.iter().find_map(|event| match event {
            ChatStreamEvent::Chunk {
                tool_calls: Some(calls),
                ..
            } => Some(calls),
            _ => None,
        });
        let call = calls
            .and_then(|calls| calls.first())
            .expect("assembled tool call is emitted");
        assert_eq!(call.id, "openai-call");
        assert_eq!(call.function.name, "Read");
        assert_eq!(
            serde_json::from_str::<Value>(&call.function.arguments)
                .expect("assembled arguments are JSON"),
            json!({ "files": [{ "file_path": "a.ts" }] })
        );

        let done = state.handle_data("[DONE]").expect("done parses").0;
        assert!(done.iter().any(|event| matches!(
            event,
            ChatStreamEvent::Done {
                stop_reason: Some(AgentStopReason::ToolCalls),
                ..
            }
        )));
    }

    #[test]
    fn think_tags_are_preserved_across_chunk_boundaries() {
        let mut parser = ThinkTagParser::default();
        assert_eq!(
            parser.push("answer<th"),
            ("answer".to_string(), String::new())
        );
        assert_eq!(
            parser.push("ink>reason</thi"),
            (String::new(), "reason".to_string())
        );
        assert_eq!(parser.push("nk>tail"), ("tail".to_string(), String::new()));
    }
}
