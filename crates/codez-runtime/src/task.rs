use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use codez_core::{AppError, AtomicPersistence, SessionId};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const TASK_DIRECTORY: &str = "tasks";
const TASK_SNAPSHOT_VERSION: u16 = 1;
const MAX_TASK_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TASKS: usize = 256;
const MAX_SUBJECT_BYTES: usize = 512;
const MAX_DESCRIPTION_BYTES: usize = 32 * 1024;
const MAX_LABEL_BYTES: usize = 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024;
const MAX_LIST_ITEMS: usize = 128;
const MAX_LIST_ITEM_BYTES: usize = 4 * 1024;
const MAX_PROMPT_TODO_ITEMS: usize = 40;
const MAX_PROMPT_SUBJECT_CHARS: usize = 200;
const MAX_PROMPT_DESCRIPTION_CHARS: usize = 4_000;
const MAX_PROMPT_DETAIL_ITEMS: usize = 16;
const MAX_PROMPT_DETAIL_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl TaskStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskRiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskApprovalStatus {
    NotRequired,
    Pending,
    Approved,
    ChangesRequested,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskContextBundle {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub known_facts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded_directions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_references: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskItem {
    pub id: String,
    pub subject: String,
    pub description: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<TaskRiskLevel>,
    pub requires_approval: bool,
    pub approval_status: TaskApprovalStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance_criteria: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_bundle: Option<TaskContextBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSnapshot {
    pub version: u16,
    pub session_id: SessionId,
    pub revision: u64,
    pub next_sequence: u64,
    pub tasks: Vec<TaskItem>,
}

impl TaskSnapshot {
    fn empty(session_id: SessionId) -> Self {
        Self {
            version: TASK_SNAPSHOT_VERSION,
            session_id,
            revision: 0,
            next_sequence: 1,
            tasks: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCreateInput {
    pub subject: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub active_form: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub group_title: Option<String>,
    #[serde(default)]
    pub group_subtitle: Option<String>,
    #[serde(default)]
    pub risk_level: Option<TaskRiskLevel>,
    #[serde(default)]
    pub requires_approval: bool,
    #[serde(default)]
    pub approval_status: Option<TaskApprovalStatus>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub verification_command: Option<String>,
    #[serde(default)]
    pub context_bundle: Option<TaskContextBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskUpdateInput {
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    pub add_blocked_by: Vec<String>,
    #[serde(default)]
    pub remove_blocked_by: Vec<String>,
    #[serde(default)]
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub active_form: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub group_title: Option<String>,
    #[serde(default)]
    pub group_subtitle: Option<String>,
    #[serde(default)]
    pub risk_level: Option<TaskRiskLevel>,
    #[serde(default)]
    pub requires_approval: Option<bool>,
    #[serde(default)]
    pub approval_status: Option<TaskApprovalStatus>,
    #[serde(default)]
    pub acceptance_criteria: Option<Vec<String>>,
    #[serde(default)]
    pub verification_command: Option<String>,
    #[serde(default)]
    pub context_bundle: Option<TaskContextBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskItemUpdate {
    pub task_id: String,
    pub patch: TaskUpdateInput,
}

pub type TodoStatus = TaskStatus;
pub type TodoRiskLevel = TaskRiskLevel;
pub type TodoApprovalStatus = TaskApprovalStatus;
pub type TodoContextBundle = TaskContextBundle;
pub type TodoItem = TaskItem;
pub type TodoListSnapshot = TaskSnapshot;
pub type TodoCreateInput = TaskCreateInput;
pub type TodoItemPatch = TaskUpdateInput;
pub type TodoItemUpdate = TaskItemUpdate;

pub trait TaskEventSink: Send + Sync {
    fn emit(&self, snapshot: &TaskSnapshot) -> Result<(), AppError>;
}

#[derive(Default)]
struct NoopTaskEventSink;

impl TaskEventSink for NoopTaskEventSink {
    fn emit(&self, _snapshot: &TaskSnapshot) -> Result<(), AppError> {
        Ok(())
    }
}

#[derive(Default)]
struct SessionTaskState {
    snapshot: Option<TaskSnapshot>,
}

/// Durable, session-scoped owner for lightweight task tracking state.
pub struct TaskStore {
    root: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    events: Arc<dyn TaskEventSink>,
    sessions: DashMap<SessionId, Arc<Mutex<SessionTaskState>>>,
}

pub type TodoStore = TaskStore;

impl TaskStore {
    #[must_use]
    pub fn new(data_directory: &Path, persistence: Arc<dyn AtomicPersistence>) -> Self {
        Self::with_event_sink(data_directory, persistence, Arc::new(NoopTaskEventSink))
    }

    #[must_use]
    pub fn with_event_sink(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        events: Arc<dyn TaskEventSink>,
    ) -> Self {
        Self {
            root: data_directory.join(TASK_DIRECTORY),
            persistence,
            events,
            sessions: DashMap::new(),
        }
    }

    pub async fn snapshot(&self, session_id: &SessionId) -> Result<TaskSnapshot, AppError> {
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        state
            .snapshot
            .clone()
            .ok_or_else(|| AppError::internal("task snapshot was not loaded"))
    }

    pub async fn get(&self, session_id: &SessionId, task_id: &str) -> Result<TaskItem, AppError> {
        validate_task_id(task_id).map_err(AppError::validation)?;
        self.snapshot(session_id)
            .await?
            .tasks
            .into_iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| AppError::not_found("The task was not found"))
    }

    pub async fn create(
        &self,
        session_id: &SessionId,
        inputs: Vec<TaskCreateInput>,
    ) -> Result<TaskSnapshot, AppError> {
        if inputs.is_empty() {
            return Err(AppError::validation(
                "Task creation requires at least one task",
            ));
        }
        if inputs.len() > MAX_TASKS {
            return Err(AppError::validation("Too many tasks were requested"));
        }
        for input in &inputs {
            validate_create_input(input)?;
        }

        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        let mut next = state
            .snapshot
            .clone()
            .ok_or_else(|| AppError::internal("task snapshot was not loaded"))?;
        if next.tasks.iter().all(|task| task.status.is_terminal()) {
            next.tasks.clear();
        }
        if next.tasks.len().saturating_add(inputs.len()) > MAX_TASKS {
            return Err(AppError::conflict("The session task limit was reached"));
        }

        for input in inputs {
            let sequence = next.next_sequence;
            next.next_sequence = sequence.checked_add(1).ok_or_else(|| {
                AppError::storage(
                    "Task state cannot allocate another identifier",
                    "task sequence overflowed",
                    false,
                )
            })?;
            next.tasks.push(task_from_create(sequence, input));
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await
    }

    pub async fn update(
        &self,
        session_id: &SessionId,
        task_id: &str,
        mut patch: TaskUpdateInput,
    ) -> Result<TaskSnapshot, AppError> {
        let expected_revision = patch.expected_revision.take();
        self.update_batch(
            session_id,
            expected_revision,
            vec![TaskItemUpdate {
                task_id: task_id.to_string(),
                patch,
            }],
        )
        .await
    }

    pub async fn update_batch(
        &self,
        session_id: &SessionId,
        expected_revision: Option<u64>,
        updates: Vec<TaskItemUpdate>,
    ) -> Result<TaskSnapshot, AppError> {
        if updates.is_empty() {
            return Err(AppError::validation(
                "TodoUpdate requires at least one update",
            ));
        }
        if updates.len() > MAX_TASKS {
            return Err(AppError::validation("Too many Todo updates were requested"));
        }
        let mut identifiers = HashSet::with_capacity(updates.len());
        for update in &updates {
            validate_task_id(&update.task_id).map_err(AppError::validation)?;
            if !identifiers.insert(update.task_id.as_str()) {
                return Err(AppError::validation(
                    "TodoUpdate cannot update the same item more than once",
                ));
            }
            validate_update_input(&update.patch)?;
        }

        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        let mut next = state
            .snapshot
            .clone()
            .ok_or_else(|| AppError::internal("task snapshot was not loaded"))?;
        if let Some(expected_revision) = expected_revision {
            if expected_revision != next.revision {
                return Err(AppError::conflict(format!(
                    "Todo state changed since revision {expected_revision}; use the latest injected state at revision {}",
                    next.revision
                )));
            }
        }

        let previous = next.tasks.clone();
        for update in updates {
            let task = next
                .tasks
                .iter_mut()
                .find(|task| task.id == update.task_id)
                .ok_or_else(|| AppError::not_found("The Todo item was not found"))?;
            apply_patch(task, update.patch);
        }
        for task in &next.tasks {
            validate_task(task)?;
        }
        validate_task_graph(&next.tasks)?;
        for task_index in 0..next.tasks.len() {
            validate_task_admission(&next.tasks, task_index)?;
        }
        if next
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::InProgress)
            .count()
            > 1
        {
            return Err(AppError::conflict(
                "Another Todo item is already in progress for this session",
            ));
        }
        if next.tasks == previous {
            return Ok(next);
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await
    }

    pub async fn delete(
        &self,
        session_id: &SessionId,
        task_id: &str,
    ) -> Result<TaskSnapshot, AppError> {
        validate_task_id(task_id).map_err(AppError::validation)?;
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        let mut next = state
            .snapshot
            .clone()
            .ok_or_else(|| AppError::internal("task snapshot was not loaded"))?;
        let previous_len = next.tasks.len();
        next.tasks.retain(|task| task.id != task_id);
        if next.tasks.len() == previous_len {
            return Err(AppError::not_found("The task was not found"));
        }
        for task in &mut next.tasks {
            task.blocked_by.retain(|dependency| dependency != task_id);
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await
    }

    pub async fn cleanup_session(&self, session_id: &SessionId) -> Result<(), AppError> {
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.persistence.remove(&self.path_for(session_id)).await?;
        state.snapshot = Some(TaskSnapshot::empty(session_id.clone()));
        Ok(())
    }

    async fn ensure_loaded(
        &self,
        session_id: &SessionId,
        state: &mut SessionTaskState,
    ) -> Result<(), AppError> {
        if state.snapshot.is_some() {
            return Ok(());
        }
        let path = self.path_for(session_id);
        let snapshot = match self.persistence.read(&path).await? {
            Some(bytes) => decode_snapshot(session_id, &path, &bytes)?,
            None => TaskSnapshot::empty(session_id.clone()),
        };
        state.snapshot = Some(snapshot);
        Ok(())
    }

    async fn commit(
        &self,
        state: &mut SessionTaskState,
        snapshot: TaskSnapshot,
    ) -> Result<TaskSnapshot, AppError> {
        let path = self.path_for(&snapshot.session_id);
        let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|source| {
            AppError::internal(format!(
                "serialize task snapshot {}: {source}",
                path.display()
            ))
        })?;
        if bytes.len() > MAX_TASK_DOCUMENT_BYTES {
            return Err(AppError::validation("The task snapshot is too large"));
        }
        self.persistence.replace(&path, &bytes).await?;
        state.snapshot = Some(snapshot.clone());
        if let Err(error) = self.events.emit(&snapshot) {
            tracing::warn!(diagnostic = ?error.diagnostic(), "task snapshot event could not be emitted");
        }
        Ok(snapshot)
    }

    fn session_state(&self, session_id: &SessionId) -> Arc<Mutex<SessionTaskState>> {
        self.sessions
            .entry(session_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(SessionTaskState::default())))
            .clone()
    }

    fn path_for(&self, session_id: &SessionId) -> PathBuf {
        self.root.join(format!("{}.json", session_id.as_str()))
    }
}

#[must_use]
pub fn todo_prompt_state(snapshot: &TaskSnapshot) -> Option<String> {
    if snapshot.tasks.is_empty() {
        return None;
    }
    let active = snapshot
        .tasks
        .iter()
        .find(|task| task.status == TaskStatus::InProgress)
        .map(active_todo_prompt_value);
    let items = snapshot
        .tasks
        .iter()
        .take(MAX_PROMPT_TODO_ITEMS)
        .map(|task| {
            serde_json::json!({
                "id": task.id,
                "subject": bounded_prompt_text(&task.subject, MAX_PROMPT_SUBJECT_CHARS),
                "status": task.status,
                "blockedBy": bounded_prompt_list(&task.blocked_by),
                "requiresApproval": task.requires_approval,
                "approvalStatus": task.approval_status,
            })
        })
        .collect::<Vec<_>>();
    let completed = snapshot
        .tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Completed)
        .count();
    let pending = snapshot
        .tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Pending)
        .count();
    let cancelled = snapshot
        .tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Cancelled)
        .count();
    let value = serde_json::json!({
        "summary": {
            "total": snapshot.tasks.len(),
            "completed": completed,
            "pending": pending,
            "cancelled": cancelled,
            "omitted": snapshot.tasks.len().saturating_sub(items.len()),
        },
        "active": active,
        "items": items,
    });
    let encoded = serde_json::to_string(&value)
        .ok()?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    Some(format!(
        "<todo_state revision=\"{}\">\n{}\n</todo_state>",
        snapshot.revision, encoded
    ))
}

fn active_todo_prompt_value(task: &TaskItem) -> serde_json::Value {
    let context_bundle = task.context_bundle.as_ref().map(|bundle| {
        serde_json::json!({
            "knownFacts": bounded_prompt_list(&bundle.known_facts),
            "decisions": bounded_prompt_list(&bundle.decisions),
            "constraints": bounded_prompt_list(&bundle.constraints),
            "excludedDirections": bounded_prompt_list(&bundle.excluded_directions),
            "sourceReferences": bounded_prompt_list(&bundle.source_references),
        })
    });
    serde_json::json!({
        "id": task.id,
        "subject": bounded_prompt_text(&task.subject, MAX_PROMPT_SUBJECT_CHARS),
        "description": bounded_prompt_text(&task.description, MAX_PROMPT_DESCRIPTION_CHARS),
        "status": task.status,
        "blockedBy": bounded_prompt_list(&task.blocked_by),
        "files": bounded_prompt_list(&task.files),
        "riskLevel": task.risk_level,
        "requiresApproval": task.requires_approval,
        "approvalStatus": task.approval_status,
        "acceptanceCriteria": bounded_prompt_list(&task.acceptance_criteria),
        "verificationCommand": task.verification_command.as_deref().map(|value| bounded_prompt_text(value, MAX_PROMPT_DETAIL_CHARS)),
        "contextBundle": context_bundle,
    })
}

fn bounded_prompt_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .take(MAX_PROMPT_DETAIL_ITEMS)
        .map(|value| bounded_prompt_text(value, MAX_PROMPT_DETAIL_CHARS))
        .collect()
}

fn bounded_prompt_text(value: &str, maximum_chars: usize) -> String {
    let mut output = value.chars().take(maximum_chars).collect::<String>();
    if value.chars().count() > maximum_chars {
        output.push_str("...");
    }
    output
}

fn decode_snapshot(
    expected_session_id: &SessionId,
    path: &Path,
    bytes: &[u8],
) -> Result<TaskSnapshot, AppError> {
    if bytes.len() > MAX_TASK_DOCUMENT_BYTES {
        return Err(task_document_error(
            path,
            format!("document has {} bytes", bytes.len()),
        ));
    }
    let snapshot: TaskSnapshot = serde_json::from_slice(bytes)
        .map_err(|source| task_document_error(path, format!("parse JSON: {source}")))?;
    validate_snapshot(expected_session_id, path, &snapshot)?;
    Ok(snapshot)
}

fn validate_snapshot(
    expected_session_id: &SessionId,
    path: &Path,
    snapshot: &TaskSnapshot,
) -> Result<(), AppError> {
    if snapshot.version != TASK_SNAPSHOT_VERSION {
        return Err(task_document_error(
            path,
            format!("unsupported version {}", snapshot.version),
        ));
    }
    if &snapshot.session_id != expected_session_id {
        return Err(task_document_error(path, "session identity mismatch"));
    }
    if snapshot.tasks.len() > MAX_TASKS || snapshot.next_sequence == 0 {
        return Err(task_document_error(path, "invalid task snapshot bounds"));
    }
    let mut identifiers = HashSet::with_capacity(snapshot.tasks.len());
    let mut largest_sequence = 0;
    for task in &snapshot.tasks {
        let sequence =
            validate_task_id(&task.id).map_err(|message| task_document_error(path, message))?;
        if !identifiers.insert(task.id.as_str()) {
            return Err(task_document_error(path, "duplicate task identifier"));
        }
        largest_sequence = largest_sequence.max(sequence);
        validate_task(task).map_err(|error| {
            task_document_error(
                path,
                error
                    .diagnostic()
                    .unwrap_or_else(|| error.public_message())
                    .to_string(),
            )
        })?;
    }
    if snapshot.next_sequence <= largest_sequence {
        return Err(task_document_error(
            path,
            "next sequence does not follow persisted task identifiers",
        ));
    }
    if snapshot
        .tasks
        .iter()
        .filter(|task| task.status == TaskStatus::InProgress)
        .count()
        > 1
    {
        return Err(task_document_error(
            path,
            "multiple tasks are marked in progress",
        ));
    }
    validate_task_graph(&snapshot.tasks).map_err(|error| {
        task_document_error(
            path,
            error
                .diagnostic()
                .unwrap_or_else(|| error.public_message())
                .to_string(),
        )
    })?;
    for index in 0..snapshot.tasks.len() {
        validate_task_admission(&snapshot.tasks, index).map_err(|error| {
            task_document_error(
                path,
                error
                    .diagnostic()
                    .unwrap_or_else(|| error.public_message())
                    .to_string(),
            )
        })?;
    }
    Ok(())
}

fn task_document_error(path: &Path, diagnostic: impl Into<String>) -> AppError {
    AppError::storage(
        "The saved task state is invalid",
        format!("task document {}: {}", path.display(), diagnostic.into()),
        false,
    )
}

fn bump_revision(snapshot: &mut TaskSnapshot) -> Result<(), AppError> {
    snapshot.revision = snapshot.revision.checked_add(1).ok_or_else(|| {
        AppError::storage(
            "Task state cannot be updated",
            "task revision overflowed",
            false,
        )
    })?;
    Ok(())
}

fn task_from_create(sequence: u64, input: TaskCreateInput) -> TaskItem {
    let approval_status = input.approval_status.unwrap_or(if input.requires_approval {
        TaskApprovalStatus::Pending
    } else {
        TaskApprovalStatus::NotRequired
    });
    TaskItem {
        id: format!("t{sequence}"),
        subject: input.subject.trim().to_string(),
        description: input.description,
        status: TaskStatus::Pending,
        blocked_by: Vec::new(),
        files: input.files,
        active_form: input.active_form,
        group_id: input.group_id,
        group_title: input.group_title,
        group_subtitle: input.group_subtitle,
        risk_level: input.risk_level,
        requires_approval: input.requires_approval,
        approval_status,
        acceptance_criteria: input.acceptance_criteria,
        verification_command: input.verification_command,
        context_bundle: input.context_bundle,
    }
}

fn apply_patch(task: &mut TaskItem, patch: TaskUpdateInput) {
    if let Some(subject) = patch.subject {
        task.subject = subject.trim().to_string();
    }
    if let Some(description) = patch.description {
        task.description = description;
    }
    if let Some(status) = patch.status {
        task.status = status;
    }
    if !patch.remove_blocked_by.is_empty() {
        task.blocked_by
            .retain(|dependency| !patch.remove_blocked_by.contains(dependency));
    }
    task.blocked_by.extend(patch.add_blocked_by);
    if let Some(files) = patch.files {
        task.files = files;
    }
    if let Some(active_form) = patch.active_form {
        task.active_form = Some(active_form);
    }
    if let Some(group_id) = patch.group_id {
        task.group_id = Some(group_id);
    }
    if let Some(group_title) = patch.group_title {
        task.group_title = Some(group_title);
    }
    if let Some(group_subtitle) = patch.group_subtitle {
        task.group_subtitle = Some(group_subtitle);
    }
    if let Some(risk_level) = patch.risk_level {
        task.risk_level = Some(risk_level);
    }
    if let Some(requires_approval) = patch.requires_approval {
        task.requires_approval = requires_approval;
    }
    if let Some(approval_status) = patch.approval_status {
        task.approval_status = approval_status;
    }
    if let Some(acceptance_criteria) = patch.acceptance_criteria {
        task.acceptance_criteria = acceptance_criteria;
    }
    if let Some(verification_command) = patch.verification_command {
        task.verification_command = Some(verification_command);
    }
    if let Some(context_bundle) = patch.context_bundle {
        task.context_bundle = Some(context_bundle);
    }
}

fn validate_create_input(input: &TaskCreateInput) -> Result<(), AppError> {
    let task = task_from_create(1, input.clone());
    validate_task(&task)
}

fn validate_update_input(input: &TaskUpdateInput) -> Result<(), AppError> {
    if !has_task_mutation(input) {
        return Err(AppError::validation(
            "TaskUpdate requires at least one change",
        ));
    }
    if let Some(subject) = &input.subject {
        validate_required_text("Task subject", subject, MAX_SUBJECT_BYTES)?;
    }
    if let Some(description) = &input.description {
        validate_text("Task description", description, MAX_DESCRIPTION_BYTES)?;
    }
    validate_dependency_patch(input)?;
    if let Some(files) = &input.files {
        validate_files(files)?;
    }
    validate_optional_text(
        "Task active form",
        input.active_form.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text("Task group ID", input.group_id.as_deref(), MAX_LABEL_BYTES)?;
    validate_optional_text(
        "Task group title",
        input.group_title.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text(
        "Task group subtitle",
        input.group_subtitle.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    if let Some(criteria) = &input.acceptance_criteria {
        validate_string_list("Task acceptance criteria", criteria)?;
    }
    validate_optional_text(
        "Task verification command",
        input.verification_command.as_deref(),
        MAX_COMMAND_BYTES,
    )?;
    if let Some(bundle) = &input.context_bundle {
        validate_context_bundle(bundle)?;
    }
    Ok(())
}

fn validate_task(task: &TaskItem) -> Result<(), AppError> {
    validate_task_id(&task.id).map_err(AppError::validation)?;
    validate_required_text("Task subject", &task.subject, MAX_SUBJECT_BYTES)?;
    validate_text("Task description", &task.description, MAX_DESCRIPTION_BYTES)?;
    validate_dependency_list(task)?;
    validate_files(&task.files)?;
    validate_optional_text(
        "Task active form",
        task.active_form.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text("Task group ID", task.group_id.as_deref(), MAX_LABEL_BYTES)?;
    validate_optional_text(
        "Task group title",
        task.group_title.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text(
        "Task group subtitle",
        task.group_subtitle.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_string_list("Task acceptance criteria", &task.acceptance_criteria)?;
    validate_optional_text(
        "Task verification command",
        task.verification_command.as_deref(),
        MAX_COMMAND_BYTES,
    )?;
    if let Some(bundle) = &task.context_bundle {
        validate_context_bundle(bundle)?;
    }
    if task.requires_approval && task.approval_status == TaskApprovalStatus::NotRequired {
        return Err(AppError::validation(
            "A task requiring approval cannot be marked not required",
        ));
    }
    if !task.requires_approval && task.approval_status != TaskApprovalStatus::NotRequired {
        return Err(AppError::validation(
            "A task without approval requirements must be marked not required",
        ));
    }
    Ok(())
}

fn has_task_mutation(input: &TaskUpdateInput) -> bool {
    input.subject.is_some()
        || input.description.is_some()
        || input.status.is_some()
        || !input.add_blocked_by.is_empty()
        || !input.remove_blocked_by.is_empty()
        || input.files.is_some()
        || input.active_form.is_some()
        || input.group_id.is_some()
        || input.group_title.is_some()
        || input.group_subtitle.is_some()
        || input.risk_level.is_some()
        || input.requires_approval.is_some()
        || input.approval_status.is_some()
        || input.acceptance_criteria.is_some()
        || input.verification_command.is_some()
        || input.context_bundle.is_some()
}

fn validate_dependency_patch(input: &TaskUpdateInput) -> Result<(), AppError> {
    validate_task_ids("Task dependencies to add", &input.add_blocked_by)?;
    validate_task_ids("Task dependencies to remove", &input.remove_blocked_by)?;
    if input
        .add_blocked_by
        .iter()
        .any(|dependency| input.remove_blocked_by.contains(dependency))
    {
        return Err(AppError::validation(
            "A task dependency cannot be added and removed in the same update",
        ));
    }
    Ok(())
}

fn validate_dependency_list(task: &TaskItem) -> Result<(), AppError> {
    validate_task_ids("Task blockedBy", &task.blocked_by)?;
    if task
        .blocked_by
        .iter()
        .any(|dependency| dependency == &task.id)
    {
        return Err(AppError::validation("A task cannot depend on itself"));
    }
    Ok(())
}

fn validate_task_ids(field: &str, task_ids: &[String]) -> Result<(), AppError> {
    if task_ids.len() > MAX_LIST_ITEMS {
        return Err(AppError::validation(format!("{field} is too large")));
    }
    let mut identifiers = HashSet::with_capacity(task_ids.len());
    for task_id in task_ids {
        validate_task_id(task_id).map_err(AppError::validation)?;
        if !identifiers.insert(task_id.as_str()) {
            return Err(AppError::validation(format!(
                "{field} contains a duplicate task identifier"
            )));
        }
    }
    Ok(())
}

fn validate_task_graph(tasks: &[TaskItem]) -> Result<(), AppError> {
    for task in tasks {
        for dependency in &task.blocked_by {
            if !tasks.iter().any(|candidate| candidate.id == *dependency) {
                return Err(AppError::conflict(format!(
                    "Task {} depends on missing task {dependency}",
                    task.id
                )));
            }
        }
    }

    let mut states = vec![0_u8; tasks.len()];
    for index in 0..tasks.len() {
        visit_task_dependencies(tasks, index, &mut states)?;
    }
    Ok(())
}

fn visit_task_dependencies(
    tasks: &[TaskItem],
    index: usize,
    states: &mut [u8],
) -> Result<(), AppError> {
    match states[index] {
        1 => {
            return Err(AppError::conflict(
                "Task dependencies cannot contain a cycle",
            ));
        }
        2 => return Ok(()),
        _ => {}
    }
    states[index] = 1;
    for dependency in &tasks[index].blocked_by {
        let dependency_index = tasks
            .iter()
            .position(|candidate| candidate.id == *dependency)
            .ok_or_else(|| {
                AppError::conflict(format!(
                    "Task {} depends on missing task {dependency}",
                    tasks[index].id
                ))
            })?;
        visit_task_dependencies(tasks, dependency_index, states)?;
    }
    states[index] = 2;
    Ok(())
}

fn validate_task_admission(tasks: &[TaskItem], index: usize) -> Result<(), AppError> {
    let task = &tasks[index];
    if !matches!(task.status, TaskStatus::InProgress | TaskStatus::Completed) {
        return Ok(());
    }
    if task.requires_approval && task.approval_status != TaskApprovalStatus::Approved {
        return Err(AppError::conflict(format!(
            "Task {} requires approval before it can start or complete",
            task.id
        )));
    }
    let unfinished = task
        .blocked_by
        .iter()
        .filter(|dependency| {
            tasks
                .iter()
                .find(|candidate| candidate.id == dependency.as_str())
                .is_none_or(|candidate| candidate.status != TaskStatus::Completed)
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unfinished.is_empty() {
        return Err(AppError::conflict(format!(
            "Task {} is blocked by unfinished dependencies: {}",
            task.id,
            unfinished.join(", ")
        )));
    }
    Ok(())
}

fn validate_task_id(value: &str) -> Result<u64, &'static str> {
    let digits = value
        .strip_prefix('t')
        .ok_or("Task identifiers must use the t<number> format")?;
    if digits.is_empty()
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Task identifiers must use the t<number> format");
    }
    digits
        .parse::<u64>()
        .ok()
        .filter(|sequence| *sequence > 0)
        .ok_or("Task identifier is out of range")
}

fn validate_required_text(field: &str, value: &str, maximum_bytes: usize) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::validation(format!("{field} cannot be empty")));
    }
    validate_text(field, value, maximum_bytes)
}

fn validate_optional_text(
    field: &str,
    value: Option<&str>,
    maximum_bytes: usize,
) -> Result<(), AppError> {
    if let Some(value) = value {
        validate_required_text(field, value, maximum_bytes)?;
    }
    Ok(())
}

fn validate_text(field: &str, value: &str, maximum_bytes: usize) -> Result<(), AppError> {
    if value.len() > maximum_bytes || value.contains('\0') {
        return Err(AppError::validation(format!(
            "{field} is invalid or too large"
        )));
    }
    Ok(())
}

fn validate_files(files: &[String]) -> Result<(), AppError> {
    if files.len() > MAX_LIST_ITEMS {
        return Err(AppError::validation("Task file list is too large"));
    }
    for file in files {
        validate_required_text("Task file", file, MAX_LIST_ITEM_BYTES)?;
        let path = Path::new(file);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(AppError::validation(
                "Task files must be relative workspace paths",
            ));
        }
    }
    Ok(())
}

fn validate_string_list(field: &str, values: &[String]) -> Result<(), AppError> {
    if values.len() > MAX_LIST_ITEMS {
        return Err(AppError::validation(format!("{field} is too large")));
    }
    for value in values {
        validate_required_text(field, value, MAX_LIST_ITEM_BYTES)?;
    }
    Ok(())
}

fn validate_context_bundle(bundle: &TaskContextBundle) -> Result<(), AppError> {
    validate_string_list("Task known facts", &bundle.known_facts)?;
    validate_string_list("Task decisions", &bundle.decisions)?;
    validate_string_list("Task constraints", &bundle.constraints)?;
    validate_string_list("Task excluded directions", &bundle.excluded_directions)?;
    validate_string_list("Task source references", &bundle.source_references)
}

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    use codez_core::{
        AppError, AppErrorKind, AtomicCreateOutcome, AtomicPersistence, PortFuture, SessionId,
    };
    use codez_storage::AtomicFileStore;

    use super::{
        TaskApprovalStatus, TaskCreateInput, TaskEventSink, TaskItem, TaskItemUpdate, TaskSnapshot,
        TaskStatus, TaskStore, TaskUpdateInput, todo_prompt_state,
    };

    #[derive(Default)]
    struct RecordingEvents {
        revisions: StdMutex<Vec<u64>>,
    }

    impl TaskEventSink for RecordingEvents {
        fn emit(&self, snapshot: &TaskSnapshot) -> Result<(), AppError> {
            self.revisions
                .lock()
                .expect("event fixture lock must remain available")
                .push(snapshot.revision);
            Ok(())
        }
    }

    struct FailingPersistence {
        inner: AtomicFileStore,
        fail_next_replace: AtomicBool,
    }

    impl FailingPersistence {
        fn new() -> Self {
            Self {
                inner: AtomicFileStore::default(),
                fail_next_replace: AtomicBool::new(false),
            }
        }
    }

    impl AtomicPersistence for FailingPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            self.inner.read(path)
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                if self.fail_next_replace.swap(false, Ordering::SeqCst) {
                    return Err(AppError::storage(
                        "The task state could not be saved",
                        "injected task persistence failure",
                        true,
                    ));
                }
                self.inner.replace(path, bytes).await
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            self.inner.create_no_clobber(path, bytes)
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            self.inner.append(path, bytes)
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            self.inner.remove(path)
        }
    }

    fn session(value: &str) -> SessionId {
        SessionId::parse(value).expect("fixture session ID must be valid")
    }

    fn input(subject: impl Into<String>) -> TaskCreateInput {
        TaskCreateInput {
            subject: subject.into(),
            description: String::new(),
            files: Vec::new(),
            active_form: None,
            group_id: None,
            group_title: None,
            group_subtitle: None,
            risk_level: None,
            requires_approval: false,
            approval_status: None,
            acceptance_criteria: Vec::new(),
            verification_command: None,
            context_bundle: None,
        }
    }

    #[tokio::test]
    async fn concurrent_creates_preserve_every_task_and_revision() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TaskStore::new(directory.path(), persistence));
        let session_id = session("session-1");
        let mut workers = Vec::new();
        for index in 0..32 {
            let store = Arc::clone(&store);
            let session_id = session_id.clone();
            workers.push(tokio::spawn(async move {
                store
                    .create(&session_id, vec![input(format!("task {index}"))])
                    .await
            }));
        }
        for worker in workers {
            worker
                .await
                .expect("task worker must join")
                .expect("concurrent task create must succeed");
        }

        let snapshot = store
            .snapshot(&session_id)
            .await
            .expect("task snapshot must load");
        assert_eq!(
            (
                snapshot.tasks.len(),
                snapshot.revision,
                snapshot.next_sequence
            ),
            (32, 32, 33)
        );
    }

    #[tokio::test]
    async fn failed_replace_preserves_the_old_snapshot_and_emits_no_event() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence = Arc::new(FailingPersistence::new());
        let events = Arc::new(RecordingEvents::default());
        let store =
            TaskStore::with_event_sink(directory.path(), persistence.clone(), events.clone());
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first")])
            .await
            .expect("initial task create must succeed");
        persistence.fail_next_replace.store(true, Ordering::SeqCst);

        let error = store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("injected replacement must fail");
        let snapshot = store
            .snapshot(&session_id)
            .await
            .expect("old task snapshot must remain readable");
        assert_eq!(error.kind(), AppErrorKind::Storage);
        assert_eq!(
            (snapshot.revision, snapshot.tasks[0].status),
            (1, TaskStatus::Pending)
        );
        assert_eq!(
            events
                .revisions
                .lock()
                .expect("event fixture lock must remain available")
                .as_slice(),
            &[1]
        );
    }

    #[tokio::test]
    async fn snapshot_recovers_after_store_recreation_and_cleanup_is_durable() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let session_id = session("session-1");
        TaskStore::new(directory.path(), Arc::clone(&persistence))
            .create(&session_id, vec![input("persisted")])
            .await
            .expect("task create must persist");
        let restarted = TaskStore::new(directory.path(), Arc::clone(&persistence));
        let recovered = restarted
            .snapshot(&session_id)
            .await
            .expect("task snapshot must recover");
        assert_eq!(recovered.tasks[0].subject, "persisted");

        restarted
            .cleanup_session(&session_id)
            .await
            .expect("task cleanup must succeed");
        let after_cleanup = TaskStore::new(directory.path(), persistence)
            .snapshot(&session_id)
            .await
            .expect("cleaned task snapshot must be empty");
        assert!(after_cleanup.tasks.is_empty() && after_cleanup.revision == 0);
    }

    #[tokio::test]
    async fn invalid_persisted_documents_fail_closed() {
        let cases = [
            r#"{"version":1,"sessionId":"other-session","revision":0,"nextSequence":1,"tasks":[]}"#,
            r#"{"version":1,"sessionId":"session-1","revision":0,"nextSequence":2,"tasks":[{"id":"t1","subject":"a","description":"","status":"pending","requiresApproval":false,"approvalStatus":"not_required"},{"id":"t1","subject":"b","description":"","status":"pending","requiresApproval":false,"approvalStatus":"not_required"}]}"#,
            r#"{"version":1,"sessionId":"session-1","revision":0,"nextSequence":2,"tasks":[{"id":"t1","subject":"a","description":"","status":"unknown","requiresApproval":false,"approvalStatus":"not_required"}]}"#,
        ];
        for document in cases {
            let directory = tempfile::tempdir().expect("temporary directory must be available");
            let task_directory = directory.path().join("tasks");
            std::fs::create_dir_all(&task_directory)
                .expect("task fixture directory must be created");
            std::fs::write(task_directory.join("session-1.json"), document)
                .expect("invalid task fixture must be written");
            let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
            let error = store
                .snapshot(&session("session-1"))
                .await
                .expect_err("invalid task document must fail closed");
            assert_eq!(error.kind(), AppErrorKind::Storage);
        }
    }

    #[tokio::test]
    async fn oversized_document_and_cross_session_access_fail_closed() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = TaskStore::new(directory.path(), Arc::clone(&persistence));
        let owner = session("session-1");
        store
            .create(&owner, vec![input("owned")])
            .await
            .expect("owner task create must succeed");
        let error = store
            .get(&session("session-2"), "t1")
            .await
            .expect_err("another session must not access the task");
        assert_eq!(error.kind(), AppErrorKind::NotFound);

        let oversized_session = session("session-3");
        let oversized_path = directory.path().join("tasks/session-3.json");
        std::fs::write(
            &oversized_path,
            vec![b' '; super::MAX_TASK_DOCUMENT_BYTES + 1],
        )
        .expect("oversized task fixture must be written");
        let error = store
            .snapshot(&oversized_session)
            .await
            .expect_err("oversized task document must fail closed");
        assert_eq!(error.kind(), AppErrorKind::Storage);
    }

    #[tokio::test]
    async fn in_progress_admission_is_atomic() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = Arc::new(TaskStore::new(
            directory.path(),
            Arc::new(AtomicFileStore::default()),
        ));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first"), input("second")])
            .await
            .expect("task create must succeed");
        let mut workers = Vec::new();
        for task_id in ["t1", "t2"] {
            let store = Arc::clone(&store);
            let session_id = session_id.clone();
            workers.push(tokio::spawn(async move {
                store
                    .update(
                        &session_id,
                        task_id,
                        TaskUpdateInput {
                            status: Some(TaskStatus::InProgress),
                            ..TaskUpdateInput::default()
                        },
                    )
                    .await
            }));
        }
        let mut successes = 0;
        for worker in workers {
            if worker.await.expect("task worker must join").is_ok() {
                successes += 1;
            }
        }
        let snapshot = store
            .snapshot(&session_id)
            .await
            .expect("task snapshot must load");
        assert_eq!(successes, 1);
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .filter(|task| task.status == TaskStatus::InProgress)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn unfinished_dependency_blocks_start_until_completed() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("task create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency update must succeed");

        let error = store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("unfinished dependency must block admission");
        assert_eq!(error.kind(), AppErrorKind::Conflict);

        store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency must start");
        store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::Completed),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency must complete");
        let snapshot = store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("completed dependency must unblock admission");

        assert_eq!(snapshot.tasks[1].status, TaskStatus::InProgress);
    }

    #[tokio::test]
    async fn unfinished_dependency_blocks_completion() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("task create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency update must succeed");

        let error = store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    status: Some(TaskStatus::Completed),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("unfinished dependency must block completion");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn dependencies_survive_store_recreation() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let session_id = session("session-1");
        let store = TaskStore::new(directory.path(), Arc::clone(&persistence));
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("task create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency update must persist");

        let recovered = TaskStore::new(directory.path(), persistence)
            .snapshot(&session_id)
            .await
            .expect("task snapshot must recover");

        assert_eq!(recovered.tasks[1].blocked_by, ["t1"]);
    }

    #[tokio::test]
    async fn reopening_dependency_cannot_reblock_active_dependent() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("task create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency update must succeed");
        store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::Completed),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency must complete");
        store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependent must start");

        let error = store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::Pending),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("active dependent cannot be reblocked");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn dependency_update_rejects_self_dependency() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("task")])
            .await
            .expect("task create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("self dependency must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn dependency_update_rejects_missing_task() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("task")])
            .await
            .expect("task create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    add_blocked_by: vec!["t2".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("missing dependency must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn dependency_update_rejects_duplicate_identifier() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("task create must succeed");

        let error = store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string(), "t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("duplicate dependency must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn dependency_update_rejects_cycle() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first"), input("second")])
            .await
            .expect("task create must succeed");
        store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    add_blocked_by: vec!["t2".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("first dependency must be accepted");

        let error = store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("dependency cycle must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn stale_expected_revision_rejects_update() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("task")])
            .await
            .expect("task create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    expected_revision: Some(0),
                    subject: Some("stale update".to_string()),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("stale revision must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn approval_required_task_cannot_start_before_approval() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        let mut approval_task = input("approval task");
        approval_task.requires_approval = true;
        store
            .create(&session_id, vec![approval_task])
            .await
            .expect("task create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect_err("pending approval must block admission");
        assert_eq!(error.kind(), AppErrorKind::Conflict);

        let snapshot = store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    approval_status: Some(TaskApprovalStatus::Approved),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("approval and admission may be committed atomically");
        assert_eq!(snapshot.tasks[0].status, TaskStatus::InProgress);
    }

    #[tokio::test]
    async fn empty_update_is_rejected() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("task")])
            .await
            .expect("task create must succeed");

        let error = store
            .update(&session_id, "t1", TaskUpdateInput::default())
            .await
            .expect_err("empty update must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn deleting_task_removes_it_from_dependencies() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("task create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TaskUpdateInput {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("dependency update must succeed");

        let snapshot = store
            .delete(&session_id, "t1")
            .await
            .expect("task deletion must succeed");

        assert!(snapshot.tasks[0].blocked_by.is_empty());
    }

    #[tokio::test]
    async fn batch_update_validates_the_final_state_and_emits_once() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let events = Arc::new(RecordingEvents::default());
        let event_sink: Arc<dyn TaskEventSink> = events.clone();
        let store = TaskStore::with_event_sink(
            directory.path(),
            Arc::new(AtomicFileStore::default()),
            event_sink,
        );
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first"), input("second")])
            .await
            .expect("Todo creation must succeed");
        store
            .update(
                &session_id,
                "t1",
                TaskUpdateInput {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdateInput::default()
                },
            )
            .await
            .expect("first Todo must start");

        let snapshot = store
            .update_batch(
                &session_id,
                Some(2),
                vec![
                    TaskItemUpdate {
                        task_id: "t1".to_string(),
                        patch: TaskUpdateInput {
                            status: Some(TaskStatus::Completed),
                            ..TaskUpdateInput::default()
                        },
                    },
                    TaskItemUpdate {
                        task_id: "t2".to_string(),
                        patch: TaskUpdateInput {
                            status: Some(TaskStatus::InProgress),
                            ..TaskUpdateInput::default()
                        },
                    },
                ],
            )
            .await
            .expect("final batch state must be valid");

        assert_eq!(
            (
                snapshot.revision,
                snapshot.tasks[0].status,
                snapshot.tasks[1].status,
                events
                    .revisions
                    .lock()
                    .expect("event fixture lock must remain available")
                    .as_slice(),
            ),
            (
                3,
                TaskStatus::Completed,
                TaskStatus::InProgress,
                &[1, 2, 3][..],
            )
        );
    }

    #[tokio::test]
    async fn batch_update_rejects_duplicate_ids_without_mutating_state() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TaskStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first")])
            .await
            .expect("Todo creation must succeed");

        let error = store
            .update_batch(
                &session_id,
                Some(1),
                vec![
                    TaskItemUpdate {
                        task_id: "t1".to_string(),
                        patch: TaskUpdateInput {
                            subject: Some("changed once".to_string()),
                            ..TaskUpdateInput::default()
                        },
                    },
                    TaskItemUpdate {
                        task_id: "t1".to_string(),
                        patch: TaskUpdateInput {
                            subject: Some("changed twice".to_string()),
                            ..TaskUpdateInput::default()
                        },
                    },
                ],
            )
            .await
            .expect_err("duplicate Todo ids must be rejected");
        let snapshot = store
            .snapshot(&session_id)
            .await
            .expect("Todo snapshot must remain readable");

        assert_eq!(
            (
                error.kind(),
                snapshot.revision,
                snapshot.tasks[0].subject.as_str()
            ),
            (AppErrorKind::Validation, 1, "first")
        );
    }

    #[test]
    fn todo_prompt_state_is_bounded_and_escapes_markup() {
        let snapshot = TaskSnapshot {
            version: 1,
            session_id: session("session-1"),
            revision: 7,
            next_sequence: 2,
            tasks: vec![TaskItem {
                id: "t1".to_string(),
                subject: "active <item>".to_string(),
                description: "x".repeat(super::MAX_PROMPT_DESCRIPTION_CHARS + 100),
                status: TaskStatus::InProgress,
                blocked_by: Vec::new(),
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

        let state = todo_prompt_state(&snapshot).expect("non-empty Todo state must render");

        assert!(
            state.starts_with("<todo_state revision=\"7\">")
                && state.contains("active \\u003citem\\u003e")
                && state.contains(&format!(
                    "{}...",
                    "x".repeat(super::MAX_PROMPT_DESCRIPTION_CHARS)
                ))
                && !state.contains("active <item>")
        );
    }
}
