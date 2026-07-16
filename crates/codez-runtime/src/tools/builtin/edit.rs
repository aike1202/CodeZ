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

const MAX_EDIT_BYTES: u64 = 10 * 1024 * 1024;

pub struct EditTool {
    descriptor: DefaultToolDescriptor,
}

impl EditTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Edit",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:edit".to_string(),
                summary: "Make exact string replacements in a file.".to_string(),
                description: "Edits a bounded UTF-8 file after exact path authorization."
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "file_path": { "type": "string", "minLength": 1 },
                        "edits": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "old_string": { "type": "string", "minLength": 1 },
                                    "new_string": { "type": "string" },
                                    "replace_all": { "type": "boolean" }
                                },
                                "required": ["old_string", "new_string"]
                            }
                        }
                    },
                    "required": ["file_path", "edits"]
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

impl Default for EditTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for EditTool {
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
                return unparsed_plan("edit-path-missing");
            };
            resolve_tool_path(raw_path, &context.workspace_root)
                .await
                .map_or_else(
                    |_| unparsed_plan("edit-path-analysis"),
                    |resolved| ToolEffectPlan {
                        effects: vec![ToolEffect::WriteFile {
                            path: resolved.path.to_string_lossy().to_string(),
                            mode: "modify".to_string(),
                        }],
                        analysis_status: "parsed".to_string(),
                    },
                )
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
            let Some(edits) = arguments.get("edits").and_then(Value::as_array) else {
                return execution_error("TOOL_INPUT_INVALID", "edits is required", true);
            };
            let resolved = match resolve_tool_path(raw_path, &context.workspace_root).await {
                Ok(resolved) => resolved,
                Err(error) => return path_error(error),
            };
            let approved = context.authorized_effects.effects.iter().any(|effect| {
                matches!(effect, ToolEffect::WriteFile { path, mode } if mode == "modify" && std::path::Path::new(path) == resolved.path)
            });
            if !approved {
                return path_error(ToolPathError::AuthorizationMismatch);
            }
            let metadata = match tokio::fs::metadata(&resolved.path).await {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => {
                    return execution_error(
                        "TOOL_PATH_INVALID",
                        "Edit only accepts regular files.",
                        true,
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return execution_error("TOOL_FILE_NOT_FOUND", "File not found.", true);
                }
                Err(_) => {
                    return execution_error(
                        "TOOL_READ_FAILED",
                        "The file metadata could not be read.",
                        false,
                    );
                }
            };
            if metadata.len() > MAX_EDIT_BYTES {
                return execution_error(
                    "TOOL_FILE_TOO_LARGE",
                    "The file exceeds the 10 MiB edit limit.",
                    true,
                );
            }
            let mut content = match tokio::fs::read_to_string(&resolved.path).await {
                Ok(content) => content,
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    return execution_error(
                        "TOOL_FILE_NOT_TEXT",
                        "The file is not valid UTF-8 text.",
                        true,
                    );
                }
                Err(_) => {
                    return execution_error(
                        "TOOL_READ_FAILED",
                        "The file could not be read.",
                        false,
                    );
                }
            };
            for (index, edit) in edits.iter().enumerate() {
                let Some(old_string) = edit.get("old_string").and_then(Value::as_str) else {
                    return execution_error(
                        "TOOL_INPUT_INVALID",
                        "Every edit requires old_string.",
                        true,
                    );
                };
                let Some(new_string) = edit.get("new_string").and_then(Value::as_str) else {
                    return execution_error(
                        "TOOL_INPUT_INVALID",
                        "Every edit requires new_string.",
                        true,
                    );
                };
                let replace_all = edit
                    .get("replace_all")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let count = content.matches(old_string).count();
                if count == 0 {
                    return execution_error(
                        "TOOL_EDIT_CONFLICT",
                        &format!("Edit {} did not match the current file.", index + 1),
                        true,
                    );
                }
                if count > 1 && !replace_all {
                    return execution_error(
                        "TOOL_EDIT_CONFLICT",
                        &format!(
                            "Edit {} matched {count} locations; replace_all is required.",
                            index + 1
                        ),
                        true,
                    );
                }
                content = if replace_all {
                    content.replace(old_string, new_string)
                } else {
                    content.replacen(old_string, new_string, 1)
                };
            }
            match tokio::fs::write(&resolved.path, content).await {
                Ok(()) => ToolExecutionResult::Success {
                    data: None,
                    model_content: format!("Successfully edited {raw_path}"),
                    ui_content: None,
                    effects: None,
                },
                Err(_) => execution_error(
                    "TOOL_WRITE_FAILED",
                    "The edited file could not be written.",
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
