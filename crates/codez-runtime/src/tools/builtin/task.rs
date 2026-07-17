use std::sync::Arc;

use codez_core::{AppError, AppErrorKind, SessionId};
use serde_json::{Map, Value};

use crate::{
    task::{TaskCreateInput, TaskSnapshot, TaskStatus, TaskStore, TaskUpdateInput},
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
enum TaskToolKind {
    Create,
    Update,
    Get,
    List,
}

/// One of the four typed session-task handlers exposed to model tool loops.
pub struct TaskTool {
    descriptor: DefaultToolDescriptor,
    kind: TaskToolKind,
    store: Arc<TaskStore>,
}

impl TaskTool {
    #[must_use]
    pub fn create(store: Arc<TaskStore>) -> Self {
        Self::new(
            TaskToolKind::Create,
            "TaskCreate",
            "Create session-scoped tracking tasks.",
            "Creates one or more durable tasks in pending state for multi-step work.",
            create_schema(),
            store,
        )
    }

    #[must_use]
    pub fn update(store: Arc<TaskStore>) -> Self {
        Self::new(
            TaskToolKind::Update,
            "TaskUpdate",
            "Update one session task.",
            "Updates a task by ID. Keep at most one task in_progress and mark completed work promptly.",
            update_schema(),
            store,
        )
    }

    #[must_use]
    pub fn get(store: Arc<TaskStore>) -> Self {
        Self::new(
            TaskToolKind::Get,
            "TaskGet",
            "Read one session task.",
            "Returns the complete typed task identified by taskId for the active session.",
            task_id_schema(),
            store,
        )
    }

    #[must_use]
    pub fn list(store: Arc<TaskStore>) -> Self {
        Self::new(
            TaskToolKind::List,
            "TaskList",
            "List session tasks and progress.",
            "Returns the active session's complete task snapshot and progress summary.",
            serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {}
            }),
            store,
        )
    }

    fn new(
        kind: TaskToolKind,
        name: &'static str,
        summary: &str,
        description: &str,
        input_schema: Value,
        store: Arc<TaskStore>,
    ) -> Self {
        let concurrency = if matches!(kind, TaskToolKind::Create | TaskToolKind::Update) {
            ToolConcurrency::ResourceLocked
        } else {
            ToolConcurrency::Safe
        };
        Self {
            descriptor: DefaultToolDescriptor {
                name,
                version: "1.0.0",
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
                    concurrency,
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
            TaskToolKind::Create | TaskToolKind::Update => ToolEffect::MutateTaskState {
                session_id: session_id.map(str::to_string),
            },
            TaskToolKind::Get | TaskToolKind::List => ToolEffect::ReadMemory {
                path: task_resource(session_id),
            },
        }
    }
}

impl ToolHandler for TaskTool {
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
                    return error_result(error, self.effect(context.session_id.as_deref()));
                }
            };
            let result = match self.kind {
                TaskToolKind::Create => execute_create(&self.store, &session_id, input).await,
                TaskToolKind::Update => execute_update(&self.store, &session_id, input).await,
                TaskToolKind::Get => execute_get(&self.store, &session_id, input).await,
                TaskToolKind::List => execute_list(&self.store, &session_id).await,
            };
            match result {
                Ok(value) => success_result(value, self.effect(Some(session_id.as_str()))),
                Err(error) => error_result(error, self.effect(Some(session_id.as_str()))),
            }
        })
    }
}

fn parse_session_id(value: Option<&str>) -> Result<SessionId, AppError> {
    let value = value.ok_or_else(|| AppError::validation("The task tool requires a session"))?;
    SessionId::parse(value.to_string())
        .map_err(|source| AppError::validation(format!("The task session is invalid: {source}")))
}

async fn execute_create(
    store: &TaskStore,
    session_id: &SessionId,
    input: &Value,
) -> Result<Value, AppError> {
    let tasks = input
        .get("tasks")
        .cloned()
        .ok_or_else(|| AppError::validation("TaskCreate requires tasks"))?;
    let tasks: Vec<TaskCreateInput> = serde_json::from_value(tasks)
        .map_err(|source| AppError::validation(format!("TaskCreate input is invalid: {source}")))?;
    store.create(session_id, tasks).await.map(snapshot_result)
}

async fn execute_update(
    store: &TaskStore,
    session_id: &SessionId,
    input: &Value,
) -> Result<Value, AppError> {
    let task_id = input
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("TaskUpdate requires taskId"))?;
    let mut patch = input.clone();
    patch
        .as_object_mut()
        .ok_or_else(|| AppError::validation("TaskUpdate input must be an object"))?
        .remove("taskId");
    let patch: TaskUpdateInput = serde_json::from_value(patch)
        .map_err(|source| AppError::validation(format!("TaskUpdate input is invalid: {source}")))?;
    let snapshot = store.update(session_id, task_id, patch).await?;
    let task = snapshot
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .cloned()
        .ok_or_else(|| AppError::internal("updated task disappeared from its snapshot"))?;
    Ok(serde_json::json!({
        "task": task,
        "summary": task_summary(&snapshot),
        "snapshot": snapshot
    }))
}

async fn execute_get(
    store: &TaskStore,
    session_id: &SessionId,
    input: &Value,
) -> Result<Value, AppError> {
    let task_id = input
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("TaskGet requires taskId"))?;
    let task = store.get(session_id, task_id).await?;
    Ok(serde_json::json!({ "task": task }))
}

async fn execute_list(store: &TaskStore, session_id: &SessionId) -> Result<Value, AppError> {
    store.snapshot(session_id).await.map(snapshot_result)
}

fn snapshot_result(snapshot: TaskSnapshot) -> Value {
    serde_json::json!({
        "summary": task_summary(&snapshot),
        "snapshot": snapshot
    })
}

fn task_summary(snapshot: &TaskSnapshot) -> String {
    let completed = count_status(snapshot, TaskStatus::Completed);
    let in_progress = count_status(snapshot, TaskStatus::InProgress);
    let cancelled = count_status(snapshot, TaskStatus::Cancelled);
    let mut parts = vec![format!("{completed}/{} completed", snapshot.tasks.len())];
    if in_progress > 0 {
        parts.push(format!("{in_progress} in progress"));
    }
    if cancelled > 0 {
        parts.push(format!("{cancelled} cancelled"));
    }
    parts.join(", ")
}

fn count_status(snapshot: &TaskSnapshot, status: TaskStatus) -> usize {
    snapshot
        .tasks
        .iter()
        .filter(|task| task.status == status)
        .count()
}

fn task_resource(session_id: Option<&str>) -> String {
    format!("session:{}:tasks", session_id.unwrap_or("unavailable"))
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

fn error_result(error: AppError, effect: ToolEffect) -> ToolExecutionResult {
    let (code, recoverable) = match error.kind() {
        AppErrorKind::Validation => ("TASK_INPUT_INVALID", true),
        AppErrorKind::NotFound => ("TASK_NOT_FOUND", true),
        AppErrorKind::Conflict => ("TASK_CONFLICT", true),
        AppErrorKind::Storage => ("TASK_STORAGE_FAILED", error.retryable()),
        _ => ("TASK_OPERATION_FAILED", false),
    };
    let message = error.public_message().to_string();
    ToolExecutionResult::Error {
        error: ToolExecutionError {
            code: code.to_string(),
            message: message.clone(),
            recoverable,
            suggestion: None,
            retry_after_ms: None,
            details: None,
        },
        model_content: Some(format!("Error: {message}")),
        ui_content: None,
        effects: Some(vec![effect]),
    }
}

fn cancelled_result(effect: ToolEffect) -> ToolExecutionResult {
    ToolExecutionResult::Cancelled {
        error: ToolExecutionError {
            code: "TASK_CANCELLED".to_string(),
            message: "The task operation was cancelled".to_string(),
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
            "tasks": {
                "type": "array",
                "minItems": 1,
                "maxItems": 256,
                "items": task_fields_schema(true)
            }
        },
        "required": ["tasks"]
    })
}

fn update_schema() -> Value {
    let mut properties = task_properties();
    properties.insert(
        "taskId".to_string(),
        serde_json::json!({ "type": "string", "pattern": "^t[1-9][0-9]*$" }),
    );
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": ["taskId"]
    })
}

fn task_id_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "taskId": { "type": "string", "pattern": "^t[1-9][0-9]*$" }
        },
        "required": ["taskId"]
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
        "maxItems": 128,
        "items": { "type": "string", "minLength": 1, "maxLength": 4096 }
    })
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use codez_core::{AtomicPersistence, CancellationToken};
    use codez_storage::AtomicFileStore;

    use super::TaskTool;
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
    async fn task_handlers_share_one_durable_store() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(AtomicFileStore::default());
        let store = Arc::new(TaskStore::new(directory.path(), persistence));
        let create = TaskTool::create(Arc::clone(&store));
        let list = TaskTool::list(store);
        let context = context(directory.path());

        let created = create
            .execute(
                &serde_json::json!({ "tasks": [{ "subject": "Implement task store" }] }),
                &context,
            )
            .await;
        let listed = list.execute(&serde_json::json!({}), &context).await;

        assert!(matches!(created, ToolExecutionResult::Success { .. }));
        assert!(matches!(
            listed,
            ToolExecutionResult::Success { data: Some(ref value), .. }
                if value["snapshot"]["tasks"][0]["id"] == "t1"
        ));
    }
}
