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
    CommandTaskStatus, ShellKind,
};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
    ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
    ToolPlanningContext, ToolSource,
};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 250;
const MAX_TIMEOUT_MS: u64 = 120_000;
const UTF8_SETUP: &str = concat!(
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false);"
);

pub struct PowerShellTool {
    descriptor: DefaultToolDescriptor,
    host: Option<PowerShellHost>,
}

#[derive(Clone)]
pub struct PowerShellHost {
    registry: Arc<CommandTaskRegistry>,
    executable: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    workspace: Arc<ShellWorkspaceState>,
}

impl PowerShellHost {
    /// Builds an explicit PowerShell host without ambient executable lookup.
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
                "The PowerShell executable path must be absolute",
            ));
        }
        let executable = dunce::canonicalize(&executable).map_err(|source| {
            AppError::external(
                "The configured PowerShell executable could not be resolved",
                format!("canonicalize {executable:?}: {source}"),
                false,
            )
        })?;
        if !executable.is_file() {
            return Err(AppError::not_found(
                "The configured PowerShell executable is not a regular file",
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

impl PowerShellTool {
    #[must_use]
    pub fn new() -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "PowerShell",
                version: "1.2.0",
                source: ToolSource::Builtin,
                source_id: "builtin:powershell".to_string(),
                summary: "Execute or control a PowerShell command.".to_string(),
                description: "Executes a PowerShell command or controls a retained command task. A wait timeout leaves the process running; use the returned task_id to wait again or interrupt it.".to_string(),
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
                    platforms: Some(vec!["windows".to_string()]),
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
    pub fn with_host(host: PowerShellHost) -> Self {
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

impl Default for PowerShellTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHandler for PowerShellTool {
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
                        shell: "powershell".to_string(),
                        command: command.to_string(),
                    }],
                    analysis_status: "parsed".to_string(),
                }
            } else if let Some(task_id) = input.get("task_id").and_then(Value::as_str) {
                ToolEffectPlan {
                    effects: vec![ToolEffect::Unknown {
                        target: format!("powershell-command-task:{task_id}"),
                    }],
                    analysis_status: "parsed".to_string(),
                }
            } else {
                ToolEffectPlan {
                    effects: vec![ToolEffect::Unknown {
                        target: "powershell-command-missing".to_string(),
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
                    "PowerShell is unavailable because the desktop host did not configure an executable and process registry.",
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
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
            let Some(session_id) = context.session_id.as_deref() else {
                return execution_error(
                    "TOOL_SESSION_REQUIRED",
                    "PowerShell command tasks require an active session.",
                    false,
                );
            };
            let access = CommandTaskAccess {
                session_id,
                shell: ShellKind::PowerShell,
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
                    if task_id.trim().is_empty() {
                        return execution_error(
                            "TOOL_INPUT_INVALID",
                            "task_id cannot be empty",
                            true,
                        );
                    }
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
                    if command.trim().is_empty() {
                        return execution_error(
                            "TOOL_INPUT_INVALID",
                            "command cannot be empty",
                            true,
                        );
                    }
                    if action.is_some() {
                        return execution_error(
                            "TOOL_INPUT_INVALID",
                            "action requires task_id",
                            true,
                        );
                    }
                    let approved = context.authorized_effects.effects.iter().any(|effect| {
                        matches!(effect, ToolEffect::ExecuteCommand { shell, command: approved } if shell == "powershell" && approved == command)
                    });
                    if !approved {
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
                    let executed_command = format!("{UTF8_SETUP}\n{command}");
                    let result = host
                        .registry
                        .run(
                            CommandRequest {
                                command: executed_command,
                                session_id: session_id.to_string(),
                                shell: ShellKind::PowerShell,
                                executable: host.executable.clone(),
                                current_directory: current_directory.clone(),
                                environment: host.environment.clone(),
                                wait_window: Duration::from_millis(timeout_ms),
                                background,
                            },
                            &context.cancellation,
                        )
                        .await;
                    if result.as_ref().is_ok_and(|result| {
                        !background && result.status == CommandTaskStatus::Completed
                    }) {
                        if let Some(requested) = literal_location_target(command) {
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

fn literal_location_target(command: &str) -> Option<String> {
    let trimmed = command.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    let remainder = if lower.starts_with("set-location")
        && trimmed
            .chars()
            .nth("set-location".len())
            .is_some_and(char::is_whitespace)
    {
        trimmed.get("set-location".len()..)?
    } else if lower.starts_with("cd")
        && trimmed
            .chars()
            .nth("cd".len())
            .is_some_and(char::is_whitespace)
    {
        trimmed.get("cd".len()..)?
    } else {
        return None;
    };
    let mut remainder = remainder.trim_start();
    for parameter in ["-literalpath", "-path"] {
        if remainder
            .get(..parameter.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(parameter))
            && remainder
                .chars()
                .nth(parameter.len())
                .is_some_and(char::is_whitespace)
        {
            remainder = remainder.get(parameter.len()..)?.trim_start();
            break;
        }
    }
    parse_powershell_literal(remainder)
}

fn parse_powershell_literal(input: &str) -> Option<String> {
    match input.chars().next()? {
        '\'' => parse_single_quoted_literal(input),
        '"' => parse_double_quoted_literal(input),
        _ => parse_unquoted_literal(input),
    }
}

fn parse_single_quoted_literal(input: &str) -> Option<String> {
    let mut value = String::new();
    let mut characters = input.char_indices().skip(1).peekable();
    while let Some((offset, character)) = characters.next() {
        if character != '\'' {
            value.push(character);
            continue;
        }
        if characters.peek().is_some_and(|(_, next)| *next == '\'') {
            value.push('\'');
            characters.next();
            continue;
        }
        let remainder = input.get(offset + character.len_utf8()..)?;
        return powershell_literal_is_safe(&value, remainder).then_some(value);
    }
    None
}

fn parse_double_quoted_literal(input: &str) -> Option<String> {
    let mut value = String::new();
    for (offset, character) in input.char_indices().skip(1) {
        if character == '"' {
            let remainder = input.get(offset + character.len_utf8()..)?;
            return powershell_literal_is_safe(&value, remainder).then_some(value);
        }
        if matches!(character, '$' | '`') {
            return None;
        }
        value.push(character);
    }
    None
}

fn parse_unquoted_literal(input: &str) -> Option<String> {
    let end = input
        .find(|character: char| character.is_whitespace() || matches!(character, ';' | '|' | '&'))
        .unwrap_or(input.len());
    let value = input.get(..end)?;
    let remainder = input.get(end..)?;
    powershell_literal_is_safe(value, remainder).then(|| value.to_string())
}

fn powershell_literal_is_safe(value: &str, remainder: &str) -> bool {
    !value.is_empty()
        && value != "-"
        && !value.starts_with('-')
        && !value.chars().any(|character| {
            matches!(
                character,
                '$' | '`' | '*' | '?' | '[' | ']' | '{' | '}' | '(' | ')' | '|' | '&' | ';' | ','
            )
        })
        && remainder.trim().is_empty()
}

fn command_result(mut result: CommandTaskResult) -> ToolExecutionResult {
    result.command = display_command(&result.command).to_string();
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

fn display_command(command: &str) -> &str {
    command
        .strip_prefix(UTF8_SETUP)
        .and_then(|remainder| remainder.strip_prefix('\n'))
        .unwrap_or(command)
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
        path::{Path, PathBuf},
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use codez_core::{
        AppError, CancellationToken, PortFuture, SpawnedProcess, SpawnedProcessOutput,
        SpawnedProcessOutputTarget, SpawnedProcessRequest, SpawnedProcessRunner,
        SpawnedProcessTermination,
    };
    use serde_json::Value;
    use tokio::sync::{Mutex, Notify};

    use super::{PowerShellHost, PowerShellTool, UTF8_SETUP, literal_location_target};
    use crate::tools::{
        registry::{ToolContext, ToolHandler},
        spawn::{CommandRequest, CommandTaskRegistry, ShellKind},
        types::{ToolEffect, ToolEffectPlan, ToolExecutionResult, ToolPlanningContext},
    };

    struct FakeRunner {
        processes: StdMutex<Vec<Arc<FakeProcess>>>,
        requests: StdMutex<Vec<SpawnedProcessRequest>>,
        complete_on_spawn: bool,
    }

    impl FakeRunner {
        fn pending() -> Self {
            Self {
                processes: StdMutex::new(Vec::new()),
                requests: StdMutex::new(Vec::new()),
                complete_on_spawn: false,
            }
        }

        fn completing() -> Self {
            Self {
                processes: StdMutex::new(Vec::new()),
                requests: StdMutex::new(Vec::new()),
                complete_on_spawn: true,
            }
        }

        fn last_process(&self) -> Arc<FakeProcess> {
            Arc::clone(
                self.processes
                    .lock()
                    .expect("fake process list must remain available")
                    .last()
                    .expect("a fake process must have been spawned"),
            )
        }
    }

    impl SpawnedProcessRunner for FakeRunner {
        fn spawn(&self, request: SpawnedProcessRequest) -> PortFuture<'_, Arc<dyn SpawnedProcess>> {
            Box::pin(async move {
                if let SpawnedProcessOutputTarget::Files {
                    stdout_path,
                    stderr_path,
                } = &request.output
                {
                    tokio::fs::write(stdout_path, b"").await.map_err(|error| {
                        AppError::storage("fixture stdout write failed", error.to_string(), false)
                    })?;
                    tokio::fs::write(stderr_path, b"").await.map_err(|error| {
                        AppError::storage("fixture stderr write failed", error.to_string(), false)
                    })?;
                }
                self.requests
                    .lock()
                    .expect("fake request list must remain available")
                    .push(request);
                let process = Arc::new(FakeProcess::new());
                if self.complete_on_spawn {
                    process.complete(success_output()).await;
                }
                self.processes
                    .lock()
                    .expect("fake process list must remain available")
                    .push(Arc::clone(&process));
                Ok(process as Arc<dyn SpawnedProcess>)
            })
        }
    }

    struct FakeProcess {
        output: Mutex<Option<SpawnedProcessOutput>>,
        changed: Notify,
        terminations: AtomicUsize,
    }

    impl FakeProcess {
        fn new() -> Self {
            Self {
                output: Mutex::new(None),
                changed: Notify::new(),
                terminations: AtomicUsize::new(0),
            }
        }

        async fn complete(&self, output: SpawnedProcessOutput) {
            *self.output.lock().await = Some(output);
            self.changed.notify_waiters();
        }

        async fn retained_output(&self) -> SpawnedProcessOutput {
            loop {
                let changed = self.changed.notified();
                if let Some(output) = self.output.lock().await.clone() {
                    return output;
                }
                changed.await;
            }
        }
    }

    impl SpawnedProcess for FakeProcess {
        fn pid(&self) -> Option<u32> {
            Some(42)
        }

        fn wait(&self) -> PortFuture<'_, SpawnedProcessOutput> {
            Box::pin(async move { Ok(self.retained_output().await) })
        }

        fn terminate(&self) -> PortFuture<'_, SpawnedProcessOutput> {
            Box::pin(async move {
                self.terminations.fetch_add(1, Ordering::Relaxed);
                let output = SpawnedProcessOutput {
                    exit_code: None,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    output_truncated: false,
                    elapsed: Duration::from_millis(15),
                    termination: SpawnedProcessTermination::Terminated,
                };
                self.complete(output.clone()).await;
                Ok(output)
            })
        }
    }

    struct Harness {
        tool: PowerShellTool,
        registry: Arc<CommandTaskRegistry>,
        runner: Arc<FakeRunner>,
        _registry_root: tempfile::TempDir,
        executable: PathBuf,
    }

    impl Harness {
        fn pending() -> Self {
            Self::new(FakeRunner::pending())
        }

        fn completing() -> Self {
            Self::new(FakeRunner::completing())
        }

        fn new(runner: FakeRunner) -> Self {
            let registry_root = tempfile::tempdir().expect("registry root must be available");
            let runner = Arc::new(runner);
            let registry = Arc::new(
                CommandTaskRegistry::new(
                    Arc::clone(&runner) as Arc<dyn SpawnedProcessRunner>,
                    registry_root.path().to_path_buf(),
                )
                .expect("fixture registry must be valid"),
            );
            let executable = std::env::current_exe().expect("test executable must be available");
            let host = PowerShellHost::new(
                Arc::clone(&registry),
                executable.clone(),
                BTreeMap::from([("SystemRoot".into(), "C:\\Windows".into())]),
            )
            .expect("fixture PowerShell host must be valid");
            Self {
                tool: PowerShellTool::with_host(host),
                registry,
                runner,
                _registry_root: registry_root,
                executable,
            }
        }
    }

    fn success_output() -> SpawnedProcessOutput {
        SpawnedProcessOutput {
            exit_code: Some(0),
            stdout: "你好，PowerShell".as_bytes().to_vec(),
            stderr: Vec::new(),
            output_truncated: false,
            elapsed: Duration::from_millis(10),
            termination: SpawnedProcessTermination::Exited,
        }
    }

    fn context_path(root: &Path, session_id: Option<&str>) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
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
        }
    }

    fn context_for_command(root: &Path, session_id: &str, command: &str) -> ToolContext {
        let mut context = context_path(root, Some(session_id));
        context.authorized_effects.effects = vec![ToolEffect::ExecuteCommand {
            shell: "powershell".to_string(),
            command: command.to_string(),
        }];
        context
    }

    fn task_id(result: &ToolExecutionResult) -> String {
        match result {
            ToolExecutionResult::Success {
                data: Some(data), ..
            } => data
                .get("taskId")
                .and_then(Value::as_str)
                .expect("task id must be returned")
                .to_string(),
            _ => panic!("successful task result must be returned"),
        }
    }

    #[test]
    fn descriptor_exposes_the_complete_command_task_schema() {
        let tool = PowerShellTool::new();
        let schema = tool.descriptor().input_schema();

        assert!(
            schema["properties"]["command"]["minLength"] == 1
                && schema["properties"]["timeout"]["minimum"] == 250
                && schema["properties"]["task_id"]["minLength"] == 1
                && schema["properties"]["action"]["enum"]
                    == serde_json::json!(["wait", "interrupt"])
                && schema["properties"]["run_in_background"]["type"] == "boolean"
                && schema.get("required").is_none()
        );
    }

    #[tokio::test]
    async fn planning_authorizes_only_the_original_user_command() {
        let tool = PowerShellTool::new();
        let planning = ToolPlanningContext {
            workspace_root: std::env::temp_dir(),
            session_id: Some("session-a".to_string()),
            agent_role: "main".to_string(),
        };
        let command = "Write-Output '你好'";

        let effects = tool
            .plan_effects(&serde_json::json!({"command": command}), &planning)
            .await;

        assert_eq!(
            effects.effects,
            vec![ToolEffect::ExecuteCommand {
                shell: "powershell".to_string(),
                command: command.to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn execute_fails_closed_without_a_configured_host() {
        let workspace = tempfile::tempdir().expect("workspace must be available");

        let result = PowerShellTool::new()
            .execute(
                &serde_json::json!({"command": "Write-Output test"}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. } if error.code == "TOOL_UNAVAILABLE"
        ));
    }

    #[tokio::test]
    async fn execute_requires_a_session_for_command_task_ownership() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::completing();

        let result = harness
            .tool
            .execute(
                &serde_json::json!({"command": "Write-Output test"}),
                &context_path(workspace.path(), None),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. } if error.code == "TOOL_SESSION_REQUIRED"
        ));
    }

    #[tokio::test]
    async fn execute_rejects_mutually_exclusive_command_task_arguments() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::pending();

        let command_and_task = harness
            .tool
            .execute(
                &serde_json::json!({"command": "Write-Output test", "task_id": "cmd-1"}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;
        let background_control = harness
            .tool
            .execute(
                &serde_json::json!({"task_id": "cmd-1", "action": "wait", "run_in_background": true}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;
        let action_without_task = harness
            .tool
            .execute(
                &serde_json::json!({"command": "Write-Output test", "action": "wait"}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;

        assert!(
            matches!(command_and_task, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_INPUT_INVALID")
                && matches!(background_control, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_INPUT_INVALID")
                && matches!(action_without_task, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_INPUT_INVALID")
        );
    }

    #[tokio::test]
    async fn command_injects_utf8_setup_but_reports_only_the_original_command() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::completing();
        let command = "Write-Output '你好'";

        let result = harness
            .tool
            .execute(
                &serde_json::json!({"command": command, "timeout": 550}),
                &context_for_command(workspace.path(), "session-a", command),
            )
            .await;
        let requests = harness
            .runner
            .requests
            .lock()
            .expect("fake request list must remain available");
        let request = requests.first().expect("one request must be captured");
        let executed = request
            .arguments
            .last()
            .map(|argument| argument.to_string_lossy())
            .expect("PowerShell command argument must be present");

        assert!(
            matches!(result, ToolExecutionResult::Success { ref data, ref model_content, .. }
                if data.as_ref().is_some_and(|data| data["command"] == command)
                    && model_content.contains("你好")
                    && !model_content.contains(UTF8_SETUP))
                && executed == format!("{UTF8_SETUP}\n{command}")
                && request.environment.len() == 1
        );
    }

    #[tokio::test]
    async fn wait_timeout_retains_the_process_for_later_control() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::pending();
        let command = "Start-Sleep -Seconds 10";
        let started = harness
            .tool
            .execute(
                &serde_json::json!({"command": command, "run_in_background": true}),
                &context_for_command(workspace.path(), "session-a", command),
            )
            .await;

        let waited = harness
            .tool
            .execute(
                &serde_json::json!({"task_id": task_id(&started), "action": "wait", "timeout": 250}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;

        assert!(
            matches!(waited, ToolExecutionResult::Success { data: Some(data), .. }
                if data["status"] == "running" && data["waitTimedOut"] == true)
                && harness
                    .runner
                    .last_process()
                    .terminations
                    .load(Ordering::Relaxed)
                    == 0
        );
    }

    #[tokio::test]
    async fn interrupt_reuses_the_registry_and_reports_a_terminal_result() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::pending();
        let command = "Start-Sleep -Seconds 10";
        let started = harness
            .tool
            .execute(
                &serde_json::json!({"command": command, "run_in_background": true}),
                &context_for_command(workspace.path(), "session-a", command),
            )
            .await;

        let interrupted = harness
            .tool
            .execute(
                &serde_json::json!({"task_id": task_id(&started), "action": "interrupt"}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;

        assert!(
            matches!(interrupted, ToolExecutionResult::Success { data: Some(data), .. }
                if data["status"] == "interrupted"
                    && data["error"]["code"] == "COMMAND_INTERRUPTED")
                && harness
                    .runner
                    .last_process()
                    .terminations
                    .load(Ordering::Relaxed)
                    == 1
        );
    }

    #[tokio::test]
    async fn task_control_rejects_another_session() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::pending();
        let command = "Start-Sleep -Seconds 10";
        let started = harness
            .tool
            .execute(
                &serde_json::json!({"command": command, "run_in_background": true}),
                &context_for_command(workspace.path(), "session-a", command),
            )
            .await;

        let result = harness
            .tool
            .execute(
                &serde_json::json!({"task_id": task_id(&started), "action": "wait", "timeout": 250}),
                &context_path(workspace.path(), Some("session-b")),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. }
                if error.code == "COMMAND_TASK_ACCESS_DENIED"
        ));
    }

    #[tokio::test]
    async fn task_control_rejects_a_task_created_by_another_shell() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::pending();
        let bash_task = harness
            .registry
            .run(
                CommandRequest {
                    command: "printf test".to_string(),
                    session_id: "session-a".to_string(),
                    shell: ShellKind::Bash,
                    executable: harness.executable.clone(),
                    current_directory: workspace.path().to_path_buf(),
                    environment: BTreeMap::new(),
                    wait_window: Duration::from_millis(250),
                    background: true,
                },
                &CancellationToken::new(),
            )
            .await
            .expect("foreign shell task must start");

        let result = harness
            .tool
            .execute(
                &serde_json::json!({"task_id": bash_task.task_id, "action": "wait", "timeout": 250}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Error { error, .. }
                if error.code == "COMMAND_TASK_SHELL_MISMATCH"
        ));
    }

    #[tokio::test]
    async fn background_command_returns_artifacts_and_preserves_the_original_command() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::pending();
        let command = "Write-Output background";

        let result = harness
            .tool
            .execute(
                &serde_json::json!({"command": command, "run_in_background": true}),
                &context_for_command(workspace.path(), "session-a", command),
            )
            .await;

        assert!(matches!(
            result,
            ToolExecutionResult::Success { data: Some(data), .. }
                if data["background"] == true
                    && data["status"] == "running"
                    && data["command"] == command
                    && data["stdoutFile"].is_string()
                    && data["stderrFile"].is_string()
        ));
    }

    #[tokio::test]
    async fn cancellation_interrupts_the_registry_owned_background_process() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let harness = Harness::pending();
        let command = "Start-Sleep -Seconds 10";
        let mut start_context = context_for_command(workspace.path(), "session-a", command);
        let cancellation = CancellationToken::new();
        start_context.cancellation = cancellation.clone();
        let started = harness
            .tool
            .execute(
                &serde_json::json!({"command": command, "run_in_background": true}),
                &start_context,
            )
            .await;

        cancellation.cancel();
        let terminal = harness
            .tool
            .execute(
                &serde_json::json!({"task_id": task_id(&started), "action": "wait", "timeout": 1000}),
                &context_path(workspace.path(), Some("session-a")),
            )
            .await;

        assert!(matches!(
            terminal,
            ToolExecutionResult::Success { data: Some(data), .. }
                if data["status"] == "interrupted"
        ));
    }

    #[tokio::test]
    async fn completed_literal_set_location_persists_a_trusted_session_cwd() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        let nested = workspace.path().join("中文目录");
        std::fs::create_dir(&nested).expect("nested cwd must be created");
        let harness = Harness::completing();
        let set_location = "Set-Location -LiteralPath '中文目录'";
        let first = harness
            .tool
            .execute(
                &serde_json::json!({"command": set_location}),
                &context_for_command(workspace.path(), "session-a", set_location),
            )
            .await;
        let second_command = "Write-Output done";
        let second = harness
            .tool
            .execute(
                &serde_json::json!({"command": second_command}),
                &context_for_command(workspace.path(), "session-a", second_command),
            )
            .await;
        let requests = harness
            .runner
            .requests
            .lock()
            .expect("fake request list must remain available");

        assert!(
            matches!(first, ToolExecutionResult::Success { .. })
                && matches!(second, ToolExecutionResult::Success { .. })
                && requests
                    .get(1)
                    .is_some_and(|request| request.current_directory == nested)
        );
    }

    #[tokio::test]
    async fn background_set_location_does_not_change_the_session_cwd() {
        let workspace = tempfile::tempdir().expect("workspace must be available");
        std::fs::create_dir(workspace.path().join("nested")).expect("nested cwd must be created");
        let harness = Harness::completing();
        let set_location = "cd nested";
        harness
            .tool
            .execute(
                &serde_json::json!({"command": set_location, "run_in_background": true}),
                &context_for_command(workspace.path(), "session-a", set_location),
            )
            .await;
        let second_command = "Write-Output done";
        let result = harness
            .tool
            .execute(
                &serde_json::json!({"command": second_command}),
                &context_for_command(workspace.path(), "session-a", second_command),
            )
            .await;
        let requests = harness
            .runner
            .requests
            .lock()
            .expect("fake request list must remain available");

        assert!(
            matches!(result, ToolExecutionResult::Success { .. })
                && requests
                    .get(1)
                    .is_some_and(|request| request.current_directory == workspace.path())
        );
    }

    #[tokio::test]
    async fn task_control_does_not_reopen_workspace_authority() {
        let parent = tempfile::tempdir().expect("workspace parent must be available");
        let workspace = parent.path().join("workspace");
        let replaced = parent.path().join("replaced");
        std::fs::create_dir(&workspace).expect("workspace must be created");
        let harness = Harness::completing();
        let command = "Write-Output done";
        let started = harness
            .tool
            .execute(
                &serde_json::json!({"command": command, "run_in_background": true}),
                &context_for_command(&workspace, "session-a", command),
            )
            .await;
        std::fs::rename(&workspace, &replaced).expect("workspace must be moved");
        std::fs::create_dir(&workspace).expect("replacement workspace must be created");

        let waited = harness
            .tool
            .execute(
                &serde_json::json!({"task_id": task_id(&started), "action": "wait", "timeout": 1000}),
                &context_path(&workspace, Some("session-a")),
            )
            .await;

        assert!(matches!(waited, ToolExecutionResult::Success { .. }));
    }

    #[tokio::test]
    async fn clear_session_resets_workspace_authority_without_clearing_shared_tasks() {
        let first_workspace = tempfile::tempdir().expect("first workspace must be available");
        let second_workspace = tempfile::tempdir().expect("second workspace must be available");
        let harness = Harness::completing();
        let command = "Write-Output done";
        harness
            .tool
            .execute(
                &serde_json::json!({"command": command}),
                &context_for_command(first_workspace.path(), "session-a", command),
            )
            .await;

        harness.tool.clear_session("session-a");

        let result = harness
            .tool
            .execute(
                &serde_json::json!({"command": command}),
                &context_for_command(second_workspace.path(), "session-a", command),
            )
            .await;
        assert!(matches!(result, ToolExecutionResult::Success { .. }));
    }

    #[test]
    fn location_parser_accepts_literals_and_rejects_dynamic_or_ambiguous_targets() {
        assert_eq!(
            literal_location_target("Set-Location -LiteralPath '中文 目录'"),
            Some("中文 目录".to_string())
        );
        assert_eq!(
            literal_location_target("cd \"nested directory\""),
            Some("nested directory".to_string())
        );
        assert_eq!(literal_location_target("Set-Location $HOME"), None);
        assert_eq!(literal_location_target("cd \"$HOME\""), None);
        assert_eq!(literal_location_target("cd nested; Get-Location"), None);
        assert_eq!(literal_location_target("cd nested extra"), None);
    }
}
