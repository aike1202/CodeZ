use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

const REDACTED: &str = "[REDACTED]";
const TEXT_PATTERNS: [(&str, &str); 3] = [
    (r#"(?i)(bearer\s+)[^\s,;"']+"#, "$1[REDACTED]"),
    (
        r#"(?i)((?:api[_-]?key|api[_-]?key[_-]?ref|authorization|x-api-key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential|encrypted|secret)\s*[\"']?\s*[:=]\s*[\"']?)[^\"',\s&}]+"#,
        "$1[REDACTED]",
    ),
    (
        r"(?i)([?&](?:key|api_key|access_token|refresh_token|token|code)=)[^&#\s]+",
        "$1[REDACTED]",
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
    patterns
        .iter()
        .fold(input.to_owned(), |redacted, (regex, replacement)| {
            regex.replace_all(&redacted, *replacement).into_owned()
        })
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
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("credential")
        || normalized == "encrypted"
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{redact_sensitive_text, redact_sensitive_value};

    #[test]
    fn text_redaction_removes_bearer_and_query_tokens() {
        let redacted = redact_sensitive_text(
            "Authorization: Bearer token-123 apiKey=key-789 https://example.test?access_token=query-456",
        );

        assert!(
            !redacted.contains("token-123")
                && !redacted.contains("key-789")
                && !redacted.contains("query-456")
        );
    }

    #[test]
    fn json_redaction_recurses_through_sensitive_keys() {
        let value = json!({
            "provider": { "apiKey": "secret-key" },
            "servers": [{ "access_token": "secret-token", "name": "safe" }]
        });

        assert_eq!(
            redact_sensitive_value(&value),
            json!({
                "provider": { "apiKey": "[REDACTED]" },
                "servers": [{ "access_token": "[REDACTED]", "name": "safe" }]
            })
        );
    }
}
