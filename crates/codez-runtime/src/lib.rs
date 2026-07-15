#![forbid(unsafe_code)]

mod host;
mod system;

pub use host::{HostPreferences, ShutdownCoordinator};
pub use system::SystemService;
