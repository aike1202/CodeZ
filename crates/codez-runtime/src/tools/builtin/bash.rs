use std::path::PathBuf;

use serde_json::Value;

use crate::tools::registry::{
    BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext, ToolDescriptor,
    ToolHandler,
};
use crate::tools::spawn::{ShellKind, SpawnError, SpawnRunner};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
    ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
    ToolPlanningContext, ToolSource,
};

pub struct BashTool {
    descriptor: DefaultToolDescriptor,
}

impl BashTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Bash",
                version: "1.1.0",
                source: ToolSource::Builtin,
                source_id: "builtin:bash".to_string(),
                summary: "Execute a bash command.".to_string(),
                description: "Executes one classified bash command in the workspace.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "command": { "type": "string", "minLength": 1 },
                        "timeout": { "type": "integer", "minimum": 250, "maximum": 120000 }
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
                    concurrency: ToolConcurrency::Exclusive,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 100_000,
                    timeout_ms: Some(120_000),
                },
            },
        }
    }
}

impl Default for BashTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for BashTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            input.get("command").and_then(Value::as_str).map_or_else(
                || ToolEffectPlan {
                    effects: vec![ToolEffect::Unknown {
                        target: "bash-command-missing".to_string(),
                    }],
                    analysis_status: "unparsed".to_string(),
                },
                |command| ToolEffectPlan {
                    effects: vec![ToolEffect::ExecuteCommand {
                        shell: "bash".to_string(),
                        command: command.to_string(),
                    }],
                    analysis_status: "parsed".to_string(),
                },
            )
        })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        _context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async { vec!["workspace-process:write".to_string()] })
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            let Some(command) = arguments.get("command").and_then(Value::as_str) else {
                return execution_error("TOOL_INPUT_INVALID", "command is required", true);
            };
            let approved = context.authorized_effects.effects.iter().any(|effect| {
                matches!(effect, ToolEffect::ExecuteCommand { shell, command: approved } if shell == "bash" && approved == command)
            });
            if !approved {
                return execution_error(
                    "TOOL_COMMAND_NOT_AUTHORIZED",
                    "The command changed after authorization.",
                    false,
                );
            }
            let Some(executable) = resolve_bash_executable() else {
                return execution_error(
                    "TOOL_UNAVAILABLE",
                    "A supported bash executable was not found.",
                    false,
                );
            };
            let timeout_ms = arguments
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(30_000)
                .clamp(250, 120_000);
            match SpawnRunner::run(
                command,
                &context.workspace_root,
                ShellKind::Bash,
                &executable,
                timeout_ms,
                &context.cancellation,
            )
            .await
            {
                Ok(result) => {
                    let model_content = if result.stderr.is_empty() {
                        result.stdout.clone()
                    } else if result.stdout.is_empty() {
                        result.stderr.clone()
                    } else {
                        format!("{}\n{}", result.stdout, result.stderr)
                    };
                    ToolExecutionResult::Success {
                        data: Some(serde_json::json!({
                            "status": result.status,
                            "exitCode": result.exit_code,
                            "stdout": result.stdout,
                            "stderr": result.stderr,
                            "timedOut": result.timed_out,
                        })),
                        model_content,
                        ui_content: None,
                        effects: None,
                    }
                }
                Err(SpawnError::Cancelled) => ToolExecutionResult::Cancelled {
                    error: ToolExecutionError {
                        code: "TOOL_CANCELLED".to_string(),
                        message: "Command execution was cancelled.".to_string(),
                        recoverable: false,
                        suggestion: None,
                        retry_after_ms: None,
                        details: None,
                    },
                    model_content: None,
                    ui_content: None,
                    effects: None,
                },
                Err(error) => execution_error("TOOL_PROCESS_FAILED", &error.to_string(), false),
            }
        })
    }
}

fn resolve_bash_executable() -> Option<PathBuf> {
    for variable in ["CODEZ_BASH_PATH", "GIT_BASH_PATH"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            if path.is_absolute() && path.is_file() {
                return Some(path);
            }
        }
    }
    let candidates = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files\Git\usr\bin\bash.exe"),
        ]
    } else {
        vec![PathBuf::from("/bin/bash"), PathBuf::from("/usr/bin/bash")]
    };
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .or_else(|| executable_from_path("bash"))
}

fn executable_from_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|directory| {
        let candidate = directory.join(name);
        if candidate.is_absolute() && candidate.is_file() {
            return Some(candidate);
        }
        if cfg!(windows) {
            let candidate = directory.join(format!("{name}.exe"));
            if candidate.is_absolute() && candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    })
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
