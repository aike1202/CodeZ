use codez_contracts::{
    CommandError,
    task::{
        TASK_EVENT_VERSION, TASK_UPDATED_EVENT, TaskApprovalStatus, TaskContextBundle,
        TaskCreateInput, TaskCreateRequest, TaskGetRequest, TaskItem, TaskListRequest,
        TaskMutationResult, TaskRiskLevel, TaskSnapshot, TaskStatus, TaskUpdateInput,
        TaskUpdateRequest, TaskUpdatedEvent,
    },
};
use codez_core::{AppError, SessionId};
use codez_runtime::task::{
    TaskApprovalStatus as RuntimeApprovalStatus, TaskContextBundle as RuntimeContextBundle,
    TaskCreateInput as RuntimeCreateInput, TaskEventSink, TaskItem as RuntimeTaskItem,
    TaskRiskLevel as RuntimeRiskLevel, TaskSnapshot as RuntimeSnapshot,
    TaskStatus as RuntimeStatus, TaskUpdateInput as RuntimeUpdateInput,
};
use tauri::{AppHandle, Emitter, State, command};

use crate::{error::command_result, state::AppState};

pub(crate) struct DesktopTaskEventSink {
    app: AppHandle,
}

impl DesktopTaskEventSink {
    #[must_use]
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl TaskEventSink for DesktopTaskEventSink {
    fn emit(&self, snapshot: &RuntimeSnapshot) -> Result<(), AppError> {
        let snapshot = snapshot_contract(snapshot);
        let event = TaskUpdatedEvent {
            version: TASK_EVENT_VERSION,
            session_id: snapshot.session_id.clone(),
            revision: snapshot.revision,
            snapshot,
        };
        self.app.emit(TASK_UPDATED_EVENT, event).map_err(|source| {
            AppError::external(
                "The task update event could not be delivered",
                format!("emit {TASK_UPDATED_EVENT}: {source}"),
                true,
            )
        })
    }
}

#[command]
pub async fn task_list(
    state: State<'_, AppState>,
    request: TaskListRequest,
) -> Result<TaskSnapshot, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        state
            .task_store
            .snapshot(&session_id)
            .await
            .map(|snapshot| snapshot_contract(&snapshot))
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn task_get(
    state: State<'_, AppState>,
    request: TaskGetRequest,
) -> Result<TaskItem, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        state
            .task_store
            .get(&session_id, &request.task_id)
            .await
            .map(|task| task_contract(&task))
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn task_create(
    state: State<'_, AppState>,
    request: TaskCreateRequest,
) -> Result<TaskMutationResult, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        let tasks = request.tasks.into_iter().map(create_input).collect();
        let snapshot = state.task_store.create(&session_id, tasks).await?;
        Ok(TaskMutationResult {
            task: None,
            snapshot: snapshot_contract(&snapshot),
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn task_update(
    state: State<'_, AppState>,
    request: TaskUpdateRequest,
) -> Result<TaskMutationResult, CommandError> {
    let result = async {
        let session_id = parse_session_id(request.session_id)?;
        let snapshot = state
            .task_store
            .update(&session_id, &request.task_id, update_input(request.patch))
            .await?;
        let task = snapshot
            .tasks
            .iter()
            .find(|task| task.id == request.task_id)
            .map(task_contract);
        Ok(TaskMutationResult {
            task,
            snapshot: snapshot_contract(&snapshot),
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[command(rename_all = "camelCase")]
pub async fn task_delete(
    state: State<'_, AppState>,
    session_id: String,
    task_id: String,
) -> Result<TaskSnapshot, CommandError> {
    let result = async {
        let session_id = parse_session_id(session_id)?;
        state
            .task_store
            .delete(&session_id, &task_id)
            .await
            .map(|snapshot| snapshot_contract(&snapshot))
    }
    .await;
    command_result(&state.errors, result)
}

fn parse_session_id(value: String) -> Result<SessionId, AppError> {
    SessionId::parse(value)
        .map_err(|source| AppError::validation(format!("The task session is invalid: {source}")))
}

fn create_input(input: TaskCreateInput) -> RuntimeCreateInput {
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

fn update_input(input: TaskUpdateInput) -> RuntimeUpdateInput {
    RuntimeUpdateInput {
        subject: input.subject,
        description: input.description,
        status: input.status.map(status_runtime),
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
        context_bundle: input.context_bundle.map(context_runtime),
    }
}

fn context_runtime(context: TaskContextBundle) -> RuntimeContextBundle {
    RuntimeContextBundle {
        known_facts: context.known_facts.unwrap_or_default(),
        decisions: context.decisions.unwrap_or_default(),
        constraints: context.constraints.unwrap_or_default(),
        excluded_directions: context.excluded_directions.unwrap_or_default(),
        source_references: context.source_references.unwrap_or_default(),
    }
}

fn snapshot_contract(snapshot: &RuntimeSnapshot) -> TaskSnapshot {
    TaskSnapshot {
        version: snapshot.version,
        session_id: snapshot.session_id.as_str().to_string(),
        revision: snapshot.revision,
        next_sequence: snapshot.next_sequence,
        tasks: snapshot.tasks.iter().map(task_contract).collect(),
    }
}

fn task_contract(task: &RuntimeTaskItem) -> TaskItem {
    TaskItem {
        id: task.id.clone(),
        subject: task.subject.clone(),
        description: task.description.clone(),
        status: status_contract(task.status),
        files: non_empty(task.files.clone()),
        active_form: task.active_form.clone(),
        group_id: task.group_id.clone(),
        group_title: task.group_title.clone(),
        group_subtitle: task.group_subtitle.clone(),
        risk_level: task.risk_level.map(risk_contract),
        requires_approval: task.requires_approval,
        approval_status: approval_contract(task.approval_status),
        acceptance_criteria: non_empty(task.acceptance_criteria.clone()),
        verification_command: task.verification_command.clone(),
        context_bundle: task.context_bundle.as_ref().map(context_contract),
    }
}

fn context_contract(context: &RuntimeContextBundle) -> TaskContextBundle {
    TaskContextBundle {
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

const fn status_contract(status: RuntimeStatus) -> TaskStatus {
    match status {
        RuntimeStatus::Pending => TaskStatus::Pending,
        RuntimeStatus::InProgress => TaskStatus::InProgress,
        RuntimeStatus::Completed => TaskStatus::Completed,
        RuntimeStatus::Cancelled => TaskStatus::Cancelled,
    }
}

const fn status_runtime(status: TaskStatus) -> RuntimeStatus {
    match status {
        TaskStatus::Pending => RuntimeStatus::Pending,
        TaskStatus::InProgress => RuntimeStatus::InProgress,
        TaskStatus::Completed => RuntimeStatus::Completed,
        TaskStatus::Cancelled => RuntimeStatus::Cancelled,
    }
}

const fn risk_contract(risk: RuntimeRiskLevel) -> TaskRiskLevel {
    match risk {
        RuntimeRiskLevel::Low => TaskRiskLevel::Low,
        RuntimeRiskLevel::Medium => TaskRiskLevel::Medium,
        RuntimeRiskLevel::High => TaskRiskLevel::High,
    }
}

const fn risk_runtime(risk: TaskRiskLevel) -> RuntimeRiskLevel {
    match risk {
        TaskRiskLevel::Low => RuntimeRiskLevel::Low,
        TaskRiskLevel::Medium => RuntimeRiskLevel::Medium,
        TaskRiskLevel::High => RuntimeRiskLevel::High,
    }
}

const fn approval_contract(status: RuntimeApprovalStatus) -> TaskApprovalStatus {
    match status {
        RuntimeApprovalStatus::NotRequired => TaskApprovalStatus::NotRequired,
        RuntimeApprovalStatus::Pending => TaskApprovalStatus::Pending,
        RuntimeApprovalStatus::Approved => TaskApprovalStatus::Approved,
        RuntimeApprovalStatus::ChangesRequested => TaskApprovalStatus::ChangesRequested,
        RuntimeApprovalStatus::Rejected => TaskApprovalStatus::Rejected,
    }
}

const fn approval_runtime(status: TaskApprovalStatus) -> RuntimeApprovalStatus {
    match status {
        TaskApprovalStatus::NotRequired => RuntimeApprovalStatus::NotRequired,
        TaskApprovalStatus::Pending => RuntimeApprovalStatus::Pending,
        TaskApprovalStatus::Approved => RuntimeApprovalStatus::Approved,
        TaskApprovalStatus::ChangesRequested => RuntimeApprovalStatus::ChangesRequested,
        TaskApprovalStatus::Rejected => RuntimeApprovalStatus::Rejected,
    }
}

#[cfg(test)]
mod tests {
    use codez_core::SessionId;
    use codez_runtime::task::{TaskApprovalStatus, TaskItem, TaskSnapshot, TaskStatus};

    use super::snapshot_contract;

    #[test]
    fn snapshot_conversion_preserves_identity_revision_and_optional_fields() {
        let snapshot = TaskSnapshot {
            version: 1,
            session_id: SessionId::parse("session-1").expect("fixture session ID must be valid"),
            revision: 4,
            next_sequence: 2,
            tasks: vec![TaskItem {
                id: "t1".to_string(),
                subject: "Implement task events".to_string(),
                description: String::new(),
                status: TaskStatus::Pending,
                files: Vec::new(),
                active_form: None,
                group_id: None,
                group_title: None,
                group_subtitle: None,
                risk_level: None,
                requires_approval: false,
                approval_status: TaskApprovalStatus::NotRequired,
                acceptance_criteria: Vec::new(),
                verification_command: None,
                context_bundle: None,
            }],
        };

        let contract = snapshot_contract(&snapshot);

        assert_eq!(
            (
                contract.session_id.as_str(),
                contract.revision,
                contract.tasks[0].files.as_ref()
            ),
            ("session-1", 4, None)
        );
    }
}
