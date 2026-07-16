#![forbid(unsafe_code)]

mod cancellation;
mod host;
mod observability;
mod project_analysis;
mod search;
mod system;
mod workspace;

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
