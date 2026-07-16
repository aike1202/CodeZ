use std::{cmp, time::Duration};

use codez_core::redact_sensitive_text;
use futures_util::StreamExt;
use reqwest::{RequestBuilder, Response, StatusCode};
use tokio_util::sync::CancellationToken;

use super::ChatProviderError;

const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
pub(super) const PROMPT_DYNAMIC_BOUNDARY: &str = "<!-- codez:prompt-dynamic-boundary -->";

pub(super) async fn send_request(
    request: RequestBuilder,
    cancellation: &CancellationToken,
) -> Result<Response, ChatProviderError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(ChatProviderError::Cancelled),
        response = request.send() => response.map_err(network_error),
    }
}

pub(super) fn network_error(error: reqwest::Error) -> ChatProviderError {
    ChatProviderError::Network(redact_sensitive_text(&error.to_string()))
}

pub(super) async fn response_error(
    response: Response,
    cancellation: &CancellationToken,
) -> ChatProviderError {
    let status = response.status();
    let body = tokio::select! {
        biased;
        () = cancellation.cancelled() => return ChatProviderError::Cancelled,
        result = tokio::time::timeout(
            Duration::from_secs(5),
            read_bounded_error_body(response),
        ) => result.unwrap_or_default(),
    };
    classify_http_error(status, &body)
}

async fn read_bounded_error_body(response: Response) -> String {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        let Ok(bytes) = next else {
            break;
        };
        let remaining = MAX_ERROR_BODY_BYTES.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        let take = cmp::min(remaining, bytes.len());
        body.extend_from_slice(&bytes[..take]);
        if take < bytes.len() {
            break;
        }
    }
    redact_sensitive_text(String::from_utf8_lossy(&body).as_ref())
}

fn classify_http_error(status: StatusCode, body: &str) -> ChatProviderError {
    let body = redact_sensitive_text(body);
    let message = if body.trim().is_empty() {
        status.to_string()
    } else {
        format!("{status}: {body}")
    };
    let normalized = body.to_ascii_lowercase();

    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        ChatProviderError::Auth(message)
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        ChatProviderError::RateLimit(message)
    } else if status == StatusCode::NOT_FOUND {
        ChatProviderError::NotFound(message)
    } else if matches!(
        status,
        StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE
    ) && [
        "context length",
        "context_length",
        "context window",
        "maximum context",
        "too many tokens",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        ChatProviderError::ContextOverflow(message)
    } else {
        ChatProviderError::Unknown(message)
    }
}

pub(super) fn split_system_prompt(prompt: &str) -> (String, String) {
    match prompt.find(PROMPT_DYNAMIC_BOUNDARY) {
        Some(index) => (
            prompt[..index].trim().to_string(),
            prompt[index + PROMPT_DYNAMIC_BOUNDARY.len()..]
                .trim()
                .to_string(),
        ),
        None => (prompt.trim().to_string(), String::new()),
    }
}

pub(super) fn strip_system_prompt_marker(prompt: &str) -> String {
    let (stable, dynamic) = split_system_prompt(prompt);
    [stable, dynamic]
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn saturating_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use reqwest::StatusCode;

    use super::{classify_http_error, split_system_prompt, strip_system_prompt_marker};

    #[test]
    fn prompt_cache_boundary_is_removed_without_losing_sections() {
        let prompt = "stable\n<!-- codez:prompt-dynamic-boundary -->\ndynamic";

        assert_eq!(
            split_system_prompt(prompt),
            ("stable".to_string(), "dynamic".to_string())
        );
        assert_eq!(strip_system_prompt_marker(prompt), "stable\n\ndynamic");
    }

    #[test]
    fn provider_error_bodies_are_redacted_before_display() {
        let error = classify_http_error(
            StatusCode::UNAUTHORIZED,
            "request failed: api_key=secret-value",
        );
        let rendered = error.to_string();

        assert!(!rendered.contains("secret-value"));
        assert!(rendered.contains("[REDACTED]"));
    }
}
