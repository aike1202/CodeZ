use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use codez_core::{AppError, AppErrorKind};
use serde_json::Value;

use super::shell_workspace::ShellWorkspaceState;
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
    workspace: Arc<ShellWorkspaceState>,
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
            workspace: Arc::new(ShellWorkspaceState::new()),
        })
    }

    /// Clears the workspace authority and remembered working directory for a session.
    pub fn clear_session(&self, session_id: &str) {
        self.workspace.clear_session(session_id);
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

    /// Clears the workspace authority and remembered working directory for a session.
    pub fn clear_session(&self, session_id: &str) {
        if let Some(host) = &self.host {
            host.clear_session(session_id);
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
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            if let Some(command) = input.get("command").and_then(Value::as_str) {
                let cwd = context
                    .session_id
                    .as_deref()
                    .and_then(|session_id| {
                        self.host.as_ref().and_then(|host| {
                            host.workspace
                                .current_directory(session_id, &context.workspace_root)
                                .ok()
                        })
                    })
                    .unwrap_or_else(|| context.workspace_root.clone());
                ToolEffectPlan {
                    effects: vec![ToolEffect::ExecuteCommand {
                        shell: "bash".to_string(),
                        command: command.to_string(),
                        cwd: Some(cwd.to_string_lossy().to_string()),
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
            let owner_id = context.turn_id.as_deref().unwrap_or(session_id);
            let access = CommandTaskAccess {
                session_id,
                owner_id,
                shell: ShellKind::Bash,
            };

            let result =
                match (command, task_id) {
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
                        let approved_cwd = context.authorized_effects.effects.iter().find_map(
                            |effect| match effect {
                                ToolEffect::ExecuteCommand {
                                    shell,
                                    command: approved,
                                    cwd,
                                } if shell == "bash" && approved == command => cwd.as_deref(),
                                _ => None,
                            },
                        );
                        if approved_cwd.is_none() {
                            return execution_error(
                                "TOOL_COMMAND_NOT_AUTHORIZED",
                                "The command changed after authorization.",
                                false,
                            );
                        }
                        let current_directory = match host
                            .workspace
                            .current_directory(session_id, &context.workspace_root)
                        {
                            Ok(current_directory) => current_directory,
                            Err(error) => return workspace_error(error),
                        };
                        if approved_cwd
                            .is_none_or(|approved| Path::new(approved) != current_directory)
                        {
                            return execution_error(
                                "TOOL_COMMAND_NOT_AUTHORIZED",
                                "The shell working directory changed after authorization.",
                                false,
                            );
                        }
                        let result = host
                            .registry
                            .run(
                                CommandRequest {
                                    command: command.to_string(),
                                    session_id: session_id.to_string(),
                                    owner_id: owner_id.to_string(),
                                    shell: ShellKind::Bash,
                                    executable: host.executable.clone(),
                                    current_directory: current_directory.clone(),
                                    environment: host.environment.clone(),
                                    wait_window: Duration::from_millis(timeout_ms),
                                    background,
                                },
                                &context.cancellation,
                            )
                            .await;
                        if result.is_ok() && !background {
                            if let Some(requested) = literal_bash_cd_target(command) {
                                if let Err(error) = host.workspace.remember_working_directory(
                                    session_id,
                                    &context.workspace_root,
                                    &current_directory,
                                    Path::new(&requested),
                                ) {
                                    return workspace_error(error);
                                }
                            }
                        }
                        result
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

fn literal_bash_cd_target(command: &str) -> Option<String> {
    let trimmed = command.trim_start();
    let remainder = trimmed.strip_prefix("cd")?;
    if !remainder.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    parse_bash_literal(remainder.trim_start())
}

fn parse_bash_literal(input: &str) -> Option<String> {
    let first = input.chars().next()?;
    match first {
        '\'' => parse_single_quoted_literal(input),
        '"' => parse_double_quoted_literal(input),
        _ => parse_unquoted_literal(input),
    }
}

fn parse_single_quoted_literal(input: &str) -> Option<String> {
    let closing = input.get(1..)?.find('\'')? + 1;
    let value = input.get(1..closing)?.to_string();
    literal_remainder_is_safe(input.get(closing + 1..)?).then_some(value)
}

fn parse_double_quoted_literal(input: &str) -> Option<String> {
    let mut value = String::new();
    let mut closing = None;
    for (offset, character) in input.char_indices().skip(1) {
        if character == '"' {
            closing = Some(offset + character.len_utf8());
            break;
        }
        if matches!(character, '$' | '`' | '\\') {
            return None;
        }
        value.push(character);
    }
    let remainder = input.get(closing?..)?;
    literal_remainder_is_safe(remainder).then_some(value)
}

fn parse_unquoted_literal(input: &str) -> Option<String> {
    let end = input
        .find(|character: char| character.is_whitespace() || matches!(character, ';' | '&'))
        .unwrap_or(input.len());
    let value = input.get(..end)?;
    if value.is_empty()
        || value == "-"
        || value.chars().any(|character| {
            matches!(
                character,
                '$' | '`'
                    | '\\'
                    | '*'
                    | '?'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '~'
                    | '"'
                    | '\''
                    | '|'
                    | '('
                    | ')'
                    | '<'
                    | '>'
            )
        })
        || !literal_remainder_is_safe(input.get(end..)?)
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn literal_remainder_is_safe(remainder: &str) -> bool {
    let remainder = remainder.trim_start();
    remainder.is_empty() || remainder.starts_with(';') || remainder.starts_with("&&")
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

fn workspace_error(error: AppError) -> ToolExecutionResult {
    match error.kind() {
        AppErrorKind::Validation => {
            execution_error("TOOL_COMMAND_INVALID", error.public_message(), true)
        }
        AppErrorKind::PermissionDenied => execution_error(
            "TOOL_WORKSPACE_NOT_AUTHORIZED",
            error.public_message(),
            false,
        ),
        AppErrorKind::Conflict | AppErrorKind::NotFound => {
            execution_error("TOOL_WORKSPACE_CHANGED", error.public_message(), false)
        }
        _ => execution_error("TOOL_PROCESS_FAILED", error.public_message(), false),
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
    use std::{
        collections::BTreeMap,
        path::Path,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use codez_core::{
        AppError, CancellationToken, PortFuture, SpawnedProcess, SpawnedProcessOutput,
        SpawnedProcessRequest, SpawnedProcessRunner, SpawnedProcessTermination,
    };

    use super::{BashHost, BashTool, literal_bash_cd_target};
    use crate::tools::{
        registry::{ToolContext, ToolHandler},
        spawn::CommandTaskRegistry,
        types::{ToolEffect, ToolEffectPlan, ToolExecutionResult},
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

    struct CompletedRunner {
        requests: Mutex<Vec<SpawnedProcessRequest>>,
    }

    impl CompletedRunner {
        fn new() -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl SpawnedProcessRunner for CompletedRunner {
        fn spawn(&self, request: SpawnedProcessRequest) -> PortFuture<'_, Arc<dyn SpawnedProcess>> {
            Box::pin(async move {
                self.requests
                    .lock()
                    .expect("request lock must remain available")
                    .push(request);
                Ok(Arc::new(CompletedProcess) as Arc<dyn SpawnedProcess>)
            })
        }
    }

    struct CompletedProcess;

    impl SpawnedProcess for CompletedProcess {
        fn pid(&self) -> Option<u32> {
            Some(42)
        }

        fn wait(&self) -> PortFuture<'_, SpawnedProcessOutput> {
            Box::pin(async { Ok(completed_output(SpawnedProcessTermination::Exited)) })
        }

        fn terminate(&self) -> PortFuture<'_, SpawnedProcessOutput> {
            Box::pin(async { Ok(completed_output(SpawnedProcessTermination::Terminated)) })
        }
    }

    fn completed_output(termination: SpawnedProcessTermination) -> SpawnedProcessOutput {
        SpawnedProcessOutput {
            exit_code: Some(0),
            stdout: b"done".to_vec(),
            stderr: Vec::new(),
            output_truncated: false,
            elapsed: Duration::from_millis(5),
            termination,
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

    fn completed_tool() -> (BashTool, Arc<CompletedRunner>, tempfile::TempDir) {
        let registry_root = tempfile::tempdir().expect("registry root must be available");
        let runner = Arc::new(CompletedRunner::new());
        let registry = Arc::new(
            CommandTaskRegistry::new(
                Arc::clone(&runner) as Arc<dyn SpawnedProcessRunner>,
                registry_root.path().to_path_buf(),
            )
            .expect("fixture registry must be valid"),
        );
        let executable = std::env::current_exe().expect("test executable path must be available");
        let host = BashHost::new(registry, executable, BTreeMap::new())
            .expect("fixture Bash host must be valid");
        (BashTool::with_host(host), runner, registry_root)
    }

    fn context(root: &tempfile::TempDir, session_id: Option<&str>) -> ToolContext {
        context_path(root.path(), session_id)
    }

    fn context_path(root: &Path, session_id: Option<&str>) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            call_id: "call-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            session_id: session_id.map(str::to_string),
            context_scope_id: "scope-1".to_string(),
            transaction_id: None,
            workspace_root: root.to_path_buf(),
            cancellation: CancellationToken::new(),
            authorized_effects: ToolEffectPlan {
                effects: Vec::new(),
                analysis_status: "test".to_string(),
            },
            file_services: None,
            deferred_tools: Vec::new(),
        }
    }

    fn context_for_command(root: &Path, session_id: &str, command: &str) -> ToolContext {
        context_for_command_at(root, root, session_id, command)
    }

    fn context_for_command_at(
        workspace_root: &Path,
        authorized_cwd: &Path,
        session_id: &str,
        command: &str,
    ) -> ToolContext {
        let mut context = context_path(workspace_root, Some(session_id));
        context.authorized_effects.effects = vec![ToolEffect::ExecuteCommand {
            shell: "bash".to_string(),
            command: command.to_string(),
            cwd: Some(authorized_cwd.to_string_lossy().to_string()),
        }];
        context
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

    #[tokio::test]
    async fn leading_literal_cd_persists_a_trusted_cwd_for_the_session() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let nested = workspace.path().join("nested");
        std::fs::create_dir(&nested).expect("nested cwd must be created");
        let (tool, runner, _registry_root) = completed_tool();
        let cd = "cd 'nested'";

        let first = tool
            .execute(
                &serde_json::json!({"command": cd}),
                &context_for_command(workspace.path(), "session-a", cd),
            )
            .await;
        let second_command = "printf done";
        let second = tool
            .execute(
                &serde_json::json!({"command": second_command}),
                &context_for_command_at(workspace.path(), &nested, "session-a", second_command),
            )
            .await;
        let requests = runner
            .requests
            .lock()
            .expect("request lock must remain available");

        assert!(
            matches!(first, ToolExecutionResult::Success { .. })
                && matches!(second, ToolExecutionResult::Success { .. })
                && requests
                    .get(1)
                    .is_some_and(|request| request.current_directory == nested)
        );
    }

    #[tokio::test]
    async fn background_cd_does_not_change_the_session_cwd() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        std::fs::create_dir(workspace.path().join("nested")).expect("nested cwd must be created");
        let (tool, runner, _registry_root) = completed_tool();
        let cd = "cd nested";

        let first = tool
            .execute(
                &serde_json::json!({"command": cd, "run_in_background": true}),
                &context_for_command(workspace.path(), "session-a", cd),
            )
            .await;
        let second_command = "printf done";
        let second = tool
            .execute(
                &serde_json::json!({"command": second_command}),
                &context_for_command(workspace.path(), "session-a", second_command),
            )
            .await;
        let requests = runner
            .requests
            .lock()
            .expect("request lock must remain available");

        assert!(
            matches!(first, ToolExecutionResult::Success { .. })
                && matches!(second, ToolExecutionResult::Success { .. })
                && requests
                    .get(1)
                    .is_some_and(|request| request.current_directory == workspace.path())
        );
    }

    #[tokio::test]
    async fn a_session_cannot_switch_its_bash_workspace_root() {
        let first_workspace = tempfile::tempdir().expect("first workspace must be available");
        let second_workspace = tempfile::tempdir().expect("second workspace must be available");
        let (tool, runner, _registry_root) = completed_tool();
        let command = "printf done";

        let first = tool
            .execute(
                &serde_json::json!({"command": command}),
                &context_for_command(first_workspace.path(), "session-a", command),
            )
            .await;
        let second = tool
            .execute(
                &serde_json::json!({"command": command}),
                &context_for_command(second_workspace.path(), "session-a", command),
            )
            .await;

        assert!(
            matches!(first, ToolExecutionResult::Success { .. })
                && matches!(second, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_WORKSPACE_CHANGED")
                && runner
                    .requests
                    .lock()
                    .expect("request lock must remain available")
                    .len()
                    == 1
        );
    }

    #[tokio::test]
    async fn task_control_does_not_reopen_workspace_authority() {
        let parent = tempfile::tempdir().expect("workspace parent must be available");
        let workspace = parent.path().join("workspace");
        let replaced = parent.path().join("replaced");
        std::fs::create_dir(&workspace).expect("workspace must be created");
        let (tool, _runner, _registry_root) = completed_tool();
        let command = "printf done";
        let started = tool
            .execute(
                &serde_json::json!({"command": command, "run_in_background": true}),
                &context_for_command(&workspace, "session-a", command),
            )
            .await;
        let task_id = match &started {
            ToolExecutionResult::Success {
                data: Some(data), ..
            } => data.get("taskId").and_then(serde_json::Value::as_str),
            _ => None,
        }
        .expect("background task id must be returned")
        .to_string();
        std::fs::rename(&workspace, &replaced).expect("workspace must be moved");
        std::fs::create_dir(&workspace).expect("replacement workspace must be created");

        let waited = tool
            .execute(
                &serde_json::json!({"task_id": task_id, "action": "wait"}),
                &context_path(&workspace, Some("session-a")),
            )
            .await;

        assert!(
            matches!(started, ToolExecutionResult::Success { .. })
                && matches!(waited, ToolExecutionResult::Success { .. })
        );
    }

    #[tokio::test]
    async fn clear_session_allows_a_fresh_workspace_authority() {
        let first_workspace = tempfile::tempdir().expect("first workspace must be available");
        let second_workspace = tempfile::tempdir().expect("second workspace must be available");
        let (tool, runner, _registry_root) = completed_tool();
        let command = "printf done";
        tool.execute(
            &serde_json::json!({"command": command}),
            &context_for_command(first_workspace.path(), "session-a", command),
        )
        .await;

        tool.clear_session("session-a");

        let result = tool
            .execute(
                &serde_json::json!({"command": command}),
                &context_for_command(second_workspace.path(), "session-a", command),
            )
            .await;
        assert!(
            matches!(result, ToolExecutionResult::Success { .. })
                && runner
                    .requests
                    .lock()
                    .expect("request lock must remain available")
                    .len()
                    == 2
        );
    }

    #[test]
    fn bash_cd_parser_accepts_literals_and_rejects_dynamic_or_ambiguous_targets() {
        assert_eq!(
            literal_bash_cd_target("  cd '中文 目录' && printf done"),
            Some("中文 目录".to_string())
        );
        assert_eq!(
            literal_bash_cd_target("cd \"nested directory\""),
            Some("nested directory".to_string())
        );
        assert_eq!(literal_bash_cd_target("cd $HOME"), None);
        assert_eq!(literal_bash_cd_target("cd \"$HOME\""), None);
        assert_eq!(literal_bash_cd_target("cd nested | pwd"), None);
        assert_eq!(literal_bash_cd_target("cd nested extra"), None);
    }
}
