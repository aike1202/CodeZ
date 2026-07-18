use std::collections::HashMap;

use codez_contracts::context as wire;
use codez_core::context as domain;

use crate::{attachment_boundary::composer_to_wire, provider_boundary::usage_to_wire};

pub(crate) fn append_request_from_wire(
    value: wire::LedgerAppendRequest,
) -> domain::LedgerAppendRequest {
    domain::LedgerAppendRequest {
        event_id: value.event_id,
        session_id: value.session_id,
        context_scope_id: scope_from_wire(value.context_scope_id),
        turn_id: value.turn_id,
        created_at: value.created_at,
        r#type: event_type_from_wire(value.r#type),
        payload: value.payload,
    }
}

pub(crate) fn event_to_wire(value: domain::LedgerEvent) -> wire::LedgerEvent {
    wire::LedgerEvent {
        schema_version: value.schema_version,
        event_id: value.event_id,
        session_id: value.session_id,
        context_scope_id: scope_to_wire(value.context_scope_id),
        sequence: value.sequence,
        history_version: value.history_version,
        turn_id: value.turn_id,
        created_at: value.created_at,
        r#type: event_type_to_wire(value.r#type),
        payload: value.payload,
    }
}

pub(crate) fn snapshot_to_wire(
    value: domain::SessionRuntimeSnapshot,
) -> wire::SessionRuntimeSnapshot {
    wire::SessionRuntimeSnapshot {
        schema_version: value.schema_version,
        session_id: value.session_id,
        through_sequence: value.through_sequence,
        created_at: value.created_at,
        scopes: value
            .scopes
            .into_iter()
            .map(|(id, scope)| (id, scope_to_wire_snapshot(scope)))
            .collect::<HashMap<_, _>>(),
    }
}

fn scope_from_wire(value: wire::ContextScopeId) -> domain::ContextScopeId {
    match value {
        wire::ContextScopeId::Main => domain::ContextScopeId::Main,
    }
}

fn scope_to_wire(value: domain::ContextScopeId) -> wire::ContextScopeId {
    match value {
        domain::ContextScopeId::Main => wire::ContextScopeId::Main,
    }
}

fn event_type_from_wire(value: wire::LedgerEventType) -> domain::LedgerEventType {
    match value {
        wire::LedgerEventType::UserMessage => domain::LedgerEventType::UserMessage,
        wire::LedgerEventType::AssistantMessage => domain::LedgerEventType::AssistantMessage,
        wire::LedgerEventType::ToolResult => domain::LedgerEventType::ToolResult,
        wire::LedgerEventType::SkillStateUpdated => domain::LedgerEventType::SkillStateUpdated,
        wire::LedgerEventType::TurnCompleted => domain::LedgerEventType::TurnCompleted,
        wire::LedgerEventType::TurnInterrupted => domain::LedgerEventType::TurnInterrupted,
        wire::LedgerEventType::ResumeStateUpdated => domain::LedgerEventType::ResumeStateUpdated,
        wire::LedgerEventType::CompactionStarted => domain::LedgerEventType::CompactionStarted,
        wire::LedgerEventType::CompactionCompleted => domain::LedgerEventType::CompactionCompleted,
        wire::LedgerEventType::CompactionFailed => domain::LedgerEventType::CompactionFailed,
        wire::LedgerEventType::HistoryReverted => domain::LedgerEventType::HistoryReverted,
        wire::LedgerEventType::LegacyImportCompleted => {
            domain::LedgerEventType::LegacyImportCompleted
        }
    }
}

fn event_type_to_wire(value: domain::LedgerEventType) -> wire::LedgerEventType {
    match value {
        domain::LedgerEventType::UserMessage => wire::LedgerEventType::UserMessage,
        domain::LedgerEventType::AssistantMessage => wire::LedgerEventType::AssistantMessage,
        domain::LedgerEventType::ToolResult => wire::LedgerEventType::ToolResult,
        domain::LedgerEventType::SkillStateUpdated => wire::LedgerEventType::SkillStateUpdated,
        domain::LedgerEventType::TurnCompleted => wire::LedgerEventType::TurnCompleted,
        domain::LedgerEventType::TurnInterrupted => wire::LedgerEventType::TurnInterrupted,
        domain::LedgerEventType::ResumeStateUpdated => wire::LedgerEventType::ResumeStateUpdated,
        domain::LedgerEventType::CompactionStarted => wire::LedgerEventType::CompactionStarted,
        domain::LedgerEventType::CompactionCompleted => wire::LedgerEventType::CompactionCompleted,
        domain::LedgerEventType::CompactionFailed => wire::LedgerEventType::CompactionFailed,
        domain::LedgerEventType::HistoryReverted => wire::LedgerEventType::HistoryReverted,
        domain::LedgerEventType::LegacyImportCompleted => {
            wire::LedgerEventType::LegacyImportCompleted
        }
    }
}

fn scope_to_wire_snapshot(
    value: domain::SessionRuntimeScopeSnapshot,
) -> wire::SessionRuntimeScopeSnapshot {
    wire::SessionRuntimeScopeSnapshot {
        history_version: value.history_version,
        active_messages: value
            .active_messages
            .into_iter()
            .map(message_to_wire)
            .collect(),
        latest_compaction: value.latest_compaction,
        observed_provider_input_limit: value.observed_provider_input_limit,
        resume_state: value.resume_state.map(versioned_resume_to_wire),
        last_completed_turn_id: value.last_completed_turn_id,
        last_interrupted_turn_id: value.last_interrupted_turn_id,
        legacy_import: value.legacy_import,
        latest_compaction_resume_revision: value.latest_compaction_resume_revision,
        last_provider_id: value.last_provider_id,
        last_model: value.last_model,
        last_provider_usage: value.last_provider_usage.map(usage_to_wire),
        last_provider_usage_message_id: value.last_provider_usage_message_id,
        last_provider_usage_provider_id: value.last_provider_usage_provider_id,
        last_provider_usage_model: value.last_provider_usage_model,
        last_provider_usage_request_fingerprint: value.last_provider_usage_request_fingerprint,
        post_compaction_file_context: value
            .post_compaction_file_context
            .map(post_file_context_to_wire),
        post_compaction_skill_context: value
            .post_compaction_skill_context
            .map(post_skill_context_to_wire),
        skill_states: value
            .skill_states
            .map(|states| states.into_iter().map(skill_state_to_wire).collect()),
        post_compaction_skill_states: value
            .post_compaction_skill_states
            .map(|states| states.into_iter().map(skill_state_to_wire).collect()),
    }
}

fn message_to_wire(value: domain::NormalizedModelMessage) -> wire::NormalizedModelMessage {
    wire::NormalizedModelMessage {
        id: value.id,
        client_message_id: value.client_message_id,
        turn_id: value.turn_id,
        role: value.role,
        content: value.content,
        tool_calls: value
            .tool_calls
            .map(|calls| calls.into_iter().map(tool_call_to_wire).collect()),
        tool_call_id: value.tool_call_id,
        name: value.name,
        status: value.status,
        created_at: value.created_at,
        source_sequence: value.source_sequence,
        attachments: value
            .attachments
            .map(|items| items.into_iter().map(composer_to_wire).collect()),
        file_references: value
            .file_references
            .map(|references| references.into_iter().map(file_reference_to_wire).collect()),
    }
}

fn tool_call_to_wire(value: domain::NormalizedToolCall) -> wire::NormalizedToolCall {
    wire::NormalizedToolCall {
        id: value.id,
        name: value.name,
        arguments: value.arguments,
        thought_signature: value.thought_signature,
    }
}

fn file_reference_to_wire(value: domain::FileContextReference) -> wire::FileContextReference {
    wire::FileContextReference {
        path: value.path,
        sha256: value.sha256,
        operation: value.operation,
        content_included: value.content_included,
        content_sha256: value.content_sha256,
        offset: value.offset,
        limit: value.limit,
        character_offset: value.character_offset,
        access_sequence: value.access_sequence,
        result_block_start: value.result_block_start,
        result_block_end: value.result_block_end,
    }
}

fn post_file_block_to_wire(
    value: domain::PostCompactionFileBlock,
) -> wire::PostCompactionFileBlock {
    wire::PostCompactionFileBlock {
        reference: file_reference_to_wire(value.reference),
        content: value.content,
        stat_signature: value.stat_signature,
        real_path: value.real_path,
    }
}

fn post_file_context_to_wire(
    value: domain::PostCompactionFileContext,
) -> wire::PostCompactionFileContext {
    wire::PostCompactionFileContext {
        content: value.content,
        file_references: value
            .file_references
            .into_iter()
            .map(file_reference_to_wire)
            .collect(),
        blocks: value
            .blocks
            .map(|blocks| blocks.into_iter().map(post_file_block_to_wire).collect()),
        created_at: value.created_at,
        source_sequence: value.source_sequence,
    }
}

fn skill_entry_to_wire(value: domain::InvokedSkillContextEntry) -> wire::InvokedSkillContextEntry {
    wire::InvokedSkillContextEntry {
        name: value.name,
        content: value.content,
        invoked_sequence: value.invoked_sequence,
    }
}

fn post_skill_context_to_wire(
    value: domain::PostCompactionSkillContext,
) -> wire::PostCompactionSkillContext {
    wire::PostCompactionSkillContext {
        content: value.content,
        skills: value.skills.into_iter().map(skill_entry_to_wire).collect(),
        created_at: value.created_at,
        source_sequence: value.source_sequence,
    }
}

fn skill_state_to_wire(value: domain::SessionSkillState) -> wire::SessionSkillState {
    wire::SessionSkillState {
        name: value.name,
        status: value.status,
        content: value.content,
        content_hash: value.content_hash,
        args: value.args,
        source: value.source,
        reason: value.reason,
        updated_at: value.updated_at,
        updated_sequence: value.updated_sequence,
    }
}

fn versioned_resume_to_wire(value: domain::VersionedResumeState) -> wire::VersionedResumeState {
    wire::VersionedResumeState {
        revision: value.revision,
        covered_through_sequence: value.covered_through_sequence,
        source: value.source,
        updated_at: value.updated_at,
        state: resume_to_wire(value.state),
    }
}

fn resume_to_wire(value: domain::ResumeState) -> wire::ResumeState {
    wire::ResumeState {
        current_goal_id: value.current_goal_id,
        current_phase: value.current_phase,
        current_step: value.current_step,
        last_completed_step: value.last_completed_step,
        next_action: value.next_action,
        open_questions: value.open_questions,
        blocked_by: value.blocked_by,
        files_touched: value.files_touched,
        files_to_inspect_next: value.files_to_inspect_next,
        validation_pending: value.validation_pending,
        validation_results: value
            .validation_results
            .map(|results| results.into_iter().map(validation_result_to_wire).collect()),
        goal: value.goal.map(goal_to_wire),
        plan: value.plan.map(plan_to_wire),
        context_files: value.context_files,
        last_trimmed_at: value.last_trimmed_at,
        updated_at: value.updated_at,
    }
}

fn validation_result_to_wire(value: domain::ValidationResult) -> wire::ValidationResult {
    wire::ValidationResult {
        command_or_check: value.command_or_check,
        status: value.status,
        result: value.result,
    }
}

fn goal_to_wire(value: domain::GoalSnapshot) -> wire::GoalSnapshot {
    wire::GoalSnapshot {
        id: value.id,
        title: value.title,
        original_prompt: value.original_prompt,
        normalized_goal: value.normalized_goal,
        key_requirements: value.key_requirements,
        non_goals: value.non_goals,
        success_criteria: value.success_criteria,
        updated_at: value.updated_at,
    }
}

fn plan_to_wire(value: domain::TaskPlan) -> wire::TaskPlan {
    wire::TaskPlan {
        current_step: value.current_step,
        completed_steps: value.completed_steps,
        pending_steps: value.pending_steps,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use codez_contracts::context as wire;
    use codez_core::{SessionImageAttachment, context as domain};

    use super::{append_request_from_wire, snapshot_to_wire};

    #[test]
    fn append_request_conversion_preserves_client_authored_fields() {
        let source = wire::LedgerAppendRequest {
            event_id: "event-1".to_string(),
            session_id: "session-1".to_string(),
            context_scope_id: wire::ContextScopeId::Main,
            turn_id: Some("turn-1".to_string()),
            created_at: "2026-07-16T00:00:00.000Z".to_string(),
            r#type: wire::LedgerEventType::ToolResult,
            payload: serde_json::json!({"status": "success"}),
        };

        let converted = append_request_from_wire(source);

        assert_eq!(
            (
                converted.event_id.as_str(),
                converted.context_scope_id.as_key().as_ref(),
                converted.r#type,
                converted.payload["status"].as_str()
            ),
            (
                "event-1",
                "main",
                domain::LedgerEventType::ToolResult,
                Some("success")
            )
        );
    }

    #[test]
    fn snapshot_conversion_preserves_nested_attachment_and_usage() {
        let message = domain::NormalizedModelMessage {
            id: "message-1".to_string(),
            client_message_id: Some("client-1".to_string()),
            turn_id: "turn-1".to_string(),
            role: "user".to_string(),
            content: "inspect".to_string(),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            status: "complete".to_string(),
            created_at: "2026-07-16T00:00:00.000Z".to_string(),
            source_sequence: Some(1),
            attachments: Some(vec![codez_core::ComposerImageAttachment::Session(
                SessionImageAttachment {
                    id: "image-1".to_string(),
                    kind: "image".to_string(),
                    name: "fixture.png".to_string(),
                    mime_type: "image/png".to_string(),
                    width: 10,
                    height: 10,
                    size_bytes: 100,
                    storage_key: "attachments/image-1.png".to_string(),
                    scope: "session".to_string(),
                    session_id: "session-1".to_string(),
                },
            )]),
            file_references: None,
        };
        let scope = domain::SessionRuntimeScopeSnapshot {
            history_version: 1,
            active_messages: vec![message],
            latest_compaction: None,
            observed_provider_input_limit: None,
            resume_state: None,
            last_completed_turn_id: None,
            last_interrupted_turn_id: None,
            legacy_import: None,
            latest_compaction_resume_revision: None,
            last_provider_id: Some("provider-1".to_string()),
            last_model: Some("model-1".to_string()),
            last_provider_usage: Some(codez_core::provider::ProviderTokenUsage {
                input_tokens: 10,
                output_tokens: 5,
                reasoning_tokens: None,
                total_tokens: Some(15),
            }),
            last_provider_usage_message_id: Some("message-1".to_string()),
            last_provider_usage_provider_id: Some("provider-1".to_string()),
            last_provider_usage_model: Some("model-1".to_string()),
            last_provider_usage_request_fingerprint: Some("hash".to_string()),
            post_compaction_file_context: None,
            post_compaction_skill_context: None,
            skill_states: None,
            post_compaction_skill_states: None,
        };
        let source = domain::SessionRuntimeSnapshot {
            schema_version: domain::CONTEXT_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            through_sequence: 1,
            created_at: "2026-07-16T00:00:00.000Z".to_string(),
            scopes: HashMap::from([("main".to_string(), scope)]),
        };

        let converted = snapshot_to_wire(source);
        let main = &converted.scopes["main"];

        assert_eq!(
            (
                main.active_messages[0].attachments.as_ref().map(Vec::len),
                main.last_provider_usage
                    .as_ref()
                    .and_then(|usage| usage.total_tokens),
                main.last_provider_usage_request_fingerprint.as_deref()
            ),
            (Some(1), Some(15), Some("hash"))
        );
    }
}
