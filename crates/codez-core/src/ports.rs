use std::{
    collections::BTreeMap,
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime},
};

use crate::{AppError, CancellationToken, RecentProject, SafeWorkspacePath, WorkspaceRoot};

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

/// One direct child returned from a bounded workspace directory read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEntry {
    pub name: OsString,
    pub path: SafeWorkspacePath,
    pub kind: FileKind,
    pub byte_length: u64,
}

/// Bounded directory result that reports whether additional entries were omitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryListing {
    pub entries: Vec<DirectoryEntry>,
    pub truncated: bool,
}

/// Bounded filesystem operations supplied by storage or platform adapters.
pub trait FileSystem: Send + Sync {
    fn workspace_root(&self) -> &WorkspaceRoot;

    fn resolve<'a>(&'a self, requested: &'a Path) -> PortFuture<'a, SafeWorkspacePath>;

    fn metadata<'a>(&'a self, path: &'a SafeWorkspacePath) -> PortFuture<'a, FileMetadata>;

    fn read_directory<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_entries: usize,
    ) -> PortFuture<'a, DirectoryListing>;

    fn read_bounded<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        max_bytes: u64,
    ) -> PortFuture<'a, Vec<u8>>;

    fn write_atomic<'a>(
        &'a self,
        path: &'a SafeWorkspacePath,
        bytes: &'a [u8],
    ) -> PortFuture<'a, ()>;
}

/// Durable recent-project repository implemented by the storage adapter.
pub trait RecentProjectRepository: Send + Sync {
    fn list(&self) -> PortFuture<'_, Vec<RecentProject>>;

    fn upsert(&self, project: RecentProject) -> PortFuture<'_, ()>;

    fn remove<'a>(&'a self, id: &'a str) -> PortFuture<'a, ()>;

    fn rename<'a>(&'a self, id: &'a str, new_name: &'a str) -> PortFuture<'a, ()>;
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

/// Output routing for a supervised process that may outlive one wait window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnedProcessOutputTarget {
    /// Captures stdout and stderr in memory under one combined byte limit.
    Capture,
    /// Streams stdout and stderr directly to distinct, caller-owned files.
    Files {
        stdout_path: PathBuf,
        stderr_path: PathBuf,
    },
}

/// Explicit request for a process whose lifetime is controlled through a handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnedProcessRequest {
    pub program: PathBuf,
    pub arguments: Vec<OsString>,
    pub current_directory: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
    pub max_output_bytes: u64,
    pub output: SpawnedProcessOutputTarget,
}

impl SpawnedProcessRequest {
    /// Rejects requests that depend on ambient process state or invalid output paths.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when an executable, working directory, or output path
    /// is relative, when file targets alias each other, or when the capture limit is zero.
    pub fn validate(&self) -> Result<(), AppError> {
        if !self.program.is_absolute() {
            return Err(AppError::validation(
                "Spawned process program path must be absolute",
            ));
        }
        if !self.current_directory.is_absolute() {
            return Err(AppError::validation(
                "Spawned process working directory must be absolute",
            ));
        }
        if self.max_output_bytes == 0 {
            return Err(AppError::validation(
                "Spawned process output limit must be positive",
            ));
        }
        if let SpawnedProcessOutputTarget::Files {
            stdout_path,
            stderr_path,
        } = &self.output
        {
            if !stdout_path.is_absolute() || !stderr_path.is_absolute() {
                return Err(AppError::validation(
                    "Spawned process output paths must be absolute",
                ));
            }
            if stdout_path == stderr_path {
                return Err(AppError::validation(
                    "Spawned process output paths must be distinct",
                ));
            }
        }
        Ok(())
    }
}

/// Reason a supervised process reached its terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnedProcessTermination {
    Exited,
    Terminated,
}

/// Terminal result retained by a long-lived process handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnedProcessOutput {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output_truncated: bool,
    pub elapsed: Duration,
    pub termination: SpawnedProcessTermination,
}

/// One owned process tree that supports repeatable waits and confirmed termination.
pub trait SpawnedProcess: Send + Sync {
    /// Returns the top-level process identifier when the platform supplied one.
    fn pid(&self) -> Option<u32>;

    /// Waits for and returns the retained terminal result.
    fn wait(&self) -> PortFuture<'_, SpawnedProcessOutput>;

    /// Terminates the owned process tree and waits for confirmed completion.
    fn terminate(&self) -> PortFuture<'_, SpawnedProcessOutput>;
}

/// Starts process trees whose handles remain valid across multiple wait windows.
pub trait SpawnedProcessRunner: Send + Sync {
    fn spawn(&self, request: SpawnedProcessRequest) -> PortFuture<'_, Arc<dyn SpawnedProcess>>;
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
