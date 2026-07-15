#![forbid(unsafe_code)]

//! Filesystem, process, PTY, Git, search, notification, and resource adapters.

mod filesystem;
mod resources;
mod system;

pub use filesystem::{NativeFileSystem, NativeFileSystemError};
pub use resources::{RequiredResources, ResourceError, ResourceLocator};
pub use system::{SystemClock, UuidGenerator};
