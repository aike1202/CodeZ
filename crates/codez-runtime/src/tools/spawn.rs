use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use codez_core::{
    AppError, AppErrorKind, CancellationToken, SpawnedProcess, SpawnedProcessOutput,
    SpawnedProcessOutputTarget, SpawnedProcessRequest, SpawnedProcessRunner,
    SpawnedProcessTermination,
};
use dashmap::DashMap;
use serde::Serialize;
use thiserror::Error;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

const DEFAULT_RETENTION: Duration = Duration::from_secs(15 * 60);
const DEFAULT_MAX_TASKS: usize = 100;
const LIVE_OUTPUT_LIMIT: u64 = 1_000_000;
const FINAL_OUTPUT_HEAD: usize = 1_000;
const FINAL_OUTPUT_TAIL: usize = 3_000;
const TERMINATION_CONFIRMATION_WINDOW: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Bash,
    PowerShell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandTaskStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTaskResult {
    pub status: CommandTaskStatus,
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub wait_timed_out: bool,
    pub background: bool,
    pub task_id: String,
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_file: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_file: Option<PathBuf>,
    pub started_at: u64,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

#[derive(Debug, Error)]
pub enum CommandTaskError {
    #[error("command cannot be empty")]
    EmptyCommand,
    #[error("command task `{0}` was not found")]
    NotFound(String),
    #[error("the command task belongs to another session")]
    WrongSession,
    #[error("the command task belongs to another Agent run")]
    WrongOwner,
    #[error("the command task was started by another shell")]
    WrongShell,
    #[error("the command task was cancelled")]
    Cancelled,
    #[error("the command process tree did not reach a terminal state after interruption")]
    TerminationNotConfirmed,
    #[error("the command task host configuration is invalid: {0}")]
    InvalidHost(String),
    #[error("the command process could not be supervised: {message}")]
    Supervision { kind: AppErrorKind, message: String },
}

impl CommandTaskError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::EmptyCommand | Self::InvalidHost(_) => "TOOL_INPUT_INVALID",
            Self::NotFound(_) => "COMMAND_TASK_NOT_FOUND",
            Self::WrongSession | Self::WrongOwner => "COMMAND_TASK_ACCESS_DENIED",
            Self::WrongShell => "COMMAND_TASK_SHELL_MISMATCH",
            Self::Cancelled => "TOOL_CANCELLED",
            Self::TerminationNotConfirmed => "COMMAND_INTERRUPT_UNCONFIRMED",
            Self::Supervision { .. } => "TOOL_PROCESS_FAILED",
        }
    }

    #[must_use]
    pub const fn recoverable(&self) -> bool {
        matches!(
            self,
            Self::NotFound(_) | Self::TerminationNotConfirmed | Self::Supervision { .. }
        )
    }
}

impl From<AppError> for CommandTaskError {
    fn from(error: AppError) -> Self {
        Self::Supervision {
            kind: error.kind(),
            message: error.public_message().to_string(),
        }
    }
}

impl From<CommandTaskError> for AppError {
    fn from(error: CommandTaskError) -> Self {
        let public_message = error.to_string();
        match error {
            CommandTaskError::EmptyCommand | CommandTaskError::InvalidHost(_) => {
                AppError::validation(public_message)
            }
            CommandTaskError::NotFound(_) => AppError::not_found(public_message),
            CommandTaskError::WrongSession | CommandTaskError::WrongOwner => {
                AppError::permission_denied(public_message)
            }
            CommandTaskError::WrongShell => AppError::validation(public_message),
            CommandTaskError::Cancelled => AppError::cancelled(public_message),
            CommandTaskError::TerminationNotConfirmed => AppError::external(
                "The command process could not be stopped safely",
                public_message,
                true,
            ),
            CommandTaskError::Supervision { kind, message } => match kind {
                AppErrorKind::Validation => AppError::validation(message),
                AppErrorKind::Unsupported => AppError::unsupported(message),
                AppErrorKind::PermissionDenied => AppError::permission_denied(message),
                AppErrorKind::NotFound => AppError::not_found(message),
                AppErrorKind::Conflict => AppError::conflict(message),
                AppErrorKind::RunActive => AppError::run_active(message),
                AppErrorKind::External => AppError::external(message.clone(), message, false),
                AppErrorKind::ProcessFailed => AppError::process_failed(message.clone(), message),
                AppErrorKind::Cancelled => AppError::cancelled(message),
                AppErrorKind::Timeout => AppError::timeout(message),
                AppErrorKind::Storage => AppError::storage(message.clone(), message, false),
                AppErrorKind::Internal => AppError::internal(message),
            },
        }
    }
}

pub struct CommandRequest {
    pub command: String,
    pub session_id: String,
    pub owner_id: String,
    pub shell: ShellKind,
    pub executable: PathBuf,
    pub current_directory: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
    pub wait_window: Duration,
    pub background: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct CommandTaskAccess<'a> {
    pub session_id: &'a str,
    pub owner_id: &'a str,
    pub shell: ShellKind,
}

pub struct CommandTaskRegistry {
    runner: Arc<dyn SpawnedProcessRunner>,
    background_root: PathBuf,
    tasks: Arc<DashMap<String, Arc<ManagedCommandTask>>>,
    sequence: AtomicU64,
    retention: Duration,
    max_tasks: usize,
}

struct ManagedCommandTask {
    task_id: String,
    command: String,
    session_id: String,
    owner_id: String,
    shell: ShellKind,
    started_at: SystemTime,
    started: Instant,
    pid: Option<u32>,
    background: bool,
    stdout_file: Option<PathBuf>,
    stderr_file: Option<PathBuf>,
    process: Arc<dyn SpawnedProcess>,
    state: Mutex<ManagedTaskState>,
    termination: Mutex<()>,
    changed: Notify,
}

struct ManagedTaskState {
    terminal: Option<Result<SpawnedProcessOutput, TaskProcessFailure>>,
    completed_at: Option<Instant>,
}

#[derive(Debug, Clone)]
struct TaskProcessFailure {
    kind: AppErrorKind,
    message: String,
}

impl TaskProcessFailure {
    fn from_app_error(error: AppError) -> Self {
        Self {
            kind: error.kind(),
            message: error.public_message().to_string(),
        }
    }

    fn into_command_error(self) -> CommandTaskError {
        CommandTaskError::Supervision {
            kind: self.kind,
            message: self.message,
        }
    }
}

impl CommandTaskRegistry {
    /// Creates a registry backed by an explicit host process adapter.
    ///
    /// # Errors
    ///
    /// Returns [`CommandTaskError`] when the background artifact directory is
    /// not an existing absolute directory.
    pub fn new(
        runner: Arc<dyn SpawnedProcessRunner>,
        background_root: PathBuf,
    ) -> Result<Self, CommandTaskError> {
        Self::with_limits(
            runner,
            background_root,
            DEFAULT_RETENTION,
            DEFAULT_MAX_TASKS,
        )
    }

    fn with_limits(
        runner: Arc<dyn SpawnedProcessRunner>,
        background_root: PathBuf,
        retention: Duration,
        max_tasks: usize,
    ) -> Result<Self, CommandTaskError> {
        if !background_root.is_absolute() || !background_root.is_dir() {
            return Err(CommandTaskError::InvalidHost(
                "background artifact root must be an existing absolute directory".to_string(),
            ));
        }
        if max_tasks == 0 {
            return Err(CommandTaskError::InvalidHost(
                "task limit must be positive".to_string(),
            ));
        }
        Ok(Self {
            runner,
            background_root,
            tasks: Arc::new(DashMap::new()),
            sequence: AtomicU64::new(0),
            retention,
            max_tasks,
        })
    }

    /// Starts a command and waits for the first window unless it is detached.
    /// Cancellation always interrupts and confirms the owned process tree.
    pub async fn run(
        &self,
        request: CommandRequest,
        cancellation: &CancellationToken,
    ) -> Result<CommandTaskResult, CommandTaskError> {
        if request.command.trim().is_empty() {
            return Err(CommandTaskError::EmptyCommand);
        }
        if cancellation.is_cancelled() {
            return Err(CommandTaskError::Cancelled);
        }
        self.prune().await;

        let task_id = self.next_task_id();
        let (stdout_file, stderr_file, output) = if request.background {
            let stdout_path = self
                .background_root
                .join(format!("codez-bg-{}.out", Uuid::new_v4()));
            let stderr_path = self
                .background_root
                .join(format!("codez-bg-{}.err", Uuid::new_v4()));
            (
                Some(stdout_path.clone()),
                Some(stderr_path.clone()),
                SpawnedProcessOutputTarget::Files {
                    stdout_path,
                    stderr_path,
                },
            )
        } else {
            (None, None, SpawnedProcessOutputTarget::Capture)
        };
        let arguments = shell_arguments(request.shell, &request.command);
        let process_request = SpawnedProcessRequest {
            program: request.executable,
            arguments,
            current_directory: request.current_directory,
            environment: request.environment,
            max_output_bytes: LIVE_OUTPUT_LIMIT,
            output,
        };
        let process = match self.runner.spawn(process_request).await {
            Ok(process) => process,
            Err(error) => {
                remove_artifacts(stdout_file.as_deref(), stderr_file.as_deref()).await;
                return Err(error.into());
            }
        };
        let task = Arc::new(ManagedCommandTask {
            task_id: task_id.clone(),
            command: request.command,
            session_id: request.session_id,
            owner_id: request.owner_id,
            shell: request.shell,
            started_at: SystemTime::now(),
            started: Instant::now(),
            pid: process.pid(),
            background: request.background,
            stdout_file,
            stderr_file,
            process,
            state: Mutex::new(ManagedTaskState {
                terminal: None,
                completed_at: None,
            }),
            termination: Mutex::new(()),
            changed: Notify::new(),
        });
        self.tasks.insert(task_id.clone(), Arc::clone(&task));
        monitor_task(Arc::clone(&task));
        monitor_cancellation(Arc::clone(&task), cancellation.clone());

        let access = CommandTaskAccess {
            session_id: &task.session_id,
            owner_id: &task.owner_id,
            shell: task.shell,
        };
        if request.background {
            if cancellation.is_cancelled() {
                return match self.interrupt(access, &task_id).await {
                    Ok(_) => Err(CommandTaskError::Cancelled),
                    Err(error) => Err(error),
                };
            }
            return task.snapshot(true).await;
        }
        self.wait_or_interrupt(access, &task_id, request.wait_window, cancellation)
            .await
    }

    /// Waits for one task window while keeping the process alive after expiry.
    pub async fn wait(
        &self,
        access: CommandTaskAccess<'_>,
        task_id: &str,
        wait_window: Duration,
    ) -> Result<CommandTaskResult, CommandTaskError> {
        let task = self.authorized_task(access, task_id)?;
        if task.is_terminal().await {
            return task.snapshot(false).await;
        }
        if wait_window.is_zero() {
            return task.snapshot(false).await;
        }
        let wait = wait_until_terminal(&task);
        if tokio::time::timeout(wait_window, wait).await.is_err() {
            return task.snapshot(false).await;
        }
        task.snapshot(false).await
    }

    /// Waits for a task but turns tool-call cancellation into process interruption.
    pub async fn wait_or_interrupt(
        &self,
        access: CommandTaskAccess<'_>,
        task_id: &str,
        wait_window: Duration,
        cancellation: &CancellationToken,
    ) -> Result<CommandTaskResult, CommandTaskError> {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                match self.interrupt(access, task_id).await {
                    Ok(_) => Err(CommandTaskError::Cancelled),
                    Err(error) => Err(error),
                }
            }
            result = self.wait(access, task_id, wait_window) => {
                match result {
                    Ok(result)
                        if result.status == CommandTaskStatus::Interrupted
                            && cancellation.is_cancelled() =>
                    {
                        Err(CommandTaskError::Cancelled)
                    }
                    other => other,
                }
            }
        }
    }

    /// Terminates a task's process tree and requires a terminal confirmation.
    pub async fn interrupt(
        &self,
        access: CommandTaskAccess<'_>,
        task_id: &str,
    ) -> Result<CommandTaskResult, CommandTaskError> {
        let task = self.authorized_task(access, task_id)?;
        if !task.is_terminal().await {
            task.terminate_confirmed().await?;
        }
        task.snapshot(false).await
    }

    /// Terminates and forgets every command owned by a deleted session.
    pub async fn clear_session(&self, session_id: &str) -> Result<(), CommandTaskError> {
        let tasks = self
            .tasks
            .iter()
            .filter(|entry| entry.value().session_id == session_id)
            .map(|entry| (entry.key().clone(), Arc::clone(entry.value())))
            .collect::<Vec<_>>();
        let mut first_error = None;
        for (task_id, task) in tasks {
            if !task.is_terminal().await {
                if let Err(error) = task.terminate_confirmed().await {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                    continue;
                }
            }
            remove_artifacts(task.stdout_file.as_deref(), task.stderr_file.as_deref()).await;
            self.tasks.remove(&task_id);
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Removes expired completed tasks and enforces the completed-task count bound.
    pub async fn prune(&self) {
        let now = Instant::now();
        let candidates = self
            .tasks
            .iter()
            .map(|entry| (entry.key().clone(), Arc::clone(entry.value())))
            .collect::<Vec<_>>();
        let mut completed = Vec::new();
        for (task_id, task) in candidates {
            let state = task.state.lock().await;
            if let Some(completed_at) = state.completed_at {
                completed.push((task_id, completed_at));
            }
        }
        let expired = completed
            .iter()
            .filter(|(_, completed_at)| now.duration_since(*completed_at) >= self.retention)
            .map(|(task_id, _)| task_id.clone())
            .collect::<Vec<_>>();
        for task_id in expired {
            self.remove_completed_task(&task_id).await;
        }

        if self.tasks.len() < self.max_tasks {
            return;
        }
        completed.sort_by_key(|(_, completed_at)| *completed_at);
        let remove_count = self
            .tasks
            .len()
            .saturating_sub(self.max_tasks.saturating_sub(1));
        for (task_id, _) in completed.into_iter().take(remove_count) {
            self.remove_completed_task(&task_id).await;
        }
    }

    fn authorized_task(
        &self,
        access: CommandTaskAccess<'_>,
        task_id: &str,
    ) -> Result<Arc<ManagedCommandTask>, CommandTaskError> {
        let task = self
            .tasks
            .get(task_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| CommandTaskError::NotFound(task_id.to_string()))?;
        if task.session_id != access.session_id {
            return Err(CommandTaskError::WrongSession);
        }
        if task.owner_id != access.owner_id {
            return Err(CommandTaskError::WrongOwner);
        }
        if task.shell != access.shell {
            return Err(CommandTaskError::WrongShell);
        }
        Ok(task)
    }

    fn next_task_id(&self) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        format!("cmd-{}-{sequence}", unix_millis(SystemTime::now()))
    }

    async fn remove_completed_task(&self, task_id: &str) {
        let Some((_, task)) = self.tasks.remove(task_id) else {
            return;
        };
        remove_artifacts(task.stdout_file.as_deref(), task.stderr_file.as_deref()).await;
    }

    #[cfg(test)]
    fn task_count(&self) -> usize {
        self.tasks.len()
    }
}

impl ManagedCommandTask {
    async fn is_terminal(&self) -> bool {
        self.state.lock().await.terminal.is_some()
    }

    async fn snapshot(
        &self,
        background_started: bool,
    ) -> Result<CommandTaskResult, CommandTaskError> {
        let state = self.state.lock().await;
        let (status, exit_code, stdout, stderr, elapsed, truncated) = match &state.terminal {
            None => (
                CommandTaskStatus::Running,
                None,
                String::new(),
                String::new(),
                self.started.elapsed(),
                false,
            ),
            Some(Ok(output)) => {
                let status = match output.termination {
                    SpawnedProcessTermination::Terminated => CommandTaskStatus::Interrupted,
                    SpawnedProcessTermination::Exited if output.exit_code == Some(0) => {
                        CommandTaskStatus::Completed
                    }
                    SpawnedProcessTermination::Exited => CommandTaskStatus::Failed,
                };
                let stdout = truncate_output(&String::from_utf8_lossy(&output.stdout));
                let stderr = truncate_output(&String::from_utf8_lossy(&output.stderr));
                (
                    status,
                    output.exit_code,
                    stdout.text,
                    stderr.text,
                    output.elapsed,
                    output.output_truncated || stdout.truncated || stderr.truncated,
                )
            }
            Some(Err(error)) => return Err(error.clone().into_command_error()),
        };
        Ok(CommandTaskResult {
            status,
            command: self.command.clone(),
            exit_code,
            stdout,
            stderr,
            timed_out: false,
            wait_timed_out: status == CommandTaskStatus::Running && !background_started,
            background: self.background,
            task_id: self.task_id.clone(),
            pid: self.pid,
            stdout_file: self.stdout_file.clone(),
            stderr_file: self.stderr_file.clone(),
            started_at: unix_millis(self.started_at),
            elapsed_ms: duration_millis(elapsed),
            truncated,
        })
    }

    async fn terminate_confirmed(&self) -> Result<(), CommandTaskError> {
        let _termination = self.termination.lock().await;
        if self.is_terminal().await {
            return Ok(());
        }
        self.process.terminate().await?;
        tokio::time::timeout(TERMINATION_CONFIRMATION_WINDOW, wait_until_terminal(self))
            .await
            .map_err(|_| CommandTaskError::TerminationNotConfirmed)
    }
}

struct TruncatedOutput {
    text: String,
    truncated: bool,
}

fn truncate_output(text: &str) -> TruncatedOutput {
    let character_count = text.chars().count();
    if character_count <= FINAL_OUTPUT_HEAD + FINAL_OUTPUT_TAIL {
        return TruncatedOutput {
            text: text.to_string(),
            truncated: false,
        };
    }
    let head = text.chars().take(FINAL_OUTPUT_HEAD).collect::<String>();
    let tail = text
        .chars()
        .skip(character_count - FINAL_OUTPUT_TAIL)
        .collect::<String>();
    TruncatedOutput {
        text: format!(
            "{head}\n\n[System Note: Output truncated (Original size: {character_count} chars). Head {FINAL_OUTPUT_HEAD} + tail {FINAL_OUTPUT_TAIL} kept. Do NOT rerun the same command; redirect to a file and Read it, or filter with Grep.]\n\n{tail}"
        ),
        truncated: true,
    }
}

fn shell_arguments(shell: ShellKind, command: &str) -> Vec<OsString> {
    match shell {
        ShellKind::Bash => ["-c", command].into_iter().map(OsString::from).collect(),
        ShellKind::PowerShell => ["-NoProfile", "-NonInteractive", "-Command", command]
            .into_iter()
            .map(OsString::from)
            .collect(),
    }
}

fn monitor_task(task: Arc<ManagedCommandTask>) {
    tokio::spawn(async move {
        let terminal = task
            .process
            .wait()
            .await
            .map_err(TaskProcessFailure::from_app_error);
        let mut state = task.state.lock().await;
        state.terminal = Some(terminal);
        state.completed_at = Some(Instant::now());
        drop(state);
        task.changed.notify_waiters();
    });
}

fn monitor_cancellation(task: Arc<ManagedCommandTask>, cancellation: CancellationToken) {
    tokio::spawn(async move {
        tokio::select! {
            () = cancellation.cancelled() => {
                if let Err(error) = task.terminate_confirmed().await
                {
                    tracing::warn!(task_id = %task.task_id, %error, "command cancellation failed");
                }
            }
            () = wait_until_terminal(&task) => {}
        }
    });
}

async fn wait_until_terminal(task: &ManagedCommandTask) {
    loop {
        let changed = task.changed.notified();
        if task.is_terminal().await {
            return;
        }
        changed.await;
    }
}

async fn remove_artifacts(stdout: Option<&Path>, stderr: Option<&Path>) {
    for path in [stdout, stderr].into_iter().flatten() {
        match tokio::fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "command artifact cleanup failed")
            }
        }
    }
}

fn unix_millis(time: SystemTime) -> u64 {
    duration_millis(time.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO))
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::PathBuf,
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
    use tempfile::TempDir;
    use tokio::sync::{Mutex, Notify};

    use super::{
        CommandRequest, CommandTaskAccess, CommandTaskError, CommandTaskRegistry,
        CommandTaskStatus, ShellKind,
    };

    struct FakeRunner {
        processes: StdMutex<Vec<Arc<FakeProcess>>>,
        complete_on_spawn: bool,
    }

    impl FakeRunner {
        fn pending() -> Self {
            Self {
                processes: StdMutex::new(Vec::new()),
                complete_on_spawn: false,
            }
        }

        fn completing() -> Self {
            Self {
                processes: StdMutex::new(Vec::new()),
                complete_on_spawn: true,
            }
        }

        fn last_process(&self) -> Arc<FakeProcess> {
            Arc::clone(
                self.processes
                    .lock()
                    .expect("fake process list must not be poisoned")
                    .last()
                    .expect("a fake process must have been spawned"),
            )
        }
    }

    impl SpawnedProcessRunner for FakeRunner {
        fn spawn(&self, request: SpawnedProcessRequest) -> PortFuture<'_, Arc<dyn SpawnedProcess>> {
            Box::pin(async move {
                request.validate()?;
                if let SpawnedProcessOutputTarget::Files {
                    stdout_path,
                    stderr_path,
                } = request.output
                {
                    tokio::fs::write(stdout_path, b"").await.map_err(|error| {
                        AppError::storage("fixture write failed", error.to_string(), false)
                    })?;
                    tokio::fs::write(stderr_path, b"").await.map_err(|error| {
                        AppError::storage("fixture write failed", error.to_string(), false)
                    })?;
                }
                let process = Arc::new(FakeProcess::new());
                if self.complete_on_spawn {
                    process.complete(success_output()).await;
                }
                self.processes
                    .lock()
                    .expect("fake process list must not be poisoned")
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
        _root: TempDir,
        registry: Arc<CommandTaskRegistry>,
        runner: Arc<FakeRunner>,
        executable: PathBuf,
    }

    impl Harness {
        fn pending() -> Self {
            Self::new(FakeRunner::pending(), Duration::from_secs(900), 100)
        }

        fn new(runner: FakeRunner, retention: Duration, max_tasks: usize) -> Self {
            let root = tempfile::tempdir().expect("temporary root must be available");
            let runner = Arc::new(runner);
            let registry = Arc::new(
                CommandTaskRegistry::with_limits(
                    Arc::clone(&runner) as Arc<dyn SpawnedProcessRunner>,
                    root.path().to_path_buf(),
                    retention,
                    max_tasks,
                )
                .expect("fixture registry must be valid"),
            );
            let executable = root.path().join("bash-fixture");
            Self {
                _root: root,
                registry,
                runner,
                executable,
            }
        }

        fn request(&self, session_id: &str, background: bool) -> CommandRequest {
            CommandRequest {
                command: "fixture command".to_string(),
                session_id: session_id.to_string(),
                owner_id: session_id.to_string(),
                shell: ShellKind::Bash,
                executable: self.executable.clone(),
                current_directory: self._root.path().to_path_buf(),
                environment: BTreeMap::new(),
                wait_window: Duration::from_millis(1),
                background,
            }
        }
    }

    fn success_output() -> SpawnedProcessOutput {
        SpawnedProcessOutput {
            exit_code: Some(0),
            stdout: b"done".to_vec(),
            stderr: Vec::new(),
            output_truncated: false,
            elapsed: Duration::from_millis(10),
            termination: SpawnedProcessTermination::Exited,
        }
    }

    #[tokio::test]
    async fn wait_should_reject_a_task_from_another_session() {
        let harness = Harness::pending();
        let result = harness
            .registry
            .run(
                harness.request("session-a", false),
                &CancellationToken::new(),
            )
            .await
            .expect("first wait should return a running task");

        let error = harness
            .registry
            .wait(
                CommandTaskAccess {
                    session_id: "session-b",
                    owner_id: "session-b",
                    shell: ShellKind::Bash,
                },
                &result.task_id,
                Duration::ZERO,
            )
            .await
            .expect_err("another session must not observe the task");

        assert!(matches!(error, CommandTaskError::WrongSession));
    }

    #[tokio::test]
    async fn wait_should_reject_another_agent_run_in_the_same_session() {
        let harness = Harness::pending();
        let mut request = harness.request("session-a", false);
        request.owner_id = "attempt-a".to_string();
        let result = harness
            .registry
            .run(request, &CancellationToken::new())
            .await
            .expect("first Agent wait should return a running task");

        let error = harness
            .registry
            .wait(
                CommandTaskAccess {
                    session_id: "session-a",
                    owner_id: "attempt-b",
                    shell: ShellKind::Bash,
                },
                &result.task_id,
                Duration::ZERO,
            )
            .await
            .expect_err("another Agent run must not observe the task");

        assert!(matches!(error, CommandTaskError::WrongOwner));
    }

    #[tokio::test]
    async fn wait_should_reject_a_task_from_another_shell() {
        let harness = Harness::pending();
        let result = harness
            .registry
            .run(
                harness.request("session-a", false),
                &CancellationToken::new(),
            )
            .await
            .expect("first wait should return a running task");

        let error = harness
            .registry
            .wait(
                CommandTaskAccess {
                    session_id: "session-a",
                    owner_id: "session-a",
                    shell: ShellKind::PowerShell,
                },
                &result.task_id,
                Duration::ZERO,
            )
            .await
            .expect_err("another shell must not observe the task");

        assert!(matches!(error, CommandTaskError::WrongShell));
    }

    #[tokio::test]
    async fn wait_should_return_not_found_for_an_unknown_task() {
        let harness = Harness::pending();

        let error = harness
            .registry
            .wait(
                CommandTaskAccess {
                    session_id: "session-a",
                    owner_id: "session-a",
                    shell: ShellKind::Bash,
                },
                "cmd-missing",
                Duration::ZERO,
            )
            .await
            .expect_err("unknown task must fail");

        assert!(matches!(error, CommandTaskError::NotFound(_)));
    }

    #[tokio::test]
    async fn interrupt_should_confirm_a_terminal_interrupted_result() {
        let harness = Harness::pending();
        let running = harness
            .registry
            .run(
                harness.request("session-a", false),
                &CancellationToken::new(),
            )
            .await
            .expect("first wait should return a running task");

        let interrupted = harness
            .registry
            .interrupt(
                CommandTaskAccess {
                    session_id: "session-a",
                    owner_id: "session-a",
                    shell: ShellKind::Bash,
                },
                &running.task_id,
            )
            .await
            .expect("interrupt must be confirmed");

        assert_eq!(interrupted.status, CommandTaskStatus::Interrupted);
    }

    #[tokio::test]
    async fn cancellation_should_interrupt_the_owned_process() {
        let mut outcomes = Vec::new();
        for _ in 0..32 {
            let harness = Harness::pending();
            let cancellation = CancellationToken::new();
            let trigger = cancellation.clone();
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                trigger.cancel();
            });

            let result = harness
                .registry
                .run(harness.request("session-a", false), &cancellation)
                .await;
            let termination_count = harness
                .runner
                .last_process()
                .terminations
                .load(Ordering::Relaxed);
            outcomes.push((result, termination_count));
        }

        assert!(outcomes.into_iter().all(|(result, termination_count)| {
            matches!(result, Err(CommandTaskError::Cancelled)) && termination_count == 1
        }));
    }

    #[tokio::test]
    async fn foreground_task_should_remain_bound_to_cancellation_after_returning_running() {
        let harness = Harness::pending();
        let cancellation = CancellationToken::new();
        let running = harness
            .registry
            .run(harness.request("session-a", false), &cancellation)
            .await
            .expect("the short wait must return a retained task");
        assert_eq!(running.status, CommandTaskStatus::Running);

        cancellation.cancel();
        let terminal = harness
            .registry
            .wait(
                CommandTaskAccess {
                    session_id: "session-a",
                    owner_id: "session-a",
                    shell: ShellKind::Bash,
                },
                &running.task_id,
                Duration::from_secs(1),
            )
            .await
            .expect("late cancellation must become observable as a terminal result");
        let termination_count = harness
            .runner
            .last_process()
            .terminations
            .load(Ordering::Relaxed);

        assert_eq!(
            (terminal.status, termination_count),
            (CommandTaskStatus::Interrupted, 1)
        );
    }

    #[tokio::test]
    async fn cancellation_after_completion_should_not_terminate_the_process() {
        let harness = Harness::new(FakeRunner::completing(), Duration::MAX, 100);
        let cancellation = CancellationToken::new();
        let completed = harness
            .registry
            .run(harness.request("session-a", false), &cancellation)
            .await
            .expect("fixture command must complete");
        assert_eq!(completed.status, CommandTaskStatus::Completed);

        cancellation.cancel();
        tokio::task::yield_now().await;
        let termination_count = harness
            .runner
            .last_process()
            .terminations
            .load(Ordering::Relaxed);

        assert_eq!(termination_count, 0);
    }

    #[tokio::test]
    async fn cancellation_and_explicit_interrupt_should_terminate_only_once() {
        let harness = Harness::pending();
        let cancellation = CancellationToken::new();
        let running = harness
            .registry
            .run(harness.request("session-a", false), &cancellation)
            .await
            .expect("the short wait must return a retained task");

        cancellation.cancel();
        let interrupted = harness
            .registry
            .interrupt(
                CommandTaskAccess {
                    session_id: "session-a",
                    owner_id: "session-a",
                    shell: ShellKind::Bash,
                },
                &running.task_id,
            )
            .await
            .expect("explicit interruption must converge with cancellation");
        let termination_count = harness
            .runner
            .last_process()
            .terminations
            .load(Ordering::Relaxed);

        assert_eq!(
            (interrupted.status, termination_count),
            (CommandTaskStatus::Interrupted, 1)
        );
    }

    #[tokio::test]
    async fn prune_should_keep_the_registry_under_its_completed_task_bound() {
        let harness = Harness::new(FakeRunner::completing(), Duration::MAX, 2);
        for index in 0..3 {
            harness
                .registry
                .run(
                    harness.request(&format!("session-{index}"), false),
                    &CancellationToken::new(),
                )
                .await
                .expect("completed fixture command must succeed");
        }

        assert_eq!(harness.registry.task_count(), 2);
    }

    #[tokio::test]
    async fn clear_session_should_interrupt_tasks_and_delete_background_artifacts() {
        let harness = Harness::pending();
        let running = harness
            .registry
            .run(
                harness.request("session-a", true),
                &CancellationToken::new(),
            )
            .await
            .expect("background task must start");
        let stdout_file = running
            .stdout_file
            .expect("background stdout artifact must be returned");
        let stderr_file = running
            .stderr_file
            .expect("background stderr artifact must be returned");

        harness
            .registry
            .clear_session("session-a")
            .await
            .expect("session cleanup must terminate and remove artifacts");

        assert!(
            !stdout_file.exists() && !stderr_file.exists() && harness.registry.task_count() == 0
        );
    }

    #[tokio::test]
    async fn background_task_should_remain_bound_to_late_tool_call_cancellation() {
        let harness = Harness::pending();
        let cancellation = CancellationToken::new();
        harness
            .registry
            .run(harness.request("session-a", true), &cancellation)
            .await
            .expect("background task must start");
        let process = harness.runner.last_process();

        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(1), async {
            while process.terminations.load(Ordering::Relaxed) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late cancellation must reach the background process");

        assert_eq!(process.terminations.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn prune_should_delete_completed_background_artifacts() {
        let harness = Harness::new(FakeRunner::completing(), Duration::ZERO, 100);
        let result = harness
            .registry
            .run(
                harness.request("session-a", true),
                &CancellationToken::new(),
            )
            .await
            .expect("background task must start");
        let stdout_file = result
            .stdout_file
            .expect("background stdout artifact must be returned");
        let stderr_file = result
            .stderr_file
            .expect("background stderr artifact must be returned");
        let access = CommandTaskAccess {
            session_id: "session-a",
            owner_id: "session-a",
            shell: ShellKind::Bash,
        };
        harness
            .registry
            .wait(access, &result.task_id, Duration::from_secs(1))
            .await
            .expect("completed background task must become observable");

        harness.registry.prune().await;

        assert!(!stdout_file.exists() && !stderr_file.exists());
    }
}
