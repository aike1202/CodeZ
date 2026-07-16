use serde_json::Value;

use crate::tools::builtin::path::{ToolPathError, resolve_tool_path};
use crate::tools::registry::{
    BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext, ToolDescriptor,
    ToolHandler,
};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
    ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
    ToolPlanningContext, ToolSource,
};

pub struct WriteTool {
    descriptor: DefaultToolDescriptor,
}

impl WriteTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Write",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:write".to_string(),
                summary: "Write or overwrite a file.".to_string(),
                description: "Writes a UTF-8 file after exact path authorization.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "file_path": { "type": "string", "minLength": 1 },
                        "content": { "type": "string" }
                    },
                    "required": ["file_path", "content"]
                }),
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
                    max_result_chars: 100_000,
                    timeout_ms: Some(30_000),
                },
            },
        }
    }
}

impl Default for WriteTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for WriteTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            let Some(raw_path) = input.get("file_path").and_then(Value::as_str) else {
                return unparsed_plan("write-path-missing");
            };
            match resolve_tool_path(raw_path, &context.workspace_root).await {
                Ok(resolved) => ToolEffectPlan {
                    effects: vec![ToolEffect::WriteFile {
                        path: resolved.path.to_string_lossy().to_string(),
                        mode: if tokio::fs::try_exists(&resolved.path).await.unwrap_or(true) {
                            "overwrite"
                        } else {
                            "create"
                        }
                        .to_string(),
                    }],
                    analysis_status: if resolved.inside_workspace {
                        "parsed"
                    } else {
                        "external"
                    }
                    .to_string(),
                },
                Err(_) => unparsed_plan("write-path-analysis"),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            let Some(raw_path) = input.get("file_path").and_then(Value::as_str) else {
                return Vec::new();
            };
            resolve_tool_path(raw_path, &context.workspace_root)
                .await
                .map_or_else(
                    |_| Vec::new(),
                    |resolved| vec![format!("{}:write", resolved.path.to_string_lossy())],
                )
        })
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let Some(raw_path) = arguments.get("file_path").and_then(Value::as_str) else {
                return execution_error("TOOL_INPUT_INVALID", "file_path is required", true);
            };
            let Some(content) = arguments.get("content").and_then(Value::as_str) else {
                return execution_error("TOOL_INPUT_INVALID", "content is required", true);
            };
            let resolved = match resolve_tool_path(raw_path, &context.workspace_root).await {
                Ok(resolved) => resolved,
                Err(error) => return path_error(error),
            };
            let approved = context.authorized_effects.effects.iter().any(|effect| {
                matches!(effect, ToolEffect::WriteFile { path, .. } if std::path::Path::new(path) == resolved.path)
            });
            if !approved {
                return path_error(ToolPathError::AuthorizationMismatch);
            }
            if let Some(parent) = resolved.path.parent() {
                if tokio::fs::create_dir_all(parent).await.is_err() {
                    return execution_error(
                        "TOOL_WRITE_FAILED",
                        "The destination directory could not be created.",
                        false,
                    );
                }
            }
            match tokio::fs::write(&resolved.path, content).await {
                Ok(()) => ToolExecutionResult::Success {
                    data: None,
                    model_content: format!("Successfully wrote to {raw_path}"),
                    ui_content: None,
                    effects: None,
                },
                Err(_) => execution_error(
                    "TOOL_WRITE_FAILED",
                    "The destination file could not be written.",
                    false,
                ),
            }
        })
    }
}

fn unparsed_plan(target: &str) -> ToolEffectPlan {
    ToolEffectPlan {
        effects: vec![ToolEffect::Unknown {
            target: target.to_string(),
        }],
        analysis_status: "unparsed".to_string(),
    }
}

fn path_error(error: ToolPathError) -> ToolExecutionResult {
    execution_error("TOOL_PATH_NOT_AUTHORIZED", &error.to_string(), false)
}

fn execution_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionResult {
    ToolExecutionResult::Error {
        error: ToolExecutionError {
            code: code.to_string(),
            message: message.to_string(),
            recoverable,
            suggestion: None,
            retry_after_ms: None,
            details: None,
        },
        model_content: None,
        ui_content: None,
        effects: None,
    }
}
