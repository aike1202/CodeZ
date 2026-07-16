use std::path::Path;
use std::sync::Arc;
use serde_json::Value;

use crate::tools::registry::{DefaultToolDescriptor, ToolDescriptor, ToolHandler, ToolContext, BoxFuture, ToolAvailability, ToolBehavior};
use crate::tools::types::{
    ToolApprovalMetadata,
    ToolExecutionResult, ToolExecutionError, ToolSource, ToolExposure, ToolConcurrency,
    ToolInterruptBehavior, ModelPreference
};
use crate::tools::spawn::SpawnRunner;

pub struct BashTool {
    descriptor: DefaultToolDescriptor,
}

impl BashTool {
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Bash",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:bash".to_string(),
                summary: "Execute or control a bash command.".to_string(),
                description: "Executes a bash command.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "New bash command to execute." },
                        "timeout": { "type": "number", "description": "Wait window in ms." }
                    },
                    "required": ["command"]
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

fn resolve_bash_exe() -> String {
    if let Ok(p) = std::env::var("CODEZ_BASH_PATH") {
        if Path::new(&p).exists() {
            return p;
        }
    }
    if let Ok(p) = std::env::var("GIT_BASH_PATH") {
        if Path::new(&p).exists() {
            return p;
        }
    }
    let candidates = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ];
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "bash".to_string()
}

impl ToolHandler for BashTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a Value,
        _context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let command = match arguments.get("command").and_then(|v| v.as_str()) {
                Some(c) => c,
                None => {
                    return ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "INVALID_ARGUMENT".to_string(),
                            message: "command is required".to_string(),
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

            let timeout_ms = arguments.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30_000);
            
            // Assume workspace root as current dir for simplified execution
            let workspace = ".";

            match SpawnRunner::run(command, workspace, "bash", Some(&resolve_bash_exe()), timeout_ms).await {
                Ok(result) => {
                    let model_content = if result.status == "completed" {
                        result.stdout.clone()
                    } else {
                        format!("{}\n{}", result.stdout, result.stderr)
                    };

                    ToolExecutionResult::Success {
                        data: Some(serde_json::json!({
                            "status": result.status,
                            "exitCode": result.exit_code,
                            "stdout": result.stdout,
                            "stderr": result.stderr,
                        })),
                        model_content,
                        ui_content: None,
                        effects: None,
                    }
                }
                Err(e) => {
                    ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "SPAWN_ERROR".to_string(),
                            message: e,
                            recoverable: false,
                            suggestion: None,
                            retry_after_ms: None,
                            details: None,
                        },
                        model_content: None,
                        ui_content: None,
                        effects: None,
                    }
                }
            }
        })
    }
}
