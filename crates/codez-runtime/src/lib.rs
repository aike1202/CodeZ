#![forbid(unsafe_code)]

mod host;
mod observability;
mod system;

pub use host::{
    HostPreferences, ShutdownCoordinator, ShutdownFailure, ShutdownFuture, ShutdownHook,
    ShutdownPhase, ShutdownPolicy, ShutdownReport, ShutdownState,
};
pub use observability::{session_span, stream_span, tool_span};
pub use system::SystemService;
