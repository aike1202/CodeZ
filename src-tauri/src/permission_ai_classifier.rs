use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use codez_core::{
    CancellationToken,
    provider::{ApiFormat, ChatMessage, ChatStreamEvent, Role, ThinkingConfig, ThinkingMode},
};
use codez_providers::{
    chat::{
        ChatProvider, ChatRequestConfig, anthropic::AnthropicProvider, gemini::GeminiProvider,
        openai::OpenAiProvider,
    },
    service::{ProviderService, ResolvedProviderChatConfig},
};
use codez_runtime::permission::ai_classifier::{
    PERMISSION_CLASSIFIER_SYSTEM_PROMPT, PermissionAiClassifier, PermissionClassificationRequest,
    PermissionClassifierVerdict,
};
use futures_util::{StreamExt, stream::BoxStream};

const CLASSIFIER_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CLASSIFIER_REQUEST_BYTES: usize = 64 * 1024;
const MAX_CLASSIFIER_OUTPUT_BYTES: usize = 8 * 1024;
const MAX_CLASSIFIER_OUTPUT_TOKENS: u32 = 512;

pub(crate) struct ProviderPermissionAiClassifier {
    providers: Arc<ProviderService>,
}

impl ProviderPermissionAiClassifier {
    #[must_use]
    pub(crate) fn new(providers: Arc<ProviderService>) -> Self {
        Self { providers }
    }
}

#[async_trait]
impl PermissionAiClassifier for ProviderPermissionAiClassifier {
    async fn classify(
        &self,
        request: &PermissionClassificationRequest,
    ) -> PermissionClassifierVerdict {
        let resolved = match self
            .providers
            .resolve_chat_config(request.provider_id.as_deref(), request.model.as_deref())
            .await
        {
            Ok(resolved) => resolved,
            Err(_) => return PermissionClassifierVerdict::Unavailable,
        };
        let request_json = match serde_json::to_string(request) {
            Ok(request_json) if request_json.len() <= MAX_CLASSIFIER_REQUEST_BYTES => request_json,
            Err(_) => return PermissionClassifierVerdict::Unavailable,
            Ok(_) => return PermissionClassifierVerdict::Unavailable,
        };
        let cancellation = CancellationToken::new();
        let operation = classify_with_provider(resolved, request_json, cancellation.clone());
        match tokio::time::timeout(CLASSIFIER_TIMEOUT, operation).await {
            Ok(verdict) => verdict,
            Err(_) => {
                cancellation.cancel();
                PermissionClassifierVerdict::Unavailable
            }
        }
    }
}

async fn classify_with_provider(
    resolved: ResolvedProviderChatConfig,
    request_json: String,
    cancellation: CancellationToken,
) -> PermissionClassifierVerdict {
    let system_prompt = format!(
        "{PERMISSION_CLASSIFIER_SYSTEM_PROMPT} The only accepted outputs are exactly one JSON object matching either {{\"verdict\":\"allow\",\"category\":\"local_read|local_build|local_edit|local_mutation|local_delete|network|publish|deploy|remote_mutation|privilege|unknown\",\"confidencePercent\":0,\"reason\":\"...\"}} or {{\"verdict\":\"block\",\"reason\":\"...\"}}. Never emit Markdown, tool calls, or additional fields."
    );
    let messages = vec![
        ChatMessage {
            role: Role::System,
            content: Some(system_prompt),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: Vec::new(),
        },
        ChatMessage {
            role: Role::User,
            content: Some(request_json),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            images: Vec::new(),
        },
    ];
    let mut stream = match open_classifier_stream(resolved, messages, cancellation).await {
        Ok(stream) => stream,
        Err(()) => return PermissionClassifierVerdict::Unavailable,
    };
    let mut content = String::new();
    while let Some(event) = stream.next().await {
        match event {
            Ok(ChatStreamEvent::Chunk {
                delta, tool_calls, ..
            }) => {
                if tool_calls.is_some_and(|calls| !calls.is_empty())
                    || content.len().saturating_add(delta.len()) > MAX_CLASSIFIER_OUTPUT_BYTES
                {
                    return PermissionClassifierVerdict::Unavailable;
                }
                content.push_str(&delta);
            }
            Ok(ChatStreamEvent::Done { full_content, .. }) => {
                if !full_content.is_empty() {
                    content = full_content;
                }
                return parse_classifier_response(&content);
            }
            Ok(ChatStreamEvent::Usage(_)) => {}
            Err(_) => return PermissionClassifierVerdict::Unavailable,
        }
    }
    PermissionClassifierVerdict::Unavailable
}

async fn open_classifier_stream(
    resolved: ResolvedProviderChatConfig,
    messages: Vec<ChatMessage>,
    cancellation: CancellationToken,
) -> Result<BoxStream<'static, Result<ChatStreamEvent, codez_providers::chat::ChatProviderError>>, ()>
{
    let api_format = resolved.api_format;
    let config = ChatRequestConfig {
        base_url: resolved.base_url,
        api_key: resolved.api_key,
        model: resolved.model.name,
        api_format: Some(api_format_name(api_format).to_string()),
        messages,
        tools: None,
        thinking: Some(ThinkingConfig {
            enabled: false,
            mode: ThinkingMode::None,
            effort: None,
            budget_tokens: None,
        }),
        max_output_tokens: Some(MAX_CLASSIFIER_OUTPUT_TOKENS),
        resolve_image: false,
    };
    let stream = match api_format {
        ApiFormat::Openai => {
            OpenAiProvider::new()
                .stream_chat(config, cancellation)
                .await
        }
        ApiFormat::Anthropic => {
            AnthropicProvider::new()
                .stream_chat(config, cancellation)
                .await
        }
        ApiFormat::Gemini => {
            GeminiProvider::new()
                .stream_chat(config, cancellation)
                .await
        }
    };
    stream.map_err(|_| ())
}

fn parse_classifier_response(content: &str) -> PermissionClassifierVerdict {
    if content.len() > MAX_CLASSIFIER_OUTPUT_BYTES {
        return PermissionClassifierVerdict::Unavailable;
    }
    serde_json::from_str(content.trim()).unwrap_or(PermissionClassifierVerdict::Unavailable)
}

const fn api_format_name(format: ApiFormat) -> &'static str {
    match format {
        ApiFormat::Openai => "openai",
        ApiFormat::Anthropic => "anthropic",
        ApiFormat::Gemini => "gemini",
    }
}

#[cfg(test)]
mod tests {
    use codez_runtime::permission::ai_classifier::{
        PermissionClassificationRequest, PermissionClassifierVerdict,
    };

    use super::{MAX_CLASSIFIER_REQUEST_BYTES, parse_classifier_response};

    #[test]
    fn response_parser_accepts_only_plain_strict_json() {
        let accepted = parse_classifier_response(
            r#"{"verdict":"allow","category":"local_build","confidencePercent":95,"reason":"local verification"}"#,
        );
        let fenced = parse_classifier_response(
            "```json\n{\"verdict\":\"block\",\"reason\":\"uncertain\"}\n```",
        );
        assert!(accepted.can_auto_allow());
        assert_eq!(fenced, PermissionClassifierVerdict::Unavailable);
    }

    #[test]
    fn response_parser_rejects_unknown_fields() {
        let response = parse_classifier_response(
            r#"{"verdict":"allow","category":"local_read","confidencePercent":99,"reason":"read","command":"run it"}"#,
        );
        assert_eq!(response, PermissionClassifierVerdict::Unavailable);
    }

    #[test]
    fn serialized_request_limit_covers_the_complete_classifier_payload() {
        let request = PermissionClassificationRequest {
            provider_id: Some("provider-1".to_string()),
            model: Some("model-1".to_string()),
            tool_name: "PowerShell".to_string(),
            shell: "powershell".to_string(),
            command: "x".repeat(MAX_CLASSIFIER_REQUEST_BYTES),
            operation: "custom-build".to_string(),
            workspace_root: "C:\\workspace".to_string(),
            cwd: "C:\\workspace".to_string(),
            session_id: Some("session-1".to_string()),
            agent_role: "main".to_string(),
            user_intent: None,
            project_markers: Vec::new(),
            project_instructions: Vec::new(),
        };
        let serialized = serde_json::to_string(&request).expect("request must serialize");
        assert!(serialized.len() > MAX_CLASSIFIER_REQUEST_BYTES);
    }
}
