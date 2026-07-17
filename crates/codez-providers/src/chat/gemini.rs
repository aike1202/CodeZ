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
use crate::chat::common::{
    response_error, saturating_u32, send_request, strip_system_prompt_marker,
};

pub struct GeminiProvider {
    client: Client,
}

impl Default for GeminiProvider {
    fn default() -> Self {
        Self {
            client: Client::new(),
        }
    }
}

impl GeminiProvider {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl ChatProvider for GeminiProvider {
    async fn stream_chat(
        &self,
        config: ChatRequestConfig,
        cancellation: CancellationToken,
    ) -> Result<BoxStream<'static, Result<ChatStreamEvent, ChatProviderError>>, ChatProviderError>
    {
        let url = gemini_endpoint(
            &config.base_url,
            &config.model,
            config.api_key.expose_secret(),
        )?;
        let payload = build_request_payload(&config)?;
        info!(provider = "gemini", model = %config.model, "starting provider stream");

        let response = send_request(self.client.post(url).json(&payload), &cancellation).await?;
        if !response.status().is_success() {
            return Err(response_error(response, &cancellation).await);
        }

        let mut source = response.bytes_stream().eventsource();
        let output = async_stream::stream! {
            let mut state = GeminiStreamState::default();
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

fn gemini_endpoint(base_url: &str, model: &str, api_key: &str) -> Result<Url, ChatProviderError> {
    if model.trim().is_empty() {
        return Err(ChatProviderError::Parse(
            "Gemini model identifier is empty".to_string(),
        ));
    }
    let mut url = Url::parse(base_url)
        .map_err(|_| ChatProviderError::Parse("invalid Gemini base URL".to_string()))?;
    if url.cannot_be_a_base() || url.query().is_some() || url.fragment().is_some() {
        return Err(ChatProviderError::Parse(
            "invalid Gemini base URL".to_string(),
        ));
    }

    let current_path = url.path().trim_end_matches('/').to_string();
    if current_path.contains("/models/") {
        if !current_path.ends_with(":streamGenerateContent") {
            url.set_path(&format!("{current_path}:streamGenerateContent"));
        }
    } else {
        let mut root = current_path.as_str();
        for suffix in ["/v1/chat/completions", "/v1beta", "/v1"] {
            if let Some(value) = root.strip_suffix(suffix) {
                root = value;
                break;
            }
        }
        url.set_path(&format!("{root}/v1beta/models/"));
        let mut segments = url
            .path_segments_mut()
            .map_err(|()| ChatProviderError::Parse("invalid Gemini base URL".to_string()))?;
        segments.pop_if_empty();
        segments.push(&format!("{}:streamGenerateContent", model.trim()));
    }
    url.query_pairs_mut()
        .append_pair("key", api_key)
        .append_pair("alt", "sse");
    Ok(url)
}

fn build_request_payload(config: &ChatRequestConfig) -> Result<Value, ChatProviderError> {
    let (system_parts, contents) = build_gemini_contents(&config.messages)?;
    let mut body = Map::new();
    if !system_parts.is_empty() {
        body.insert(
            "systemInstruction".to_string(),
            json!({ "parts": system_parts }),
        );
    }
    body.insert("contents".to_string(), Value::Array(contents));
    if let Some(tools) = config.tools.as_ref().filter(|tools| !tools.is_empty()) {
        body.insert(
            "tools".to_string(),
            json!([{
                "functionDeclarations": tools.iter().map(|tool| json!({
                    "name": tool.function.name,
                    "description": tool.function.description,
                    "parameters": tool.function.parameters
                })).collect::<Vec<_>>()
            }]),
        );
    }

    let mut generation = gemini_thinking_config(config);
    if let Some(limit) = config.max_output_tokens.filter(|limit| *limit > 0) {
        generation.insert("maxOutputTokens".to_string(), Value::from(limit));
    }
    if !generation.is_empty() {
        body.insert("generationConfig".to_string(), Value::Object(generation));
    }
    Ok(Value::Object(body))
}

fn build_gemini_contents(
    messages: &[ChatMessage],
) -> Result<(Vec<Value>, Vec<Value>), ChatProviderError> {
    let mut system_parts = Vec::new();
    let mut contents = Vec::new();
    let mut pending_assistant_summary: Option<String> = None;
    let mut index = 0;
    while index < messages.len() {
        let message = &messages[index];
        if !message.images.is_empty() && message.role != Role::User {
            return Err(ChatProviderError::Parse(
                "only user messages can include image input".to_string(),
            ));
        }
        match message.role {
            Role::System => {
                if let Some(content) = message.content.as_deref() {
                    system_parts.push(json!({ "text": strip_system_prompt_marker(content) }));
                }
                index += 1;
            }
            Role::User => {
                let mut parts = message
                    .content
                    .as_deref()
                    .filter(|content| !content.trim().is_empty())
                    .map(|content| vec![json!({ "text": content })])
                    .unwrap_or_default();
                parts.extend(message.images.iter().map(|image| {
                    json!({
                        "inlineData": {
                            "mimeType": image.mime_type,
                            "data": BASE64_STANDARD.encode(&image.bytes)
                        }
                    })
                }));
                push_or_merge_content(&mut contents, "user", parts);
                index += 1;
            }
            Role::Assistant => {
                let mut parts = Vec::new();
                let has_tool_calls = message
                    .tool_calls
                    .as_ref()
                    .is_some_and(|calls| !calls.is_empty());
                if let Some(content) = message
                    .content
                    .as_deref()
                    .filter(|content| !content.is_empty())
                {
                    if has_tool_calls {
                        pending_assistant_summary = Some(content.to_string());
                    } else {
                        parts.push(json!({ "text": content }));
                    }
                }
                for call in message.tool_calls.as_deref().unwrap_or_default() {
                    let arguments = serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| json!({}));
                    let mut part = json!({
                        "functionCall": {
                            "name": call.function.name,
                            "args": arguments
                        }
                    });
                    if let Some(signature) = &call.thought_signature {
                        part["thoughtSignature"] = Value::String(signature.clone());
                    }
                    parts.push(part);
                }
                push_or_merge_content(&mut contents, "model", parts);
                index += 1;
            }
            Role::Tool => {
                let mut parts = Vec::new();
                while index < messages.len() && messages[index].role == Role::Tool {
                    let tool = &messages[index];
                    let name = tool.name.as_deref().ok_or_else(|| {
                        ChatProviderError::Parse(
                            "Gemini tool result is missing its name".to_string(),
                        )
                    })?;
                    parts.push(json!({
                        "functionResponse": {
                            "name": name,
                            "response": { "result": tool.content.as_deref().unwrap_or("") }
                        }
                    }));
                    index += 1;
                }
                push_or_merge_content(&mut contents, "user", parts);
                if index < messages.len() && messages[index].role == Role::User {
                    push_or_merge_content(
                        &mut contents,
                        "model",
                        vec![json!({
                            "text": pending_assistant_summary.take().unwrap_or_else(|| "OK".to_string())
                        })],
                    );
                }
            }
        }
    }
    Ok((system_parts, contents))
}

fn push_or_merge_content(contents: &mut Vec<Value>, role: &str, parts: Vec<Value>) {
    if parts.is_empty() {
        return;
    }
    if let Some(existing_parts) = contents
        .last_mut()
        .filter(|content| content.get("role").and_then(Value::as_str) == Some(role))
        .and_then(|content| content.get_mut("parts"))
        .and_then(Value::as_array_mut)
    {
        existing_parts.extend(parts);
    } else {
        contents.push(json!({ "role": role, "parts": parts }));
    }
}

fn gemini_thinking_config(config: &ChatRequestConfig) -> Map<String, Value> {
    let Some(thinking) = config
        .thinking
        .as_ref()
        .filter(|thinking| thinking.enabled && thinking.mode != ThinkingMode::None)
    else {
        return Map::new();
    };
    let mut thinking_config = Map::new();
    thinking_config.insert("includeThoughts".to_string(), Value::Bool(true));
    if config.model.to_ascii_lowercase().contains("gemini-3") {
        if let Some(level) = thinking.effort.and_then(thinking_level_name) {
            thinking_config.insert(
                "thinkingLevel".to_string(),
                Value::String(level.to_string()),
            );
        }
    } else {
        thinking_config.insert(
            "thinkingBudget".to_string(),
            thinking
                .budget_tokens
                .map(Value::from)
                .unwrap_or_else(|| Value::from(-1)),
        );
    }
    Map::from_iter([("thinkingConfig".to_string(), Value::Object(thinking_config))])
}

fn thinking_level_name(effort: ThinkingEffort) -> Option<&'static str> {
    match effort {
        ThinkingEffort::Minimal => Some("minimal"),
        ThinkingEffort::Low => Some("low"),
        ThinkingEffort::Medium => Some("medium"),
        ThinkingEffort::High | ThinkingEffort::Xhigh | ThinkingEffort::Max => Some("high"),
        ThinkingEffort::Auto | ThinkingEffort::None | ThinkingEffort::Custom => None,
    }
}

#[derive(Default)]
struct GeminiStreamState {
    full_content: String,
    stop_reason: Option<AgentStopReason>,
    next_tool_index: u64,
    finished: bool,
}

impl GeminiStreamState {
    fn handle_data(
        &mut self,
        data: &str,
    ) -> Result<(Vec<ChatStreamEvent>, bool), ChatProviderError> {
        if data.trim() == "[DONE]" {
            return Ok((self.finish(), true));
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| ChatProviderError::Parse(error.to_string()))?;
        let responses = match value {
            Value::Array(values) => values,
            value => vec![value],
        };
        let mut events = Vec::new();
        for response in responses {
            events.extend(self.handle_response(&response));
        }
        Ok((events, false))
    }

    fn handle_response(&mut self, value: &Value) -> Vec<ChatStreamEvent> {
        let mut events = Vec::new();
        if let Some(usage) = value.get("usageMetadata") {
            events.push(ChatStreamEvent::Usage(gemini_usage(usage)));
        }
        let Some(candidate) = value
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
        else {
            return events;
        };
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            self.stop_reason = Some(map_gemini_stop_reason(reason));
        }
        let Some(parts) = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
        else {
            return events;
        };
        for part in parts {
            let signature = part
                .get("thoughtSignature")
                .or_else(|| part.get("thought_signature"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    events.push(ChatStreamEvent::Chunk {
                        delta: String::new(),
                        reasoning_delta: Some(text.to_string()),
                        tool_calls: None,
                        thought_signature: signature.clone(),
                    });
                } else {
                    self.full_content.push_str(text);
                    events.push(ChatStreamEvent::Chunk {
                        delta: text.to_string(),
                        reasoning_delta: None,
                        tool_calls: None,
                        thought_signature: signature.clone(),
                    });
                }
            }
            if let Some(function) = part.get("functionCall") {
                let id = function
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        let id = format!("gemini-call-{}", self.next_tool_index);
                        self.next_tool_index = self.next_tool_index.saturating_add(1);
                        id
                    });
                let arguments = function.get("args").cloned().unwrap_or_else(|| json!({}));
                events.push(ChatStreamEvent::Chunk {
                    delta: String::new(),
                    reasoning_delta: None,
                    tool_calls: Some(vec![ToolCall {
                        id,
                        r#type: "function".to_string(),
                        function: ToolCallFunction {
                            name: function
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            arguments: arguments.to_string(),
                        },
                        thought_signature: signature.clone(),
                    }]),
                    thought_signature: signature.clone(),
                });
            } else if signature.is_some() && part.get("text").is_none() {
                events.push(ChatStreamEvent::Chunk {
                    delta: String::new(),
                    reasoning_delta: None,
                    tool_calls: None,
                    thought_signature: signature,
                });
            }
        }
        events
    }

    fn finish(&mut self) -> Vec<ChatStreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        vec![ChatStreamEvent::Done {
            full_content: self.full_content.clone(),
            stop_reason: self.stop_reason.clone(),
            tx_id: None,
        }]
    }
}

fn gemini_usage(value: &Value) -> ProviderTokenUsage {
    ProviderTokenUsage {
        input_tokens: saturating_u32(
            value
                .get("promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        ),
        output_tokens: saturating_u32(
            value
                .get("candidatesTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        ),
        reasoning_tokens: value
            .get("thoughtsTokenCount")
            .and_then(Value::as_u64)
            .map(saturating_u32),
        total_tokens: value
            .get("totalTokenCount")
            .and_then(Value::as_u64)
            .map(saturating_u32),
    }
}

fn map_gemini_stop_reason(reason: &str) -> AgentStopReason {
    match reason {
        "STOP" => AgentStopReason::Stop,
        "MAX_TOKENS" => AgentStopReason::Length,
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => {
            AgentStopReason::ContentFilter
        }
        "MALFORMED_FUNCTION_CALL" | "UNEXPECTED_TOOL_CALL" => AgentStopReason::Error,
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

    use super::{ChatRequestConfig, GeminiStreamState, build_request_payload, gemini_endpoint};
    use crate::chat::protocol_fixture;

    fn fixture_config() -> ChatRequestConfig {
        ChatRequestConfig {
            base_url: "https://provider.example/v1".to_string(),
            api_key: SecretValue::new("fixture-secret").expect("fixture secret is valid"),
            model: "model-fixture".to_string(),
            api_format: Some("gemini".to_string()),
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
                    name: "Grep".to_string(),
                    description: "Search text".to_string(),
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
    fn request_matches_the_frozen_gemini_protocol_shape() {
        let config = fixture_config();
        let frozen = protocol_fixture("gemini");
        let payload = build_request_payload(&config).expect("fixture payload is valid");
        assert_eq!(
            gemini_endpoint(
                &config.base_url,
                &config.model,
                config.api_key.expose_secret()
            )
            .expect("fixture endpoint is valid")
            .as_str(),
            "https://provider.example/v1beta/models/model-fixture:streamGenerateContent?key=fixture-secret&alt=sse"
        );
        assert_eq!(payload, frozen["expectedRequest"]["body"]);
        assert_eq!(
            payload,
            json!({
                "systemInstruction": { "parts": [{ "text": "You are a fixture." }] },
                "contents": [{ "role": "user", "parts": [{ "text": "use a tool" }] }],
                "tools": [{
                    "functionDeclarations": [{
                        "name": "Grep",
                        "description": "Search text",
                        "parameters": {
                            "type": "object",
                            "properties": { "pattern": { "type": "string" } },
                            "required": ["pattern"],
                            "additionalProperties": false
                        }
                    }]
                }],
                "generationConfig": { "maxOutputTokens": 256 }
            })
        );
    }

    #[test]
    fn request_encodes_verified_user_images_as_gemini_inline_data() {
        let mut config = fixture_config();
        config.tools = None;
        config.messages = vec![ChatMessage {
            role: Role::User,
            content: Some("inspect this image".to_string()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: vec![ChatImage {
                mime_type: "image/jpeg".to_string(),
                bytes: vec![1, 2, 3],
            }],
        }];

        let payload = build_request_payload(&config).expect("image payload is valid");

        assert_eq!(
            payload["contents"][0]["parts"],
            json!([
                { "text": "inspect this image" },
                { "inlineData": { "mimeType": "image/jpeg", "data": "AQID" } }
            ])
        );
    }

    #[test]
    fn stream_state_emits_function_call_signature_usage_and_done() {
        let mut state = GeminiStreamState::default();
        let events = state
            .handle_data(
                r#"{"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":5,"thoughtsTokenCount":2,"totalTokenCount":19},"candidates":[{"content":{"parts":[{"functionCall":{"name":"Grep","args":{"pattern":"needle"}},"thoughtSignature":"sig"}]},"finishReason":"STOP"}]}"#,
            )
            .expect("fixture event parses")
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
            .expect("function call is emitted");
        assert_eq!(call.function.name, "Grep");
        assert_eq!(call.thought_signature.as_deref(), Some("sig"));
        assert_eq!(
            serde_json::from_str::<Value>(&call.function.arguments)
                .expect("function arguments are JSON"),
            json!({ "pattern": "needle" })
        );
        assert!(events.iter().any(|event| matches!(
            event,
            ChatStreamEvent::Usage(usage)
                if usage.input_tokens == 12
                    && usage.output_tokens == 5
                    && usage.reasoning_tokens == Some(2)
                    && usage.total_tokens == Some(19)
        )));

        assert!(
            state
                .handle_data("[DONE]")
                .expect("done parses")
                .0
                .iter()
                .any(|event| matches!(
                    event,
                    ChatStreamEvent::Done {
                        stop_reason: Some(AgentStopReason::Stop),
                        ..
                    }
                ))
        );
    }
}
