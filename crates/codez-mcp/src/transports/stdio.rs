use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use rmcp::{
    RoleClient,
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::{Transport, async_rw::AsyncRwTransport},
};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{ChildStderr, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    task::JoinHandle,
    time::timeout,
};

use crate::{McpError, McpOperation};

const DEFAULT_MAX_STDOUT_LINE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_CAPTURE_BYTES: usize = 8 * 1024;

/// Platform-resolved process specification for an MCP stdio server.
///
/// The executable and working directory are required to be absolute. The child
/// receives only the supplied environment; the ambient host environment is not
/// inherited.
pub struct StdioServerConfig {
    executable: PathBuf,
    arguments: Vec<OsString>,
    environment: BTreeMap<OsString, OsString>,
    working_directory: Option<PathBuf>,
    max_stdout_line_bytes: usize,
    max_stderr_capture_bytes: usize,
    extra_redaction_values: Vec<String>,
}

impl std::fmt::Debug for StdioServerConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StdioServerConfig")
            .field("executable", &self.executable)
            .field("argument_count", &self.arguments.len())
            .field("environment_key_count", &self.environment.len())
            .field("working_directory", &self.working_directory)
            .field("max_stdout_line_bytes", &self.max_stdout_line_bytes)
            .field("max_stderr_capture_bytes", &self.max_stderr_capture_bytes)
            .finish_non_exhaustive()
    }
}

impl StdioServerConfig {
    /// Builds a direct-exec stdio process specification.
    ///
    /// # Errors
    ///
    /// Returns [`McpError`] if the platform boundary supplied relative paths.
    pub fn new(
        executable: PathBuf,
        arguments: Vec<OsString>,
        environment: BTreeMap<OsString, OsString>,
        working_directory: Option<PathBuf>,
    ) -> Result<Self, McpError> {
        if !executable.is_absolute() {
            return Err(McpError::RelativeExecutable { path: executable });
        }
        if let Some(path) = working_directory
            .as_ref()
            .filter(|path| !path.is_absolute())
        {
            return Err(McpError::RelativeWorkingDirectory { path: path.clone() });
        }
        Ok(Self {
            executable,
            arguments,
            environment,
            working_directory,
            max_stdout_line_bytes: DEFAULT_MAX_STDOUT_LINE_BYTES,
            max_stderr_capture_bytes: DEFAULT_MAX_STDERR_CAPTURE_BYTES,
            extra_redaction_values: Vec::new(),
        })
    }

    /// Overrides bounded stdout-line and stderr-capture limits.
    pub fn with_output_limits(
        mut self,
        max_stdout_line_bytes: usize,
        max_stderr_capture_bytes: usize,
    ) -> Result<Self, McpError> {
        if max_stdout_line_bytes == 0 {
            return Err(McpError::InvalidLimit {
                name: "max_stdout_line_bytes",
            });
        }
        if max_stderr_capture_bytes == 0 {
            return Err(McpError::InvalidLimit {
                name: "max_stderr_capture_bytes",
            });
        }
        self.max_stdout_line_bytes = max_stdout_line_bytes;
        self.max_stderr_capture_bytes = max_stderr_capture_bytes;
        Ok(self)
    }

    /// Adds secret values that must be removed from server-originated events.
    #[must_use]
    pub fn with_redaction_values(mut self, values: impl IntoIterator<Item = String>) -> Self {
        self.extra_redaction_values.extend(values);
        self
    }

    pub(crate) fn redaction_values(&self) -> Vec<String> {
        let mut values = self.extra_redaction_values.clone();
        values.extend(
            self.environment
                .iter()
                .filter(|(key, _)| is_sensitive_name(key))
                .map(|(_, value)| value.to_string_lossy().into_owned()),
        );
        values.extend(sensitive_argument_values(&self.arguments));
        values
    }
}

fn is_sensitive_name(value: &OsStr) -> bool {
    let normalized = value.to_string_lossy().to_ascii_lowercase();
    [
        "authorization",
        "password",
        "secret",
        "token",
        "api_key",
        "api-key",
        "apikey",
    ]
    .iter()
    .any(|candidate| normalized.contains(candidate))
}

fn sensitive_argument_values(arguments: &[OsString]) -> Vec<String> {
    let mut values = Vec::new();
    let mut previous_was_sensitive = false;
    for argument in arguments {
        let value = argument.to_string_lossy();
        if previous_was_sensitive {
            values.push(value.into_owned());
            previous_was_sensitive = false;
            continue;
        }
        let Some((name, inline_value)) = value.split_once('=') else {
            previous_was_sensitive = is_sensitive_name(OsStr::new(value.as_ref()));
            continue;
        };
        if is_sensitive_name(OsStr::new(name)) {
            values.push(inline_value.to_owned());
        }
    }
    values
}

#[derive(Debug, Error)]
pub(crate) enum StdioTransportError {
    #[error("stdio protocol I/O failed")]
    ProtocolIo(#[source] io::Error),
    #[error("stdio process cleanup failed")]
    Cleanup(#[source] io::Error),
}

struct BoundedLineReader<R> {
    inner: R,
    current_line_bytes: usize,
    max_line_bytes: usize,
    limit_exceeded: bool,
}

impl<R> BoundedLineReader<R> {
    fn new(inner: R, max_line_bytes: usize) -> Self {
        Self {
            inner,
            current_line_bytes: 0,
            max_line_bytes,
            limit_exceeded: false,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for BoundedLineReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.limit_exceeded {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "MCP stdout line exceeded the configured byte limit",
            )));
        }

        let previous_length = buffer.filled().len();
        match Pin::new(&mut self.inner).poll_read(context, buffer) {
            Poll::Ready(Ok(())) => {
                for byte in &buffer.filled()[previous_length..] {
                    if *byte == b'\n' {
                        self.current_line_bytes = 0;
                    } else {
                        self.current_line_bytes = self.current_line_bytes.saturating_add(1);
                        if self.current_line_bytes > self.max_line_bytes {
                            self.limit_exceeded = true;
                            return Poll::Ready(Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "MCP stdout line exceeded the configured byte limit",
                            )));
                        }
                    }
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

pub(crate) struct SupervisedStdioTransport {
    io: AsyncRwTransport<RoleClient, BoundedLineReader<ChildStdout>, ChildStdin>,
    process: Arc<ProcessSupervisor>,
    shutdown_timeout: Duration,
}

impl Transport<RoleClient> for SupervisedStdioTransport {
    type Error = StdioTransportError;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let send = self.io.send(item);
        async move { send.await.map_err(StdioTransportError::ProtocolIo) }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        self.io.receive().await
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.io
            .close()
            .await
            .map_err(StdioTransportError::ProtocolIo)?;
        self.process
            .shutdown(self.shutdown_timeout)
            .await
            .map_err(StdioTransportError::Cleanup)
    }
}

struct ProcessSupervisor {
    child: Mutex<Option<Box<dyn ChildWrapper>>>,
    process_id: Option<u32>,
}

impl ProcessSupervisor {
    async fn shutdown(&self, grace: Duration) -> io::Result<()> {
        let mut guard = self.child.lock().await;
        let Some(child) = guard.as_mut() else {
            return Ok(());
        };

        if timeout(grace, child.wait()).await.is_err() {
            Box::into_pin(child.kill()).await?;
            let _status = child.wait().await?;
        }
        *guard = None;
        Ok(())
    }

    async fn force_kill(&self) -> io::Result<()> {
        let mut guard = self.child.lock().await;
        let Some(child) = guard.as_mut() else {
            return Ok(());
        };
        if child.try_wait()?.is_some() {
            *guard = None;
            return Ok(());
        }
        Box::into_pin(child.kill()).await?;
        let _status = child.wait().await?;
        *guard = None;
        Ok(())
    }
}

/// Non-sensitive diagnostic summary for a drained stderr stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StderrSummary {
    pub total_bytes: u64,
    pub retained_bytes: usize,
    pub truncated: bool,
}

pub(crate) struct StdioResources {
    process: Arc<ProcessSupervisor>,
    stderr_task: Mutex<Option<JoinHandle<io::Result<StderrSummary>>>>,
}

impl StdioResources {
    pub(crate) fn process_id(&self) -> Option<u32> {
        self.process.process_id
    }

    pub(crate) async fn cleanup(
        &self,
        cleanup_timeout: Duration,
    ) -> Result<StderrSummary, McpError> {
        self.process.force_kill().await.map_err(McpError::Process)?;
        let Some(mut task) = self.stderr_task.lock().await.take() else {
            return Ok(StderrSummary {
                total_bytes: 0,
                retained_bytes: 0,
                truncated: false,
            });
        };
        match timeout(cleanup_timeout, &mut task).await {
            Ok(result) => result
                .map_err(|_| McpError::BackgroundTask)?
                .map_err(McpError::Stderr),
            Err(_) => {
                task.abort();
                let _aborted = task.await;
                Err(McpError::Timeout {
                    operation: McpOperation::Close,
                    timeout: cleanup_timeout,
                })
            }
        }
    }
}

pub(crate) fn spawn(
    config: StdioServerConfig,
    shutdown_timeout: Duration,
) -> Result<(SupervisedStdioTransport, StdioResources), McpError> {
    let mut command = Command::new(&config.executable);
    command
        .args(&config.arguments)
        .env_clear()
        .envs(&config.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(working_directory) = config.working_directory {
        command.current_dir(working_directory);
    }

    let mut command = CommandWrap::from(command);
    #[cfg(windows)]
    command.wrap(JobObject);
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
    command.wrap(KillOnDrop);

    let mut child = command.spawn().map_err(McpError::Spawn)?;
    let process_id = child.id();
    let stdin = child
        .inner_mut()
        .stdin()
        .take()
        .ok_or_else(|| McpError::Spawn(io::Error::other("MCP stdin was not piped")))?;
    let stdout = child
        .inner_mut()
        .stdout()
        .take()
        .ok_or_else(|| McpError::Spawn(io::Error::other("MCP stdout was not piped")))?;
    let stderr = child
        .inner_mut()
        .stderr()
        .take()
        .ok_or_else(|| McpError::Spawn(io::Error::other("MCP stderr was not piped")))?;
    let process = Arc::new(ProcessSupervisor {
        child: Mutex::new(Some(child)),
        process_id,
    });
    let stderr_task = tokio::spawn(drain_stderr(stderr, config.max_stderr_capture_bytes));
    let transport = SupervisedStdioTransport {
        io: AsyncRwTransport::new(
            BoundedLineReader::new(stdout, config.max_stdout_line_bytes),
            stdin,
        ),
        process: process.clone(),
        shutdown_timeout,
    };
    let resources = StdioResources {
        process,
        stderr_task: Mutex::new(Some(stderr_task)),
    };
    Ok((transport, resources))
}

async fn drain_stderr(
    mut stderr: ChildStderr,
    max_retained_bytes: usize,
) -> io::Result<StderrSummary> {
    let mut total_bytes = 0_u64;
    let mut retained_bytes = 0_usize;
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stderr.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(read as u64);
        retained_bytes = retained_bytes.saturating_add(read).min(max_retained_bytes);
    }
    Ok(StderrSummary {
        total_bytes,
        retained_bytes,
        truncated: total_bytes > max_retained_bytes as u64,
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

    use super::{StdioServerConfig, sensitive_argument_values};
    use crate::McpError;

    #[test]
    fn config_rejects_relative_executable_paths() {
        let error =
            StdioServerConfig::new(PathBuf::from("node"), Vec::new(), BTreeMap::new(), None)
                .expect_err("relative executables must be rejected");

        assert!(matches!(error, McpError::RelativeExecutable { .. }));
    }

    #[test]
    fn sensitive_argument_detection_supports_split_and_inline_values() {
        let arguments = [
            OsString::from("--token"),
            OsString::from("first-secret"),
            OsString::from("--api-key=second-secret"),
        ];

        let values = sensitive_argument_values(&arguments);

        assert_eq!(values, ["first-secret", "second-secret"]);
    }
}
