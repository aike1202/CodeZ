use codez_core::{AppError, AppErrorKind, FileKind};
use serde_json::Value;

use crate::tools::builtin::file_mutation::{ensure_authorized_path, services, sha256};
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
const MAX_READ_LINES: u64 = 1_000;

pub struct ReadTool {
    descriptor: DefaultToolDescriptor,
}

impl ReadTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Read",
                version: "2.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:read".to_string(),
                summary: "Read one local text file.".to_string(),
                description: "Reads one known text file after path authorization. Use Glob or list_files to discover paths first; call Read separately for each file.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Known workspace-relative or absolute path to one existing text file."
                        },
                        "offset": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Optional 1-based starting line."
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": MAX_READ_LINES,
                            "default": MAX_READ_LINES,
                            "description": "Maximum lines to return."
                        }
                    },
                    "required": ["file_path"]
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
                    max_result_chars: 50_000,
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
            let parsed = if let Some(raw_path) = input.get("file_path").and_then(Value::as_str) {
                match resolve_tool_path(raw_path, &context.workspace_root).await {
                    Ok(resolved) => {
                        effects.push(ToolEffect::ReadFile {
                            path: resolved.path.to_string_lossy().to_string(),
                            scope: if resolved.inside_workspace {
                                "workspace"
                            } else {
                                "external"
                            }
                            .to_string(),
                        });
                        true
                    }
                    Err(_) => false,
                }
            } else {
                false
            };
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
            let Some(raw_path) = input.get("file_path").and_then(Value::as_str) else {
                return Vec::new();
            };
            resolve_tool_path(raw_path, &context.workspace_root)
                .await
                .map(|resolved| vec![format!("{}:read", resolved.path.to_string_lossy())])
                .unwrap_or_default()
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
            let resolved = match resolve_tool_path(raw_path, &context.workspace_root).await {
                Ok(resolved) => resolved,
                Err(error) => return path_error(error),
            };
            if !resolved.inside_workspace {
                return path_error(ToolPathError::OutsideWorkspace);
            }
            let approved = context.authorized_effects.effects.iter().any(|effect| {
                matches!(effect, ToolEffect::ReadFile { path, .. } if PathLike::eq(path, &resolved.path))
            });
            if !approved {
                return path_error(ToolPathError::AuthorizationMismatch);
            }
            let services = match services(context) {
                Ok(services) => services,
                Err(error) => return app_error(error, None),
            };
            let safe_path = match services
                .file_system
                .resolve(std::path::Path::new(raw_path))
                .await
            {
                Ok(path) => path,
                Err(error) => return app_error(error, Some(raw_path)),
            };
            if let Err(error) = ensure_authorized_path(&resolved.path, &safe_path) {
                return app_error(error, Some(raw_path));
            }
            let metadata = match services.file_system.metadata(&safe_path).await {
                Ok(metadata) if metadata.kind == FileKind::File => metadata,
                Ok(_) => {
                    return execution_error(
                        "TOOL_PATH_INVALID",
                        "Read only accepts one regular file.",
                        true,
                    );
                }
                Err(error) => return app_error(error, Some(raw_path)),
            };
            if metadata.byte_length > MAX_READ_BYTES {
                return execution_error(
                    "TOOL_FILE_TOO_LARGE",
                    "The file exceeds the 10 MiB read limit. Use Grep to locate a smaller range.",
                    true,
                );
            }
            let bytes = match services
                .file_system
                .read_bounded(&safe_path, MAX_READ_BYTES)
                .await
            {
                Ok(bytes) => bytes,
                Err(error) => return app_error(error, Some(raw_path)),
            };
            let content = match String::from_utf8(bytes) {
                Ok(content) => content,
                Err(_) => {
                    return execution_error(
                        "TOOL_FILE_NOT_TEXT",
                        "The file is not valid UTF-8 text.",
                        true,
                    );
                }
            };
            if let Some(session_id) = context.session_id.as_deref() {
                let sha256 = sha256(content.as_bytes());
                services
                    .fingerprint_store
                    .record(session_id, &safe_path.absolute_path(), &sha256);
                services.fingerprint_store.record_delivery(
                    session_id,
                    &context.context_scope_id,
                    &safe_path.absolute_path(),
                    &sha256,
                );
            }
            let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(1);
            let limit = arguments
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(MAX_READ_LINES)
                .min(MAX_READ_LINES);
            let start = usize::try_from(offset.saturating_sub(1)).unwrap_or(usize::MAX);
            let limit = usize::try_from(limit).unwrap_or(MAX_READ_LINES as usize);
            let lines = content
                .lines()
                .enumerate()
                .skip(start)
                .take(limit)
                .map(|(index, line)| format!("{:>6}\t{}", index + 1, line))
                .collect::<Vec<_>>()
                .join("\n");
            ToolExecutionResult::Success {
                data: None,
                model_content: format!("<file path=\"{}\">\n{}\n</file>", raw_path, lines),
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

fn app_error(error: AppError, requested_path: Option<&str>) -> ToolExecutionResult {
    let (code, recoverable) = match error.kind() {
        AppErrorKind::Conflict => ("TOOL_PATH_CHANGED", true),
        AppErrorKind::NotFound => ("TOOL_FILE_NOT_FOUND", true),
        AppErrorKind::Validation => ("TOOL_READ_INVALID", true),
        AppErrorKind::PermissionDenied => ("TOOL_PATH_NOT_AUTHORIZED", false),
        _ => ("TOOL_READ_FAILED", false),
    };
    if error.kind() == AppErrorKind::NotFound
        && let Some(path) = requested_path
    {
        return execution_error_with_suggestion(
            code,
            &format!("The requested file does not exist: {path}"),
            recoverable,
            "Use Glob or list_files to discover the actual path before retrying Read.",
        );
    }
    execution_error(code, error.public_message(), recoverable)
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

fn execution_error_with_suggestion(
    code: &str,
    message: &str,
    recoverable: bool,
    suggestion: &str,
) -> ToolExecutionResult {
    ToolExecutionResult::Error {
        error: ToolExecutionError {
            code: code.to_string(),
            message: message.to_string(),
            recoverable,
            suggestion: Some(suggestion.to_string()),
            retry_after_ms: None,
            details: None,
        },
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_READ_LINES, ReadTool};
    use crate::tools::registry::ToolHandler;

    #[test]
    fn schema_accepts_exactly_one_file_path() {
        let tool = ReadTool::new();
        let schema = tool.descriptor().input_schema();

        assert!(
            schema["required"] == serde_json::json!(["file_path"])
                && schema["properties"].get("files").is_none()
                && schema["properties"]["limit"]["maximum"] == serde_json::json!(MAX_READ_LINES)
                && schema["additionalProperties"] == serde_json::json!(false)
        );
    }
}
