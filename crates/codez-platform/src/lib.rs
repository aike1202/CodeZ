#![forbid(unsafe_code)]

//! Filesystem, process, PTY, Git, search, notification, and resource adapters.

mod executable;
mod filesystem;
pub mod process;
pub mod pty;
mod resources;
mod system;

pub use executable::{
    BashDiscoveryError, BashInstallation, GitDiscoveryError, GitInstallation,
    PowerShellDiscoveryError, PowerShellInstallation,
};
pub use filesystem::{NativeFileSystem, NativeFileSystemError};
pub use process::NativeProcessRunner;
pub use pty::{PtyEvent, PtyManager};
pub use resources::{RequiredResources, ResourceError, ResourceLocator};
pub use system::{SystemClock, UuidGenerator};
