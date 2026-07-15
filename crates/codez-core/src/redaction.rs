use std::{borrow::Cow, fmt, sync::OnceLock};

use regex::Regex;
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

const REDACTED: &str = "[REDACTED]";
const TEXT_PATTERNS: [(&str, &str); 6] = [
    (
        r"(?is)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----.*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
    ),
    (r#"(?i)((?:bearer|basic)\s+)[^\s,;"']+"#, "$1[REDACTED]"),
    (
        r"(?i)((?:cookie|set-cookie)\s*:\s*)[^\r\n]+",
        "$1[REDACTED]",
    ),
    (
        r#"(?i)((?:api[_-]?key|api[_-]?key[_-]?ref|authorization|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|credential|encrypted|private[_-]?key|secret|token)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)"#,
        "$1[REDACTED]",
    ),
    (
        r"(?i)([?&](?:key|api_key|access_token|refresh_token|id_token|client_secret|password|token|code|signature)=)[^&#\s]+",
        "$1[REDACTED]",
    ),
    (
        r"(?i)([a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s/]+(@)",
        "$1[REDACTED]$2",
    ),
];

type CompiledPatterns = Result<Vec<(Regex, &'static str)>, regex::Error>;
static COMPILED_PATTERNS: OnceLock<CompiledPatterns> = OnceLock::new();

fn compiled_patterns() -> &'static CompiledPatterns {
    COMPILED_PATTERNS.get_or_init(|| {
        TEXT_PATTERNS
            .into_iter()
            .map(|(pattern, replacement)| Regex::new(pattern).map(|regex| (regex, replacement)))
            .collect()
    })
}

/// Redacts common credential forms from unstructured diagnostic text.
#[must_use]
pub fn redact_sensitive_text(input: &str) -> String {
    let Ok(patterns) = compiled_patterns() else {
        // Failing closed is safer than emitting an unredacted diagnostic.
        return REDACTED.to_string();
    };
    let mut redacted = Zeroizing::new(input.to_owned());
    for (regex, replacement) in patterns {
        let next = match regex.replace_all(redacted.as_str(), *replacement) {
            Cow::Borrowed(_) => None,
            Cow::Owned(value) => Some(value),
        };
        if let Some(next) = next {
            redacted.zeroize();
            *redacted = next;
        }
    }
    std::mem::take(&mut *redacted)
}

/// Eagerly redacted diagnostic text that is safe for structured log fields.
///
/// The original owned buffer is cleared during construction. Both
/// [`std::fmt::Display`] and [`std::fmt::Debug`] expose only the redacted
/// representation.
pub struct RedactedText(String);

impl RedactedText {
    /// Consumes and redacts potentially sensitive diagnostic text.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        let value = Zeroizing::new(value.into());
        Self(redact_sensitive_text(value.as_str()))
    }

    /// Returns the already-redacted text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RedactedText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Debug for RedactedText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("RedactedText")
            .field(&self.0)
            .finish()
    }
}

/// Returns a redacted copy of a JSON value using key-aware recursive traversal.
#[must_use]
pub fn redact_sensitive_value(value: &Value) -> Value {
    let mut redacted = value.clone();
    redact_value_in_place(&mut redacted);
    redacted
}

fn redact_value_in_place(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, item) in object {
                if is_sensitive_key(key) {
                    *item = Value::String(REDACTED.to_string());
                } else {
                    redact_value_in_place(item);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value_in_place),
        Value::String(text) => *text = redact_sensitive_text(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized.contains("apikey")
        || normalized.contains("authorization")
        || normalized.contains("accesstoken")
        || normalized.contains("refreshtoken")
        || normalized.contains("idtoken")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("credential")
        || normalized.contains("privatekey")
        || matches!(normalized.as_str(), "token" | "cookie" | "setcookie")
        || normalized == "encrypted"
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{RedactedText, redact_sensitive_text, redact_sensitive_value};

    #[test]
    fn text_redaction_removes_common_credential_forms() {
        let redacted = redact_sensitive_text(
            "Authorization: Bearer token-123 apiKey=key-789 https://example.test?access_token=query-456\nCookie: session=cookie-123\npostgres://user:password-456@example.test/db\n-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----",
        );

        assert!(
            !redacted.contains("token-123")
                && !redacted.contains("key-789")
                && !redacted.contains("query-456")
                && !redacted.contains("cookie-123")
                && !redacted.contains("password-456")
                && !redacted.contains("private-key-body")
        );
    }

    #[test]
    fn json_redaction_recurses_through_sensitive_keys() {
        let value = json!({
            "provider": { "apiKey": "secret-key" },
            "servers": [{
                "access_token": "secret-token",
                "token": "generic-token",
                "cookie": "session-cookie",
                "name": "safe"
            }]
        });

        assert_eq!(
            redact_sensitive_value(&value),
            json!({
                "provider": { "apiKey": "[REDACTED]" },
                "servers": [{
                    "access_token": "[REDACTED]",
                    "token": "[REDACTED]",
                    "cookie": "[REDACTED]",
                    "name": "safe"
                }]
            })
        );
    }

    #[test]
    fn redacted_text_hides_credentials_from_display_and_debug() {
        let text = RedactedText::new(r#"OAuth failed: {"refresh_token":"refresh fixture value"}"#);

        let rendered = format!("{text} {text:?}");

        assert!(!rendered.contains("refresh fixture value"));
    }
}
