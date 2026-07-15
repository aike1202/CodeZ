use std::{
    collections::BTreeMap,
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    time::{Duration, SystemTime},
};

use crate::{AppError, CancellationToken};

/// Boxed asynchronous port result used at dynamic adapter boundaries.
pub type PortFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, AppError>> + Send + 'a>>;

/// Filesystem object kind returned without following a symbolic link implicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    File,
    Directory,
    SymbolicLink,
    Other,
}

/// Minimal metadata needed by application services before filesystem access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileMetadata {
    pub kind: FileKind,
    pub byte_length: u64,
}

/// Bounded filesystem operations supplied by storage or platform adapters.
pub trait FileSystem: Send + Sync {
    fn metadata<'a>(&'a self, path: &'a Path) -> PortFuture<'a, FileMetadata>;

    fn read_bounded<'a>(&'a self, path: &'a Path, max_bytes: u64) -> PortFuture<'a, Vec<u8>>;

    fn write_atomic<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()>;
}

/// Fully explicit request passed to a process adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRequest {
    /// Absolute executable path; adapters must not resolve it through ambient `PATH`.
    pub program: PathBuf,
    /// Ordered child-process arguments excluding the executable.
    pub arguments: Vec<OsString>,
    /// Absolute working directory validated by the caller's workspace policy.
    pub current_directory: PathBuf,
    /// Complete explicit child environment; adapters must clear ambient variables first.
    pub environment: BTreeMap<OsString, OsString>,
    /// Monotonic execution deadline enforced independently of cancellation.
    pub timeout: Duration,
    /// Combined memory bound applied to captured stdout and stderr.
    pub max_output_bytes: u64,
}

impl ProcessRequest {
    /// Rejects requests that would depend on ambient process state or have no bound.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the program or working directory is
    /// relative, or timeout/output bounds are zero.
    pub fn validate(&self) -> Result<(), AppError> {
        if !self.program.is_absolute() {
            return Err(AppError::validation(
                "Process program path must be absolute",
            ));
        }
        if !self.current_directory.is_absolute() {
            return Err(AppError::validation(
                "Process working directory must be absolute",
            ));
        }
        if self.timeout.is_zero() {
            return Err(AppError::validation("Process timeout must be positive"));
        }
        if self.max_output_bytes == 0 {
            return Err(AppError::validation(
                "Process output limit must be positive",
            ));
        }
        Ok(())
    }
}

/// Bounded output collected from a child process after successful supervision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output_truncated: bool,
    pub elapsed: Duration,
}

/// Process execution supplied by the platform layer.
///
/// Implementations clear the ambient environment, enforce request bounds, map
/// cancellation/timeout/non-zero exit to distinct [`crate::AppErrorKind`] values,
/// and terminate the owned process tree before resolving the future.
pub trait ProcessRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        cancellation: CancellationToken,
    ) -> PortFuture<'a, ProcessOutput>;
}

/// Domain event publisher implemented by the active host adapter.
pub trait EventSink<E>: Send + Sync {
    /// Publishes one owned event without exposing host-specific handles.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the host no longer accepts the event.
    fn publish(&self, event: E) -> Result<(), AppError>;
}

/// Wall-clock source replaceable by deterministic tests.
///
/// This port is for persisted timestamps; timeout logic uses a monotonic runtime clock.
pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}

/// Opaque identifier source; callers validate the result into a domain newtype.
pub trait IdGenerator: Send + Sync {
    fn next_id(&self) -> String;
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::PathBuf, time::Duration};

    use super::ProcessRequest;
    use crate::AppErrorKind;

    #[test]
    fn process_requests_reject_ambient_or_unbounded_execution() {
        let mut request = ProcessRequest {
            program: PathBuf::from("git"),
            arguments: Vec::new(),
            current_directory: PathBuf::from("relative"),
            environment: BTreeMap::new(),
            timeout: Duration::from_secs(1),
            max_output_bytes: 1024,
        };

        assert_eq!(
            request
                .validate()
                .expect_err("ambient executable lookup must be rejected")
                .kind(),
            AppErrorKind::Validation
        );

        let current_directory =
            std::env::current_dir().expect("test process must have an absolute current directory");
        request.program = current_directory.join("git.exe");
        assert_eq!(
            request
                .validate()
                .expect_err("relative working directories must be rejected")
                .kind(),
            AppErrorKind::Validation
        );

        request.current_directory = current_directory;
        request.timeout = Duration::ZERO;
        assert_eq!(
            request
                .validate()
                .expect_err("unbounded process requests must be rejected")
                .kind(),
            AppErrorKind::Validation
        );
    }
}
