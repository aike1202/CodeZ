//! Ordering and validation for normalized model context items.

use codez_core::context::{
    ModelContextItem, ModelContextItemMessage, NormalizedModelMessage, PostCompactionFileContext,
    PostCompactionSkillContext,
};
use thiserror::Error;

/// Invalid durable history supplied to the model context item builder.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ModelContextBuildError {
    #[error("the current input message identifier is empty")]
    EmptyCurrentInputMessageId,
    #[error("the current input message `{message_id}` is not present in durable history")]
    CurrentInputMissing { message_id: String },
    #[error("the current input message `{message_id}` has role `{role}` instead of an input role")]
    CurrentInputNotUser { message_id: String, role: String },
}

/// Owned inputs used to construct the ordered model-visible context.
pub struct BuildModelContextItemsInput {
    pub system_prompt: String,
    pub instructions: Vec<String>,
    pub summary: Option<String>,
    pub resume: Option<String>,
    pub skill_context: Option<PostCompactionSkillContext>,
    pub session_skill_state: Option<String>,
    pub file_context: Option<PostCompactionFileContext>,
    pub current_input_message_id: String,
    pub history: Vec<NormalizedModelMessage>,
}

/// Builds ordered model context after proving that the current durable input exists.
pub fn build_model_context_items(
    input: BuildModelContextItemsInput,
) -> Result<Vec<ModelContextItem>, ModelContextBuildError> {
    require_current_input_message(&input.history, &input.current_input_message_id)?;
    let mut items = Vec::new();

    if !input.system_prompt.trim().is_empty() {
        items.push(ModelContextItem {
            kind: "system".to_string(),
            message: ModelContextItemMessage::System {
                role: "system".to_string(),
                content: input.system_prompt,
                file_references: None,
                source_sequence: None,
            },
        });
    }

    for instruction in input.instructions {
        if !instruction.trim().is_empty() {
            items.push(ModelContextItem {
                kind: "system".to_string(),
                message: ModelContextItemMessage::System {
                    role: "system".to_string(),
                    content: instruction,
                    file_references: None,
                    source_sequence: None,
                },
            });
        }
    }

    if let Some(summary) = input.summary.filter(|value| !value.trim().is_empty()) {
        items.push(ModelContextItem {
            kind: "compaction_summary".to_string(),
            message: ModelContextItemMessage::System {
                role: "system".to_string(),
                content: summary,
                file_references: None,
                source_sequence: None,
            },
        });
    }

    if let Some(resume) = input.resume.filter(|value| !value.trim().is_empty()) {
        items.push(ModelContextItem {
            kind: "resume_state".to_string(),
            message: ModelContextItemMessage::System {
                role: "system".to_string(),
                content: resume,
                file_references: None,
                source_sequence: None,
            },
        });
    }

    for message in input.history {
        if let Some(skill_ctx) = &input.skill_context {
            if message.id == input.current_input_message_id {
                items.push(ModelContextItem {
                    kind: "skill_context".to_string(),
                    message: ModelContextItemMessage::Normalized(Box::new(
                        NormalizedModelMessage {
                            id: skill_ctx.source_sequence.map_or_else(
                                || format!("skill-context:{}", skill_ctx.created_at),
                                |sequence| format!("skill-context:{sequence}"),
                            ),
                            client_message_id: None,
                            turn_id: message.turn_id.clone(),
                            role: "assistant".to_string(),
                            content: skill_ctx.content.clone(),
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                            status: "complete".to_string(),
                            created_at: skill_ctx.created_at.clone(),
                            source_sequence: skill_ctx.source_sequence,
                            attachments: None,
                            file_references: None,
                        },
                    )),
                });
            }
        }

        if let Some(session_skill_state) = &input.session_skill_state {
            if message.id == input.current_input_message_id {
                items.push(ModelContextItem {
                    kind: "skill_state".to_string(),
                    message: ModelContextItemMessage::Normalized(Box::new(
                        NormalizedModelMessage {
                            id: format!("skill-state:{}", message.turn_id),
                            client_message_id: None,
                            turn_id: message.turn_id.clone(),
                            role: "assistant".to_string(),
                            content: session_skill_state.clone(),
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                            status: "complete".to_string(),
                            created_at: message.created_at.clone(),
                            source_sequence: None,
                            attachments: None,
                            file_references: None,
                        },
                    )),
                });
            }
        }

        if let Some(file_ctx) = &input.file_context {
            if message.id == input.current_input_message_id {
                items.push(ModelContextItem {
                    kind: "file_context".to_string(),
                    message: ModelContextItemMessage::Normalized(Box::new(
                        NormalizedModelMessage {
                            id: file_ctx.source_sequence.map_or_else(
                                || format!("file-context:{}", file_ctx.created_at),
                                |sequence| format!("file-context:{sequence}"),
                            ),
                            client_message_id: None,
                            turn_id: message.turn_id.clone(),
                            role: "assistant".to_string(),
                            content: file_ctx.content.clone(),
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                            status: "complete".to_string(),
                            created_at: file_ctx.created_at.clone(),
                            source_sequence: file_ctx.source_sequence,
                            attachments: None,
                            file_references: Some(file_ctx.file_references.clone()),
                        },
                    )),
                });
            }
        }

        let kind = message.role.clone();
        items.push(ModelContextItem {
            kind,
            message: ModelContextItemMessage::Normalized(Box::new(message)),
        });
    }

    Ok(items)
}

/// Locates the durable user or internal-system input that anchors the current model request.
pub fn require_current_input_message<'a>(
    history: &'a [NormalizedModelMessage],
    current_input_message_id: &str,
) -> Result<&'a NormalizedModelMessage, ModelContextBuildError> {
    if current_input_message_id.trim().is_empty() {
        return Err(ModelContextBuildError::EmptyCurrentInputMessageId);
    }
    let message = history
        .iter()
        .find(|message| message.id == current_input_message_id)
        .ok_or_else(|| ModelContextBuildError::CurrentInputMissing {
            message_id: current_input_message_id.to_string(),
        })?;
    if !matches!(message.role.as_str(), "user" | "system") {
        return Err(ModelContextBuildError::CurrentInputNotUser {
            message_id: current_input_message_id.to_string(),
            role: message.role.clone(),
        });
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use codez_core::context::{
        ModelContextItemMessage, NormalizedModelMessage, PostCompactionFileContext,
        PostCompactionSkillContext,
    };

    use super::{
        BuildModelContextItemsInput, ModelContextBuildError, build_model_context_items,
        require_current_input_message,
    };

    fn message(id: &str, role: &str) -> NormalizedModelMessage {
        NormalizedModelMessage {
            id: id.to_string(),
            client_message_id: None,
            turn_id: "turn-1".to_string(),
            role: role.to_string(),
            content: format!("content for {id}"),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            status: "complete".to_string(),
            created_at: "2026-07-17T00:00:00Z".to_string(),
            source_sequence: Some(1),
            attachments: None,
            file_references: None,
        }
    }

    #[test]
    fn current_input_validation_returns_the_durable_user_message() {
        let history = vec![
            message("assistant-1", "assistant"),
            message("user-1", "user"),
        ];

        let current = require_current_input_message(&history, "user-1")
            .expect("durable user message must be accepted");

        assert_eq!(current.id, "user-1");
    }

    #[test]
    fn current_input_validation_rejects_a_missing_message() {
        let history = vec![message("assistant-1", "assistant")];

        let error = require_current_input_message(&history, "user-1")
            .expect_err("missing current input must be rejected");

        assert_eq!(
            error,
            ModelContextBuildError::CurrentInputMissing {
                message_id: "user-1".to_string(),
            }
        );
    }

    #[test]
    fn current_input_validation_rejects_a_non_user_anchor() {
        let history = vec![message("assistant-1", "assistant")];

        let error = require_current_input_message(&history, "assistant-1")
            .expect_err("assistant message cannot anchor current input");

        assert_eq!(
            error,
            ModelContextBuildError::CurrentInputNotUser {
                message_id: "assistant-1".to_string(),
                role: "assistant".to_string(),
            }
        );
    }

    #[test]
    fn current_input_validation_accepts_an_internal_system_input() {
        let history = vec![message("system-1", "system")];

        let current = require_current_input_message(&history, "system-1")
            .expect("internal system input must remain model-visible");

        assert_eq!(current.id, "system-1");
    }

    #[test]
    fn item_builder_does_not_invent_an_empty_system_message() {
        let items = build_model_context_items(BuildModelContextItemsInput {
            system_prompt: String::new(),
            instructions: Vec::new(),
            summary: None,
            resume: None,
            skill_context: None,
            session_skill_state: None,
            file_context: None,
            current_input_message_id: "user-1".to_string(),
            history: vec![message("user-1", "user")],
        })
        .expect("valid durable input must build context");

        assert_eq!(items.len(), 1);
    }

    #[test]
    fn item_builder_orders_static_and_restored_context_before_current_input() {
        let history = vec![
            message("assistant-1", "assistant"),
            message("user-1", "user"),
        ];
        let skill_context = PostCompactionSkillContext {
            content: "skill instructions".to_string(),
            skills: Vec::new(),
            created_at: "2026-07-17T00:00:01Z".to_string(),
            source_sequence: Some(8),
        };
        let file_context = PostCompactionFileContext {
            content: "restored file data".to_string(),
            file_references: Vec::new(),
            blocks: None,
            created_at: "2026-07-17T00:00:02Z".to_string(),
            source_sequence: Some(9),
        };

        let items = build_model_context_items(BuildModelContextItemsInput {
            system_prompt: "system".to_string(),
            instructions: vec!["instruction".to_string()],
            summary: Some("summary".to_string()),
            resume: Some("resume".to_string()),
            skill_context: Some(skill_context),
            session_skill_state: Some("skill state".to_string()),
            file_context: Some(file_context),
            current_input_message_id: "user-1".to_string(),
            history,
        })
        .expect("valid durable history must build context items");
        let kinds = items
            .iter()
            .map(|item| item.kind.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            kinds,
            [
                "system",
                "system",
                "compaction_summary",
                "resume_state",
                "assistant",
                "skill_context",
                "skill_state",
                "file_context",
                "user",
            ]
        );
        assert!(matches!(
            items[7].message,
            ModelContextItemMessage::Normalized(ref message) if message.role == "assistant"
        ));
    }
}
