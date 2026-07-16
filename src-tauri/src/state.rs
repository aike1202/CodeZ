use std::sync::Arc;

use codez_core::AppPaths;
use codez_platform::ResourceLocator;
use codez_runtime::{CancellationTree, HostPreferences, ShutdownCoordinator, SystemService};
use codez_storage::{AtomicFileStore, OsCredentialStore, RecentProjectsStore};

use crate::{error::ErrorReporter, logging::LoggingGuard};

pub(crate) struct AppState {
    pub(crate) system: Arc<SystemService>,
    pub(crate) host_preferences: Arc<HostPreferences>,
    pub(crate) resources: Arc<ResourceLocator>,
    pub(crate) storage: Arc<AtomicFileStore>,
    pub(crate) recent_projects: Arc<RecentProjectsStore>,
    pub(crate) credentials: Arc<OsCredentialStore>,
    pub(crate) cancellation: Arc<CancellationTree>,
    pub(crate) shutdown: Arc<ShutdownCoordinator>,
    pub(crate) errors: Arc<ErrorReporter>,
    pub(crate) _logging: LoggingGuard,
    pub(crate) paths: Arc<AppPaths>,
}
