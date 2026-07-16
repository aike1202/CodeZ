use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use serde_json::Value;

use crate::tools::registry::{DefaultToolDescriptor, ToolDescriptor, ToolHandler, ToolContext, BoxFuture, ToolAvailability, ToolBehavior};
use crate::tools::types::{
    ToolApprovalMetadata,
    ToolExecutionResult, ToolExecutionError, ToolSource, ToolExposure, ToolConcurrency,
    ToolInterruptBehavior, ModelPreference
};

pub struct ReadTool {
    descriptor: DefaultToolDescriptor,
}

impl ReadTool {
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Read",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:read".to_string(),
                summary: "Read local files.".to_string(),
                description: "Reads local files.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "files": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "file_path": { "type": "string" },
                                    "offset": { "type": "number" },
                                    "limit": { "type": "number" }
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
            }
        }
    }
}

impl ToolHandler for ReadTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a Value,
        _context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let files = match arguments.get("files").and_then(|v| v.as_array()) {
                Some(f) => f,
                None => {
                    return ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "INVALID_ARGUMENT".to_string(),
                            message: "files is required".to_string(),
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

            let mut output_blocks = Vec::new();

            for item in files {
                let file_path_str = match item.get("file_path").and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None => continue,
                };

                let offset = item.get("offset").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
                let limit = item.get("limit").and_then(|v| v.as_u64()).unwrap_or(800) as usize;

                let path = Path::new(file_path_str);
                if !path.exists() {
                    output_blocks.push(format!("<file path=\"{}\">\nError: File not found.\n</file>", file_path_str));
                    continue;
                }

                match File::open(path) {
                    Ok(file) => {
                        let reader = BufReader::new(file);
                        let mut lines = Vec::new();
                        let start_index = if offset > 0 { offset - 1 } else { 0 };

                        for (i, line_res) in reader.lines().enumerate() {
                            if i < start_index {
                                continue;
                            }
                            if i >= start_index + limit {
                                break;
                            }
                            if let Ok(line) = line_res {
                                // cat -n style formatting
                                lines.push(format!("{:>6}\t{}", i + 1, line));
                            }
                        }

                        let body = lines.join("\n");
                        output_blocks.push(format!("<file path=\"{}\">\n{}\n</file>", file_path_str, body));
                    }
                    Err(e) => {
                        output_blocks.push(format!("<file path=\"{}\">\nError: {}\n</file>", file_path_str, e));
                    }
                }
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
