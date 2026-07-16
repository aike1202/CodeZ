#![forbid(unsafe_code)]

mod app_paths;
mod error;
mod host;
mod identifiers;
mod ports;
mod redaction;
mod system;
mod workspace;
mod workspace_path;

pub use app_paths::{AppPathError, AppPaths};
pub use error::{AppError, AppErrorKind};
pub use host::HostThemeSource;
pub use identifiers::{AgentRunId, IdentifierError, ProcessId, SessionId, StreamId, ToolCallId};
pub use ports::{
    Clock, DirectoryEntry, DirectoryListing, EventSink, FileKind, FileMetadata, FileSystem,
    IdGenerator, PortFuture, ProcessOutput, ProcessRequest, ProcessRunner, RecentProjectRepository,
};
pub use redaction::{RedactedText, redact_sensitive_text, redact_sensitive_value};
pub use system::SystemHealth;
pub use tokio_util::sync::CancellationToken;
pub use workspace::{RecentProject, RecentProjectError};
pub use workspace_path::{SafeWorkspacePath, WorkspacePathError, WorkspaceRoot};
