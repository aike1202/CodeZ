use std::sync::Arc;

use codez_core::{AppError, AppErrorKind, SessionId};
use serde_json::{Map, Value};

use crate::{
    task::{
        TodoCreateInput, TodoItem, TodoItemPatch, TodoItemUpdate, TodoListSnapshot, TodoStatus,
        TodoStore,
    },
    tools::{
        registry::{
            BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext,
            ToolDescriptor, ToolHandler,
        },
        types::{
            ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
            ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
            ToolPlanningContext, ToolSource,
        },
    },
};

#[derive(Clone, Copy)]
enum TodoToolKind {
    Create,
    Update,
}

/// Model-facing handlers for durable session Todo state.
pub struct TodoTool {
    descriptor: DefaultToolDescriptor,
    kind: TodoToolKind,
    store: Arc<TodoStore>,
}

impl TodoTool {
    #[must_use]
    pub fn create(store: Arc<TodoStore>) -> Self {
        Self::new(
            TodoToolKind::Create,
            "TodoCreate",
            "Create session-scoped Todo items.",
            "Creates one or more durable Todo items in pending state for substantial multi-step work.",
            create_schema(),
            store,
        )
    }

    #[must_use]
    pub fn update(store: Arc<TodoStore>) -> Self {
        Self::new(
            TodoToolKind::Update,
            "TodoUpdate",
            "Atomically update one or more Todo items.",
            "Applies all updates to the latest Todo snapshot as one transaction. Use expectedRevision from the injected todo_state when available. The final state must keep at most one item in_progress and satisfy dependency and approval gates.",
            update_schema(),
            store,
        )
    }

    fn new(
        kind: TodoToolKind,
        name: &'static str,
        summary: &str,
        description: &str,
        input_schema: Value,
        store: Arc<TodoStore>,
    ) -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name,
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: format!("builtin:{}", name.to_ascii_lowercase()),
                summary: summary.to_string(),
                description: description.to_string(),
                input_schema,
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Always,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::ResourceLocked,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 64 * 1024,
                    timeout_ms: Some(30_000),
                },
            },
            kind,
            store,
        }
    }

    fn effect(&self, session_id: Option<&str>) -> ToolEffect {
        match self.kind {
            TodoToolKind::Create | TodoToolKind::Update => ToolEffect::MutateTaskState {
                session_id: session_id.map(str::to_string),
            },
        }
    }
}

impl ToolHandler for TodoTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            ToolEffectPlan {
                effects: vec![self.effect(context.session_id.as_deref())],
                analysis_status: "parsed".to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move { vec![task_resource(context.session_id.as_deref())] })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            if context.cancellation.is_cancelled() {
                return cancelled_result(self.effect(context.session_id.as_deref()));
            }
            let session_id = match parse_session_id(context.session_id.as_deref()) {
                Ok(session_id) => session_id,
                Err(error) => {
                    return error_result(error, self.effect(context.session_id.as_deref()), None);
                }
            };
            let result = match self.kind {
                TodoToolKind::Create => execute_create(&self.store, &session_id, input).await,
                TodoToolKind::Update => execute_update(&self.store, &session_id, input).await,
            };
            match result {
                Ok(value) => success_result(value, self.effect(Some(session_id.as_str()))),
                Err(error) => {
                    let latest = if error.kind() == AppErrorKind::Conflict {
                        self.store
                            .snapshot(&session_id)
                            .await
                            .ok()
                            .map(snapshot_result)
                    } else {
                        None
                    };
                    error_result(error, self.effect(Some(session_id.as_str())), latest)
                }
            }
        })
    }
}

fn parse_session_id(value: Option<&str>) -> Result<SessionId, AppError> {
    let value = value.ok_or_else(|| AppError::validation("The Todo tool requires a session"))?;
    SessionId::parse(value.to_string())
        .map_err(|source| AppError::validation(format!("The Todo session is invalid: {source}")))
}

async fn execute_create(
    store: &TodoStore,
    session_id: &SessionId,
    input: &Value,
) -> Result<Value, AppError> {
    let items = input
        .get("items")
        .cloned()
        .ok_or_else(|| AppError::validation("TodoCreate requires items"))?;
    let items: Vec<TodoCreateInput> = serde_json::from_value(items)
        .map_err(|source| AppError::validation(format!("TodoCreate input is invalid: {source}")))?;
    store.create(session_id, items).await.map(snapshot_result)
}

async fn execute_update(
    store: &TodoStore,
    session_id: &SessionId,
    input: &Value,
) -> Result<Value, AppError> {
    let expected_revision = input.get("expectedRevision").and_then(Value::as_u64);
    let updates = input
        .get("updates")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("TodoUpdate requires updates"))?;
    let mut parsed_updates = Vec::with_capacity(updates.len());
    for update in updates {
        let mut patch = update
            .as_object()
            .cloned()
            .ok_or_else(|| AppError::validation("TodoUpdate updates must be objects"))?;
        let todo_id = patch
            .remove("todoId")
            .and_then(|value| value.as_str().map(str::to_string))
            .ok_or_else(|| AppError::validation("Each TodoUpdate item requires todoId"))?;
        let patch: TodoItemPatch =
            serde_json::from_value(Value::Object(patch)).map_err(|source| {
                AppError::validation(format!("TodoUpdate input is invalid: {source}"))
            })?;
        parsed_updates.push(TodoItemUpdate {
            task_id: todo_id,
            patch,
        });
    }
    let snapshot = store
        .update_batch(session_id, expected_revision, parsed_updates)
        .await?;
    Ok(serde_json::json!({
        "summary": todo_summary(&snapshot),
        "todoStates": todo_states(&snapshot),
        "snapshot": todo_snapshot_value(&snapshot)
    }))
}

fn snapshot_result(snapshot: TodoListSnapshot) -> Value {
    serde_json::json!({
        "summary": todo_summary(&snapshot),
        "todoStates": todo_states(&snapshot),
        "snapshot": todo_snapshot_value(&snapshot)
    })
}

fn todo_snapshot_value(snapshot: &TodoListSnapshot) -> Value {
    serde_json::json!({
        "version": snapshot.version,
        "sessionId": snapshot.session_id,
        "revision": snapshot.revision,
        "nextSequence": snapshot.next_sequence,
        "items": snapshot.tasks
    })
}

fn todo_summary(snapshot: &TodoListSnapshot) -> String {
    let completed = count_status(snapshot, TodoStatus::Completed);
    let in_progress = count_status(snapshot, TodoStatus::InProgress);
    let cancelled = count_status(snapshot, TodoStatus::Cancelled);
    let ready = snapshot
        .tasks
        .iter()
        .filter(|task| task_is_ready(snapshot, task))
        .count();
    let blocked = snapshot
        .tasks
        .iter()
        .filter(|task| task_is_blocked(snapshot, task))
        .count();
    let mut parts = vec![format!("{completed}/{} completed", snapshot.tasks.len())];
    if in_progress > 0 {
        parts.push(format!("{in_progress} in progress"));
    }
    if cancelled > 0 {
        parts.push(format!("{cancelled} cancelled"));
    }
    if ready > 0 {
        parts.push(format!("{ready} ready"));
    }
    if blocked > 0 {
        parts.push(format!("{blocked} blocked"));
    }
    parts.join(", ")
}

fn todo_states(snapshot: &TodoListSnapshot) -> Value {
    let states = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.clone(), todo_state(snapshot, task)))
        .collect::<Map<_, _>>();
    Value::Object(states)
}

fn todo_state(snapshot: &TodoListSnapshot, task: &TodoItem) -> Value {
    let unfinished_dependencies = task
        .blocked_by
        .iter()
        .filter(|dependency| {
            snapshot
                .tasks
                .iter()
                .find(|candidate| candidate.id == dependency.as_str())
                .is_none_or(|candidate| candidate.status != TodoStatus::Completed)
        })
        .cloned()
        .collect::<Vec<_>>();
    let blocks = snapshot
        .tasks
        .iter()
        .filter(|candidate| candidate.blocked_by.contains(&task.id))
        .map(|candidate| candidate.id.clone())
        .collect::<Vec<_>>();
    let waiting_for_approval = task_waits_for_approval(task);
    let blocked = task.status == TodoStatus::Pending
        && (waiting_for_approval || !unfinished_dependencies.is_empty());
    let ready = task.status == TodoStatus::Pending && !blocked;
    serde_json::json!({
        "ready": ready,
        "blocked": blocked,
        "unfinishedDependencies": unfinished_dependencies,
        "blocks": blocks,
        "waitingForApproval": waiting_for_approval
    })
}

fn task_is_ready(snapshot: &TodoListSnapshot, task: &TodoItem) -> bool {
    task.status == TodoStatus::Pending && !task_is_blocked(snapshot, task)
}

fn task_is_blocked(snapshot: &TodoListSnapshot, task: &TodoItem) -> bool {
    task.status == TodoStatus::Pending
        && (task_waits_for_approval(task)
            || task.blocked_by.iter().any(|dependency| {
                snapshot
                    .tasks
                    .iter()
                    .find(|candidate| candidate.id == dependency.as_str())
                    .is_none_or(|candidate| candidate.status != TodoStatus::Completed)
            }))
}

fn task_waits_for_approval(task: &TodoItem) -> bool {
    task.requires_approval && task.approval_status != crate::task::TodoApprovalStatus::Approved
}

fn count_status(snapshot: &TodoListSnapshot, status: TodoStatus) -> usize {
    snapshot
        .tasks
        .iter()
        .filter(|task| task.status == status)
        .count()
}

fn task_resource(session_id: Option<&str>) -> String {
    format!("session:{}:todos", session_id.unwrap_or("unavailable"))
}

fn success_result(value: Value, effect: ToolEffect) -> ToolExecutionResult {
    let content = value.to_string();
    ToolExecutionResult::Success {
        data: Some(value),
        model_content: content.clone(),
        ui_content: Some(content),
        effects: Some(vec![effect]),
    }
}

fn error_result(error: AppError, effect: ToolEffect, latest: Option<Value>) -> ToolExecutionResult {
    let (code, recoverable) = match error.kind() {
        AppErrorKind::Validation => ("TODO_INPUT_INVALID", true),
        AppErrorKind::NotFound => ("TODO_NOT_FOUND", true),
        AppErrorKind::Conflict => ("TODO_CONFLICT", true),
        AppErrorKind::Storage => ("TODO_STORAGE_FAILED", error.retryable()),
        _ => ("TODO_OPERATION_FAILED", false),
    };
    let message = error.public_message().to_string();
    let model_content = latest.as_ref().map_or_else(
        || format!("Error: {message}"),
        |snapshot| format!("Error: {message}\nLatest Todo state: {snapshot}"),
    );
    ToolExecutionResult::Error {
        error: ToolExecutionError {
            code: code.to_string(),
            message: message.clone(),
            recoverable,
            suggestion: latest
                .as_ref()
                .map(|_| "Retry once with the latest revision shown in this result.".to_string()),
            retry_after_ms: None,
            details: latest,
        },
        model_content: Some(model_content),
        ui_content: None,
        effects: Some(vec![effect]),
    }
}

fn cancelled_result(effect: ToolEffect) -> ToolExecutionResult {
    ToolExecutionResult::Cancelled {
        error: ToolExecutionError {
            code: "TODO_CANCELLED".to_string(),
            message: "The Todo operation was cancelled".to_string(),
            recoverable: true,
            suggestion: None,
            retry_after_ms: None,
            details: None,
        },
        model_content: None,
        ui_content: None,
        effects: Some(vec![effect]),
    }
}

fn create_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "items": {
                "type": "array",
                "minItems": 1,
                "maxItems": 256,
                "items": task_fields_schema(true)
            }
        },
        "required": ["items"]
    })
}

fn update_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "expectedRevision": { "type": "integer", "minimum": 0 },
            "updates": {
                "type": "array",
                "minItems": 1,
                "maxItems": 256,
                "items": todo_update_item_schema()
            }
        },
        "required": ["updates"]
    })
}

fn todo_update_item_schema() -> Value {
    let mut properties = task_properties();
    properties.insert(
        "todoId".to_string(),
        serde_json::json!({ "type": "string", "pattern": "^t[1-9][0-9]*$" }),
    );
    properties.insert("addBlockedBy".to_string(), task_id_list_schema());
    properties.insert("removeBlockedBy".to_string(), task_id_list_schema());
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": ["todoId"],
        "anyOf": [
            { "required": ["subject"] },
            { "required": ["description"] },
            { "required": ["status"] },
            { "required": ["addBlockedBy"] },
            { "required": ["removeBlockedBy"] },
            { "required": ["files"] },
            { "required": ["activeForm"] },
            { "required": ["groupId"] },
            { "required": ["groupTitle"] },
            { "required": ["groupSubtitle"] },
            { "required": ["riskLevel"] },
            { "required": ["requiresApproval"] },
            { "required": ["approvalStatus"] },
            { "required": ["acceptanceCriteria"] },
            { "required": ["verificationCommand"] },
            { "required": ["contextBundle"] }
        ]
    })
}

fn task_fields_schema(require_subject: bool) -> Value {
    let mut properties = task_properties();
    if require_subject {
        properties.remove("status");
    }
    let mut schema = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties
    });
    if require_subject {
        schema["required"] = serde_json::json!(["subject"]);
    }
    schema
}

fn task_properties() -> Map<String, Value> {
    let fields = serde_json::json!({
        "subject": { "type": "string", "minLength": 1, "maxLength": 512 },
        "description": { "type": "string", "maxLength": 32768 },
        "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] },
        "files": { "type": "array", "maxItems": 128, "items": { "type": "string", "minLength": 1, "maxLength": 4096 } },
        "activeForm": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "groupId": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "groupTitle": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "groupSubtitle": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] },
        "requiresApproval": { "type": "boolean" },
        "approvalStatus": { "type": "string", "enum": ["not_required", "pending", "approved", "changes_requested", "rejected"] },
        "acceptanceCriteria": string_list_schema(),
        "verificationCommand": { "type": "string", "minLength": 1, "maxLength": 8192 },
        "contextBundle": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "knownFacts": string_list_schema(),
                "decisions": string_list_schema(),
                "constraints": string_list_schema(),
                "excludedDirections": string_list_schema(),
                "sourceReferences": string_list_schema()
            }
        }
    });
    fields.as_object().cloned().unwrap_or_default()
}

fn string_list_schema() -> Value {
    serde_json::json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 128,
        "items": { "type": "string", "minLength": 1, "maxLength": 4096 }
    })
}

fn task_id_list_schema() -> Value {
    serde_json::json!({
        "type": "array",
        "maxItems": 128,
        "uniqueItems": true,
        "items": { "type": "string", "pattern": "^t[1-9][0-9]*$" }
    })
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use codez_core::{AtomicPersistence, CancellationToken};
    use codez_storage::AtomicFileStore;

    use super::TodoTool;
    use crate::{
        task::TaskStore,
        tools::{
            registry::{ToolContext, ToolHandler},
            types::{ToolEffect, ToolEffectPlan, ToolExecutionResult},
        },
    };

    fn context(root: &Path) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            call_id: "call-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            session_id: Some("session-1".to_string()),
            context_scope_id: "main".to_string(),
            transaction_id: None,
            workspace_root: root.to_path_buf(),
            cancellation: CancellationToken::new(),
            authorized_effects: ToolEffectPlan {
                effects: vec![ToolEffect::MutateTaskState {
                    session_id: Some("session-1".to_string()),
                }],
                analysis_status: "parsed".to_string(),
            },
            file_services: None,
            deferred_tools: Vec::new(),
        }
    }

    #[tokio::test]
    async fn todo_create_returns_items_from_the_shared_store() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TaskStore::new(directory.path(), persistence));
        let create = TodoTool::create(Arc::clone(&store));
        let context = context(directory.path());

        let created = create
            .execute(
                &serde_json::json!({ "items": [{ "subject": "Implement Todo store" }] }),
                &context,
            )
            .await;
        assert!(matches!(
            created,
            ToolExecutionResult::Success { data: Some(ref value), .. }
                if value["snapshot"]["items"][0]["id"] == "t1"
        ));
    }

    #[tokio::test]
    async fn todo_update_commits_a_complete_and_start_transition_atomically() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TaskStore::new(directory.path(), persistence));
        let create = TodoTool::create(Arc::clone(&store));
        let update = TodoTool::update(Arc::clone(&store));
        let context = context(directory.path());
        create
            .execute(
                &serde_json::json!({
                    "items": [{ "subject": "first" }, { "subject": "second" }]
                }),
                &context,
            )
            .await;
        update
            .execute(
                &serde_json::json!({
                    "expectedRevision": 1,
                    "updates": [{ "todoId": "t1", "status": "in_progress" }]
                }),
                &context,
            )
            .await;

        let updated = update
            .execute(
                &serde_json::json!({
                    "expectedRevision": 2,
                    "updates": [
                        { "todoId": "t1", "status": "completed" },
                        { "todoId": "t2", "status": "in_progress" }
                    ]
                }),
                &context,
            )
            .await;

        assert!(matches!(
            updated,
            ToolExecutionResult::Success { data: Some(ref value), .. }
                if value["snapshot"]["revision"] == 3
                    && value["snapshot"]["items"][0]["status"] == "completed"
                    && value["snapshot"]["items"][1]["status"] == "in_progress"
        ));
    }

    #[tokio::test]
    async fn todo_update_conflict_returns_the_latest_snapshot() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TaskStore::new(directory.path(), persistence));
        let create = TodoTool::create(Arc::clone(&store));
        let update = TodoTool::update(store);
        let context = context(directory.path());
        create
            .execute(
                &serde_json::json!({ "items": [{ "subject": "first" }] }),
                &context,
            )
            .await;

        let conflicted = update
            .execute(
                &serde_json::json!({
                    "expectedRevision": 0,
                    "updates": [{ "todoId": "t1", "status": "in_progress" }]
                }),
                &context,
            )
            .await;

        assert!(matches!(
            conflicted,
            ToolExecutionResult::Error { error, .. }
                if error.code == "TODO_CONFLICT"
                    && error.details.as_ref().is_some_and(|value| value["snapshot"]["revision"] == 1)
        ));
    }
}
