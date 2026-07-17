#![forbid(unsafe_code)]

pub mod attachment;
pub mod cancellation;
pub mod context;
pub mod edit_transaction;
pub mod fingerprint;
pub mod git;
pub mod history_revert;
pub mod host;
pub mod mutation_coordinator;
mod observability;
mod project_analysis;
mod search;
pub mod session_deletion;
pub mod session_maintenance;
mod system;
pub mod task;
pub mod tools;
pub mod workspace;

pub use cancellation::{
    AgentCancellation, CancellationTree, ProcessCancellation, SessionCancellation, ToolCancellation,
};
pub use host::{
    HostPreferences, ShutdownCoordinator, ShutdownFailure, ShutdownFuture, ShutdownHook,
    ShutdownPhase, ShutdownPolicy, ShutdownReport, ShutdownState,
};
pub use observability::{session_span, stream_span, tool_span};
pub use project_analysis::{ProjectAnalysisService, ProjectSnapshot, SnapshotOptions};
pub use search::{GlobResult, GrepOptions, GrepOutputMode, GrepResult, SearchService};
pub use system::SystemService;
pub use workspace::{
    FilePreview, FileTreeNode, ProjectInfo, WorkspaceEntryKind, WorkspaceLimits, WorkspacePathItem,
    WorkspaceService,
};
pub mod agent;
pub mod chat;
pub mod extension;
pub mod permission;
