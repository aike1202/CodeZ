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

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

pub struct ReadTool {
    descriptor: DefaultToolDescriptor,
}

impl ReadTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Read",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:read".to_string(),
                summary: "Read local files.".to_string(),
                description: "Reads bounded text files after path authorization.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "files": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "file_path": { "type": "string", "minLength": 1 },
                                    "offset": { "type": "integer", "minimum": 1 },
                                    "limit": { "type": "integer", "minimum": 1, "maximum": 5000 }
                                },
                                "required": ["file_path"]
                            }
                        }
                    },
                    "required": ["files"]
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
                    concurrency: ToolConcurrency::Safe,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 100_000,
                    timeout_ms: Some(30_000),
                },
            },
        }
    }
}

impl Default for ReadTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for ReadTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            let mut effects = Vec::new();
            let mut parsed = true;
            if let Some(files) = input.get("files").and_then(Value::as_array) {
                for file in files {
                    let Some(raw_path) = file.get("file_path").and_then(Value::as_str) else {
                        parsed = false;
                        continue;
                    };
                    match resolve_tool_path(raw_path, &context.workspace_root).await {
                        Ok(resolved) => effects.push(ToolEffect::ReadFile {
                            path: resolved.path.to_string_lossy().to_string(),
                            scope: if resolved.inside_workspace {
                                "workspace"
                            } else {
                                "external"
                            }
                            .to_string(),
                        }),
                        Err(_) => parsed = false,
                    }
                }
            } else {
                parsed = false;
            }
            if !parsed {
                effects.push(ToolEffect::Unknown {
                    target: "read-path-analysis".to_string(),
                });
            }
            ToolEffectPlan {
                effects,
                analysis_status: if parsed { "parsed" } else { "unparsed" }.to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            let mut keys = Vec::new();
            if let Some(files) = input.get("files").and_then(Value::as_array) {
                for file in files {
                    if let Some(raw_path) = file.get("file_path").and_then(Value::as_str) {
                        if let Ok(resolved) =
                            resolve_tool_path(raw_path, &context.workspace_root).await
                        {
                            keys.push(format!("{}:read", resolved.path.to_string_lossy()));
                        }
                    }
                }
            }
            keys
        })
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let Some(files) = arguments.get("files").and_then(Value::as_array) else {
                return execution_error("TOOL_INPUT_INVALID", "files is required", true);
            };
            let mut output_blocks = Vec::with_capacity(files.len());
            for item in files {
                let Some(raw_path) = item.get("file_path").and_then(Value::as_str) else {
                    return execution_error(
                        "TOOL_INPUT_INVALID",
                        "Every file requires file_path.",
                        true,
                    );
                };
                let resolved = match resolve_tool_path(raw_path, &context.workspace_root).await {
                    Ok(resolved) => resolved,
                    Err(error) => return path_error(error),
                };
                let approved = context.authorized_effects.effects.iter().any(|effect| {
                    matches!(effect, ToolEffect::ReadFile { path, .. } if PathLike::eq(path, &resolved.path))
                });
                if !approved {
                    return path_error(ToolPathError::AuthorizationMismatch);
                }
                let metadata = match tokio::fs::metadata(&resolved.path).await {
                    Ok(metadata) if metadata.is_file() => metadata,
                    Ok(_) => {
                        return execution_error(
                            "TOOL_PATH_INVALID",
                            "Read only accepts regular files.",
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
                if metadata.len() > MAX_READ_BYTES {
                    return execution_error(
                        "TOOL_FILE_TOO_LARGE",
                        "The file exceeds the 10 MiB read limit.",
                        true,
                    );
                }
                let content = match tokio::fs::read_to_string(&resolved.path).await {
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
                let offset = item.get("offset").and_then(Value::as_u64).unwrap_or(1);
                let limit = item.get("limit").and_then(Value::as_u64).unwrap_or(800);
                let start = usize::try_from(offset.saturating_sub(1)).unwrap_or(usize::MAX);
                let limit = usize::try_from(limit).unwrap_or(5000);
                let lines = content
                    .lines()
                    .enumerate()
                    .skip(start)
                    .take(limit)
                    .map(|(index, line)| format!("{:>6}\t{}", index + 1, line))
                    .collect::<Vec<_>>()
                    .join("\n");
                output_blocks.push(format!("<file path=\"{}\">\n{}\n</file>", raw_path, lines));
            }
            ToolExecutionResult::Success {
                data: None,
                model_content: output_blocks.join("\n\n"),
                ui_content: None,
                effects: None,
            }
        })
    }
}

struct PathLike;

impl PathLike {
    fn eq(value: &str, path: &std::path::Path) -> bool {
        std::path::Path::new(value) == path
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
