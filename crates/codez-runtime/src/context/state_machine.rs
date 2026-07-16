use serde::de::DeserializeOwned;
use thiserror::Error;

use codez_core::context::{
    AssistantMessagePayload, CompactionCompletedPayload, CompactionFailedPayload,
    CompactionStartedPayload, HistoryRevertedPayload, LedgerEvent, LedgerEventType,
    LegacyImportCompletedPayload, ResumeStateUpdatedPayload, SessionRuntimeScopeSnapshot,
    SessionSkillState, SkillStateUpdatedPayload, ToolResultPayload, TurnCompletedPayload,
    TurnInterruptedPayload, UserMessagePayload,
};

use crate::context::{
    ledger::LoadedSessionRuntime,
    skill_state::{apply_message_to_session_skill_states, derive_session_skill_states},
};

/// A ledger event whose payload does not match its declared event type.
#[derive(Debug, Error)]
pub enum StateMachineError {
    #[error("payload does not match ledger event type {event_type:?}")]
    InvalidPayload {
        event_type: LedgerEventType,
        #[source]
        source: serde_json::Error,
    },
}

/// Applies one already-validated ledger event to an in-memory runtime snapshot.
///
/// # Errors
///
/// Returns [`StateMachineError`] when the JSON payload does not match the
/// contract associated with the event type.
pub fn apply_event(
    state: &mut LoadedSessionRuntime,
    event: &LedgerEvent,
) -> Result<(), StateMachineError> {
    match event.r#type {
        LedgerEventType::UserMessage => {
            let payload: UserMessagePayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            if observed_limit_changed(
                scope.observed_provider_input_limit.as_ref(),
                payload.provider_id.as_deref(),
                payload.model.as_deref(),
            ) {
                scope.observed_provider_input_limit = None;
            }
            if provider_usage_is_stale(
                scope,
                payload.provider_id.as_deref(),
                payload.model.as_deref(),
            ) {
                clear_provider_usage(scope);
            }
            if let Some(provider_id) = payload.provider_id {
                scope.last_provider_id = Some(provider_id);
            }
            if let Some(model) = payload.model {
                scope.last_model = Some(model);
            }

            let mut message = payload.message;
            message.source_sequence = Some(event.sequence);
            scope.active_messages.push(message.clone());
            scope.skill_states = Some(apply_message_to_session_skill_states(
                scope.skill_states.as_deref(),
                &scope.active_messages,
                &message,
            ));
        }
        LedgerEventType::AssistantMessage => {
            let payload: AssistantMessagePayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            let mut message = payload.message;
            message.source_sequence = Some(event.sequence);
            scope.active_messages.push(message.clone());

            if let Some(usage) = payload.usage.filter(|usage| usage.input_tokens > 0) {
                if let Some(request_fingerprint) = payload.request_fingerprint {
                    scope.last_provider_usage = Some(usage);
                    scope.last_provider_usage_message_id = Some(message.id);
                    scope.last_provider_usage_provider_id = scope.last_provider_id.clone();
                    scope.last_provider_usage_model = scope.last_model.clone();
                    scope.last_provider_usage_request_fingerprint = Some(request_fingerprint);
                } else {
                    clear_provider_usage(scope);
                }
            }
        }
        LedgerEventType::ToolResult => {
            let payload: ToolResultPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            let mut message = payload.message;
            message.source_sequence = Some(event.sequence);
            scope.active_messages.push(message.clone());
            scope.skill_states = Some(apply_message_to_session_skill_states(
                scope.skill_states.as_deref(),
                &scope.active_messages,
                &message,
            ));
        }
        LedgerEventType::SkillStateUpdated => {
            let payload: SkillStateUpdatedPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            upsert_skill_state(scope, payload, event);
            clear_provider_usage(scope);
        }
        LedgerEventType::TurnCompleted => {
            let _: TurnCompletedPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            scope.last_completed_turn_id.clone_from(&event.turn_id);
        }
        LedgerEventType::TurnInterrupted => {
            let payload: TurnInterruptedPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            scope
                .active_messages
                .extend(payload.interrupted_messages.into_iter().map(|mut message| {
                    message.source_sequence = Some(event.sequence);
                    message
                }));
            scope.last_interrupted_turn_id.clone_from(&event.turn_id);
        }
        LedgerEventType::ResumeStateUpdated => {
            let payload: ResumeStateUpdatedPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            scope.resume_state = Some(payload.resume_state);
            clear_provider_usage(scope);
        }
        LedgerEventType::CompactionStarted => {
            let _: CompactionStartedPayload = parse_payload(event)?;
            scope_for_event(state, event);
        }
        LedgerEventType::CompactionCompleted => {
            let payload: CompactionCompletedPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            apply_compaction(scope, payload, event.sequence);
        }
        LedgerEventType::CompactionFailed => {
            let _: CompactionFailedPayload = parse_payload(event)?;
            scope_for_event(state, event);
        }
        LedgerEventType::HistoryReverted => {
            let payload: HistoryRevertedPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            scope.active_messages = payload.active_messages;
            scope.skill_states = Some(
                payload
                    .skill_states
                    .unwrap_or_else(|| derive_session_skill_states(&scope.active_messages)),
            );
            scope.last_completed_turn_id = scope
                .active_messages
                .last()
                .map(|message| message.turn_id.clone());
            scope.last_interrupted_turn_id = None;
            scope.resume_state = None;
            scope.latest_compaction_resume_revision = None;
            scope.last_provider_id = None;
            scope.last_model = None;
            scope.observed_provider_input_limit = None;
            clear_provider_usage(scope);
        }
        LedgerEventType::LegacyImportCompleted => {
            let payload: LegacyImportCompletedPayload = parse_payload(event)?;
            let scope = scope_for_event(state, event);
            scope.active_messages = payload
                .active_messages
                .into_iter()
                .map(|mut message| {
                    message.source_sequence.get_or_insert(event.sequence);
                    message
                })
                .collect();
            scope.latest_compaction = payload.summary;
            scope.post_compaction_file_context = None;
            scope.post_compaction_skill_context = None;
            scope.skill_states = None;
            scope.post_compaction_skill_states = None;
            scope.observed_provider_input_limit = None;
            scope.legacy_import = Some(serde_json::json!({
                "sourceHash": payload.source_hash,
                "mode": payload.mode,
                "eventId": event.event_id,
            }));
            clear_provider_usage(scope);
        }
    }

    state.snapshot.through_sequence = event.sequence;
    Ok(())
}

#[must_use]
pub(crate) fn empty_scope() -> SessionRuntimeScopeSnapshot {
    SessionRuntimeScopeSnapshot {
        history_version: 0,
        active_messages: Vec::new(),
        latest_compaction: None,
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
}

fn parse_payload<T>(event: &LedgerEvent) -> Result<T, StateMachineError>
where
    T: DeserializeOwned,
{
    serde_json::from_value(event.payload.clone()).map_err(|source| {
        StateMachineError::InvalidPayload {
            event_type: event.r#type,
            source,
        }
    })
}

fn scope_for_event<'a>(
    state: &'a mut LoadedSessionRuntime,
    event: &LedgerEvent,
) -> &'a mut SessionRuntimeScopeSnapshot {
    let scope = state
        .snapshot
        .scopes
        .entry(event.context_scope_id.as_key().into_owned())
        .or_insert_with(empty_scope);
    scope.history_version = event.history_version;
    scope
}

fn observed_limit_changed(
    observed: Option<&serde_json::Value>,
    provider_id: Option<&str>,
    model: Option<&str>,
) -> bool {
    let Some(observed) = observed.and_then(serde_json::Value::as_object) else {
        return false;
    };
    provider_id.is_some_and(|provider_id| {
        observed
            .get("providerId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|observed| observed != provider_id)
    }) || model.is_some_and(|model| {
        observed
            .get("model")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|observed| observed != model)
    })
}

fn provider_usage_is_stale(
    scope: &SessionRuntimeScopeSnapshot,
    provider_id: Option<&str>,
    model: Option<&str>,
) -> bool {
    provider_id.is_some_and(|provider_id| {
        scope
            .last_provider_id
            .as_deref()
            .is_some_and(|current| current != provider_id)
            || (scope.last_provider_usage.is_some()
                && scope.last_provider_usage_provider_id.as_deref() != Some(provider_id))
    }) || model.is_some_and(|model| {
        scope
            .last_model
            .as_deref()
            .is_some_and(|current| current != model)
            || (scope.last_provider_usage.is_some()
                && scope.last_provider_usage_model.as_deref() != Some(model))
    })
}

fn clear_provider_usage(scope: &mut SessionRuntimeScopeSnapshot) {
    scope.last_provider_usage = None;
    scope.last_provider_usage_message_id = None;
    scope.last_provider_usage_provider_id = None;
    scope.last_provider_usage_model = None;
    scope.last_provider_usage_request_fingerprint = None;
}

fn upsert_skill_state(
    scope: &mut SessionRuntimeScopeSnapshot,
    payload: SkillStateUpdatedPayload,
    event: &LedgerEvent,
) {
    let state = SessionSkillState {
        name: payload.name,
        status: payload.status,
        content: payload.content,
        content_hash: payload.content_hash,
        args: payload.args,
        source: payload.source,
        reason: payload.reason,
        updated_at: event.created_at.clone(),
        updated_sequence: event.sequence,
    };
    let states = scope.skill_states.get_or_insert_with(Vec::new);
    if let Some(existing) = states.iter_mut().find(|current| current.name == state.name) {
        *existing = state;
    } else {
        states.push(state);
    }
}

fn apply_compaction(
    scope: &mut SessionRuntimeScopeSnapshot,
    payload: CompactionCompletedPayload,
    sequence: u32,
) {
    scope.active_messages = payload
        .active_messages
        .into_iter()
        .map(|mut message| {
            message.source_sequence.get_or_insert(sequence);
            message
        })
        .collect();
    scope.latest_compaction = Some(payload.summary);
    if let Some(observed_limit) = payload.observed_provider_input_limit {
        scope.observed_provider_input_limit = Some(observed_limit);
    }
    scope.post_compaction_file_context = payload.post_compaction_file_context.map(|mut context| {
        context.source_sequence.get_or_insert(sequence);
        context
    });
    scope.post_compaction_skill_context =
        payload.post_compaction_skill_context.map(|mut context| {
            context.source_sequence = Some(sequence);
            context
        });
    if let Some(skill_states) = payload.skill_states.clone() {
        scope.skill_states = Some(skill_states);
    }
    scope.post_compaction_skill_states = Some(
        payload
            .post_compaction_skill_states
            .or(payload.skill_states)
            .or_else(|| scope.skill_states.clone())
            .unwrap_or_default(),
    );
    scope.latest_compaction_resume_revision =
        payload.resume_state.as_ref().map(|resume| resume.revision);
    if let Some(resume_state) = payload.resume_state {
        scope.resume_state = Some(resume_state);
    }
    clear_provider_usage(scope);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use codez_core::context::{
        CONTEXT_SCHEMA_VERSION, ContextScopeId, LedgerEvent, LedgerEventType,
        SessionRuntimeSnapshot,
    };

    use crate::context::ledger::LoadedSessionRuntime;

    use super::apply_event;

    fn runtime() -> LoadedSessionRuntime {
        LoadedSessionRuntime {
            snapshot: SessionRuntimeSnapshot {
                schema_version: CONTEXT_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                through_sequence: 0,
                created_at: "2026-07-16T00:00:00.000Z".to_string(),
                scopes: HashMap::new(),
            },
            warnings: Vec::new(),
        }
    }

    fn event(
        sequence: u32,
        history_version: u32,
        event_type: LedgerEventType,
        payload: serde_json::Value,
    ) -> LedgerEvent {
        LedgerEvent {
            schema_version: CONTEXT_SCHEMA_VERSION,
            event_id: format!("event-{sequence}"),
            session_id: "session-1".to_string(),
            context_scope_id: ContextScopeId::Main,
            sequence,
            history_version,
            turn_id: Some("turn-1".to_string()),
            created_at: "2026-07-16T00:00:00.000Z".to_string(),
            r#type: event_type,
            payload,
        }
    }

    fn message(id: &str, role: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "turnId": "turn-1",
            "role": role,
            "content": format!("message {id}"),
            "status": "complete",
            "createdAt": "2026-07-16T00:00:00.000Z"
        })
    }

    #[test]
    fn lifecycle_payloads_are_validated_and_replayed() {
        let mut runtime = runtime();
        let skill = event(
            1,
            1,
            LedgerEventType::SkillStateUpdated,
            serde_json::json!({
                "name": "rust-best-practices",
                "status": "active",
                "source": "user"
            }),
        );
        let resume = event(
            2,
            2,
            LedgerEventType::ResumeStateUpdated,
            serde_json::json!({
                "resumeState": {
                    "revision": 1,
                    "coveredThroughSequence": 1,
                    "source": "framework",
                    "updatedAt": "2026-07-16T00:00:00.000Z",
                    "state": {
                        "currentGoalId": "goal-1",
                        "currentPhase": "implementation",
                        "currentStep": "persist ledger",
                        "nextAction": "verify restart",
                        "openQuestions": [],
                        "blockedBy": [],
                        "filesTouched": [],
                        "filesToInspectNext": [],
                        "validationPending": []
                    }
                }
            }),
        );
        let completed = event(
            3,
            2,
            LedgerEventType::TurnCompleted,
            serde_json::json!({
                "stopReason": "stop",
                "completedAt": "2026-07-16T00:00:01.000Z"
            }),
        );

        apply_event(&mut runtime, &skill).expect("skill event must apply");
        apply_event(&mut runtime, &resume).expect("resume event must apply");
        apply_event(&mut runtime, &completed).expect("completion event must apply");
        let scope = &runtime.snapshot.scopes["main"];

        assert_eq!(
            (
                scope.skill_states.as_ref().map(Vec::len),
                scope.resume_state.as_ref().map(|resume| resume.revision),
                scope.last_completed_turn_id.as_deref(),
                runtime.snapshot.through_sequence
            ),
            (Some(1), Some(1), Some("turn-1"), 3)
        );
    }

    #[test]
    fn compaction_replaces_history_and_sets_context_watermarks() {
        let mut runtime = runtime();
        let compaction = event(
            1,
            1,
            LedgerEventType::CompactionCompleted,
            serde_json::json!({
                "trigger": "manual",
                "sourceHistoryVersion": 0,
                "coveredThroughSequence": 0,
                "tokensBefore": 100,
                "tokensAfter": 20,
                "sourceHash": "hash",
                "summary": { "version": 2, "format": "text", "content": "summary", "coveredThroughSequence": 0 },
                "activeMessages": [message("message-1", "user")],
                "postCompactionFileContext": {
                    "content": "files",
                    "fileReferences": [],
                    "createdAt": "2026-07-16T00:00:00.000Z"
                },
                "postCompactionSkillContext": {
                    "content": "skills",
                    "skills": [],
                    "createdAt": "2026-07-16T00:00:00.000Z"
                }
            }),
        );

        apply_event(&mut runtime, &compaction).expect("compaction event must apply");
        let scope = &runtime.snapshot.scopes["main"];

        assert_eq!(
            (
                scope.active_messages[0].source_sequence,
                scope
                    .post_compaction_file_context
                    .as_ref()
                    .and_then(|context| context.source_sequence),
                scope
                    .post_compaction_skill_context
                    .as_ref()
                    .and_then(|context| context.source_sequence),
                scope
                    .latest_compaction
                    .as_ref()
                    .and_then(|value| value.get("version"))
            ),
            (Some(1), Some(1), Some(1), Some(&serde_json::json!(2)))
        );
    }

    #[test]
    fn invalid_payload_does_not_mutate_the_runtime() {
        let mut runtime = runtime();
        let before = runtime.clone();
        let invalid = event(
            1,
            0,
            LedgerEventType::CompactionFailed,
            serde_json::json!({}),
        );

        let result = apply_event(&mut runtime, &invalid);

        assert!(result.is_err());
        assert_eq!(runtime, before);
    }

    #[test]
    fn legacy_import_replaces_history_and_records_provenance() {
        let mut runtime = runtime();
        let imported = event(
            1,
            1,
            LedgerEventType::LegacyImportCompleted,
            serde_json::json!({
                "sourceHash": "legacy-hash",
                "mode": "summary",
                "activeMessages": [message("legacy-message", "user")],
                "summary": { "version": 2, "format": "text", "content": "legacy", "coveredThroughSequence": 0 }
            }),
        );

        apply_event(&mut runtime, &imported).expect("legacy import event must apply");
        let scope = &runtime.snapshot.scopes["main"];

        assert_eq!(
            (
                scope.active_messages[0].id.as_str(),
                scope.active_messages[0].source_sequence,
                scope
                    .legacy_import
                    .as_ref()
                    .and_then(|value| value.get("sourceHash"))
            ),
            (
                "legacy-message",
                Some(1),
                Some(&serde_json::json!("legacy-hash"))
            )
        );
    }
}
