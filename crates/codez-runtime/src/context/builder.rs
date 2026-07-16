use codez_core::context::{
    ModelContextItem, ModelContextItemMessage, NormalizedModelMessage, PostCompactionFileContext,
    PostCompactionSkillContext,
};

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

pub fn build_model_context_items(input: BuildModelContextItemsInput) -> Vec<ModelContextItem> {
    let mut items = Vec::new();

    items.push(ModelContextItem {
        kind: "system".to_string(),
        message: ModelContextItemMessage::System {
            role: "system".to_string(),
            content: input.system_prompt,
            file_references: None,
            source_sequence: None,
        },
    });

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

    if let Some(summary) = input.summary {
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

    if let Some(resume) = input.resume {
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
                            id: format!("skill-context:{}", skill_ctx.source_sequence.unwrap_or(0)),
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
                            id: "session-skill-state".to_string(),
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
                    message: ModelContextItemMessage::System {
                        role: "system".to_string(),
                        content: file_ctx.content.clone(),
                        file_references: Some(file_ctx.file_references.clone()),
                        source_sequence: file_ctx.source_sequence,
                    },
                });
            }
        }

        let kind = message.role.clone();
        items.push(ModelContextItem {
            kind,
            message: ModelContextItemMessage::Normalized(Box::new(message)),
        });
    }

    items
}
