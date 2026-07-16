use std::path::Path;
use serde_json::Value;
use tokio::fs;

use crate::tools::registry::{DefaultToolDescriptor, ToolDescriptor, ToolHandler, ToolContext, BoxFuture, ToolAvailability, ToolBehavior};
use crate::tools::types::{
    ToolApprovalMetadata,
    ToolExecutionResult, ToolExecutionError, ToolSource, ToolExposure, ToolConcurrency,
    ToolInterruptBehavior, ModelPreference
};

pub struct EditTool {
    descriptor: DefaultToolDescriptor,
}

impl EditTool {
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Edit",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:edit".to_string(),
                summary: "Make atomic exact string replacements in a file.".to_string(),
                description: "Performs exact string replacements in an existing file.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "file_path": { "type": "string" },
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "old_string": { "type": "string" },
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
                    concurrency: ToolConcurrency::Safe,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 100_000,
                    timeout_ms: Some(30_000),
                },
            }
        }
    }
}

impl ToolHandler for EditTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a Value,
        _context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let file_path_str = match arguments.get("file_path").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => {
                    return ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "INVALID_ARGUMENT".to_string(),
                            message: "file_path is required".to_string(),
                            recoverable: true,
                            suggestion: None,
                            retry_after_ms: None,
                            details: None,
                        },
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    };
                }
            };

            let edits = match arguments.get("edits").and_then(|v| v.as_array()) {
                Some(arr) => arr,
                None => {
                    return ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "INVALID_ARGUMENT".to_string(),
                            message: "edits is required".to_string(),
                            recoverable: true,
                            suggestion: None,
                            retry_after_ms: None,
                            details: None,
                        },
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    };
                }
            };

            let path = Path::new(file_path_str);
            if !path.exists() {
                return ToolExecutionResult::Error {
                    error: ToolExecutionError {
                        code: "ENOENT".to_string(),
                        message: "File not found.".to_string(),
                        recoverable: true,
                        suggestion: None,
                        retry_after_ms: None,
                        details: None,
                    },
                    model_content: None,
                    ui_content: None,
                    effects: None,
                };
            }

            let mut file_content = match fs::read_to_string(path).await {
                Ok(content) => content,
                Err(e) => {
                    return ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "READ_ERROR".to_string(),
                            message: e.to_string(),
                            recoverable: false,
                            suggestion: None,
                            retry_after_ms: None,
                            details: None,
                        },
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    };
                }
            };

            for (index, edit) in edits.iter().enumerate() {
                let old_string = match edit.get("old_string").and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None => continue,
                };
                let new_string = match edit.get("new_string").and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None => continue,
                };
                let replace_all = edit.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);

                let count = file_content.matches(old_string).count();
                if count == 0 {
                    return ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "EDIT_FAILED".to_string(),
                            message: format!("Edit {}: old_string not found.", index + 1),
                            recoverable: true,
                            suggestion: None,
                            retry_after_ms: None,
                            details: None,
                        },
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    };
                }

                if count > 1 && !replace_all {
                    return ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "EDIT_FAILED".to_string(),
                            message: format!("Edit {}: old_string is not unique (found {} occurrences). Use replace_all: true to replace all.", index + 1, count),
                            recoverable: true,
                            suggestion: None,
                            retry_after_ms: None,
                            details: None,
                        },
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    };
                }

                if replace_all {
                    file_content = file_content.replace(old_string, new_string);
                } else {
                    file_content = file_content.replacen(old_string, new_string, 1);
                }
            }

            match fs::write(path, &file_content).await {
                Ok(_) => ToolExecutionResult::Success {
                    data: None,
                    model_content: format!("Successfully edited {}", file_path_str),
                    ui_content: None,
                    effects: None,
                },
                Err(e) => ToolExecutionResult::Error {
                    error: ToolExecutionError {
                        code: "WRITE_ERROR".to_string(),
                        message: e.to_string(),
                        recoverable: false,
                        suggestion: None,
                        retry_after_ms: None,
                        details: None,
                    },
                    model_content: None,
                    ui_content: None,
                    effects: None,
                },
            }
        })
    }
}
