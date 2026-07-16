use codez_contracts::context::{
    LedgerEvent, LedgerEventType, SessionRuntimeScopeSnapshot,
    UserMessagePayload, AssistantMessagePayload, ToolResultPayload,
    TurnCompletedPayload, TurnInterruptedPayload, CompactionCompletedPayload,
};
use crate::context::ledger::LoadedSessionRuntime;
use crate::context::skill_state::apply_message_to_session_skill_states;

pub fn apply_event(state: &mut LoadedSessionRuntime, event: LedgerEvent) -> Result<(), String> {
    let scope_id_str = match &event.context_scope_id {
        codez_contracts::context::ContextScopeId::Main => "main".to_string(),
        codez_contracts::context::ContextScopeId::Subagent(id) => format!("subagent:{}", id),
    };

    let scope = state.snapshot.scopes.entry(scope_id_str.clone()).or_insert_with(|| {
        SessionRuntimeScopeSnapshot {
            history_version: 0,
            active_messages: vec![],
            observed_provider_input_limit: None,
            resume_state: None,
            last_completed_turn_id: None,
            last_interrupted_turn_id: None,
            legacy_import: None,
            latest_compaction_resume_revision: None,
            last_provider_id: None,
            last_model: None,
            last_provider_usage: None,
            last_provider_usage_message_id: None,
            last_provider_usage_provider_id: None,
            last_provider_usage_model: None,
            last_provider_usage_request_fingerprint: None,
            post_compaction_file_context: None,
            post_compaction_skill_context: None,
            skill_states: None,
            post_compaction_skill_states: None,
        }
    });

    scope.history_version = event.history_version;

    match event.r#type {
        LedgerEventType::UserMessage => {
            let payload: UserMessagePayload = serde_json::from_value(event.payload).map_err(|e| e.to_string())?;
            
            let mut clear_obs = false;
            if let Some(limit) = &scope.observed_provider_input_limit {
                if let Some(obj) = limit.as_object() {
                    if let Some(payload_provider) = &payload.provider_id {
                        if obj.get("providerId").and_then(|v| v.as_str()) != Some(payload_provider) {
                            clear_obs = true;
                        }
                    }
                    if let Some(payload_model) = &payload.model {
                        if obj.get("model").and_then(|v| v.as_str()) != Some(payload_model) {
                            clear_obs = true;
                        }
                    }
                }
            }
            if clear_obs {
                scope.observed_provider_input_limit = None;
            }

            let mut clear_usage = false;
            if let Some(payload_provider) = &payload.provider_id {
                if let Some(scope_provider) = &scope.last_provider_id {
                    if payload_provider != scope_provider {
                        clear_usage = true;
                    }
                }
            }
            if let Some(payload_model) = &payload.model {
                if let Some(scope_model) = &scope.last_model {
                    if payload_model != scope_model {
                        clear_usage = true;
                    }
                }
            }
            if scope.last_provider_usage.is_some() {
                if let Some(payload_provider) = &payload.provider_id {
                    if scope.last_provider_usage_provider_id.as_deref() != Some(payload_provider.as_str()) {
                        clear_usage = true;
                    }
                }
                if let Some(payload_model) = &payload.model {
                    if scope.last_provider_usage_model.as_deref() != Some(payload_model.as_str()) {
                        clear_usage = true;
                    }
                }
            }
            if clear_usage {
                scope.last_provider_usage = None;
                scope.last_provider_usage_message_id = None;
                scope.last_provider_usage_provider_id = None;
                scope.last_provider_usage_model = None;
                scope.last_provider_usage_request_fingerprint = None;
            }

            if let Some(p) = payload.provider_id {
                scope.last_provider_id = Some(p);
            }
            if let Some(m) = payload.model {
                scope.last_model = Some(m);
            }

            let mut msg = payload.message;
            msg.source_sequence = Some(event.sequence);
            scope.active_messages.push(msg.clone());
            scope.skill_states = Some(apply_message_to_session_skill_states(
                scope.skill_states.as_deref(),
                &scope.active_messages,
                &msg,
            ));
        }
        LedgerEventType::AssistantMessage => {
            let payload: AssistantMessagePayload = serde_json::from_value(event.payload).map_err(|e| e.to_string())?;
            let mut msg = payload.message;
            msg.source_sequence = Some(event.sequence);
            scope.active_messages.push(msg.clone());

            if let Some(usage) = payload.usage {
                if usage.input_tokens > 0 && payload.request_fingerprint.is_some() {
                    scope.last_provider_usage = Some(usage);
                    scope.last_provider_usage_message_id = Some(msg.id.clone());
                    scope.last_provider_usage_provider_id = scope.last_provider_id.clone();
                    scope.last_provider_usage_model = scope.last_model.clone();
                    scope.last_provider_usage_request_fingerprint = payload.request_fingerprint;
                } else if usage.input_tokens > 0 {
                    scope.last_provider_usage = None;
                    scope.last_provider_usage_message_id = None;
                    scope.last_provider_usage_provider_id = None;
                    scope.last_provider_usage_model = None;
                    scope.last_provider_usage_request_fingerprint = None;
                }
            }
        }
        LedgerEventType::ToolResult => {
            let payload: ToolResultPayload = serde_json::from_value(event.payload).map_err(|e| e.to_string())?;
            let mut msg = payload.message;
            msg.source_sequence = Some(event.sequence);
            scope.active_messages.push(msg.clone());
            scope.skill_states = Some(apply_message_to_session_skill_states(
                scope.skill_states.as_deref(),
                &scope.active_messages,
                &msg,
            ));
        }
        LedgerEventType::TurnCompleted => {
            let _payload: TurnCompletedPayload = serde_json::from_value(event.payload).map_err(|e| e.to_string())?;
            scope.last_completed_turn_id = event.turn_id;
        }
        LedgerEventType::TurnInterrupted => {
            let payload: TurnInterruptedPayload = serde_json::from_value(event.payload).map_err(|e| e.to_string())?;
            for mut msg in payload.interrupted_messages {
                msg.source_sequence = Some(event.sequence);
                scope.active_messages.push(msg);
            }
            scope.last_interrupted_turn_id = event.turn_id;
        }
        LedgerEventType::CompactionCompleted => {
            let payload: CompactionCompletedPayload = serde_json::from_value(event.payload).map_err(|e| e.to_string())?;
            scope.active_messages = payload.active_messages.into_iter().map(|mut m| {
                if m.source_sequence.is_none() {
                    m.source_sequence = Some(event.sequence);
                }
                m
            }).collect();
            // TODO: other fields
        }
        _ => {}
    }

    Ok(())
}
