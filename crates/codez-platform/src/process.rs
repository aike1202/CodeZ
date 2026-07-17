use std::{
    fs::{File, OpenOptions},
    path::Path,
    process::{ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use codez_core::{
    AppError, AppErrorKind, CancellationToken, PortFuture, ProcessOutput, ProcessRequest,
    ProcessRunner, SpawnedProcess, SpawnedProcessOutput, SpawnedProcessOutputTarget,
    SpawnedProcessRequest, SpawnedProcessRunner, SpawnedProcessTermination,
};
use dashmap::DashMap;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
#[cfg(windows)]
use process_wrap::tokio::{CreationFlags, JobObject};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::{Notify, watch},
    task::JoinHandle,
};
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const READ_CHUNK_BYTES: usize = 8 * 1024;
const PROCESS_TREE_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Native process adapter with bounded output and owned process-tree shutdown.
#[derive(Clone)]
pub struct NativeProcessRunner {
    state: Arc<RunnerState>,
}

struct RunnerState {
    accepting: AtomicBool,
    next_id: AtomicU64,
    active: DashMap<u64, CancellationToken>,
    active_changed: Notify,
}

struct ActiveProcessGuard {
    id: u64,
    state: Arc<RunnerState>,
}

#[derive(Debug)]
struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Debug)]
enum ProcessCompletion {
    Exited(std::io::Result<ExitStatus>),
    Cancelled,
    TimedOut,
    Shutdown,
}

enum SpawnedCaptureTasks {
    Captured {
        stdout: JoinHandle<Result<CapturedStream, std::io::Error>>,
        stderr: JoinHandle<Result<CapturedStream, std::io::Error>>,
    },
    Files,
}

#[derive(Debug, Clone)]
enum SharedProcessCompletion {
    Output(SpawnedProcessOutput),
    Error(SharedProcessError),
}

#[derive(Debug, Clone)]
struct SharedProcessError {
    kind: AppErrorKind,
    message: String,
    diagnostic: Option<String>,
    retryable: bool,
}

impl SharedProcessError {
    fn from_app_error(error: AppError) -> Self {
        Self {
            kind: error.kind(),
            message: error.public_message().to_string(),
            diagnostic: error.diagnostic().map(str::to_string),
            retryable: error.retryable(),
        }
    }

    fn into_app_error(self) -> AppError {
        let diagnostic = self.diagnostic.unwrap_or_else(|| self.message.clone());
        match self.kind {
            AppErrorKind::Validation => AppError::validation(self.message),
            AppErrorKind::Unsupported => AppError::unsupported(self.message),
            AppErrorKind::PermissionDenied => AppError::permission_denied(self.message),
            AppErrorKind::NotFound => AppError::not_found(self.message),
            AppErrorKind::Conflict => AppError::conflict(self.message),
            AppErrorKind::RunActive => AppError::run_active(self.message),
            AppErrorKind::External => AppError::external(self.message, diagnostic, self.retryable),
            AppErrorKind::ProcessFailed => AppError::process_failed(self.message, diagnostic),
            AppErrorKind::Cancelled => AppError::cancelled(self.message),
            AppErrorKind::Timeout => AppError::timeout(self.message),
            AppErrorKind::Storage => AppError::storage(self.message, diagnostic, self.retryable),
            AppErrorKind::Internal => AppError::internal(diagnostic),
        }
    }
}

struct NativeSpawnedProcess {
    pid: Option<u32>,
    terminate: CancellationToken,
    completion: watch::Receiver<Option<SharedProcessCompletion>>,
}

impl Default for NativeProcessRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeProcessRunner {
    /// Creates a process runner that initially accepts requests.
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Arc::new(RunnerState {
                accepting: AtomicBool::new(true),
                next_id: AtomicU64::new(0),
                active: DashMap::new(),
                active_changed: Notify::new(),
            }),
        }
    }

    /// Prevents new process requests from entering the registry.
    pub fn stop_accepting(&self) {
        self.state.accepting.store(false, Ordering::Release);
    }

    /// Cancels every registered process and waits until each supervisor confirms cleanup.
    pub async fn cancel_all(&self) {
        self.cancel_active();
        self.wait_until_empty().await;
    }

    /// Requests cancellation for every registered process without waiting.
    pub fn cancel_active(&self) {
        let tokens = self
            .state
            .active
            .iter()
            .map(|entry| entry.value().clone())
            .collect::<Vec<_>>();
        for token in tokens {
            token.cancel();
        }
    }

    /// Waits until every registered process supervisor has released ownership.
    pub async fn wait_for_idle(&self) {
        self.wait_until_empty().await;
    }

    /// Stops admission, cancels all owned process trees, and waits for their supervisors.
    pub async fn shutdown(&self) {
        self.stop_accepting();
        self.cancel_active();
        self.wait_for_idle().await;
    }

    /// Reports the number of process supervisors currently owned by this runner.
    #[must_use]
    pub fn active_count(&self) -> usize {
        self.state.active.len()
    }

    fn register_process(&self) -> Result<(ActiveProcessGuard, CancellationToken), AppError> {
        if !self.state.accepting.load(Ordering::Acquire) {
            return Err(AppError::conflict("The process runner is shutting down"));
        }

        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let shutdown = CancellationToken::new();
        self.state.active.insert(id, shutdown.clone());

        if !self.state.accepting.load(Ordering::Acquire) {
            shutdown.cancel();
            self.state.active.remove(&id);
            self.state.active_changed.notify_waiters();
            return Err(AppError::conflict("The process runner is shutting down"));
        }

        Ok((
            ActiveProcessGuard {
                id,
                state: Arc::clone(&self.state),
            },
            shutdown,
        ))
    }

    async fn wait_until_empty(&self) {
        loop {
            let changed = self.state.active_changed.notified();
            if self.state.active.is_empty() {
                return;
            }
            changed.await;
        }
    }
}

impl Drop for ActiveProcessGuard {
    fn drop(&mut self) {
        self.state.active.remove(&self.id);
        self.state.active_changed.notify_waiters();
    }
}

impl ProcessRunner for NativeProcessRunner {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        cancellation: CancellationToken,
    ) -> PortFuture<'a, ProcessOutput> {
        Box::pin(async move {
            request.validate()?;
            let max_bytes = usize::try_from(request.max_output_bytes).map_err(|_| {
                AppError::validation("The process output limit is unsupported on this platform")
            })?;
            let (_active_guard, shutdown) = self.register_process()?;

            let mut command = tokio::process::Command::new(&request.program);
            command
                .args(&request.arguments)
                .current_dir(&request.current_directory)
                .env_clear()
                .envs(&request.environment)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut command = CommandWrap::from(command);
            #[cfg(windows)]
            {
                command.wrap(CreationFlags(CREATE_NO_WINDOW));
                command.wrap(JobObject);
            }
            #[cfg(unix)]
            command.wrap(ProcessGroup::leader());
            command.wrap(KillOnDrop);

            let start = Instant::now();
            let mut child = command.spawn().map_err(|source| {
                AppError::external(
                    "The child process could not be started",
                    format!("spawn {:?}: {source}", request.program),
                    false,
                )
            })?;

            let stdout = child
                .stdout()
                .take()
                .ok_or_else(|| AppError::internal("process stdout was not piped after spawn"))?;
            let stderr = child
                .stderr()
                .take()
                .ok_or_else(|| AppError::internal("process stderr was not piped after spawn"))?;
            let budget = Arc::new(OutputBudget::new(max_bytes));
            let stdout_task = spawn_stream_reader(stdout, Arc::clone(&budget));
            let stderr_task = spawn_stream_reader(stderr, budget);

            let completion = tokio::select! {
                biased;
                status = child.wait() => ProcessCompletion::Exited(status),
                () = cancellation.cancelled() => ProcessCompletion::Cancelled,
                () = shutdown.cancelled() => ProcessCompletion::Shutdown,
                () = tokio::time::sleep(request.timeout) => ProcessCompletion::TimedOut,
            };

            match completion {
                ProcessCompletion::Exited(status) => {
                    let status = status.map_err(|source| {
                        AppError::external(
                            "The child process exit status could not be read",
                            source.to_string(),
                            false,
                        )
                    })?;
                    let (stdout, stderr) = collect_streams(stdout_task, stderr_task).await?;
                    process_output(status, stdout, stderr, start.elapsed())
                }
                ProcessCompletion::Cancelled => {
                    terminate_and_confirm(&mut *child, "cancellation").await?;
                    drain_after_termination(stdout_task, stderr_task).await?;
                    Err(AppError::cancelled("The child process was cancelled"))
                }
                ProcessCompletion::Shutdown => {
                    terminate_and_confirm(&mut *child, "application shutdown").await?;
                    drain_after_termination(stdout_task, stderr_task).await?;
                    Err(AppError::cancelled(
                        "The child process was stopped during application shutdown",
                    ))
                }
                ProcessCompletion::TimedOut => {
                    terminate_and_confirm(&mut *child, "timeout").await?;
                    drain_after_termination(stdout_task, stderr_task).await?;
                    Err(AppError::timeout("The child process timed out"))
                }
            }
        })
    }
}

impl SpawnedProcessRunner for NativeProcessRunner {
    fn spawn(&self, request: SpawnedProcessRequest) -> PortFuture<'_, Arc<dyn SpawnedProcess>> {
        Box::pin(async move {
            request.validate()?;
            let max_bytes = usize::try_from(request.max_output_bytes).map_err(|_| {
                AppError::validation("The process output limit is unsupported on this platform")
            })?;
            let (active_guard, shutdown) = self.register_process()?;

            let mut command = tokio::process::Command::new(&request.program);
            command
                .args(&request.arguments)
                .current_dir(&request.current_directory)
                .env_clear()
                .envs(&request.environment)
                .stdin(Stdio::null());

            match &request.output {
                SpawnedProcessOutputTarget::Capture => {
                    command.stdout(Stdio::piped()).stderr(Stdio::piped());
                }
                SpawnedProcessOutputTarget::Files {
                    stdout_path,
                    stderr_path,
                } => {
                    let stdout = create_output_file(stdout_path)?;
                    let stderr = create_output_file(stderr_path)?;
                    command
                        .stdout(Stdio::from(stdout))
                        .stderr(Stdio::from(stderr));
                }
            }

            let mut command = CommandWrap::from(command);
            #[cfg(windows)]
            {
                command.wrap(CreationFlags(CREATE_NO_WINDOW));
                command.wrap(JobObject);
            }
            #[cfg(unix)]
            command.wrap(ProcessGroup::leader());
            command.wrap(KillOnDrop);

            let started = Instant::now();
            let mut child = command.spawn().map_err(|source| {
                AppError::external(
                    "The child process could not be started",
                    format!("spawn {:?}: {source}", request.program),
                    false,
                )
            })?;
            let pid = child.id();
            let capture = match request.output {
                SpawnedProcessOutputTarget::Capture => {
                    let stdout = child.stdout().take().ok_or_else(|| {
                        AppError::internal("spawned process stdout was not piped after spawn")
                    })?;
                    let stderr = child.stderr().take().ok_or_else(|| {
                        AppError::internal("spawned process stderr was not piped after spawn")
                    })?;
                    let budget = Arc::new(OutputBudget::new(max_bytes));
                    SpawnedCaptureTasks::Captured {
                        stdout: spawn_stream_reader(stdout, Arc::clone(&budget)),
                        stderr: spawn_stream_reader(stderr, budget),
                    }
                }
                SpawnedProcessOutputTarget::Files { .. } => SpawnedCaptureTasks::Files,
            };
            let terminate = CancellationToken::new();
            let supervisor_terminate = terminate.clone();
            let (completion_tx, completion_rx) = watch::channel(None);
            tokio::spawn(async move {
                let _active_guard = active_guard;
                let completion = supervise_spawned_process(
                    &mut *child,
                    capture,
                    started,
                    &supervisor_terminate,
                    &shutdown,
                )
                .await
                .map_or_else(
                    |error| {
                        SharedProcessCompletion::Error(SharedProcessError::from_app_error(error))
                    },
                    SharedProcessCompletion::Output,
                );
                completion_tx.send_replace(Some(completion));
            });

            Ok(Arc::new(NativeSpawnedProcess {
                pid,
                terminate,
                completion: completion_rx,
            }) as Arc<dyn SpawnedProcess>)
        })
    }
}

impl SpawnedProcess for NativeSpawnedProcess {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn wait(&self) -> PortFuture<'_, SpawnedProcessOutput> {
        Box::pin(wait_for_shared_completion(self.completion.clone()))
    }

    fn terminate(&self) -> PortFuture<'_, SpawnedProcessOutput> {
        Box::pin(async move {
            self.terminate.cancel();
            tokio::time::timeout(
                PROCESS_TREE_EXIT_TIMEOUT + PIPE_DRAIN_TIMEOUT + Duration::from_secs(1),
                wait_for_shared_completion(self.completion.clone()),
            )
            .await
            .map_err(|_| {
                AppError::timeout("The child process tree termination was not confirmed")
            })?
        })
    }
}

fn create_output_file(path: &Path) -> Result<File, AppError> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| {
            AppError::storage(
                "The process output artifact could not be created",
                format!("create {:?}: {source}", path),
                false,
            )
        })
}

async fn wait_for_shared_completion(
    mut receiver: watch::Receiver<Option<SharedProcessCompletion>>,
) -> Result<SpawnedProcessOutput, AppError> {
    loop {
        if let Some(completion) = receiver.borrow().clone() {
            return match completion {
                SharedProcessCompletion::Output(output) => Ok(output),
                SharedProcessCompletion::Error(error) => Err(error.into_app_error()),
            };
        }
        receiver.changed().await.map_err(|_| {
            AppError::internal("spawned process supervisor closed without a terminal result")
        })?;
    }
}

async fn supervise_spawned_process(
    child: &mut dyn ChildWrapper,
    capture: SpawnedCaptureTasks,
    started: Instant,
    terminate: &CancellationToken,
    shutdown: &CancellationToken,
) -> Result<SpawnedProcessOutput, AppError> {
    let completion = tokio::select! {
        biased;
        status = child.wait() => ProcessCompletion::Exited(status),
        () = terminate.cancelled() => ProcessCompletion::Cancelled,
        () = shutdown.cancelled() => ProcessCompletion::Shutdown,
    };

    match completion {
        ProcessCompletion::Exited(status) => {
            let status = status.map_err(|source| {
                AppError::external(
                    "The child process exit status could not be read",
                    source.to_string(),
                    false,
                )
            })?;
            spawned_output(
                status.code(),
                capture,
                started,
                SpawnedProcessTermination::Exited,
            )
            .await
        }
        ProcessCompletion::Cancelled | ProcessCompletion::Shutdown => {
            let reason = if matches!(completion, ProcessCompletion::Shutdown) {
                "application shutdown"
            } else {
                "interruption"
            };
            terminate_and_confirm(child, reason).await?;
            let exit_code = child
                .try_wait()
                .map_err(|source| {
                    AppError::external(
                        "The terminated child process status could not be read",
                        source.to_string(),
                        false,
                    )
                })?
                .and_then(|status| status.code());
            spawned_output(
                exit_code,
                capture,
                started,
                SpawnedProcessTermination::Terminated,
            )
            .await
        }
        ProcessCompletion::TimedOut => Err(AppError::internal(
            "spawned process supervisor entered an impossible timeout state",
        )),
    }
}

async fn spawned_output(
    exit_code: Option<i32>,
    capture: SpawnedCaptureTasks,
    started: Instant,
    termination: SpawnedProcessTermination,
) -> Result<SpawnedProcessOutput, AppError> {
    let (stdout, stderr) = match capture {
        SpawnedCaptureTasks::Captured { stdout, stderr } => collect_streams(stdout, stderr).await?,
        SpawnedCaptureTasks::Files => (
            CapturedStream {
                bytes: Vec::new(),
                truncated: false,
            },
            CapturedStream {
                bytes: Vec::new(),
                truncated: false,
            },
        ),
    };
    Ok(SpawnedProcessOutput {
        exit_code,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        output_truncated: stdout.truncated || stderr.truncated,
        elapsed: started.elapsed(),
        termination,
    })
}

struct OutputBudget {
    limit: usize,
    used: AtomicUsize,
}

impl OutputBudget {
    const fn new(limit: usize) -> Self {
        Self {
            limit,
            used: AtomicUsize::new(0),
        }
    }

    fn reserve(&self, requested: usize) -> usize {
        let mut used = self.used.load(Ordering::Relaxed);
        loop {
            let remaining = self.limit.saturating_sub(used);
            let reserved = remaining.min(requested);
            if reserved == 0 {
                return 0;
            }
            match self.used.compare_exchange_weak(
                used,
                used + reserved,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return reserved,
                Err(actual) => used = actual,
            }
        }
    }
}

fn spawn_stream_reader(
    stream: impl AsyncRead + Unpin + Send + 'static,
    budget: Arc<OutputBudget>,
) -> JoinHandle<Result<CapturedStream, std::io::Error>> {
    tokio::spawn(read_bounded_stream(stream, budget))
}

async fn read_bounded_stream(
    mut stream: impl AsyncRead + Unpin,
    budget: Arc<OutputBudget>,
) -> Result<CapturedStream, std::io::Error> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    let mut truncated = false;

    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(CapturedStream { bytes, truncated });
        }
        let reserved = budget.reserve(read);
        bytes.extend_from_slice(&chunk[..reserved]);
        truncated |= reserved < read;
    }
}

async fn collect_streams(
    mut stdout_task: JoinHandle<Result<CapturedStream, std::io::Error>>,
    mut stderr_task: JoinHandle<Result<CapturedStream, std::io::Error>>,
) -> Result<(CapturedStream, CapturedStream), AppError> {
    let (stdout, stderr) = collect_stream_pair(&mut stdout_task, &mut stderr_task).await?;
    Ok((stdout, stderr))
}

async fn collect_stream(
    name: &'static str,
    task: &mut JoinHandle<Result<CapturedStream, std::io::Error>>,
) -> Result<CapturedStream, AppError> {
    task.await
        .map_err(|source| {
            AppError::internal(format!("process {name} reader task failed: {source}"))
        })?
        .map_err(|source| {
            AppError::external(
                "The child process output could not be read",
                format!("read {name}: {source}"),
                false,
            )
        })
}

async fn collect_stream_pair(
    stdout_task: &mut JoinHandle<Result<CapturedStream, std::io::Error>>,
    stderr_task: &mut JoinHandle<Result<CapturedStream, std::io::Error>>,
) -> Result<(CapturedStream, CapturedStream), AppError> {
    tokio::try_join!(
        collect_stream("stdout", stdout_task),
        collect_stream("stderr", stderr_task),
    )
}

async fn drain_after_termination(
    mut stdout_task: JoinHandle<Result<CapturedStream, std::io::Error>>,
    mut stderr_task: JoinHandle<Result<CapturedStream, std::io::Error>>,
) -> Result<(), AppError> {
    let drained = tokio::select! {
        result = collect_stream_pair(&mut stdout_task, &mut stderr_task) => Some(result),
        () = tokio::time::sleep(PIPE_DRAIN_TIMEOUT) => None,
    };
    match drained {
        Some(result) => result.map(|_| ()),
        None => {
            stdout_task.abort();
            stderr_task.abort();
            let _ = tokio::join!(&mut stdout_task, &mut stderr_task);
            Err(AppError::timeout(
                "The child process output pipes did not close after termination",
            ))
        }
    }
}

async fn terminate_and_confirm(
    child: &mut dyn ChildWrapper,
    reason: &'static str,
) -> Result<(), AppError> {
    let termination = Box::into_pin(child.kill());
    tokio::time::timeout(PROCESS_TREE_EXIT_TIMEOUT, termination)
        .await
        .map_err(|_| {
            AppError::timeout(format!(
                "The child process tree did not exit after {reason}"
            ))
        })?
        .map_err(|source| {
            AppError::external(
                "The child process tree could not be terminated",
                format!("terminate after {reason}: {source}"),
                false,
            )
        })
}

fn process_output(
    status: ExitStatus,
    stdout: CapturedStream,
    stderr: CapturedStream,
    elapsed: Duration,
) -> Result<ProcessOutput, AppError> {
    if !status.success() {
        return Err(AppError::process_failed(
            "The child process exited unsuccessfully",
            format!(
                "status={status}; stderr={}",
                String::from_utf8_lossy(&stderr.bytes)
            ),
        ));
    }

    Ok(ProcessOutput {
        exit_code: status.code(),
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        output_truncated: stdout.truncated || stderr.truncated,
        elapsed,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        ffi::OsString,
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };

    use codez_core::{
        AppErrorKind, CancellationToken, ProcessRequest, ProcessRunner, SpawnedProcessOutputTarget,
        SpawnedProcessRequest, SpawnedProcessRunner, SpawnedProcessTermination,
    };
    use tempfile::tempdir;

    use super::NativeProcessRunner;

    fn shell_executable() -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        }
        #[cfg(unix)]
        {
            PathBuf::from("/bin/sh")
        }
    }

    fn shell_arguments(script: &str) -> Vec<OsString> {
        #[cfg(windows)]
        {
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ]
            .into_iter()
            .map(OsString::from)
            .collect()
        }
        #[cfg(unix)]
        {
            ["-c", script].into_iter().map(OsString::from).collect()
        }
    }

    fn request(cwd: &Path, script: &str, max_output_bytes: u64) -> ProcessRequest {
        ProcessRequest {
            program: shell_executable(),
            arguments: shell_arguments(script),
            current_directory: cwd.to_path_buf(),
            environment: test_environment(),
            timeout: Duration::from_secs(10),
            max_output_bytes,
        }
    }

    fn test_environment() -> BTreeMap<OsString, OsString> {
        #[cfg(windows)]
        {
            ["SystemRoot", "WINDIR", "TEMP", "TMP"]
                .into_iter()
                .filter_map(|name| {
                    std::env::var_os(name).map(|value| (OsString::from(name), value))
                })
                .collect()
        }
        #[cfg(unix)]
        {
            BTreeMap::new()
        }
    }

    #[cfg(windows)]
    const LARGE_OUTPUT_SCRIPT: &str =
        "[Console]::Out.Write(('A' * 8192)); [Console]::Error.Write(('B' * 8192))";
    #[cfg(unix)]
    const LARGE_OUTPUT_SCRIPT: &str =
        "i=0; while [ $i -lt 8192 ]; do printf A; printf B >&2; i=$((i+1)); done";

    #[cfg(windows)]
    const SLEEP_SCRIPT: &str = "Start-Sleep -Seconds 120";
    #[cfg(unix)]
    const SLEEP_SCRIPT: &str = "sleep 120";

    #[tokio::test]
    async fn process_runner_should_apply_one_combined_output_budget() {
        let directory = tempdir().expect("temporary directory must be available");
        let output = NativeProcessRunner::new()
            .run(
                request(directory.path(), LARGE_OUTPUT_SCRIPT, 1024),
                CancellationToken::new(),
            )
            .await
            .expect("bounded fixture process must succeed");

        assert_eq!(
            (
                output.stdout.len() + output.stderr.len(),
                output.output_truncated
            ),
            (1024, true)
        );
    }

    #[tokio::test]
    async fn process_runner_should_terminate_on_cancellation() {
        let directory = tempdir().expect("temporary directory must be available");
        let cancellation = CancellationToken::new();
        let trigger = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            trigger.cancel();
        });

        let error = NativeProcessRunner::new()
            .run(request(directory.path(), SLEEP_SCRIPT, 1024), cancellation)
            .await
            .expect_err("cancelled fixture process must fail");

        assert_eq!(error.kind(), AppErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn process_runner_should_terminate_on_timeout() {
        let directory = tempdir().expect("temporary directory must be available");
        let mut process_request = request(directory.path(), SLEEP_SCRIPT, 1024);
        process_request.timeout = Duration::from_millis(150);

        let error = NativeProcessRunner::new()
            .run(process_request, CancellationToken::new())
            .await
            .expect_err("timed out fixture process must fail");

        assert_eq!(error.kind(), AppErrorKind::Timeout);
    }

    #[tokio::test]
    async fn process_runner_should_classify_nonzero_exit() {
        let directory = tempdir().expect("temporary directory must be available");
        #[cfg(windows)]
        let script = "[Console]::Error.Write('failure'); exit 7";
        #[cfg(unix)]
        let script = "printf failure >&2; exit 7";

        let error = NativeProcessRunner::new()
            .run(
                request(directory.path(), script, 1024),
                CancellationToken::new(),
            )
            .await
            .expect_err("nonzero fixture process must fail");

        assert_eq!(error.kind(), AppErrorKind::ProcessFailed);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn process_runner_cancellation_should_reap_windows_descendants() {
        let directory = tempdir().expect("temporary directory must be available");
        let pid_path = directory.path().join("descendant.pid");
        let lock_path = directory.path().join("descendant.lock");
        let escaped_pid_path = pid_path.to_string_lossy().replace('\'', "''");
        let escaped_lock_path = lock_path.to_string_lossy().replace('\'', "''");
        let descendant_script = format!(
            "$lock = [IO.File]::Open('{escaped_lock_path}', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); [IO.File]::WriteAllText('{escaped_pid_path}', [string]$PID); try {{ Start-Sleep -Seconds 120 }} finally {{ $lock.Dispose() }}"
        );
        let escaped_descendant_script = descendant_script.replace('\'', "''");
        let script = format!(
            "$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('{escaped_descendant_script}')); Start-Process -FilePath ($PSHOME + '\\\\powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden; Start-Sleep -Seconds 120"
        );
        let runner = Arc::new(NativeProcessRunner::new());
        let task_runner = Arc::clone(&runner);
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let process_request = request(directory.path(), &script, 1024);
        let process =
            tokio::spawn(async move { task_runner.run(process_request, task_cancellation).await });

        let descendant_pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(value) = tokio::fs::read_to_string(&pid_path).await
                    && let Ok(pid) = value.parse::<u32>()
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("descendant PID must be published");
        assert!(
            windows_file_is_exclusively_locked(&lock_path),
            "fixture descendant {descendant_pid} must hold its lock before cancellation"
        );

        cancellation.cancel();
        let error = process
            .await
            .expect("process supervisor task must join")
            .expect_err("cancelled process tree must fail");
        let descendant_lock_released = wait_for_windows_file_unlock(&lock_path).await;

        assert_eq!(
            (error.kind(), descendant_lock_released),
            (AppErrorKind::Cancelled, true)
        );
    }

    #[tokio::test]
    async fn process_runner_shutdown_should_cancel_registered_processes() {
        let directory = tempdir().expect("temporary directory must be available");
        let runner = Arc::new(NativeProcessRunner::new());
        let task_runner = Arc::clone(&runner);
        let process_request = request(directory.path(), SLEEP_SCRIPT, 1024);
        let process = tokio::spawn(async move {
            task_runner
                .run(process_request, CancellationToken::new())
                .await
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while runner.active_count() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fixture process must enter the registry");
        runner.shutdown().await;
        let error = process
            .await
            .expect("process supervisor task must join")
            .expect_err("shutdown must cancel the fixture process");

        assert_eq!(
            (error.kind(), runner.active_count()),
            (AppErrorKind::Cancelled, 0)
        );
    }

    #[tokio::test]
    async fn process_runner_should_reject_requests_after_shutdown_starts() {
        let directory = tempdir().expect("temporary directory must be available");
        let runner = NativeProcessRunner::new();
        runner.stop_accepting();

        let error = runner
            .run(
                request(directory.path(), "exit 0", 1024),
                CancellationToken::new(),
            )
            .await
            .expect_err("stopped runner must reject new work");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn spawned_process_should_interrupt_a_long_bash_command_and_run_the_next_command() {
        let Some(bash) = windows_git_bash() else {
            return;
        };
        let directory = tempdir().expect("temporary directory must be available");
        let runner = NativeProcessRunner::new();
        let long_process = runner
            .spawn(spawned_bash_request(
                &bash,
                directory.path(),
                "/usr/bin/sleep 120",
            ))
            .await
            .expect("long-running Bash fixture must start");

        let first_wait =
            tokio::time::timeout(Duration::from_millis(100), long_process.wait()).await;
        assert!(first_wait.is_err(), "the first wait window must expire");
        let interrupted = long_process
            .terminate()
            .await
            .expect("the Bash process tree interruption must be confirmed");
        let next_process = runner
            .spawn(spawned_bash_request(
                &bash,
                directory.path(),
                "printf recovered",
            ))
            .await
            .expect("the same runner must accept a subsequent Bash command");
        let next = next_process
            .wait()
            .await
            .expect("the subsequent Bash command must complete");

        assert_eq!(
            (interrupted.termination, next.exit_code, next.stdout),
            (
                SpawnedProcessTermination::Terminated,
                Some(0),
                b"recovered".to_vec(),
            )
        );
    }

    #[cfg(windows)]
    fn windows_git_bash() -> Option<PathBuf> {
        [
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files\Git\usr\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
        ]
        .into_iter()
        .find_map(|candidate| dunce::canonicalize(candidate).ok())
    }

    #[cfg(windows)]
    fn spawned_bash_request(
        executable: &Path,
        current_directory: &Path,
        command: &str,
    ) -> SpawnedProcessRequest {
        SpawnedProcessRequest {
            program: executable.to_path_buf(),
            arguments: ["-c", command].into_iter().map(OsString::from).collect(),
            current_directory: current_directory.to_path_buf(),
            environment: BTreeMap::new(),
            max_output_bytes: 64 * 1024,
            output: SpawnedProcessOutputTarget::Capture,
        }
    }

    #[cfg(windows)]
    fn windows_file_is_exclusively_locked(path: &Path) -> bool {
        use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};

        OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(path)
            .is_err_and(|source| matches!(source.raw_os_error(), Some(32 | 33)))
    }

    #[cfg(windows)]
    async fn wait_for_windows_file_unlock(path: &Path) -> bool {
        tokio::time::timeout(Duration::from_secs(2), async {
            while windows_file_is_exclusively_locked(path) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }
}
