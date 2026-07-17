use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, sync::Arc, time::Duration};

use codez_core::AppError;
use serde_json::Value;

use crate::tools::registry::{
    BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext, ToolDescriptor,
    ToolHandler,
};
use crate::tools::spawn::{
    CommandRequest, CommandTaskAccess, CommandTaskError, CommandTaskRegistry, CommandTaskResult,
    ShellKind,
};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
    ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
    ToolPlanningContext, ToolSource,
};

pub struct BashTool {
    descriptor: DefaultToolDescriptor,
    host: Option<BashHost>,
}

#[derive(Clone)]
pub struct BashHost {
    registry: Arc<CommandTaskRegistry>,
    executable: PathBuf,
    environment: BTreeMap<OsString, OsString>,
}

impl BashHost {
    /// Builds an explicit Bash host without inheriting ambient executable lookup.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the executable is relative, missing, or cannot
    /// be canonicalized to a regular file.
    pub fn new(
        registry: Arc<CommandTaskRegistry>,
        executable: PathBuf,
        environment: BTreeMap<OsString, OsString>,
    ) -> Result<Self, AppError> {
        if !executable.is_absolute() {
            return Err(AppError::validation(
                "The Bash executable path must be absolute",
            ));
        }
        let executable = dunce::canonicalize(&executable).map_err(|source| {
            AppError::external(
                "The configured Bash executable could not be resolved",
                format!("canonicalize {:?}: {source}", executable),
                false,
            )
        })?;
        if !executable.is_file() {
            return Err(AppError::not_found(
                "The configured Bash executable is not a regular file",
            ));
        }
        Ok(Self {
            registry,
            executable,
            environment,
        })
    }
}

impl BashTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "Bash",
                version: "1.2.0",
                source: ToolSource::Builtin,
                source_id: "builtin:bash".to_string(),
                summary: "Execute or control a bash command.".to_string(),
                description: "Executes a Bash command or controls a retained command task. A wait timeout leaves the process running; use the returned task_id to wait again or interrupt it.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "command": { "type": "string", "minLength": 1 },
                        "timeout": { "type": "integer", "minimum": 250, "maximum": 120000 },
                        "task_id": { "type": "string", "minLength": 1 },
                        "action": { "type": "string", "enum": ["wait", "interrupt"] },
                        "run_in_background": { "type": "boolean" }
                    }
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
                    timeout_ms: Some(126_000),
                },
            },
            host: None,
        }
    }

    #[must_use]
    pub fn with_host(host: BashHost) -> Self {
        let mut tool = Self::new();
        tool.host = Some(host);
        tool
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
            if let Some(command) = input.get("command").and_then(Value::as_str) {
                ToolEffectPlan {
                    effects: vec![ToolEffect::ExecuteCommand {
                        shell: "bash".to_string(),
                        command: command.to_string(),
                    }],
                    analysis_status: "parsed".to_string(),
                }
            } else if let Some(task_id) = input.get("task_id").and_then(Value::as_str) {
                ToolEffectPlan {
                    effects: vec![ToolEffect::Unknown {
                        target: format!("bash-command-task:{task_id}"),
                    }],
                    analysis_status: "parsed".to_string(),
                }
            } else {
                ToolEffectPlan {
                    effects: vec![ToolEffect::Unknown {
                        target: "bash-command-missing".to_string(),
                    }],
                    analysis_status: "unparsed".to_string(),
                }
            }
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
            let Some(host) = self.host.as_ref() else {
                return execution_error(
                    "TOOL_UNAVAILABLE",
                    "Bash is unavailable because the desktop host did not configure an executable and process registry.",
                    false,
                );
            };
            let command = arguments.get("command").and_then(Value::as_str);
            let task_id = arguments.get("task_id").and_then(Value::as_str);
            let action = arguments.get("action").and_then(Value::as_str);
            let background = arguments
                .get("run_in_background")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let timeout_ms = arguments
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(30_000)
                .clamp(250, 120_000);
            let Some(session_id) = context.session_id.as_deref() else {
                return execution_error(
                    "TOOL_SESSION_REQUIRED",
                    "Bash command tasks require an active session.",
                    false,
                );
            };
            let access = CommandTaskAccess {
                session_id,
                shell: ShellKind::Bash,
            };

            let result = match (command, task_id) {
                (Some(_), Some(_)) => {
                    return execution_error(
                        "TOOL_INPUT_INVALID",
                        "command and task_id cannot be used together",
                        true,
                    );
                }
                (None, Some(task_id)) => {
                    if background {
                        return execution_error(
                            "TOOL_INPUT_INVALID",
                            "run_in_background cannot be used with task_id",
                            true,
                        );
                    }
                    match action {
                        Some("wait") => {
                            host.registry
                                .wait_or_interrupt(
                                    access,
                                    task_id,
                                    Duration::from_millis(timeout_ms),
                                    &context.cancellation,
                                )
                                .await
                        }
                        Some("interrupt") => host.registry.interrupt(access, task_id).await,
                        Some(_) => {
                            return execution_error(
                                "TOOL_INPUT_INVALID",
                                "action must be wait or interrupt",
                                true,
                            );
                        }
                        None => {
                            return execution_error(
                                "TOOL_INPUT_INVALID",
                                "action is required with task_id",
                                true,
                            );
                        }
                    }
                }
                (Some(command), None) => {
                    if action.is_some() {
                        return execution_error(
                            "TOOL_INPUT_INVALID",
                            "action requires task_id",
                            true,
                        );
                    }
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
                    host.registry
                        .run(
                            CommandRequest {
                                command: command.to_string(),
                                session_id: session_id.to_string(),
                                shell: ShellKind::Bash,
                                executable: host.executable.clone(),
                                current_directory: context.workspace_root.clone(),
                                environment: host.environment.clone(),
                                wait_window: Duration::from_millis(timeout_ms),
                                background,
                            },
                            &context.cancellation,
                        )
                        .await
                }
                (None, None) => {
                    return execution_error(
                        "TOOL_INPUT_INVALID",
                        "command is required for a new command",
                        true,
                    );
                }
            };
            match result {
                Ok(result) => command_result(result),
                Err(CommandTaskError::Cancelled) => cancelled_result(),
                Err(error) => {
                    execution_error(error.code(), &error.to_string(), error.recoverable())
                }
            }
        })
    }
}

fn command_result(result: CommandTaskResult) -> ToolExecutionResult {
    let Ok(mut data) = serde_json::to_value(result) else {
        return execution_error(
            "TOOL_RESULT_INVALID",
            "The command result could not be serialized.",
            false,
        );
    };
    if let Value::Object(object) = &mut data {
        match object.get("status").and_then(Value::as_str) {
            Some("running") => {
                let task_id = object.get("taskId").cloned().unwrap_or(Value::Null);
                object.insert(
                    "message".to_string(),
                    Value::String(
                        "Command is still running. Choose wait with a new timeout or interrupt it."
                            .to_string(),
                    ),
                );
                object.insert(
                    "nextActions".to_string(),
                    serde_json::json!([
                        { "action": "wait", "task_id": task_id },
                        { "action": "interrupt", "task_id": task_id }
                    ]),
                );
            }
            Some("interrupted") => {
                object.insert(
                    "error".to_string(),
                    serde_json::json!({
                        "code": "COMMAND_INTERRUPTED",
                        "message": "The command was interrupted before completion."
                    }),
                );
            }
            _ => {}
        }
    }
    let model_content = serde_json::to_string_pretty(&data)
        .unwrap_or_else(|_| "Command result serialization failed.".to_string());
    ToolExecutionResult::Success {
        data: Some(data),
        model_content,
        ui_content: None,
        effects: None,
    }
}

fn cancelled_result() -> ToolExecutionResult {
    ToolExecutionResult::Cancelled {
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
    }
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

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Arc};

    use codez_core::{
        AppError, CancellationToken, PortFuture, SpawnedProcess, SpawnedProcessRequest,
        SpawnedProcessRunner,
    };

    use super::{BashHost, BashTool};
    use crate::tools::{
        registry::{ToolContext, ToolHandler},
        spawn::CommandTaskRegistry,
        types::{ToolEffectPlan, ToolExecutionResult},
    };

    struct UnavailableRunner;

    impl SpawnedProcessRunner for UnavailableRunner {
        fn spawn(
            &self,
            _request: SpawnedProcessRequest,
        ) -> PortFuture<'_, Arc<dyn SpawnedProcess>> {
            Box::pin(async { Err(AppError::unsupported("fixture runner is unavailable")) })
        }
    }

    fn hosted_tool() -> (BashTool, tempfile::TempDir) {
        let root = tempfile::tempdir().expect("temporary root must be available");
        let registry = Arc::new(
            CommandTaskRegistry::new(Arc::new(UnavailableRunner), root.path().to_path_buf())
                .expect("fixture registry must be valid"),
        );
        let executable = std::env::current_exe().expect("test executable path must be available");
        let host = BashHost::new(registry, executable, BTreeMap::new())
            .expect("fixture Bash host must be valid");
        (BashTool::with_host(host), root)
    }

    fn context(root: &tempfile::TempDir, session_id: Option<&str>) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            session_id: session_id.map(str::to_string),
            context_scope_id: "scope-1".to_string(),
            transaction_id: None,
            workspace_root: root.path().to_path_buf(),
            cancellation: CancellationToken::new(),
            authorized_effects: ToolEffectPlan {
                effects: Vec::new(),
                analysis_status: "test".to_string(),
            },
            file_services: None,
        }
    }

    #[tokio::test]
    async fn execute_should_require_a_session_for_command_task_ownership() {
        let (tool, root) = hosted_tool();

        let result = tool
            .execute(
                &serde_json::json!({"command": "printf test"}),
                &context(&root, None),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. } if error.code == "TOOL_SESSION_REQUIRED"
        ));
    }

    #[tokio::test]
    async fn execute_should_classify_an_invalid_control_action_as_input_error() {
        let (tool, root) = hosted_tool();

        let result = tool
            .execute(
                &serde_json::json!({"task_id": "cmd-1", "action": "restart"}),
                &context(&root, Some("session-a")),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. } if error.code == "TOOL_INPUT_INVALID"
        ));
    }

    #[tokio::test]
    async fn execute_should_fail_closed_without_host_configuration() {
        let root = tempfile::tempdir().expect("temporary root must be available");

        let result = BashTool::new()
            .execute(
                &serde_json::json!({"command": "printf test"}),
                &context(&root, Some("session-a")),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. } if error.code == "TOOL_UNAVAILABLE"
        ));
    }
}
