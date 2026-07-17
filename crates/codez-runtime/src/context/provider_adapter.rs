//! Fallible adaptation from normalized context items to provider chat messages.

use codez_core::{
    context::{ModelContextItem, ModelContextItemMessage, NormalizedModelMessage},
    provider::{ChatMessage, Role, ThinkingConfig, ToolCall, ToolCallFunction, ToolDefinition},
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Invalid normalized context that cannot be represented safely for a provider.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ModelContextAdapterError {
    #[error("model context item `{kind}` has unsupported role `{role}`")]
    UnsupportedRole { kind: String, role: String },
    #[error("tool message in model context item `{kind}` is missing its tool call identifier")]
    ToolCallIdMissing { kind: String },
    #[error("provider request fingerprint input could not be serialized: {0}")]
    FingerprintSerialization(String),
}

/// Secret-free Provider settings that affect how input tokens are measured.
pub struct ProviderUsageRequestProfile<'a> {
    pub provider_id: &'a str,
    pub model: &'a str,
    pub api_format: &'a str,
    pub base_url: &'a str,
    pub thinking: &'a ThinkingConfig,
    pub max_output_tokens: Option<u32>,
    pub reasoning_budget_tokens: u32,
}

/// Exact model-visible request whose reported usage may calibrate a later request.
pub struct ProviderUsageFingerprintInput<'a> {
    pub context_items: &'a [ModelContextItem],
    pub messages: &'a [ChatMessage],
    pub tool_schemas: &'a [ToolDefinition],
    pub profile: ProviderUsageRequestProfile<'a>,
}

/// Adapts an ordered context without coercing unknown roles or orphan tool results.
pub fn model_context_items_to_chat_messages(
    items: &[ModelContextItem],
) -> Result<Vec<ChatMessage>, ModelContextAdapterError> {
    items
        .iter()
        .map(model_context_item_to_chat_message)
        .collect()
}

/// Adapts one context item while preserving its role and tool protocol fields.
pub fn model_context_item_to_chat_message(
    item: &ModelContextItem,
) -> Result<ChatMessage, ModelContextAdapterError> {
    match &item.message {
        ModelContextItemMessage::System { role, content, .. } => {
            let role = parse_role(&item.kind, role)?;
            if role == Role::Tool {
                return Err(ModelContextAdapterError::ToolCallIdMissing {
                    kind: item.kind.clone(),
                });
            }
            Ok(ChatMessage {
                role,
                content: Some(content.clone()),
                tool_calls: None,
                tool_call_id: None,
                name: None,
                images: Vec::new(),
            })
        }
        ModelContextItemMessage::Normalized(message) => {
            normalized_to_chat_message(&item.kind, message)
        }
    }
}

/// Computes a stable, secret-free SHA-256 identity for one Provider request.
///
/// JSON object keys are sorted recursively so fingerprints survive process restarts and do not
/// depend on map insertion order.
pub fn fingerprint_provider_request(
    input: &ProviderUsageFingerprintInput<'_>,
) -> Result<String, ModelContextAdapterError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintProfile<'a> {
        provider_id: &'a str,
        model: &'a str,
        api_format: &'a str,
        base_url: &'a str,
        thinking: &'a ThinkingConfig,
        max_output_tokens: Option<u32>,
        reasoning_budget_tokens: u32,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintPayload<'a> {
        version: u8,
        adapter: &'static str,
        context_items: &'a [ModelContextItem],
        messages: &'a [ChatMessage],
        tool_schemas: &'a [ToolDefinition],
        profile: FingerprintProfile<'a>,
    }

    let profile = &input.profile;
    let payload = serde_json::to_value(FingerprintPayload {
        version: 1,
        adapter: "provider-message-adapter-v1",
        context_items: input.context_items,
        messages: input.messages,
        tool_schemas: input.tool_schemas,
        profile: FingerprintProfile {
            provider_id: profile.provider_id,
            model: profile.model,
            api_format: profile.api_format,
            base_url: profile.base_url,
            thinking: profile.thinking,
            max_output_tokens: profile.max_output_tokens,
            reasoning_budget_tokens: profile.reasoning_budget_tokens,
        },
    })
    .map_err(|error| ModelContextAdapterError::FingerprintSerialization(error.to_string()))?;
    let canonical = canonical_json(&payload)
        .map_err(|error| ModelContextAdapterError::FingerprintSerialization(error.to_string()))?;
    let mut digest = Sha256::new();
    digest.update(b"codez-provider-usage-request-v1\n");
    digest.update(canonical.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn canonical_json(value: &Value) -> Result<String, serde_json::Error> {
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => serde_json::to_string(value),
        Value::Array(values) => {
            let mut rendered = String::from("[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    rendered.push(',');
                }
                rendered.push_str(&canonical_json(value)?);
            }
            rendered.push(']');
            Ok(rendered)
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut rendered = String::from("{");
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    rendered.push(',');
                }
                rendered.push_str(&serde_json::to_string(key)?);
                rendered.push(':');
                if let Some(value) = values.get(key) {
                    rendered.push_str(&canonical_json(value)?);
                }
            }
            rendered.push('}');
            Ok(rendered)
        }
    }
}

fn normalized_to_chat_message(
    kind: &str,
    message: &NormalizedModelMessage,
) -> Result<ChatMessage, ModelContextAdapterError> {
    let role = parse_role(kind, &message.role)?;
    if role == Role::Tool
        && message
            .tool_call_id
            .as_deref()
            .is_none_or(|call_id| call_id.trim().is_empty())
    {
        return Err(ModelContextAdapterError::ToolCallIdMissing {
            kind: kind.to_string(),
        });
    }
    let tool_calls = message.tool_calls.as_ref().map(|calls| {
        calls
            .iter()
            .map(|call| ToolCall {
                id: call.id.clone(),
                r#type: "function".to_string(),
                function: ToolCallFunction {
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                },
                thought_signature: call.thought_signature.clone(),
            })
            .collect()
    });

    Ok(ChatMessage {
        role,
        content: Some(message.content.clone()),
        tool_calls,
        tool_call_id: message.tool_call_id.clone(),
        name: message.name.clone(),
        // Context carries attachment metadata only. Verified bytes are hydrated by the desktop
        // attachment boundary before a provider request is opened.
        images: Vec::new(),
    })
}

fn parse_role(kind: &str, role: &str) -> Result<Role, ModelContextAdapterError> {
    match role {
        "system" => Ok(Role::System),
        "user" => Ok(Role::User),
        "assistant" => Ok(Role::Assistant),
        "tool" => Ok(Role::Tool),
        _ => Err(ModelContextAdapterError::UnsupportedRole {
            kind: kind.to_string(),
            role: role.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use codez_core::provider::Role;
    use codez_core::{
        SessionImageAttachment,
        context::{
            ModelContextItem, ModelContextItemMessage, NormalizedModelMessage, NormalizedToolCall,
        },
        provider::{ThinkingConfig, ThinkingMode, ToolDefinition, ToolDefinitionFunction},
    };

    use super::{
        ModelContextAdapterError, ProviderUsageFingerprintInput, ProviderUsageRequestProfile,
        fingerprint_provider_request, model_context_items_to_chat_messages,
    };

    fn normalized(
        id: &str,
        role: &str,
        tool_calls: Option<Vec<NormalizedToolCall>>,
        tool_call_id: Option<&str>,
        name: Option<&str>,
    ) -> ModelContextItem {
        ModelContextItem {
            kind: role.to_string(),
            message: ModelContextItemMessage::Normalized(Box::new(NormalizedModelMessage {
                id: id.to_string(),
                client_message_id: None,
                turn_id: "turn-1".to_string(),
                role: role.to_string(),
                content: format!("content for {id}"),
                tool_calls,
                tool_call_id: tool_call_id.map(str::to_string),
                name: name.map(str::to_string),
                status: "complete".to_string(),
                created_at: "2026-07-17T00:00:00Z".to_string(),
                source_sequence: Some(1),
                attachments: None,
                file_references: None,
            })),
        }
    }

    fn fingerprint(items: &[ModelContextItem], tools: &[ToolDefinition]) -> String {
        let messages = model_context_items_to_chat_messages(items)
            .expect("fingerprint fixture context must adapt");
        let thinking = ThinkingConfig {
            enabled: false,
            mode: ThinkingMode::None,
            effort: None,
            budget_tokens: None,
        };
        fingerprint_provider_request(&ProviderUsageFingerprintInput {
            context_items: items,
            messages: &messages,
            tool_schemas: tools,
            profile: ProviderUsageRequestProfile {
                provider_id: "provider-1",
                model: "model-1",
                api_format: "openai",
                base_url: "https://provider.example/v1",
                thinking: &thinking,
                max_output_tokens: Some(1_024),
                reasoning_budget_tokens: 0,
            },
        })
        .expect("fingerprint fixture must serialize")
    }

    #[test]
    fn adapter_preserves_roles_tool_calls_identifiers_and_names() {
        let items = vec![
            ModelContextItem {
                kind: "system".to_string(),
                message: ModelContextItemMessage::System {
                    role: "system".to_string(),
                    content: "system prompt".to_string(),
                    file_references: None,
                    source_sequence: None,
                },
            },
            normalized("user-1", "user", None, None, None),
            normalized(
                "assistant-1",
                "assistant",
                Some(vec![NormalizedToolCall {
                    id: "call-1".to_string(),
                    name: "Read".to_string(),
                    arguments: r#"{"path":"README.md"}"#.to_string(),
                    thought_signature: Some("signature".to_string()),
                }]),
                None,
                None,
            ),
            normalized("tool-1", "tool", None, Some("call-1"), Some("Read")),
        ];

        let messages = model_context_items_to_chat_messages(&items)
            .expect("supported context roles must adapt");
        let call = messages[2]
            .tool_calls
            .as_ref()
            .and_then(|calls| calls.first())
            .expect("assistant tool call must be preserved");

        assert_eq!(
            (
                messages
                    .iter()
                    .map(|message| message.role)
                    .collect::<Vec<_>>(),
                call.id.as_str(),
                call.function.name.as_str(),
                call.function.arguments.as_str(),
                call.thought_signature.as_deref(),
                messages[3].tool_call_id.as_deref(),
                messages[3].name.as_deref(),
            ),
            (
                vec![Role::System, Role::User, Role::Assistant, Role::Tool],
                "call-1",
                "Read",
                r#"{"path":"README.md"}"#,
                Some("signature"),
                Some("call-1"),
                Some("Read"),
            )
        );
    }

    #[test]
    fn adapter_rejects_an_unknown_role_instead_of_coercing_it_to_user() {
        let items = vec![normalized("message-1", "observer", None, None, None)];

        let error = model_context_items_to_chat_messages(&items)
            .expect_err("unknown role must not be coerced");

        assert_eq!(
            error,
            ModelContextAdapterError::UnsupportedRole {
                kind: "observer".to_string(),
                role: "observer".to_string(),
            }
        );
    }

    #[test]
    fn adapter_rejects_a_tool_message_without_a_call_identifier() {
        let items = vec![normalized("tool-1", "tool", None, None, Some("Read"))];

        let error = model_context_items_to_chat_messages(&items)
            .expect_err("orphan tool result must be rejected");

        assert_eq!(
            error,
            ModelContextAdapterError::ToolCallIdMissing {
                kind: "tool".to_string(),
            }
        );
    }

    #[test]
    fn request_fingerprint_is_stable_across_json_object_insertion_order() {
        let items = vec![normalized("user-1", "user", None, None, None)];
        let mut left_properties = serde_json::Map::new();
        left_properties.insert("b".to_string(), serde_json::json!({ "type": "number" }));
        left_properties.insert("a".to_string(), serde_json::json!({ "type": "string" }));
        let mut right_properties = serde_json::Map::new();
        right_properties.insert("a".to_string(), serde_json::json!({ "type": "string" }));
        right_properties.insert("b".to_string(), serde_json::json!({ "type": "number" }));
        let tool = |properties| ToolDefinition {
            r#type: "function".to_string(),
            function: ToolDefinitionFunction {
                name: "Read".to_string(),
                description: "read".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": properties
                }),
            },
        };

        assert_eq!(
            fingerprint(&items, &[tool(left_properties)]),
            fingerprint(&items, &[tool(right_properties)])
        );
    }

    #[test]
    fn request_fingerprint_changes_when_image_attachment_identity_changes() {
        let mut first = normalized("user-1", "user", None, None, None);
        let ModelContextItemMessage::Normalized(message) = &mut first.message else {
            panic!("fixture must contain a normalized message");
        };
        message.attachments = Some(vec![codez_core::ComposerImageAttachment::Session(
            SessionImageAttachment {
                id: "image-1".to_string(),
                kind: "image".to_string(),
                name: "one.png".to_string(),
                mime_type: "image/png".to_string(),
                width: 1,
                height: 1,
                size_bytes: 10,
                storage_key: "images/image-1.png".to_string(),
                scope: "session".to_string(),
                session_id: "session-1".to_string(),
            },
        )]);
        let mut second = first.clone();
        let ModelContextItemMessage::Normalized(message) = &mut second.message else {
            panic!("fixture must contain a normalized message");
        };
        let Some(codez_core::ComposerImageAttachment::Session(image)) = message
            .attachments
            .as_mut()
            .and_then(|items| items.first_mut())
        else {
            panic!("fixture must contain a session image");
        };
        image.id = "image-2".to_string();
        image.storage_key = "images/image-2.png".to_string();

        assert_ne!(fingerprint(&[first], &[]), fingerprint(&[second], &[]));
    }
}
