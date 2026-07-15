#![forbid(unsafe_code)]

mod cancellation;
mod host;
mod observability;
mod system;

pub use cancellation::{
    AgentCancellation, CancellationTree, ProcessCancellation, SessionCancellation, ToolCancellation,
};
pub use host::{
    HostPreferences, ShutdownCoordinator, ShutdownFailure, ShutdownFuture, ShutdownHook,
    ShutdownPhase, ShutdownPolicy, ShutdownReport, ShutdownState,
};
pub use observability::{session_span, stream_span, tool_span};
pub use system::SystemService;
