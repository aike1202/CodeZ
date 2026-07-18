use std::sync::Arc;

use codez_core::{AppError, AppErrorKind, SessionId};
use serde_json::{Map, Value};

use crate::{
    todo::{
        TodoCreateInput, TodoItem, TodoItemPatch, TodoItemUpdate, TodoListSnapshot, TodoStatus,
        TodoStore, todo_model_state,
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

const MAX_MODEL_TODO_UPDATES: usize = 40;

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
            TodoToolKind::Create | TodoToolKind::Update => ToolEffect::MutateTodoState {
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
        Box::pin(async move { vec![todo_resource(context.session_id.as_deref())] })
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
                            .map(latest_state_result)
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
    let mut items: Vec<TodoCreateInput> = serde_json::from_value(items)
        .map_err(|source| AppError::validation(format!("TodoCreate input is invalid: {source}")))?;
    if items.len() > MAX_MODEL_TODO_UPDATES {
        return Err(AppError::validation(format!(
            "TodoCreate accepts at most {MAX_MODEL_TODO_UPDATES} items per call"
        )));
    }
    for item in &mut items {
        if item.approval_status.is_some() {
            return Err(AppError::validation(
                "TodoCreate cannot set approvalStatus; the runtime derives it from requiresApproval",
            ));
        }
        item.approval_status = Some(if item.requires_approval {
            crate::todo::TodoApprovalStatus::Pending
        } else {
            crate::todo::TodoApprovalStatus::NotRequired
        });
    }
    let created_count = items.len();
    let snapshot = store.create(session_id, items).await?;
    Ok(created_result(&snapshot, created_count))
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
    if updates.len() > MAX_MODEL_TODO_UPDATES {
        return Err(AppError::validation(format!(
            "TodoUpdate accepts at most {MAX_MODEL_TODO_UPDATES} items per call"
        )));
    }
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
        if patch.requires_approval.is_some() || patch.approval_status.is_some() {
            return Err(AppError::validation(
                "TodoUpdate cannot change approval policy or approval status",
            ));
        }
        parsed_updates.push(TodoItemUpdate { todo_id, patch });
    }
    let updated_ids = parsed_updates
        .iter()
        .map(|update| update.todo_id.clone())
        .collect::<Vec<_>>();
    let snapshot = store
        .update_batch(session_id, expected_revision, parsed_updates)
        .await?;
    Ok(updated_result(&snapshot, &updated_ids))
}

fn created_result(snapshot: &TodoListSnapshot, created_count: usize) -> Value {
    let created = snapshot
        .items
        .iter()
        .rev()
        .take(created_count)
        .rev()
        .map(todo_brief)
        .collect::<Vec<_>>();
    serde_json::json!({
        "revision": snapshot.revision,
        "summary": todo_summary(snapshot),
        "created": created,
        "state": todo_model_state(snapshot)
    })
}

fn updated_result(snapshot: &TodoListSnapshot, updated_ids: &[String]) -> Value {
    let updated = updated_ids
        .iter()
        .filter_map(|id| snapshot.items.iter().find(|todo| todo.id == id.as_str()))
        .map(todo_brief)
        .collect::<Vec<_>>();
    serde_json::json!({
        "revision": snapshot.revision,
        "summary": todo_summary(snapshot),
        "updated": updated,
        "state": todo_model_state(snapshot)
    })
}

fn latest_state_result(snapshot: TodoListSnapshot) -> Value {
    serde_json::json!({
        "revision": snapshot.revision,
        "state": todo_model_state(&snapshot)
    })
}

fn todo_brief(todo: &TodoItem) -> Value {
    serde_json::json!({
        "id": todo.id,
        "subject": todo.subject,
        "status": todo.status,
        "blockedBy": todo.blocked_by,
        "requiresApproval": todo.requires_approval,
        "approvalStatus": todo.approval_status
    })
}

fn todo_summary(snapshot: &TodoListSnapshot) -> String {
    let completed = count_status(snapshot, TodoStatus::Completed);
    let in_progress = count_status(snapshot, TodoStatus::InProgress);
    let cancelled = count_status(snapshot, TodoStatus::Cancelled);
    let ready = snapshot
        .items
        .iter()
        .filter(|todo| todo_is_ready(snapshot, todo))
        .count();
    let blocked = snapshot
        .items
        .iter()
        .filter(|todo| todo_is_blocked(snapshot, todo))
        .count();
    let mut parts = vec![format!("{completed}/{} completed", snapshot.items.len())];
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

fn todo_is_ready(snapshot: &TodoListSnapshot, todo: &TodoItem) -> bool {
    todo.status == TodoStatus::Pending && !todo_is_blocked(snapshot, todo)
}

fn todo_is_blocked(snapshot: &TodoListSnapshot, todo: &TodoItem) -> bool {
    todo.status == TodoStatus::Pending
        && (todo_waits_for_approval(todo)
            || todo.blocked_by.iter().any(|dependency| {
                snapshot
                    .items
                    .iter()
                    .find(|candidate| candidate.id == dependency.as_str())
                    .is_none_or(|candidate| candidate.status != TodoStatus::Completed)
            }))
}

fn todo_waits_for_approval(todo: &TodoItem) -> bool {
    todo.requires_approval && todo.approval_status != crate::todo::TodoApprovalStatus::Approved
}

fn count_status(snapshot: &TodoListSnapshot, status: TodoStatus) -> usize {
    snapshot
        .items
        .iter()
        .filter(|todo| todo.status == status)
        .count()
}

fn todo_resource(session_id: Option<&str>) -> String {
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
                "maxItems": MAX_MODEL_TODO_UPDATES,
                "items": todo_fields_schema(true)
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
                "maxItems": MAX_MODEL_TODO_UPDATES,
                "items": todo_update_item_schema()
            }
        },
        "required": ["updates"]
    })
}

fn todo_update_item_schema() -> Value {
    let mut properties = todo_properties(false);
    properties.insert(
        "todoId".to_string(),
        serde_json::json!({ "type": "string", "pattern": "^t[1-9][0-9]*$" }),
    );
    properties.insert("addBlockedBy".to_string(), todo_id_list_schema());
    properties.insert("removeBlockedBy".to_string(), todo_id_list_schema());
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
            { "required": ["acceptanceCriteria"] },
            { "required": ["verificationCommand"] },
            { "required": ["contextBundle"] }
        ]
    })
}

fn todo_fields_schema(require_subject: bool) -> Value {
    let mut properties = todo_properties(true);
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

fn todo_properties(allow_requires_approval: bool) -> Map<String, Value> {
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
    let mut fields = fields.as_object().cloned().unwrap_or_default();
    if allow_requires_approval {
        fields.insert(
            "requiresApproval".to_string(),
            serde_json::json!({ "type": "boolean" }),
        );
    }
    fields
}

fn string_list_schema() -> Value {
    serde_json::json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 128,
        "items": { "type": "string", "minLength": 1, "maxLength": 4096 }
    })
}

fn todo_id_list_schema() -> Value {
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
        todo::TodoStore,
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
                effects: vec![ToolEffect::MutateTodoState {
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
        let store = Arc::new(TodoStore::new(directory.path(), persistence));
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
                if value["revision"] == 1
                    && value["created"][0]["id"] == "t1"
                    && value["state"]["items"][0]["id"] == "t1"
        ));
    }

    #[tokio::test]
    async fn todo_create_rejects_more_than_the_model_projection_limit() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TodoStore::new(directory.path(), persistence));
        let create = TodoTool::create(store);
        let context = context(directory.path());
        let items = (1..=41)
            .map(|index| serde_json::json!({ "subject": format!("todo {index}") }))
            .collect::<Vec<_>>();

        let result = create
            .execute(&serde_json::json!({ "items": items }), &context)
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. }
                if error.code == "TODO_INPUT_INVALID"
                    && error.message.contains("at most 40 items")
        ));
    }

    #[tokio::test]
    async fn todo_update_commits_a_complete_and_start_transition_atomically() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TodoStore::new(directory.path(), persistence));
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
                if value["revision"] == 3
                    && value["updated"][0]["status"] == "completed"
                    && value["updated"][1]["status"] == "in_progress"
        ));
    }

    #[tokio::test]
    async fn todo_update_rejects_more_than_the_model_projection_limit() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TodoStore::new(directory.path(), persistence));
        let create = TodoTool::create(Arc::clone(&store));
        let update = TodoTool::update(store);
        let context = context(directory.path());
        create
            .execute(
                &serde_json::json!({ "items": [{ "subject": "first" }] }),
                &context,
            )
            .await;
        let updates = (1..=41)
            .map(|index| serde_json::json!({ "todoId": "t1", "subject": format!("todo {index}") }))
            .collect::<Vec<_>>();

        let result = update
            .execute(&serde_json::json!({ "updates": updates }), &context)
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. }
                if error.code == "TODO_INPUT_INVALID"
                    && error.message.contains("at most 40 items")
        ));
    }

    #[tokio::test]
    async fn todo_update_conflict_returns_the_latest_snapshot() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TodoStore::new(directory.path(), persistence));
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
                    && error.details.as_ref().is_some_and(|value| {
                        value["revision"] == 1 && value["state"]["items"][0]["id"] == "t1"
                    })
        ));
    }

    #[tokio::test]
    async fn todo_update_conflict_returns_a_bounded_latest_state() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TodoStore::new(directory.path(), persistence));
        let create = TodoTool::create(Arc::clone(&store));
        let update = TodoTool::update(store);
        let context = context(directory.path());
        let first_batch = (1..=40)
            .map(|index| serde_json::json!({ "subject": format!("todo {index}") }))
            .collect::<Vec<_>>();
        let second_batch = (41..=45)
            .map(|index| serde_json::json!({ "subject": format!("todo {index}") }))
            .collect::<Vec<_>>();
        create
            .execute(&serde_json::json!({ "items": first_batch }), &context)
            .await;
        create
            .execute(&serde_json::json!({ "items": second_batch }), &context)
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
                if error.details.as_ref().is_some_and(|value| {
                    value["state"]["items"].as_array().is_some_and(|items| items.len() == 40)
                        && value["state"]["summary"]["omitted"] == 5
                        && value.get("snapshot").is_none()
                })
        ));
    }
}
