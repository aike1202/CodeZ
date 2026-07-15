use std::sync::Arc;

use codez_core::AppPaths;
use codez_platform::ResourceLocator;
use codez_runtime::{HostPreferences, ShutdownCoordinator, SystemService};
use codez_storage::{AtomicFileStore, OsCredentialStore};

use crate::{error::ErrorReporter, logging::LoggingGuard};

pub(crate) struct AppState {
    pub(crate) system: Arc<SystemService>,
    pub(crate) host_preferences: Arc<HostPreferences>,
    pub(crate) resources: Arc<ResourceLocator>,
    pub(crate) storage: Arc<AtomicFileStore>,
    pub(crate) credentials: Arc<OsCredentialStore>,
    pub(crate) shutdown: Arc<ShutdownCoordinator>,
    pub(crate) errors: Arc<ErrorReporter>,
    pub(crate) _logging: LoggingGuard,
    pub(crate) paths: Arc<AppPaths>,
}
