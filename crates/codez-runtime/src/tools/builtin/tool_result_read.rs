use std::sync::Arc;

use serde_json::Value;

use crate::tools::large_result::LargeToolResultStore;
use crate::tools::registry::{
    BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext, ToolDescriptor,
    ToolHandler,
};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
    ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
    ToolPlanningContext, ToolSource,
};

const DEFAULT_READ_CHARS: usize = 20_000;
const MAX_READ_CHARS: usize = 50_000;

/// Reads a bounded chunk from an opaque result handle owned by the active session.
pub struct ToolResultReadTool {
    descriptor: DefaultToolDescriptor,
    store: Arc<LargeToolResultStore>,
}

impl ToolResultReadTool {
    #[must_use]
    pub fn new(store: Arc<LargeToolResultStore>) -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "ToolResultRead",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:tool-result-read".to_string(),
                summary: "Read a persisted tool result by opaque handle.".to_string(),
                description: "Reads a bounded chunk from a tool-result:// handle returned by a previous tool call. It only accepts opaque handles owned by the active workspace and session, never filesystem paths.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "handle": {
                            "type": "string",
                            "pattern": "^tool-result://[A-Za-z0-9_-]+$"
                        },
                        "offset": {
                            "type": "integer",
                            "minimum": 0,
                            "default": 0
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": MAX_READ_CHARS,
                            "default": DEFAULT_READ_CHARS
                        }
                    },
                    "required": ["handle"]
                }),
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Core,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::Safe,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 55_000,
                    timeout_ms: Some(30_000),
                },
            },
            store,
        }
    }
}

impl ToolHandler for ToolResultReadTool {
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
                effects: vec![ToolEffect::ReadMemory {
                    path: result_resource(context.session_id.as_deref()),
                }],
                analysis_status: "parsed".to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move { vec![result_resource(context.session_id.as_deref())] })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            if context.cancellation.is_cancelled() {
                return cancelled_result();
            }
            let Some(session_id) = context.session_id.as_deref() else {
                return error_result(
                    "TOOL_RESULT_SESSION_REQUIRED",
                    "ToolResultRead requires an active session.",
                    false,
                );
            };
            let Some(handle) = input.get("handle").and_then(Value::as_str) else {
                return error_result(
                    "TOOL_RESULT_INPUT_INVALID",
                    "A tool-result handle is required.",
                    false,
                );
            };
            if !valid_handle(handle) {
                return error_result(
                    "TOOL_RESULT_INPUT_INVALID",
                    "The tool-result handle is invalid.",
                    false,
                );
            }
            let offset = match optional_usize(input, "offset") {
                Ok(offset) => offset,
                Err(message) => {
                    return error_result("TOOL_RESULT_INPUT_INVALID", message, false);
                }
            };
            let limit = match optional_usize(input, "limit") {
                Ok(limit) if limit.is_none_or(|value| (1..=MAX_READ_CHARS).contains(&value)) => {
                    limit
                }
                Ok(_) => {
                    return error_result(
                        "TOOL_RESULT_INPUT_INVALID",
                        "limit must be between 1 and 50000.",
                        false,
                    );
                }
                Err(message) => {
                    return error_result("TOOL_RESULT_INPUT_INVALID", message, false);
                }
            };

            let read = self
                .store
                .read(&context.workspace_root, session_id, handle, offset, limit)
                .await;
            if context.cancellation.is_cancelled() {
                return cancelled_result();
            }
            let read = match read {
                Ok(read) => read,
                Err(error) => {
                    return error_result("TOOL_RESULT_READ_FAILED", &error.to_string(), true);
                }
            };
            let data = match serde_json::to_value(&read) {
                Ok(data) => data,
                Err(error) => {
                    return error_result(
                        "TOOL_RESULT_SERIALIZATION_FAILED",
                        &error.to_string(),
                        false,
                    );
                }
            };
            let model_content = match serde_json::to_string(&read) {
                Ok(content) => content,
                Err(error) => {
                    return error_result(
                        "TOOL_RESULT_SERIALIZATION_FAILED",
                        &error.to_string(),
                        false,
                    );
                }
            };

            ToolExecutionResult::Success {
                data: Some(data),
                model_content,
                ui_content: None,
                effects: None,
            }
        })
    }
}

fn optional_usize<'a>(input: &'a Value, field: &str) -> Result<Option<usize>, &'a str> {
    let Some(value) = input.get(field) else {
        return Ok(None);
    };
    let Some(value) = value.as_u64() else {
        return Err("offset and limit must be non-negative integers.");
    };
    usize::try_from(value)
        .map(Some)
        .map_err(|_| "offset or limit is too large for this platform.")
}

fn result_resource(session_id: Option<&str>) -> String {
    format!(
        "session:{}:tool-results",
        session_id.unwrap_or("unavailable")
    )
}

fn valid_handle(handle: &str) -> bool {
    handle.strip_prefix("tool-result://").is_some_and(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

fn cancelled_result() -> ToolExecutionResult {
    ToolExecutionResult::Cancelled {
        error: tool_error(
            "TOOL_CANCELLED",
            "The persisted tool-result read was interrupted.",
            true,
        ),
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

fn error_result(code: &str, message: &str, recoverable: bool) -> ToolExecutionResult {
    ToolExecutionResult::Error {
        error: tool_error(code, message, recoverable),
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

fn tool_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionError {
    ToolExecutionError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use codez_core::CancellationToken;

    use super::*;

    fn context(workspace_root: &std::path::Path, session_id: Option<&str>) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            call_id: "call-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            session_id: session_id.map(str::to_string),
            context_scope_id: "main".to_string(),
            transaction_id: None,
            workspace_root: workspace_root.to_path_buf(),
            cancellation: CancellationToken::new(),
            authorized_effects: ToolEffectPlan {
                effects: vec![ToolEffect::ReadMemory {
                    path: result_resource(session_id),
                }],
                analysis_status: "parsed".to_string(),
            },
            file_services: None,
            deferred_tools: Vec::new(),
        }
    }

    fn error_code(result: &ToolExecutionResult) -> Option<&str> {
        match result {
            ToolExecutionResult::Success { .. } => None,
            ToolExecutionResult::Error { error, .. }
            | ToolExecutionResult::Denied { error, .. }
            | ToolExecutionResult::Cancelled { error, .. } => Some(error.code.as_str()),
        }
    }

    #[test]
    fn schema_accepts_only_opaque_bounded_handles() {
        let store = Arc::new(LargeToolResultStore::new(std::env::temp_dir()));
        let schema = ToolResultReadTool::new(store).descriptor().input_schema();

        assert!(
            schema["required"] == serde_json::json!(["handle"])
                && schema["properties"]["handle"]["pattern"]
                    == serde_json::json!("^tool-result://[A-Za-z0-9_-]+$")
                && schema["properties"]["limit"]["maximum"] == serde_json::json!(MAX_READ_CHARS)
                && schema["additionalProperties"] == serde_json::json!(false)
        );
    }

    #[tokio::test]
    async fn execute_requires_an_active_session() {
        let root = tempfile::tempdir().expect("temporary root must be available");
        let tool = ToolResultReadTool::new(Arc::new(LargeToolResultStore::new(
            root.path().join("results"),
        )));

        let result = tool
            .execute(
                &serde_json::json!({"handle": "tool-result://result"}),
                &context(root.path(), None),
            )
            .await;

        assert_eq!(error_code(&result), Some("TOOL_RESULT_SESSION_REQUIRED"));
    }

    #[tokio::test]
    async fn execute_reads_a_unicode_chunk_owned_by_the_session() {
        let root = tempfile::tempdir().expect("temporary root must be available");
        let store = Arc::new(LargeToolResultStore::new(root.path().join("results")));
        let persisted = store
            .persist(root.path(), "session-a", "call-a", "Read", "a你b好c")
            .await
            .expect("fixture result must persist");
        let tool = ToolResultReadTool::new(store);

        let result = tool
            .execute(
                &serde_json::json!({"handle": persisted.handle, "offset": 1, "limit": 3}),
                &context(root.path(), Some("session-a")),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Success { data: Some(data), .. }
                if data["content"] == serde_json::json!("你b好")
                    && data["offset"] == serde_json::json!(1)
                    && data["nextOffset"] == serde_json::json!(4)
                    && data["totalChars"] == serde_json::json!(5)
        ));
    }

    #[tokio::test]
    async fn execute_rejects_a_handle_from_another_session() {
        let root = tempfile::tempdir().expect("temporary root must be available");
        let store = Arc::new(LargeToolResultStore::new(root.path().join("results")));
        let persisted = store
            .persist(root.path(), "session-a", "call-a", "Read", "secret")
            .await
            .expect("fixture result must persist");
        let tool = ToolResultReadTool::new(store);

        let result = tool
            .execute(
                &serde_json::json!({"handle": persisted.handle}),
                &context(root.path(), Some("session-b")),
            )
            .await;

        assert_eq!(error_code(&result), Some("TOOL_RESULT_READ_FAILED"));
    }

    #[tokio::test]
    async fn execute_rejects_a_path_like_handle_before_storage_access() {
        let root = tempfile::tempdir().expect("temporary root must be available");
        let tool = ToolResultReadTool::new(Arc::new(LargeToolResultStore::new(
            root.path().join("results"),
        )));

        let result = tool
            .execute(
                &serde_json::json!({"handle": "tool-result://../outside"}),
                &context(root.path(), Some("session-a")),
            )
            .await;

        assert_eq!(error_code(&result), Some("TOOL_RESULT_INPUT_INVALID"));
    }
}
