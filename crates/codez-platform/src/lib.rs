#![forbid(unsafe_code)]

//! Filesystem, process, PTY, Git, search, notification, and resource adapters.

mod resources;

pub use resources::{RequiredResources, ResourceError, ResourceLocator};
