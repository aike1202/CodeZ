#![forbid(unsafe_code)]

pub mod attachment;
pub mod cancellation;
pub mod edit_transaction;
pub mod fingerprint;
pub mod mutation_coordinator;
pub mod tools;
pub mod git;
pub mod host;
mod observability;
mod project_analysis;
mod search;
mod system;
pub mod workspace;
pub mod context;

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
pub mod chat;
pub mod permission;
pub mod agent;
pub mod extension;
