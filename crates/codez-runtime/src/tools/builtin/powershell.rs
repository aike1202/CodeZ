use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use codez_core::{
    AppError, AppErrorKind, ProcessOutput, ProcessRequest, ProcessRunner, SafeWorkspacePath,
    WorkspaceRoot,
};
use dashmap::DashMap;
use file_id::FileId;
use serde_json::Value;
use thiserror::Error;

use crate::tools::registry::{
    BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext, ToolDescriptor,
    ToolHandler,
};
use crate::tools::types::{
    ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect, ToolEffectPlan,
    ToolExecutionError, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
    ToolPlanningContext, ToolSource,
};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 250;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: u64 = 100_000;
const UTF8_SETUP: &str = concat!(
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false);"
);

#[derive(Debug, Clone)]
struct WorkspaceAuthority {
    requested_root: PathBuf,
    root: WorkspaceRoot,
    identity: FileId,
}

#[derive(Debug, Clone)]
struct TrustedWorkingDirectory {
    path: PathBuf,
    identity: FileId,
}

#[derive(Debug, Error)]
enum WorkspaceAuthorityError {
    #[error("PowerShell workspace root must be an absolute directory: {0}")]
    InvalidRoot(PathBuf),
    #[error("PowerShell workspace root changed after it was authorized: {0}")]
    RootChanged(PathBuf),
    #[error("PowerShell workspace path is outside the authorized root: {0}")]
    OutsideAuthority(PathBuf),
    #[error("PowerShell workspace directory is a symbolic link or reparse point: {0}")]
    UnsafeDirectory(PathBuf),
    #[error("PowerShell workspace directory identity changed: {0}")]
    DirectoryChanged(PathBuf),
    #[error("PowerShell workspace failed to {operation}: {path}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl WorkspaceAuthorityError {
    fn into_app_error(self) -> AppError {
        match self {
            Self::InvalidRoot(_) => AppError::validation(self.to_string()),
            Self::OutsideAuthority(_) | Self::UnsafeDirectory(_) => {
                AppError::permission_denied(self.to_string())
            }
            Self::RootChanged(_) | Self::DirectoryChanged(_) => {
                AppError::conflict(self.to_string())
            }
            Self::Io { ref source, .. } if source.kind() == io::ErrorKind::NotFound => {
                AppError::conflict(self.to_string())
            }
            Self::Io { ref source, .. } if source.kind() == io::ErrorKind::PermissionDenied => {
                AppError::permission_denied(self.to_string())
            }
            Self::Io { .. } => AppError::external(
                "The PowerShell workspace could not be verified",
                self.to_string(),
                false,
            ),
        }
    }
}

impl From<WorkspaceAuthorityError> for AppError {
    fn from(value: WorkspaceAuthorityError) -> Self {
        value.into_app_error()
    }
}

/// PowerShell command handler backed by the bounded platform process port.
pub struct PowerShellTool {
    descriptor: DefaultToolDescriptor,
    executable: PathBuf,
    process_runner: Arc<dyn ProcessRunner>,
    process_environment: BTreeMap<OsString, OsString>,
    session_authorities: DashMap<String, WorkspaceAuthority>,
    session_working_directories: DashMap<String, TrustedWorkingDirectory>,
}

impl PowerShellTool {
    /// Creates a handler with an explicit executable, process adapter, and child environment.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the executable is not an absolute regular file.
    pub fn new(
        executable: PathBuf,
        process_runner: Arc<dyn ProcessRunner>,
        process_environment: BTreeMap<OsString, OsString>,
    ) -> Result<Self, AppError> {
        if !executable.is_absolute() {
            return Err(AppError::validation(
                "The PowerShell executable must be an absolute regular file",
            ));
        }
        let executable = dunce::canonicalize(&executable).map_err(|source| {
            AppError::external(
                "The PowerShell executable could not be verified",
                source.to_string(),
                false,
            )
        })?;
        if !executable.is_file() {
            return Err(AppError::validation(
                "The PowerShell executable must be an absolute regular file",
            ));
        }
        Ok(Self {
            descriptor: DefaultToolDescriptor {
                name: "PowerShell",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:powershell".to_string(),
                summary: "Execute a PowerShell command.".to_string(),
                description: "Executes one classified PowerShell command in the workspace."
                    .to_string(),
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
                    platforms: Some(vec!["windows".to_string()]),
                    exposure: ToolExposure::Always,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::Exclusive,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: u32::try_from(MAX_OUTPUT_BYTES).unwrap_or(u32::MAX),
                    timeout_ms: Some(u32::try_from(MAX_TIMEOUT_MS).unwrap_or(u32::MAX)),
                },
            },
            executable,
            process_runner,
            process_environment,
            session_authorities: DashMap::new(),
            session_working_directories: DashMap::new(),
        })
    }

    /// Removes the remembered working directory for a deleted session.
    pub fn clear_session(&self, session_id: &str) {
        self.session_authorities.remove(session_id);
        self.session_working_directories.remove(session_id);
    }

    async fn execute_command(
        &self,
        command: &str,
        timeout_ms: u64,
        context: &ToolContext,
    ) -> Result<ProcessOutput, AppError> {
        let session_id = context
            .session_id
            .as_deref()
            .ok_or_else(|| AppError::validation("A session is required for PowerShell"))?;
        let authority = self.session_authority(session_id, &context.workspace_root)?;
        let current_directory = self.session_working_directory(session_id, &authority)?;
        let request = ProcessRequest {
            program: self.executable.clone(),
            arguments: vec![
                OsString::from("-NoLogo"),
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from(format!("{UTF8_SETUP}\n{command}")),
            ],
            current_directory: current_directory.clone(),
            environment: self.process_environment.clone(),
            timeout: Duration::from_millis(timeout_ms),
            max_output_bytes: MAX_OUTPUT_BYTES,
        };
        let output = self
            .process_runner
            .run(request, context.cancellation.clone())
            .await?;
        self.remember_literal_working_directory(
            session_id,
            &authority,
            &current_directory,
            command,
        )?;
        Ok(output)
    }

    fn session_authority(
        &self,
        session_id: &str,
        requested_root: &Path,
    ) -> Result<WorkspaceAuthority, AppError> {
        if let Some(existing) = self.session_authorities.get(session_id) {
            let authority = existing.value().clone();
            drop(existing);
            authority.verify_context(requested_root)?;
            return Ok(authority);
        }

        let candidate = WorkspaceAuthority::open(requested_root)?;
        let authority = self
            .session_authorities
            .entry(session_id.to_string())
            .or_insert(candidate)
            .value()
            .clone();
        authority.verify_context(requested_root)?;
        Ok(authority)
    }

    fn session_working_directory(
        &self,
        session_id: &str,
        authority: &WorkspaceAuthority,
    ) -> Result<PathBuf, AppError> {
        let remembered = self
            .session_working_directories
            .get(session_id)
            .map(|entry| entry.value().clone());
        let Some(remembered) = remembered else {
            authority.verify_root()?;
            return Ok(authority.root.as_path().to_path_buf());
        };
        if remembered.verify(authority).is_ok() {
            return Ok(remembered.path);
        }

        self.session_working_directories.remove(session_id);
        authority.verify_root()?;
        Ok(authority.root.as_path().to_path_buf())
    }

    fn remember_literal_working_directory(
        &self,
        session_id: &str,
        authority: &WorkspaceAuthority,
        current_directory: &Path,
        command: &str,
    ) -> Result<(), AppError> {
        let Some(requested) = literal_location_target(command) else {
            return Ok(());
        };
        let requested = Path::new(&requested);
        let candidate = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            current_directory.join(requested)
        };
        let trusted = TrustedWorkingDirectory::open(authority, &candidate)?;
        self.session_working_directories
            .insert(session_id.to_string(), trusted);
        Ok(())
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
            input.get("command").and_then(Value::as_str).map_or_else(
                || ToolEffectPlan {
                    effects: vec![ToolEffect::Unknown {
                        target: "powershell-command-missing".to_string(),
                    }],
                    analysis_status: "unparsed".to_string(),
                },
                |command| ToolEffectPlan {
                    effects: vec![ToolEffect::ExecuteCommand {
                        shell: "powershell".to_string(),
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
                matches!(effect, ToolEffect::ExecuteCommand { shell, command: approved } if shell == "powershell" && approved == command)
            });
            if !approved {
                return execution_error(
                    "TOOL_COMMAND_NOT_AUTHORIZED",
                    "The command changed after authorization.",
                    false,
                );
            }
            let timeout_ms = arguments
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
            match self.execute_command(command, timeout_ms, context).await {
                Ok(output) => process_success(output),
                Err(error) => process_error(error),
            }
        })
    }
}

impl WorkspaceAuthority {
    fn open(requested_root: &Path) -> Result<Self, WorkspaceAuthorityError> {
        if !requested_root.is_absolute() {
            return Err(WorkspaceAuthorityError::InvalidRoot(
                requested_root.to_path_buf(),
            ));
        }
        let requested_root = requested_root.to_path_buf();
        ensure_safe_directory(&requested_root)?;
        let canonical = canonicalize_directory(&requested_root)?;
        ensure_safe_directory(&canonical)?;
        let identity = directory_identity(&canonical)?;
        let root = WorkspaceRoot::from_canonical(canonical)
            .map_err(|_| WorkspaceAuthorityError::InvalidRoot(requested_root.to_path_buf()))?;
        let authority = Self {
            requested_root,
            root,
            identity,
        };
        authority.verify_root()?;
        Ok(authority)
    }

    fn verify_context(&self, requested_root: &Path) -> Result<(), WorkspaceAuthorityError> {
        if !requested_root.is_absolute()
            || path_identity_key(requested_root) != path_identity_key(&self.requested_root)
        {
            return Err(WorkspaceAuthorityError::RootChanged(
                requested_root.to_path_buf(),
            ));
        }
        self.verify_root()
    }

    fn verify_root(&self) -> Result<(), WorkspaceAuthorityError> {
        ensure_safe_directory(&self.requested_root)?;
        let canonical = canonicalize_directory(&self.requested_root)?;
        ensure_safe_directory(&self.requested_root)?;
        ensure_safe_directory(&canonical)?;
        let identity = directory_identity(&canonical)?;
        if path_identity_key(&canonical) != path_identity_key(self.root.as_path())
            || identity != self.identity
        {
            return Err(WorkspaceAuthorityError::RootChanged(
                self.requested_root.clone(),
            ));
        }
        Ok(())
    }
}

impl TrustedWorkingDirectory {
    fn open(
        authority: &WorkspaceAuthority,
        requested: &Path,
    ) -> Result<Self, WorkspaceAuthorityError> {
        authority.verify_root()?;
        let inspected = inspect_directory_components(authority, requested)?;
        let canonical = canonicalize_directory(&inspected)?;
        SafeWorkspacePath::from_canonical(&authority.root, &canonical)
            .map_err(|_| WorkspaceAuthorityError::OutsideAuthority(canonical.clone()))?;
        if path_identity_key(&canonical) != path_identity_key(&inspected) {
            return Err(WorkspaceAuthorityError::UnsafeDirectory(inspected));
        }
        ensure_safe_directory(&canonical)?;
        let identity = directory_identity(&canonical)?;
        authority.verify_root()?;
        let trusted = Self {
            path: canonical,
            identity,
        };
        trusted.verify(authority)?;
        Ok(trusted)
    }

    fn verify(&self, authority: &WorkspaceAuthority) -> Result<(), WorkspaceAuthorityError> {
        authority.verify_root()?;
        let inspected = inspect_directory_components(authority, &self.path)?;
        let canonical = canonicalize_directory(&inspected)?;
        SafeWorkspacePath::from_canonical(&authority.root, &canonical)
            .map_err(|_| WorkspaceAuthorityError::OutsideAuthority(canonical.clone()))?;
        let identity = directory_identity(&canonical)?;
        if path_identity_key(&canonical) != path_identity_key(&self.path)
            || identity != self.identity
        {
            return Err(WorkspaceAuthorityError::DirectoryChanged(self.path.clone()));
        }
        ensure_safe_directory(&self.path)?;
        authority.verify_root()?;
        Ok(())
    }
}

fn inspect_directory_components(
    authority: &WorkspaceAuthority,
    requested: &Path,
) -> Result<PathBuf, WorkspaceAuthorityError> {
    let relative = requested
        .strip_prefix(authority.root.as_path())
        .map_err(|_| WorkspaceAuthorityError::OutsideAuthority(requested.to_path_buf()))?;
    let mut current = authority.root.as_path().to_path_buf();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => {
                current.push(part);
                ensure_safe_directory(&current)?;
            }
            std::path::Component::ParentDir => {
                if current == authority.root.as_path() || !current.pop() {
                    return Err(WorkspaceAuthorityError::OutsideAuthority(
                        requested.to_path_buf(),
                    ));
                }
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(WorkspaceAuthorityError::OutsideAuthority(
                    requested.to_path_buf(),
                ));
            }
        }
    }
    ensure_safe_directory(&current)?;
    Ok(current)
}

fn ensure_safe_directory(path: &Path) -> Result<(), WorkspaceAuthorityError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| workspace_io("inspect directory metadata", path, source))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(WorkspaceAuthorityError::UnsafeDirectory(path.to_path_buf()));
    }
    Ok(())
}

fn canonicalize_directory(path: &Path) -> Result<PathBuf, WorkspaceAuthorityError> {
    dunce::canonicalize(path).map_err(|source| workspace_io("canonicalize directory", path, source))
}

fn directory_identity(path: &Path) -> Result<FileId, WorkspaceAuthorityError> {
    file_id::get_file_id(path)
        .map_err(|source| workspace_io("read directory identity", path, source))
}

fn path_identity_key(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn workspace_io(
    operation: &'static str,
    path: &Path,
    source: io::Error,
) -> WorkspaceAuthorityError {
    WorkspaceAuthorityError::Io {
        operation,
        path: path.to_path_buf(),
        source,
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
        &trimmed["set-location".len()..]
    } else if lower.starts_with("cd")
        && trimmed
            .chars()
            .nth("cd".len())
            .is_some_and(char::is_whitespace)
    {
        &trimmed["cd".len()..]
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
            remainder = remainder[parameter.len()..].trim_start();
            break;
        }
    }
    let literal = parse_first_literal(remainder)?;
    if literal.is_empty()
        || literal
            .chars()
            .any(|character| matches!(character, '$' | '`' | '*' | '?'))
    {
        None
    } else {
        Some(literal)
    }
}

fn parse_first_literal(input: &str) -> Option<String> {
    let first = input.chars().next()?;
    if first == '\'' || first == '"' {
        let mut escaped = false;
        let mut value = String::new();
        for character in input.chars().skip(1) {
            if escaped {
                value.push(character);
                escaped = false;
            } else if character == '`' {
                escaped = true;
            } else if character == first {
                return Some(value);
            } else {
                value.push(character);
            }
        }
        return None;
    }
    let value = input
        .split(|character: char| character.is_whitespace() || matches!(character, ';' | '|' | '&'))
        .next()?;
    (!value.is_empty()).then(|| value.to_string())
}

fn process_success(output: ProcessOutput) -> ToolExecutionResult {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let model_content = match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout.clone(),
        (true, false) => stderr.clone(),
        (true, true) => "Command completed successfully.".to_string(),
    };
    let elapsed_ms = u64::try_from(output.elapsed.as_millis()).unwrap_or(u64::MAX);
    ToolExecutionResult::Success {
        data: Some(serde_json::json!({
            "status": "completed",
            "exitCode": output.exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "outputTruncated": output.output_truncated,
            "elapsedMs": elapsed_ms,
        })),
        model_content,
        ui_content: None,
        effects: None,
    }
}

fn process_error(error: AppError) -> ToolExecutionResult {
    match error.kind() {
        AppErrorKind::Cancelled => ToolExecutionResult::Cancelled {
            error: tool_error("TOOL_CANCELLED", error.public_message(), false),
            model_content: None,
            ui_content: None,
            effects: None,
        },
        AppErrorKind::Timeout => {
            execution_error("TOOL_COMMAND_TIMEOUT", error.public_message(), true)
        }
        AppErrorKind::ProcessFailed => {
            execution_error("TOOL_COMMAND_FAILED", error.public_message(), true)
        }
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
        error: tool_error(code, message, recoverable),
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

fn tool_error(code: &str, message: &str, recoverable: bool) -> ToolExecutionError {
    ToolExecutionError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, VecDeque},
        ffi::OsString,
        io,
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
        time::Duration,
    };

    use codez_core::{
        AppError, CancellationToken, PortFuture, ProcessOutput, ProcessRequest, ProcessRunner,
    };

    use super::{MAX_OUTPUT_BYTES, PowerShellTool};
    use crate::tools::registry::{ToolContext, ToolHandler};
    use crate::tools::types::{
        ToolEffect, ToolEffectPlan, ToolExecutionResult, ToolPlanningContext,
    };

    #[derive(Clone, Copy)]
    enum Outcome {
        Success,
        Timeout,
        Failure,
    }

    struct FakeProcessRunner {
        requests: Mutex<Vec<ProcessRequest>>,
        outcomes: Mutex<VecDeque<Outcome>>,
    }

    impl FakeProcessRunner {
        fn new(outcomes: impl IntoIterator<Item = Outcome>) -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                outcomes: Mutex::new(outcomes.into_iter().collect()),
            }
        }
    }

    impl ProcessRunner for FakeProcessRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            cancellation: CancellationToken,
        ) -> PortFuture<'a, ProcessOutput> {
            Box::pin(async move {
                self.requests
                    .lock()
                    .expect("request lock must remain available")
                    .push(request);
                if cancellation.is_cancelled() {
                    return Err(AppError::cancelled("cancelled by test"));
                }
                match self
                    .outcomes
                    .lock()
                    .expect("outcome lock must remain available")
                    .pop_front()
                    .unwrap_or(Outcome::Success)
                {
                    Outcome::Success => Ok(ProcessOutput {
                        exit_code: Some(0),
                        stdout: "你好，PowerShell".as_bytes().to_vec(),
                        stderr: vec![b'x'; 8],
                        output_truncated: true,
                        elapsed: Duration::from_millis(12),
                    }),
                    Outcome::Timeout => Err(AppError::timeout("timed out by test")),
                    Outcome::Failure => Err(AppError::process_failed("failed by test", "exit=7")),
                }
            })
        }
    }

    fn executable(directory: &tempfile::TempDir) -> PathBuf {
        let path = directory.path().join("powershell.exe");
        std::fs::write(&path, b"fixture").expect("fixture executable must be created");
        path
    }

    fn context(workspace: PathBuf, cancellation: CancellationToken) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            session_id: Some("session-1".to_string()),
            context_scope_id: "main".to_string(),
            transaction_id: None,
            workspace_root: workspace,
            cancellation,
            authorized_effects: ToolEffectPlan {
                effects: vec![ToolEffect::ExecuteCommand {
                    shell: "powershell".to_string(),
                    command: "Write-Output '你好'".to_string(),
                }],
                analysis_status: "parsed".to_string(),
            },
            file_services: None,
        }
    }

    fn context_for_command(workspace: &Path, command: &str) -> ToolContext {
        let mut context = context(workspace.to_path_buf(), CancellationToken::new());
        context.authorized_effects.effects = vec![ToolEffect::ExecuteCommand {
            shell: "powershell".to_string(),
            command: command.to_string(),
        }];
        context
    }

    #[tokio::test]
    async fn planning_emits_the_exact_typed_powershell_effect() {
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let tool = PowerShellTool::new(
            executable(&executable_dir),
            Arc::new(FakeProcessRunner::new([])),
            BTreeMap::new(),
        )
        .expect("fixture tool must be valid");
        let planning = ToolPlanningContext {
            workspace_root: std::env::temp_dir(),
            session_id: Some("session-1".to_string()),
            agent_role: "main".to_string(),
        };

        let effects = tool
            .plan_effects(
                &serde_json::json!({"command": "Write-Output 'classified'"}),
                &planning,
            )
            .await;

        assert_eq!(
            effects,
            ToolEffectPlan {
                effects: vec![ToolEffect::ExecuteCommand {
                    shell: "powershell".to_string(),
                    command: "Write-Output 'classified'".to_string(),
                }],
                analysis_status: "parsed".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn command_preserves_unicode_and_uses_bounded_explicit_process_request() {
        let workspace = tempfile::tempdir().expect("workspace fixture must be available");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([Outcome::Success]));
        let tool = PowerShellTool::new(
            executable(&executable_dir),
            runner.clone(),
            BTreeMap::from([(OsString::from("SystemRoot"), OsString::from("C:\\Windows"))]),
        )
        .expect("fixture tool must be valid");
        let command = "Write-Output '你好'";

        let result = tool
            .execute(
                &serde_json::json!({"command": command, "timeout": 550}),
                &context(workspace.path().to_path_buf(), CancellationToken::new()),
            )
            .await;
        let requests = runner
            .requests
            .lock()
            .expect("request lock must remain available");
        let request = requests.first().expect("one request must be captured");

        assert!(
            matches!(result, ToolExecutionResult::Success { ref data, ref model_content, .. }
                if data.as_ref().is_some_and(|value| value["outputTruncated"] == true)
                    && model_content.contains("你好"))
                && request.timeout == Duration::from_millis(550)
                && request.max_output_bytes == MAX_OUTPUT_BYTES
                && request.environment.len() == 1
                && request
                    .arguments
                    .last()
                    .is_some_and(|value| value.to_string_lossy().contains(command))
        );
    }

    #[tokio::test]
    async fn successful_literal_set_location_persists_workspace_session_cwd() {
        let workspace = tempfile::tempdir().expect("workspace fixture must be available");
        let nested = workspace.path().join("中文目录");
        std::fs::create_dir(&nested).expect("nested fixture must be created");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([Outcome::Success, Outcome::Success]));
        let tool =
            PowerShellTool::new(executable(&executable_dir), runner.clone(), BTreeMap::new())
                .expect("fixture tool must be valid");
        let mut first_context = context(workspace.path().to_path_buf(), CancellationToken::new());
        first_context.authorized_effects.effects = vec![ToolEffect::ExecuteCommand {
            shell: "powershell".to_string(),
            command: "Set-Location -LiteralPath '中文目录'".to_string(),
        }];

        let first = tool
            .execute(
                &serde_json::json!({"command": "Set-Location -LiteralPath '中文目录'"}),
                &first_context,
            )
            .await;
        let second = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.path().to_path_buf(), CancellationToken::new()),
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
    async fn replacing_the_workspace_root_is_rejected_without_running_a_command() {
        let parent = tempfile::tempdir().expect("workspace parent fixture must be available");
        let workspace = parent.path().join("workspace");
        let replaced = parent.path().join("replaced-workspace");
        std::fs::create_dir(&workspace).expect("workspace fixture must be created");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([Outcome::Success, Outcome::Success]));
        let tool =
            PowerShellTool::new(executable(&executable_dir), runner.clone(), BTreeMap::new())
                .expect("fixture tool must be valid");

        let first = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.clone(), CancellationToken::new()),
            )
            .await;
        std::fs::rename(&workspace, &replaced).expect("original workspace must be moved");
        std::fs::create_dir(&workspace).expect("replacement workspace must be created");
        let second = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace, CancellationToken::new()),
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
    async fn a_session_cannot_replace_its_initial_workspace_authority() {
        let first_workspace = tempfile::tempdir().expect("first workspace must be available");
        let second_workspace = tempfile::tempdir().expect("second workspace must be available");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([Outcome::Success, Outcome::Success]));
        let tool =
            PowerShellTool::new(executable(&executable_dir), runner.clone(), BTreeMap::new())
                .expect("fixture tool must be valid");

        let first = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(
                    first_workspace.path().to_path_buf(),
                    CancellationToken::new(),
                ),
            )
            .await;
        let second = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(
                    second_workspace.path().to_path_buf(),
                    CancellationToken::new(),
                ),
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
    async fn replacing_the_workspace_root_with_a_link_is_rejected_when_supported() {
        let parent = tempfile::tempdir().expect("workspace parent fixture must be available");
        let outside = tempfile::tempdir().expect("outside fixture must be available");
        let workspace = parent.path().join("workspace");
        let replaced = parent.path().join("replaced-workspace");
        std::fs::create_dir(&workspace).expect("workspace fixture must be created");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([Outcome::Success, Outcome::Success]));
        let tool =
            PowerShellTool::new(executable(&executable_dir), runner.clone(), BTreeMap::new())
                .expect("fixture tool must be valid");

        let first = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.clone(), CancellationToken::new()),
            )
            .await;
        std::fs::rename(&workspace, &replaced).expect("original workspace must be moved");
        if let Err(source) = create_directory_link(outside.path(), &workspace) {
            if symlink_permission_unavailable(&source) {
                return;
            }
            panic!("workspace replacement link must be created: {source}");
        }
        let second = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace, CancellationToken::new()),
            )
            .await;

        assert!(
            matches!(first, ToolExecutionResult::Success { .. })
                && matches!(second, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_WORKSPACE_NOT_AUTHORIZED")
                && runner
                    .requests
                    .lock()
                    .expect("request lock must remain available")
                    .len()
                    == 1
        );
    }

    #[tokio::test]
    async fn replaced_remembered_cwd_falls_back_only_to_the_still_trusted_root() {
        let workspace = tempfile::tempdir().expect("workspace fixture must be available");
        let outside = tempfile::tempdir().expect("outside fixture must be available");
        let nested = workspace.path().join("nested");
        let replaced = workspace.path().join("replaced-nested");
        std::fs::create_dir(&nested).expect("nested fixture must be created");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([Outcome::Success, Outcome::Success]));
        let tool =
            PowerShellTool::new(executable(&executable_dir), runner.clone(), BTreeMap::new())
                .expect("fixture tool must be valid");
        let set_location = "Set-Location -LiteralPath 'nested'";

        let first = tool
            .execute(
                &serde_json::json!({"command": set_location}),
                &context_for_command(workspace.path(), set_location),
            )
            .await;
        std::fs::rename(&nested, &replaced).expect("remembered cwd must be moved");
        if let Err(source) = create_directory_link(outside.path(), &nested) {
            if symlink_permission_unavailable(&source) {
                return;
            }
            panic!("cwd replacement link must be created: {source}");
        }
        let second = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.path().to_path_buf(), CancellationToken::new()),
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
    async fn recreated_remembered_cwd_is_not_retrusted_by_path_name() {
        let workspace = tempfile::tempdir().expect("workspace fixture must be available");
        let nested = workspace.path().join("nested");
        let replaced = workspace.path().join("replaced-nested");
        std::fs::create_dir(&nested).expect("nested fixture must be created");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([Outcome::Success, Outcome::Success]));
        let tool =
            PowerShellTool::new(executable(&executable_dir), runner.clone(), BTreeMap::new())
                .expect("fixture tool must be valid");
        let set_location = "Set-Location -LiteralPath 'nested'";

        let first = tool
            .execute(
                &serde_json::json!({"command": set_location}),
                &context_for_command(workspace.path(), set_location),
            )
            .await;
        std::fs::rename(&nested, &replaced).expect("remembered cwd must be moved");
        std::fs::create_dir(&nested).expect("replacement cwd must be created");
        let second = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.path().to_path_buf(), CancellationToken::new()),
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
    async fn timeout_cancellation_and_command_failure_have_distinct_results() {
        let workspace = tempfile::tempdir().expect("workspace fixture must be available");
        let executable_dir = tempfile::tempdir().expect("executable fixture must be available");
        let runner = Arc::new(FakeProcessRunner::new([
            Outcome::Timeout,
            Outcome::Failure,
            Outcome::Success,
        ]));
        let tool = PowerShellTool::new(executable(&executable_dir), runner, BTreeMap::new())
            .expect("fixture tool must be valid");

        let timeout = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.path().to_path_buf(), CancellationToken::new()),
            )
            .await;
        let failure = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.path().to_path_buf(), CancellationToken::new()),
            )
            .await;
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let cancelled = tool
            .execute(
                &serde_json::json!({"command": "Write-Output '你好'"}),
                &context(workspace.path().to_path_buf(), cancellation),
            )
            .await;

        assert!(
            matches!(timeout, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_COMMAND_TIMEOUT")
                && matches!(failure, ToolExecutionResult::Error { error, .. } if error.code == "TOOL_COMMAND_FAILED")
                && matches!(cancelled, ToolExecutionResult::Cancelled { error, .. } if error.code == "TOOL_CANCELLED")
        );
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    fn symlink_permission_unavailable(source: &io::Error) -> bool {
        source.kind() == io::ErrorKind::PermissionDenied || source.raw_os_error() == Some(1314)
    }
}
