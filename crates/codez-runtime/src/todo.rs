use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use codez_core::{AppError, AtomicPersistence, SessionId};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

// Keep the legacy directory name so existing sessions remain readable after the Todo rename.
const TODO_DIRECTORY: &str = "tasks";
const TODO_SNAPSHOT_VERSION: u16 = 1;
const MAX_TODO_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TODOS: usize = 256;
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
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl TodoStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoRiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoApprovalStatus {
    NotRequired,
    Pending,
    Approved,
    ChangesRequested,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoContextBundle {
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
pub struct TodoItem {
    pub id: String,
    pub subject: String,
    pub description: String,
    pub status: TodoStatus,
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
    pub risk_level: Option<TodoRiskLevel>,
    pub requires_approval: bool,
    pub approval_status: TodoApprovalStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance_criteria: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_bundle: Option<TodoContextBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoListSnapshot {
    pub version: u16,
    pub session_id: SessionId,
    pub revision: u64,
    pub next_sequence: u64,
    #[serde(default, rename = "tasks", alias = "items")]
    pub items: Vec<TodoItem>,
}

impl TodoListSnapshot {
    fn empty(session_id: SessionId) -> Self {
        Self {
            version: TODO_SNAPSHOT_VERSION,
            session_id,
            revision: 0,
            next_sequence: 1,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoCreateInput {
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
    pub risk_level: Option<TodoRiskLevel>,
    #[serde(default)]
    pub requires_approval: bool,
    #[serde(default)]
    pub approval_status: Option<TodoApprovalStatus>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub verification_command: Option<String>,
    #[serde(default)]
    pub context_bundle: Option<TodoContextBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoItemPatch {
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<TodoStatus>,
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
    pub risk_level: Option<TodoRiskLevel>,
    #[serde(default)]
    pub requires_approval: Option<bool>,
    #[serde(default)]
    pub approval_status: Option<TodoApprovalStatus>,
    #[serde(default)]
    pub acceptance_criteria: Option<Vec<String>>,
    #[serde(default)]
    pub verification_command: Option<String>,
    #[serde(default)]
    pub context_bundle: Option<TodoContextBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItemUpdate {
    pub todo_id: String,
    pub patch: TodoItemPatch,
}

pub trait TodoEventSink: Send + Sync {
    fn emit(&self, snapshot: &TodoListSnapshot) -> Result<(), AppError>;
}

#[derive(Default)]
struct NoopTodoEventSink;

impl TodoEventSink for NoopTodoEventSink {
    fn emit(&self, _snapshot: &TodoListSnapshot) -> Result<(), AppError> {
        Ok(())
    }
}

#[derive(Default)]
struct SessionTodoState {
    snapshot: Option<TodoListSnapshot>,
}

/// Durable, session-scoped owner for lightweight todo tracking state.
pub struct TodoStore {
    root: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    events: Arc<dyn TodoEventSink>,
    sessions: DashMap<SessionId, Arc<Mutex<SessionTodoState>>>,
}

impl TodoStore {
    #[must_use]
    pub fn new(data_directory: &Path, persistence: Arc<dyn AtomicPersistence>) -> Self {
        Self::with_event_sink(data_directory, persistence, Arc::new(NoopTodoEventSink))
    }

    #[must_use]
    pub fn with_event_sink(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        events: Arc<dyn TodoEventSink>,
    ) -> Self {
        Self {
            root: data_directory.join(TODO_DIRECTORY),
            persistence,
            events,
            sessions: DashMap::new(),
        }
    }

    pub async fn snapshot(&self, session_id: &SessionId) -> Result<TodoListSnapshot, AppError> {
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        state
            .snapshot
            .clone()
            .ok_or_else(|| AppError::internal("todo snapshot was not loaded"))
    }

    pub async fn get(&self, session_id: &SessionId, todo_id: &str) -> Result<TodoItem, AppError> {
        validate_todo_id(todo_id).map_err(AppError::validation)?;
        self.snapshot(session_id)
            .await?
            .items
            .into_iter()
            .find(|todo| todo.id == todo_id)
            .ok_or_else(|| AppError::not_found("The todo was not found"))
    }

    pub async fn create(
        &self,
        session_id: &SessionId,
        inputs: Vec<TodoCreateInput>,
    ) -> Result<TodoListSnapshot, AppError> {
        if inputs.is_empty() {
            return Err(AppError::validation(
                "Todo creation requires at least one todo",
            ));
        }
        if inputs.len() > MAX_TODOS {
            return Err(AppError::validation("Too many items were requested"));
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
            .ok_or_else(|| AppError::internal("todo snapshot was not loaded"))?;
        if next.items.iter().all(|todo| todo.status.is_terminal()) {
            next.items.clear();
        }
        if next.items.len().saturating_add(inputs.len()) > MAX_TODOS {
            return Err(AppError::conflict("The session todo limit was reached"));
        }

        for input in inputs {
            let sequence = next.next_sequence;
            next.next_sequence = sequence.checked_add(1).ok_or_else(|| {
                AppError::storage(
                    "Todo state cannot allocate another identifier",
                    "todo sequence overflowed",
                    false,
                )
            })?;
            next.items.push(todo_from_create(sequence, input));
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await
    }

    pub async fn update(
        &self,
        session_id: &SessionId,
        todo_id: &str,
        mut patch: TodoItemPatch,
    ) -> Result<TodoListSnapshot, AppError> {
        let expected_revision = patch.expected_revision.take();
        self.update_batch(
            session_id,
            expected_revision,
            vec![TodoItemUpdate {
                todo_id: todo_id.to_string(),
                patch,
            }],
        )
        .await
    }

    pub async fn update_batch(
        &self,
        session_id: &SessionId,
        expected_revision: Option<u64>,
        updates: Vec<TodoItemUpdate>,
    ) -> Result<TodoListSnapshot, AppError> {
        if updates.is_empty() {
            return Err(AppError::validation(
                "TodoUpdate requires at least one update",
            ));
        }
        if updates.len() > MAX_TODOS {
            return Err(AppError::validation("Too many Todo updates were requested"));
        }
        let mut identifiers = HashSet::with_capacity(updates.len());
        for update in &updates {
            validate_todo_id(&update.todo_id).map_err(AppError::validation)?;
            if !identifiers.insert(update.todo_id.as_str()) {
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
            .ok_or_else(|| AppError::internal("todo snapshot was not loaded"))?;
        if let Some(expected_revision) = expected_revision {
            if expected_revision != next.revision {
                return Err(AppError::conflict(format!(
                    "Todo state changed since revision {expected_revision}; use the latest injected state at revision {}",
                    next.revision
                )));
            }
        }

        let previous = next.items.clone();
        for update in updates {
            let todo = next
                .items
                .iter_mut()
                .find(|todo| todo.id == update.todo_id)
                .ok_or_else(|| AppError::not_found("The Todo item was not found"))?;
            apply_patch(todo, update.patch);
        }
        validate_approval_policy_transitions(&previous, &next.items)?;
        for todo in &next.items {
            validate_todo(todo)?;
        }
        validate_todo_graph(&next.items)?;
        for todo_index in 0..next.items.len() {
            validate_todo_admission(&next.items, todo_index)?;
        }
        if next
            .items
            .iter()
            .filter(|todo| todo.status == TodoStatus::InProgress)
            .count()
            > 1
        {
            return Err(AppError::conflict(
                "Another Todo item is already in progress for this session",
            ));
        }
        if next.items == previous {
            return Ok(next);
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await
    }

    pub async fn delete(
        &self,
        session_id: &SessionId,
        todo_id: &str,
    ) -> Result<TodoListSnapshot, AppError> {
        validate_todo_id(todo_id).map_err(AppError::validation)?;
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.ensure_loaded(session_id, &mut state).await?;
        let mut next = state
            .snapshot
            .clone()
            .ok_or_else(|| AppError::internal("todo snapshot was not loaded"))?;
        let previous_len = next.items.len();
        next.items.retain(|todo| todo.id != todo_id);
        if next.items.len() == previous_len {
            return Err(AppError::not_found("The todo was not found"));
        }
        for todo in &mut next.items {
            todo.blocked_by.retain(|dependency| dependency != todo_id);
        }
        bump_revision(&mut next)?;
        self.commit(&mut state, next).await
    }

    pub async fn cleanup_session(&self, session_id: &SessionId) -> Result<(), AppError> {
        let state = self.session_state(session_id);
        let mut state = state.lock().await;
        self.persistence.remove(&self.path_for(session_id)).await?;
        state.snapshot = Some(TodoListSnapshot::empty(session_id.clone()));
        Ok(())
    }

    async fn ensure_loaded(
        &self,
        session_id: &SessionId,
        state: &mut SessionTodoState,
    ) -> Result<(), AppError> {
        if state.snapshot.is_some() {
            return Ok(());
        }
        let path = self.path_for(session_id);
        let snapshot = match self.persistence.read(&path).await? {
            Some(bytes) => decode_snapshot(session_id, &path, &bytes)?,
            None => TodoListSnapshot::empty(session_id.clone()),
        };
        state.snapshot = Some(snapshot);
        Ok(())
    }

    async fn commit(
        &self,
        state: &mut SessionTodoState,
        snapshot: TodoListSnapshot,
    ) -> Result<TodoListSnapshot, AppError> {
        let path = self.path_for(&snapshot.session_id);
        let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|source| {
            AppError::internal(format!(
                "serialize todo snapshot {}: {source}",
                path.display()
            ))
        })?;
        if bytes.len() > MAX_TODO_DOCUMENT_BYTES {
            return Err(AppError::validation("The todo snapshot is too large"));
        }
        self.persistence.replace(&path, &bytes).await?;
        state.snapshot = Some(snapshot.clone());
        if let Err(error) = self.events.emit(&snapshot) {
            tracing::warn!(diagnostic = ?error.diagnostic(), "todo snapshot event could not be emitted");
        }
        Ok(snapshot)
    }

    fn session_state(&self, session_id: &SessionId) -> Arc<Mutex<SessionTodoState>> {
        self.sessions
            .entry(session_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(SessionTodoState::default())))
            .clone()
    }

    fn path_for(&self, session_id: &SessionId) -> PathBuf {
        self.root.join(format!("{}.json", session_id.as_str()))
    }
}

#[must_use]
pub fn todo_prompt_state(snapshot: &TodoListSnapshot) -> Option<String> {
    if snapshot.items.is_empty() {
        return None;
    }
    let value = todo_model_state(snapshot);
    let encoded = serde_json::to_string(&value)
        .ok()?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    Some(format!(
        "<todo_state revision=\"{}\">\n{}\n</todo_state>",
        snapshot.revision, encoded
    ))
}

/// Builds the bounded authoritative projection used in prompts and tool conflict responses.
#[must_use]
pub fn todo_model_state(snapshot: &TodoListSnapshot) -> serde_json::Value {
    let active = snapshot
        .items
        .iter()
        .find(|todo| todo.status == TodoStatus::InProgress)
        .map(active_todo_prompt_value);
    let items = snapshot
        .items
        .iter()
        .filter(|todo| todo.status == TodoStatus::InProgress)
        .chain(
            snapshot
                .items
                .iter()
                .filter(|todo| todo.status == TodoStatus::Pending),
        )
        .chain(
            snapshot
                .items
                .iter()
                .rev()
                .filter(|todo| todo.status.is_terminal()),
        )
        .take(MAX_PROMPT_TODO_ITEMS)
        .map(|todo| {
            let waiting_on = todo
                .blocked_by
                .iter()
                .filter(|dependency| {
                    snapshot
                        .items
                        .iter()
                        .find(|candidate| candidate.id == dependency.as_str())
                        .is_none_or(|candidate| candidate.status != TodoStatus::Completed)
                })
                .take(MAX_PROMPT_DETAIL_ITEMS)
                .map(String::as_str)
                .collect::<Vec<_>>();
            let approval_ready =
                !todo.requires_approval || todo.approval_status == TodoApprovalStatus::Approved;
            let ready =
                todo.status == TodoStatus::Pending && waiting_on.is_empty() && approval_ready;
            serde_json::json!({
                "id": todo.id,
                "subject": bounded_prompt_text(&todo.subject, MAX_PROMPT_SUBJECT_CHARS),
                "status": todo.status,
                "blockedBy": bounded_prompt_list(&todo.blocked_by),
                "waitingOn": waiting_on,
                "ready": ready,
                "requiresApproval": todo.requires_approval,
                "approvalStatus": todo.approval_status,
            })
        })
        .collect::<Vec<_>>();
    let completed = snapshot
        .items
        .iter()
        .filter(|todo| todo.status == TodoStatus::Completed)
        .count();
    let pending = snapshot
        .items
        .iter()
        .filter(|todo| todo.status == TodoStatus::Pending)
        .count();
    let cancelled = snapshot
        .items
        .iter()
        .filter(|todo| todo.status == TodoStatus::Cancelled)
        .count();
    let in_progress = snapshot
        .items
        .iter()
        .filter(|todo| todo.status == TodoStatus::InProgress)
        .count();
    serde_json::json!({
        "summary": {
            "total": snapshot.items.len(),
            "completed": completed,
            "pending": pending,
            "inProgress": in_progress,
            "cancelled": cancelled,
            "omitted": snapshot.items.len().saturating_sub(items.len()),
        },
        "active": active,
        "items": items,
    })
}

fn active_todo_prompt_value(todo: &TodoItem) -> serde_json::Value {
    let context_bundle = todo.context_bundle.as_ref().map(|bundle| {
        serde_json::json!({
            "knownFacts": bounded_prompt_list(&bundle.known_facts),
            "decisions": bounded_prompt_list(&bundle.decisions),
            "constraints": bounded_prompt_list(&bundle.constraints),
            "excludedDirections": bounded_prompt_list(&bundle.excluded_directions),
            "sourceReferences": bounded_prompt_list(&bundle.source_references),
        })
    });
    serde_json::json!({
        "id": todo.id,
        "subject": bounded_prompt_text(&todo.subject, MAX_PROMPT_SUBJECT_CHARS),
        "description": bounded_prompt_text(&todo.description, MAX_PROMPT_DESCRIPTION_CHARS),
        "status": todo.status,
        "blockedBy": bounded_prompt_list(&todo.blocked_by),
        "files": bounded_prompt_list(&todo.files),
        "riskLevel": todo.risk_level,
        "requiresApproval": todo.requires_approval,
        "approvalStatus": todo.approval_status,
        "acceptanceCriteria": bounded_prompt_list(&todo.acceptance_criteria),
        "verificationCommand": todo.verification_command.as_deref().map(|value| bounded_prompt_text(value, MAX_PROMPT_DETAIL_CHARS)),
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
) -> Result<TodoListSnapshot, AppError> {
    if bytes.len() > MAX_TODO_DOCUMENT_BYTES {
        return Err(todo_document_error(
            path,
            format!("document has {} bytes", bytes.len()),
        ));
    }
    let snapshot: TodoListSnapshot = serde_json::from_slice(bytes)
        .map_err(|source| todo_document_error(path, format!("parse JSON: {source}")))?;
    validate_snapshot(expected_session_id, path, &snapshot)?;
    Ok(snapshot)
}

fn validate_snapshot(
    expected_session_id: &SessionId,
    path: &Path,
    snapshot: &TodoListSnapshot,
) -> Result<(), AppError> {
    if snapshot.version != TODO_SNAPSHOT_VERSION {
        return Err(todo_document_error(
            path,
            format!("unsupported version {}", snapshot.version),
        ));
    }
    if &snapshot.session_id != expected_session_id {
        return Err(todo_document_error(path, "session identity mismatch"));
    }
    if snapshot.items.len() > MAX_TODOS || snapshot.next_sequence == 0 {
        return Err(todo_document_error(path, "invalid todo snapshot bounds"));
    }
    let mut identifiers = HashSet::with_capacity(snapshot.items.len());
    let mut largest_sequence = 0;
    for todo in &snapshot.items {
        let sequence =
            validate_todo_id(&todo.id).map_err(|message| todo_document_error(path, message))?;
        if !identifiers.insert(todo.id.as_str()) {
            return Err(todo_document_error(path, "duplicate todo identifier"));
        }
        largest_sequence = largest_sequence.max(sequence);
        validate_todo(todo).map_err(|error| {
            todo_document_error(
                path,
                error
                    .diagnostic()
                    .unwrap_or_else(|| error.public_message())
                    .to_string(),
            )
        })?;
    }
    if snapshot.next_sequence <= largest_sequence {
        return Err(todo_document_error(
            path,
            "next sequence does not follow persisted todo identifiers",
        ));
    }
    if snapshot
        .items
        .iter()
        .filter(|todo| todo.status == TodoStatus::InProgress)
        .count()
        > 1
    {
        return Err(todo_document_error(
            path,
            "multiple items are marked in progress",
        ));
    }
    validate_todo_graph(&snapshot.items).map_err(|error| {
        todo_document_error(
            path,
            error
                .diagnostic()
                .unwrap_or_else(|| error.public_message())
                .to_string(),
        )
    })?;
    for index in 0..snapshot.items.len() {
        validate_todo_admission(&snapshot.items, index).map_err(|error| {
            todo_document_error(
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

fn todo_document_error(path: &Path, diagnostic: impl Into<String>) -> AppError {
    AppError::storage(
        "The saved todo state is invalid",
        format!("todo document {}: {}", path.display(), diagnostic.into()),
        false,
    )
}

fn bump_revision(snapshot: &mut TodoListSnapshot) -> Result<(), AppError> {
    snapshot.revision = snapshot.revision.checked_add(1).ok_or_else(|| {
        AppError::storage(
            "Todo state cannot be updated",
            "todo revision overflowed",
            false,
        )
    })?;
    Ok(())
}

fn todo_from_create(sequence: u64, input: TodoCreateInput) -> TodoItem {
    let approval_status = input.approval_status.unwrap_or(if input.requires_approval {
        TodoApprovalStatus::Pending
    } else {
        TodoApprovalStatus::NotRequired
    });
    TodoItem {
        id: format!("t{sequence}"),
        subject: input.subject.trim().to_string(),
        description: input.description,
        status: TodoStatus::Pending,
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

fn apply_patch(todo: &mut TodoItem, patch: TodoItemPatch) {
    if let Some(subject) = patch.subject {
        todo.subject = subject.trim().to_string();
    }
    if let Some(description) = patch.description {
        todo.description = description;
    }
    if let Some(status) = patch.status {
        todo.status = status;
    }
    if !patch.remove_blocked_by.is_empty() {
        todo.blocked_by
            .retain(|dependency| !patch.remove_blocked_by.contains(dependency));
    }
    todo.blocked_by.extend(patch.add_blocked_by);
    if let Some(files) = patch.files {
        todo.files = files;
    }
    if let Some(active_form) = patch.active_form {
        todo.active_form = Some(active_form);
    }
    if let Some(group_id) = patch.group_id {
        todo.group_id = Some(group_id);
    }
    if let Some(group_title) = patch.group_title {
        todo.group_title = Some(group_title);
    }
    if let Some(group_subtitle) = patch.group_subtitle {
        todo.group_subtitle = Some(group_subtitle);
    }
    if let Some(risk_level) = patch.risk_level {
        todo.risk_level = Some(risk_level);
    }
    if let Some(requires_approval) = patch.requires_approval {
        todo.requires_approval = requires_approval;
    }
    if let Some(approval_status) = patch.approval_status {
        todo.approval_status = approval_status;
    }
    if let Some(acceptance_criteria) = patch.acceptance_criteria {
        todo.acceptance_criteria = acceptance_criteria;
    }
    if let Some(verification_command) = patch.verification_command {
        todo.verification_command = Some(verification_command);
    }
    if let Some(context_bundle) = patch.context_bundle {
        todo.context_bundle = Some(context_bundle);
    }
}

fn validate_create_input(input: &TodoCreateInput) -> Result<(), AppError> {
    match (input.requires_approval, input.approval_status) {
        (true, Some(status)) if status != TodoApprovalStatus::Pending => {
            return Err(AppError::validation(
                "A newly created Todo requiring approval must start pending",
            ));
        }
        (false, Some(status)) if status != TodoApprovalStatus::NotRequired => {
            return Err(AppError::validation(
                "A newly created Todo without approval requirements must be not required",
            ));
        }
        _ => {}
    }
    let todo = todo_from_create(1, input.clone());
    validate_todo(&todo)
}

fn validate_approval_policy_transitions(
    previous: &[TodoItem],
    next: &[TodoItem],
) -> Result<(), AppError> {
    for previous_todo in previous.iter().filter(|todo| todo.requires_approval) {
        let current = next
            .iter()
            .find(|todo| todo.id == previous_todo.id)
            .ok_or_else(|| AppError::internal("updated Todo item disappeared"))?;
        if !current.requires_approval {
            return Err(AppError::conflict(format!(
                "Todo '{}' cannot remove an existing approval requirement",
                current.id
            )));
        }
    }
    Ok(())
}

fn validate_update_input(input: &TodoItemPatch) -> Result<(), AppError> {
    if !has_todo_mutation(input) {
        return Err(AppError::validation(
            "TodoUpdate requires at least one change",
        ));
    }
    if let Some(subject) = &input.subject {
        validate_required_text("Todo subject", subject, MAX_SUBJECT_BYTES)?;
    }
    if let Some(description) = &input.description {
        validate_text("Todo description", description, MAX_DESCRIPTION_BYTES)?;
    }
    validate_dependency_patch(input)?;
    if let Some(files) = &input.files {
        validate_files(files)?;
    }
    validate_optional_text(
        "Todo active form",
        input.active_form.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text("Todo group ID", input.group_id.as_deref(), MAX_LABEL_BYTES)?;
    validate_optional_text(
        "Todo group title",
        input.group_title.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text(
        "Todo group subtitle",
        input.group_subtitle.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    if let Some(criteria) = &input.acceptance_criteria {
        validate_string_list("Todo acceptance criteria", criteria)?;
    }
    validate_optional_text(
        "Todo verification command",
        input.verification_command.as_deref(),
        MAX_COMMAND_BYTES,
    )?;
    if let Some(bundle) = &input.context_bundle {
        validate_context_bundle(bundle)?;
    }
    Ok(())
}

fn validate_todo(todo: &TodoItem) -> Result<(), AppError> {
    validate_todo_id(&todo.id).map_err(AppError::validation)?;
    validate_required_text("Todo subject", &todo.subject, MAX_SUBJECT_BYTES)?;
    validate_text("Todo description", &todo.description, MAX_DESCRIPTION_BYTES)?;
    validate_dependency_list(todo)?;
    validate_files(&todo.files)?;
    validate_optional_text(
        "Todo active form",
        todo.active_form.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text("Todo group ID", todo.group_id.as_deref(), MAX_LABEL_BYTES)?;
    validate_optional_text(
        "Todo group title",
        todo.group_title.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text(
        "Todo group subtitle",
        todo.group_subtitle.as_deref(),
        MAX_LABEL_BYTES,
    )?;
    validate_string_list("Todo acceptance criteria", &todo.acceptance_criteria)?;
    validate_optional_text(
        "Todo verification command",
        todo.verification_command.as_deref(),
        MAX_COMMAND_BYTES,
    )?;
    if let Some(bundle) = &todo.context_bundle {
        validate_context_bundle(bundle)?;
    }
    if todo.requires_approval && todo.approval_status == TodoApprovalStatus::NotRequired {
        return Err(AppError::validation(
            "A todo requiring approval cannot be marked not required",
        ));
    }
    if !todo.requires_approval && todo.approval_status != TodoApprovalStatus::NotRequired {
        return Err(AppError::validation(
            "A todo without approval requirements must be marked not required",
        ));
    }
    Ok(())
}

fn has_todo_mutation(input: &TodoItemPatch) -> bool {
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

fn validate_dependency_patch(input: &TodoItemPatch) -> Result<(), AppError> {
    validate_todo_ids("Todo dependencies to add", &input.add_blocked_by)?;
    validate_todo_ids("Todo dependencies to remove", &input.remove_blocked_by)?;
    if input
        .add_blocked_by
        .iter()
        .any(|dependency| input.remove_blocked_by.contains(dependency))
    {
        return Err(AppError::validation(
            "A todo dependency cannot be added and removed in the same update",
        ));
    }
    Ok(())
}

fn validate_dependency_list(todo: &TodoItem) -> Result<(), AppError> {
    validate_todo_ids("Todo blockedBy", &todo.blocked_by)?;
    if todo
        .blocked_by
        .iter()
        .any(|dependency| dependency == &todo.id)
    {
        return Err(AppError::validation("A todo cannot depend on itself"));
    }
    Ok(())
}

fn validate_todo_ids(field: &str, todo_ids: &[String]) -> Result<(), AppError> {
    if todo_ids.len() > MAX_LIST_ITEMS {
        return Err(AppError::validation(format!("{field} is too large")));
    }
    let mut identifiers = HashSet::with_capacity(todo_ids.len());
    for todo_id in todo_ids {
        validate_todo_id(todo_id).map_err(AppError::validation)?;
        if !identifiers.insert(todo_id.as_str()) {
            return Err(AppError::validation(format!(
                "{field} contains a duplicate todo identifier"
            )));
        }
    }
    Ok(())
}

fn validate_todo_graph(items: &[TodoItem]) -> Result<(), AppError> {
    for todo in items {
        for dependency in &todo.blocked_by {
            if !items.iter().any(|candidate| candidate.id == *dependency) {
                return Err(AppError::conflict(format!(
                    "Todo {} depends on missing todo {dependency}",
                    todo.id
                )));
            }
        }
    }

    let mut states = vec![0_u8; items.len()];
    for index in 0..items.len() {
        visit_todo_dependencies(items, index, &mut states)?;
    }
    Ok(())
}

fn visit_todo_dependencies(
    items: &[TodoItem],
    index: usize,
    states: &mut [u8],
) -> Result<(), AppError> {
    match states[index] {
        1 => {
            return Err(AppError::conflict(
                "Todo dependencies cannot contain a cycle",
            ));
        }
        2 => return Ok(()),
        _ => {}
    }
    states[index] = 1;
    for dependency in &items[index].blocked_by {
        let dependency_index = items
            .iter()
            .position(|candidate| candidate.id == *dependency)
            .ok_or_else(|| {
                AppError::conflict(format!(
                    "Todo {} depends on missing todo {dependency}",
                    items[index].id
                ))
            })?;
        visit_todo_dependencies(items, dependency_index, states)?;
    }
    states[index] = 2;
    Ok(())
}

fn validate_todo_admission(items: &[TodoItem], index: usize) -> Result<(), AppError> {
    let todo = &items[index];
    if !matches!(todo.status, TodoStatus::InProgress | TodoStatus::Completed) {
        return Ok(());
    }
    if todo.requires_approval && todo.approval_status != TodoApprovalStatus::Approved {
        return Err(AppError::conflict(format!(
            "Todo {} requires approval before it can start or complete",
            todo.id
        )));
    }
    let unfinished = todo
        .blocked_by
        .iter()
        .filter(|dependency| {
            items
                .iter()
                .find(|candidate| candidate.id == dependency.as_str())
                .is_none_or(|candidate| candidate.status != TodoStatus::Completed)
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unfinished.is_empty() {
        return Err(AppError::conflict(format!(
            "Todo {} is blocked by unfinished dependencies: {}",
            todo.id,
            unfinished.join(", ")
        )));
    }
    Ok(())
}

fn validate_todo_id(value: &str) -> Result<u64, &'static str> {
    let digits = value
        .strip_prefix('t')
        .ok_or("Todo identifiers must use the t<number> format")?;
    if digits.is_empty()
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Todo identifiers must use the t<number> format");
    }
    digits
        .parse::<u64>()
        .ok()
        .filter(|sequence| *sequence > 0)
        .ok_or("Todo identifier is out of range")
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
        return Err(AppError::validation("Todo file list is too large"));
    }
    for file in files {
        validate_required_text("Todo file", file, MAX_LIST_ITEM_BYTES)?;
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
                "Todo files must be relative workspace paths",
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

fn validate_context_bundle(bundle: &TodoContextBundle) -> Result<(), AppError> {
    validate_string_list("Todo known facts", &bundle.known_facts)?;
    validate_string_list("Todo decisions", &bundle.decisions)?;
    validate_string_list("Todo constraints", &bundle.constraints)?;
    validate_string_list("Todo excluded directions", &bundle.excluded_directions)?;
    validate_string_list("Todo source references", &bundle.source_references)
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
        TodoApprovalStatus, TodoCreateInput, TodoEventSink, TodoItem, TodoItemPatch,
        TodoItemUpdate, TodoListSnapshot, TodoStatus, TodoStore, todo_model_state,
        todo_prompt_state,
    };

    #[derive(Default)]
    struct RecordingEvents {
        revisions: StdMutex<Vec<u64>>,
    }

    impl TodoEventSink for RecordingEvents {
        fn emit(&self, snapshot: &TodoListSnapshot) -> Result<(), AppError> {
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
                        "The todo state could not be saved",
                        "injected todo persistence failure",
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

    fn input(subject: impl Into<String>) -> TodoCreateInput {
        TodoCreateInput {
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
    async fn concurrent_creates_preserve_every_todo_and_revision() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TodoStore::new(directory.path(), persistence));
        let session_id = session("session-1");
        let mut workers = Vec::new();
        for index in 0..32 {
            let store = Arc::clone(&store);
            let session_id = session_id.clone();
            workers.push(tokio::spawn(async move {
                store
                    .create(&session_id, vec![input(format!("todo {index}"))])
                    .await
            }));
        }
        for worker in workers {
            worker
                .await
                .expect("todo worker must join")
                .expect("concurrent todo create must succeed");
        }

        let snapshot = store
            .snapshot(&session_id)
            .await
            .expect("todo snapshot must load");
        assert_eq!(
            (
                snapshot.items.len(),
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
            TodoStore::with_event_sink(directory.path(), persistence.clone(), events.clone());
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first")])
            .await
            .expect("initial todo create must succeed");
        persistence.fail_next_replace.store(true, Ordering::SeqCst);

        let error = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("injected replacement must fail");
        let snapshot = store
            .snapshot(&session_id)
            .await
            .expect("old todo snapshot must remain readable");
        assert_eq!(error.kind(), AppErrorKind::Storage);
        assert_eq!(
            (snapshot.revision, snapshot.items[0].status),
            (1, TodoStatus::Pending)
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
        TodoStore::new(directory.path(), Arc::clone(&persistence))
            .create(&session_id, vec![input("persisted")])
            .await
            .expect("todo create must persist");
        let restarted = TodoStore::new(directory.path(), Arc::clone(&persistence));
        let recovered = restarted
            .snapshot(&session_id)
            .await
            .expect("todo snapshot must recover");
        assert_eq!(recovered.items[0].subject, "persisted");

        restarted
            .cleanup_session(&session_id)
            .await
            .expect("todo cleanup must succeed");
        let after_cleanup = TodoStore::new(directory.path(), persistence)
            .snapshot(&session_id)
            .await
            .expect("cleaned todo snapshot must be empty");
        assert!(after_cleanup.items.is_empty() && after_cleanup.revision == 0);
    }

    #[tokio::test]
    async fn persisted_snapshot_keeps_the_legacy_tasks_field() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("persisted")])
            .await
            .expect("Todo create must persist");

        let document = std::fs::read_to_string(directory.path().join("tasks/session-1.json"))
            .expect("persisted Todo document must be readable");
        let value: serde_json::Value =
            serde_json::from_str(&document).expect("persisted Todo document must be valid JSON");

        assert!(value.get("tasks").is_some() && value.get("items").is_none());
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
            let todo_directory = directory.path().join("tasks");
            std::fs::create_dir_all(&todo_directory)
                .expect("todo fixture directory must be created");
            std::fs::write(todo_directory.join("session-1.json"), document)
                .expect("invalid todo fixture must be written");
            let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
            let error = store
                .snapshot(&session("session-1"))
                .await
                .expect_err("invalid todo document must fail closed");
            assert_eq!(error.kind(), AppErrorKind::Storage);
        }
    }

    #[tokio::test]
    async fn oversized_document_and_cross_session_access_fail_closed() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = TodoStore::new(directory.path(), Arc::clone(&persistence));
        let owner = session("session-1");
        store
            .create(&owner, vec![input("owned")])
            .await
            .expect("owner todo create must succeed");
        let error = store
            .get(&session("session-2"), "t1")
            .await
            .expect_err("another session must not access the todo");
        assert_eq!(error.kind(), AppErrorKind::NotFound);

        let oversized_session = session("session-3");
        let oversized_path = directory.path().join("tasks/session-3.json");
        std::fs::write(
            &oversized_path,
            vec![b' '; super::MAX_TODO_DOCUMENT_BYTES + 1],
        )
        .expect("oversized todo fixture must be written");
        let error = store
            .snapshot(&oversized_session)
            .await
            .expect_err("oversized todo document must fail closed");
        assert_eq!(error.kind(), AppErrorKind::Storage);
    }

    #[tokio::test]
    async fn in_progress_admission_is_atomic() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = Arc::new(TodoStore::new(
            directory.path(),
            Arc::new(AtomicFileStore::default()),
        ));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first"), input("second")])
            .await
            .expect("todo create must succeed");
        let mut workers = Vec::new();
        for todo_id in ["t1", "t2"] {
            let store = Arc::clone(&store);
            let session_id = session_id.clone();
            workers.push(tokio::spawn(async move {
                store
                    .update(
                        &session_id,
                        todo_id,
                        TodoItemPatch {
                            status: Some(TodoStatus::InProgress),
                            ..TodoItemPatch::default()
                        },
                    )
                    .await
            }));
        }
        let mut successes = 0;
        for worker in workers {
            if worker.await.expect("todo worker must join").is_ok() {
                successes += 1;
            }
        }
        let snapshot = store
            .snapshot(&session_id)
            .await
            .expect("todo snapshot must load");
        assert_eq!(successes, 1);
        assert_eq!(
            snapshot
                .items
                .iter()
                .filter(|todo| todo.status == TodoStatus::InProgress)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn unfinished_dependency_blocks_start_until_completed() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("todo create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency update must succeed");

        let error = store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("unfinished dependency must block admission");
        assert_eq!(error.kind(), AppErrorKind::Conflict);

        store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency must start");
        store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    status: Some(TodoStatus::Completed),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency must complete");
        let snapshot = store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("completed dependency must unblock admission");

        assert_eq!(snapshot.items[1].status, TodoStatus::InProgress);
    }

    #[tokio::test]
    async fn unfinished_dependency_blocks_completion() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("todo create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency update must succeed");

        let error = store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    status: Some(TodoStatus::Completed),
                    ..TodoItemPatch::default()
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
        let store = TodoStore::new(directory.path(), Arc::clone(&persistence));
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("todo create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency update must persist");

        let recovered = TodoStore::new(directory.path(), persistence)
            .snapshot(&session_id)
            .await
            .expect("todo snapshot must recover");

        assert_eq!(recovered.items[1].blocked_by, ["t1"]);
    }

    #[tokio::test]
    async fn reopening_dependency_cannot_reblock_active_dependent() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("todo create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency update must succeed");
        store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    status: Some(TodoStatus::Completed),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency must complete");
        store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependent must start");

        let error = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    status: Some(TodoStatus::Pending),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("active dependent cannot be reblocked");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn dependency_update_rejects_self_dependency() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("todo")])
            .await
            .expect("todo create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("self dependency must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn dependency_update_rejects_missing_todo() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("todo")])
            .await
            .expect("todo create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    add_blocked_by: vec!["t2".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("missing dependency must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn dependency_update_rejects_duplicate_identifier() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("todo create must succeed");

        let error = store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string(), "t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("duplicate dependency must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn dependency_update_rejects_cycle() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("first"), input("second")])
            .await
            .expect("todo create must succeed");
        store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    add_blocked_by: vec!["t2".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("first dependency must be accepted");

        let error = store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("dependency cycle must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn stale_expected_revision_rejects_update() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("todo")])
            .await
            .expect("todo create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    expected_revision: Some(0),
                    subject: Some("stale update".to_string()),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("stale revision must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn approval_required_todo_cannot_start_before_approval() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        let mut approval_todo = input("approval todo");
        approval_todo.requires_approval = true;
        store
            .create(&session_id, vec![approval_todo])
            .await
            .expect("todo create must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("pending approval must block admission");
        assert_eq!(error.kind(), AppErrorKind::Conflict);

        let snapshot = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    approval_status: Some(TodoApprovalStatus::Approved),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("approval and admission may be committed atomically");
        assert_eq!(snapshot.items[0].status, TodoStatus::InProgress);
    }

    #[tokio::test]
    async fn create_cannot_declare_an_approved_todo() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        let mut approval_todo = input("approval todo");
        approval_todo.requires_approval = true;
        approval_todo.approval_status = Some(TodoApprovalStatus::Approved);

        let error = store
            .create(&session_id, vec![approval_todo])
            .await
            .expect_err("Todo creation must not bypass approval");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn update_cannot_remove_an_existing_approval_requirement() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        let mut approval_todo = input("approval todo");
        approval_todo.requires_approval = true;
        store
            .create(&session_id, vec![approval_todo])
            .await
            .expect("Todo creation must succeed");

        let error = store
            .update(
                &session_id,
                "t1",
                TodoItemPatch {
                    requires_approval: Some(false),
                    approval_status: Some(TodoApprovalStatus::NotRequired),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect_err("Todo approval requirements must be irreversible");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn empty_update_is_rejected() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("todo")])
            .await
            .expect("todo create must succeed");

        let error = store
            .update(&session_id, "t1", TodoItemPatch::default())
            .await
            .expect_err("empty update must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn deleting_todo_removes_it_from_dependencies() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
        let session_id = session("session-1");
        store
            .create(&session_id, vec![input("dependency"), input("dependent")])
            .await
            .expect("todo create must succeed");
        store
            .update(
                &session_id,
                "t2",
                TodoItemPatch {
                    add_blocked_by: vec!["t1".to_string()],
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("dependency update must succeed");

        let snapshot = store
            .delete(&session_id, "t1")
            .await
            .expect("todo deletion must succeed");

        assert!(snapshot.items[0].blocked_by.is_empty());
    }

    #[tokio::test]
    async fn batch_update_validates_the_final_state_and_emits_once() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let events = Arc::new(RecordingEvents::default());
        let event_sink: Arc<dyn TodoEventSink> = events.clone();
        let store = TodoStore::with_event_sink(
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
                TodoItemPatch {
                    status: Some(TodoStatus::InProgress),
                    ..TodoItemPatch::default()
                },
            )
            .await
            .expect("first Todo must start");

        let snapshot = store
            .update_batch(
                &session_id,
                Some(2),
                vec![
                    TodoItemUpdate {
                        todo_id: "t1".to_string(),
                        patch: TodoItemPatch {
                            status: Some(TodoStatus::Completed),
                            ..TodoItemPatch::default()
                        },
                    },
                    TodoItemUpdate {
                        todo_id: "t2".to_string(),
                        patch: TodoItemPatch {
                            status: Some(TodoStatus::InProgress),
                            ..TodoItemPatch::default()
                        },
                    },
                ],
            )
            .await
            .expect("final batch state must be valid");

        assert_eq!(
            (
                snapshot.revision,
                snapshot.items[0].status,
                snapshot.items[1].status,
                events
                    .revisions
                    .lock()
                    .expect("event fixture lock must remain available")
                    .as_slice(),
            ),
            (
                3,
                TodoStatus::Completed,
                TodoStatus::InProgress,
                &[1, 2, 3][..],
            )
        );
    }

    #[tokio::test]
    async fn batch_update_rejects_duplicate_ids_without_mutating_state() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let store = TodoStore::new(directory.path(), Arc::new(AtomicFileStore::default()));
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
                    TodoItemUpdate {
                        todo_id: "t1".to_string(),
                        patch: TodoItemPatch {
                            subject: Some("changed once".to_string()),
                            ..TodoItemPatch::default()
                        },
                    },
                    TodoItemUpdate {
                        todo_id: "t1".to_string(),
                        patch: TodoItemPatch {
                            subject: Some("changed twice".to_string()),
                            ..TodoItemPatch::default()
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
                snapshot.items[0].subject.as_str()
            ),
            (AppErrorKind::Validation, 1, "first")
        );
    }

    #[test]
    fn todo_prompt_state_is_bounded_and_escapes_markup() {
        let snapshot = TodoListSnapshot {
            version: 1,
            session_id: session("session-1"),
            revision: 7,
            next_sequence: 2,
            items: vec![TodoItem {
                id: "t1".to_string(),
                subject: "active <item>".to_string(),
                description: "x".repeat(super::MAX_PROMPT_DESCRIPTION_CHARS + 100),
                status: TodoStatus::InProgress,
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

    #[test]
    fn todo_model_state_prioritizes_active_and_non_terminal_items() {
        let items = (1..=45)
            .map(|index| TodoItem {
                id: format!("t{index}"),
                subject: format!("todo {index}"),
                description: String::new(),
                status: if index == 45 {
                    TodoStatus::InProgress
                } else if index > 40 {
                    TodoStatus::Pending
                } else {
                    TodoStatus::Completed
                },
                blocked_by: match index {
                    41 => vec!["t1".to_string()],
                    42 => vec!["t44".to_string()],
                    _ => Vec::new(),
                },
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
                context_bundle: None,
            })
            .collect();
        let snapshot = TodoListSnapshot {
            version: 1,
            session_id: session("session-1"),
            revision: 9,
            next_sequence: 46,
            items,
        };

        let state = todo_model_state(&snapshot);
        let visible = state["items"]
            .as_array()
            .expect("Todo model state items must be an array");
        let todo_41 = visible
            .iter()
            .find(|todo| todo["id"] == "t41")
            .expect("first pending Todo must remain visible");
        let todo_42 = visible
            .iter()
            .find(|todo| todo["id"] == "t42")
            .expect("blocked pending Todo must remain visible");

        assert!(
            visible.len() == super::MAX_PROMPT_TODO_ITEMS
                && visible[0]["id"] == "t45"
                && todo_41["ready"] == true
                && todo_41["waitingOn"].as_array().is_some_and(Vec::is_empty)
                && todo_42["ready"] == false
                && todo_42["waitingOn"][0] == "t44"
                && visible.iter().all(|todo| todo["id"] != "t1")
                && state["summary"]["omitted"] == 5
        );
    }
}
