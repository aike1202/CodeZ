use codez_contracts::{
    CommandError,
    todo::{
        TODO_EVENT_VERSION, TODO_UPDATED_EVENT, TodoApprovalStatus, TodoArchiveRequest,
        TodoClearField, TodoContextBundle, TodoCreateInput, TodoCreateRequest, TodoDeleteRequest,
        TodoGetRequest, TodoItem, TodoItemUpdate, TodoListRequest, TodoListSnapshot,
        TodoMutationResult, TodoRiskLevel, TodoStatus, TodoUpdateRequest, TodoUpdatedEvent,
        TodoVerificationEvidence, TodoVerificationOutcome,
    },
};
use codez_core::{AppError, SessionId};
use codez_runtime::todo::{
    TodoApprovalStatus as RuntimeApprovalStatus, TodoClearField as RuntimeClearField,
    TodoContextBundle as RuntimeContextBundle, TodoCreateInput as RuntimeCreateInput,
    TodoEventSink, TodoItem as RuntimeTodoItem, TodoItemPatch as RuntimeItemPatch,
    TodoItemUpdate as RuntimeItemUpdate, TodoListSnapshot as RuntimeSnapshot,
    TodoRiskLevel as RuntimeRiskLevel, TodoStatus as RuntimeStatus,
    TodoVerificationEvidence as RuntimeVerificationEvidence,
    TodoVerificationOutcome as RuntimeVerificationOutcome,
};
use tauri::{AppHandle, Emitter, State, command};

use crate::{error::command_result, state::AppState};

pub(crate) struct DesktopTodoEventSink {
    app: AppHandle,
}

impl DesktopTodoEventSink {
    #[must_use]
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl TodoEventSink for DesktopTodoEventSink {
    fn emit(&self, snapshot: &RuntimeSnapshot) -> Result<(), AppError> {
        let snapshot = snapshot_contract(snapshot);
        let event = TodoUpdatedEvent {
            version: TODO_EVENT_VERSION,
            session_id: snapshot.session_id.clone(),
            revision: snapshot.revision,
            snapshot,
        };
        self.app.emit(TODO_UPDATED_EVENT, event).map_err(|source| {
            AppError::external(
                "The Todo update event could not be delivered",
                format!("emit {TODO_UPDATED_EVENT}: {source}"),
                true,
            )
        })
    }
}

#[command]
pub async fn todo_list(
    state: State<'_, AppState>,
    request: TodoListRequest,
) -> Result<TodoListSnapshot, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        state
            .todo_store
            .snapshot(&session_id)
            .await
            .map(|snapshot| snapshot_contract(&snapshot))
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn todo_get(
    state: State<'_, AppState>,
    request: TodoGetRequest,
) -> Result<TodoItem, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        state
            .todo_store
            .get(&session_id, &request.todo_id)
            .await
            .map(|todo| todo_contract(&todo))
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn todo_create(
    state: State<'_, AppState>,
    request: TodoCreateRequest,
) -> Result<TodoMutationResult, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        let items = request.items.into_iter().map(create_input).collect();
        let outcome = state
            .todo_store
            .create_guarded(
                &session_id,
                request.expected_revision,
                &request.idempotency_key,
                items,
            )
            .await?;
        Ok(TodoMutationResult {
            snapshot: snapshot_contract(&outcome.snapshot),
            replayed: outcome.replayed,
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn todo_update(
    state: State<'_, AppState>,
    request: TodoUpdateRequest,
) -> Result<TodoMutationResult, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        let snapshot = state
            .todo_store
            .update_batch(
                &session_id,
                request.expected_revision,
                request.reason.as_deref(),
                request.updates.into_iter().map(update_input).collect(),
            )
            .await?;
        Ok(TodoMutationResult {
            snapshot: snapshot_contract(&snapshot),
            replayed: false,
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[command(rename_all = "camelCase")]
pub async fn todo_delete(
    state: State<'_, AppState>,
    request: TodoDeleteRequest,
) -> Result<TodoListSnapshot, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        state
            .todo_store
            .delete_guarded(&session_id, request.expected_revision, &request.todo_id)
            .await
            .map(|snapshot| snapshot_contract(&snapshot))
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn todo_archive(
    state: State<'_, AppState>,
    request: TodoArchiveRequest,
) -> Result<TodoMutationResult, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        let snapshot = state
            .todo_store
            .archive_batch(
                &session_id,
                request.expected_revision,
                &request.todo_ids,
                &request.reason,
            )
            .await?;
        Ok(TodoMutationResult {
            snapshot: snapshot_contract(&snapshot),
            replayed: false,
        })
    }
    .await;
    command_result(&state.errors, result)
}

fn parse_session_id(value: String) -> Result<SessionId, AppError> {
    SessionId::parse(value)
        .map_err(|source| AppError::validation(format!("The Todo session is invalid: {source}")))
}

fn create_input(input: TodoCreateInput) -> RuntimeCreateInput {
    RuntimeCreateInput {
        subject: input.subject,
        description: input.description.unwrap_or_default(),
        files: input.files.unwrap_or_default(),
        active_form: input.active_form,
        group_id: input.group_id,
        group_title: input.group_title,
        group_subtitle: input.group_subtitle,
        risk_level: input.risk_level.map(risk_runtime),
        requires_approval: input.requires_approval.unwrap_or(false),
        approval_status: input.approval_status.map(approval_runtime),
        acceptance_criteria: input.acceptance_criteria.unwrap_or_default(),
        verification_command: input.verification_command,
        context_bundle: input.context_bundle.map(context_runtime),
    }
}

fn update_input(input: TodoItemUpdate) -> RuntimeItemUpdate {
    RuntimeItemUpdate {
        todo_id: input.todo_id,
        patch: RuntimeItemPatch {
            subject: input.subject,
            description: input.description,
            status: input.status.map(status_runtime),
            reopen: input.reopen.unwrap_or(false),
            clear_fields: input
                .clear_fields
                .unwrap_or_default()
                .into_iter()
                .map(clear_field_runtime)
                .collect(),
            add_blocked_by: input.add_blocked_by.unwrap_or_default(),
            remove_blocked_by: input.remove_blocked_by.unwrap_or_default(),
            files: input.files,
            active_form: input.active_form,
            group_id: input.group_id,
            group_title: input.group_title,
            group_subtitle: input.group_subtitle,
            risk_level: input.risk_level.map(risk_runtime),
            requires_approval: input.requires_approval,
            approval_status: input.approval_status.map(approval_runtime),
            acceptance_criteria: input.acceptance_criteria,
            verification_command: input.verification_command,
            verification_evidence: input.verification_evidence.map(verification_runtime),
            context_bundle: input.context_bundle.map(context_runtime),
        },
    }
}

fn context_runtime(context: TodoContextBundle) -> RuntimeContextBundle {
    RuntimeContextBundle {
        known_facts: context.known_facts.unwrap_or_default(),
        decisions: context.decisions.unwrap_or_default(),
        constraints: context.constraints.unwrap_or_default(),
        excluded_directions: context.excluded_directions.unwrap_or_default(),
        source_references: context.source_references.unwrap_or_default(),
    }
}

fn verification_runtime(evidence: TodoVerificationEvidence) -> RuntimeVerificationEvidence {
    RuntimeVerificationEvidence {
        outcome: verification_outcome_runtime(evidence.outcome),
        summary: evidence.summary,
        command: evidence.command,
        exit_code: evidence.exit_code,
        tool_call_id: evidence.tool_call_id,
    }
}

fn verification_contract(evidence: &RuntimeVerificationEvidence) -> TodoVerificationEvidence {
    TodoVerificationEvidence {
        outcome: verification_outcome_contract(evidence.outcome),
        summary: evidence.summary.clone(),
        command: evidence.command.clone(),
        exit_code: evidence.exit_code,
        tool_call_id: evidence.tool_call_id.clone(),
    }
}

fn snapshot_contract(snapshot: &RuntimeSnapshot) -> TodoListSnapshot {
    TodoListSnapshot {
        version: snapshot.version,
        session_id: snapshot.session_id.as_str().to_string(),
        revision: snapshot.revision,
        next_sequence: snapshot.next_sequence,
        items: snapshot.items.iter().map(todo_contract).collect(),
        archived_items: snapshot.archived_items.iter().map(todo_contract).collect(),
    }
}

fn todo_contract(todo: &RuntimeTodoItem) -> TodoItem {
    TodoItem {
        id: todo.id.clone(),
        subject: todo.subject.clone(),
        description: todo.description.clone(),
        status: status_contract(todo.status),
        blocked_by: non_empty(todo.blocked_by.clone()),
        files: non_empty(todo.files.clone()),
        active_form: todo.active_form.clone(),
        group_id: todo.group_id.clone(),
        group_title: todo.group_title.clone(),
        group_subtitle: todo.group_subtitle.clone(),
        risk_level: todo.risk_level.map(risk_contract),
        requires_approval: todo.requires_approval,
        approval_status: approval_contract(todo.approval_status),
        acceptance_criteria: non_empty(todo.acceptance_criteria.clone()),
        verification_command: todo.verification_command.clone(),
        verification_evidence: todo
            .verification_evidence
            .as_ref()
            .map(verification_contract),
        context_bundle: todo.context_bundle.as_ref().map(context_contract),
    }
}

fn context_contract(context: &RuntimeContextBundle) -> TodoContextBundle {
    TodoContextBundle {
        known_facts: non_empty(context.known_facts.clone()),
        decisions: non_empty(context.decisions.clone()),
        constraints: non_empty(context.constraints.clone()),
        excluded_directions: non_empty(context.excluded_directions.clone()),
        source_references: non_empty(context.source_references.clone()),
    }
}

fn non_empty(values: Vec<String>) -> Option<Vec<String>> {
    (!values.is_empty()).then_some(values)
}

const fn status_contract(status: RuntimeStatus) -> TodoStatus {
    match status {
        RuntimeStatus::Pending => TodoStatus::Pending,
        RuntimeStatus::InProgress => TodoStatus::InProgress,
        RuntimeStatus::Completed => TodoStatus::Completed,
        RuntimeStatus::Cancelled => TodoStatus::Cancelled,
    }
}

const fn status_runtime(status: TodoStatus) -> RuntimeStatus {
    match status {
        TodoStatus::Pending => RuntimeStatus::Pending,
        TodoStatus::InProgress => RuntimeStatus::InProgress,
        TodoStatus::Completed => RuntimeStatus::Completed,
        TodoStatus::Cancelled => RuntimeStatus::Cancelled,
    }
}

const fn clear_field_runtime(field: TodoClearField) -> RuntimeClearField {
    match field {
        TodoClearField::Files => RuntimeClearField::Files,
        TodoClearField::ActiveForm => RuntimeClearField::ActiveForm,
        TodoClearField::GroupId => RuntimeClearField::GroupId,
        TodoClearField::GroupTitle => RuntimeClearField::GroupTitle,
        TodoClearField::GroupSubtitle => RuntimeClearField::GroupSubtitle,
        TodoClearField::RiskLevel => RuntimeClearField::RiskLevel,
        TodoClearField::AcceptanceCriteria => RuntimeClearField::AcceptanceCriteria,
        TodoClearField::VerificationCommand => RuntimeClearField::VerificationCommand,
        TodoClearField::VerificationEvidence => RuntimeClearField::VerificationEvidence,
        TodoClearField::ContextBundle => RuntimeClearField::ContextBundle,
    }
}

const fn verification_outcome_contract(
    outcome: RuntimeVerificationOutcome,
) -> TodoVerificationOutcome {
    match outcome {
        RuntimeVerificationOutcome::Passed => TodoVerificationOutcome::Passed,
        RuntimeVerificationOutcome::Failed => TodoVerificationOutcome::Failed,
    }
}

const fn verification_outcome_runtime(
    outcome: TodoVerificationOutcome,
) -> RuntimeVerificationOutcome {
    match outcome {
        TodoVerificationOutcome::Passed => RuntimeVerificationOutcome::Passed,
        TodoVerificationOutcome::Failed => RuntimeVerificationOutcome::Failed,
    }
}

const fn risk_contract(risk: RuntimeRiskLevel) -> TodoRiskLevel {
    match risk {
        RuntimeRiskLevel::Low => TodoRiskLevel::Low,
        RuntimeRiskLevel::Medium => TodoRiskLevel::Medium,
        RuntimeRiskLevel::High => TodoRiskLevel::High,
    }
}

const fn risk_runtime(risk: TodoRiskLevel) -> RuntimeRiskLevel {
    match risk {
        TodoRiskLevel::Low => RuntimeRiskLevel::Low,
        TodoRiskLevel::Medium => RuntimeRiskLevel::Medium,
        TodoRiskLevel::High => RuntimeRiskLevel::High,
    }
}

const fn approval_contract(status: RuntimeApprovalStatus) -> TodoApprovalStatus {
    match status {
        RuntimeApprovalStatus::NotRequired => TodoApprovalStatus::NotRequired,
        RuntimeApprovalStatus::Pending => TodoApprovalStatus::Pending,
        RuntimeApprovalStatus::Approved => TodoApprovalStatus::Approved,
        RuntimeApprovalStatus::ChangesRequested => TodoApprovalStatus::ChangesRequested,
        RuntimeApprovalStatus::Rejected => TodoApprovalStatus::Rejected,
    }
}

const fn approval_runtime(status: TodoApprovalStatus) -> RuntimeApprovalStatus {
    match status {
        TodoApprovalStatus::NotRequired => RuntimeApprovalStatus::NotRequired,
        TodoApprovalStatus::Pending => RuntimeApprovalStatus::Pending,
        TodoApprovalStatus::Approved => RuntimeApprovalStatus::Approved,
        TodoApprovalStatus::ChangesRequested => RuntimeApprovalStatus::ChangesRequested,
        TodoApprovalStatus::Rejected => RuntimeApprovalStatus::Rejected,
    }
}

#[cfg(test)]
mod tests {
    use codez_core::SessionId;
    use codez_runtime::todo::{TodoApprovalStatus, TodoItem, TodoListSnapshot, TodoStatus};

    use super::snapshot_contract;

    #[test]
    fn snapshot_conversion_preserves_identity_revision_and_optional_fields() {
        let snapshot = TodoListSnapshot {
            version: 2,
            session_id: SessionId::parse("session-1").expect("fixture session ID must be valid"),
            revision: 4,
            next_sequence: 2,
            items: vec![TodoItem {
                id: "t1".to_string(),
                subject: "Implement todo events".to_string(),
                description: String::new(),
                status: TodoStatus::Pending,
                blocked_by: Vec::new(),
                files: Vec::new(),
                active_form: None,
                group_id: None,
                group_title: None,
                group_subtitle: None,
                risk_level: None,
                requires_approval: false,
                approval_status: TodoApprovalStatus::NotRequired,
                acceptance_criteria: Vec::new(),
                verification_command: None,
                verification_evidence: None,
                context_bundle: None,
            }],
            archived_items: Vec::new(),
            create_receipts: Vec::new(),
        };

        let contract = snapshot_contract(&snapshot);

        assert_eq!(
            (
                contract.session_id.as_str(),
                contract.revision,
                contract.items[0].files.as_ref()
            ),
            ("session-1", 4, None)
        );
    }
}
