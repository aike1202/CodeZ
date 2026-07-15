#![forbid(unsafe_code)]

//! Filesystem, process, PTY, Git, search, notification, and resource adapters.

mod resources;
mod system;

pub use resources::{RequiredResources, ResourceError, ResourceLocator};
pub use system::{SystemClock, UuidGenerator};
