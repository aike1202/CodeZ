use std::sync::Arc;

use codez_platform::ResourceLocator;
use codez_runtime::{HostPreferences, ShutdownCoordinator, SystemService};

use crate::error::ErrorReporter;

pub(crate) struct AppState {
    pub(crate) system: Arc<SystemService>,
    pub(crate) host_preferences: Arc<HostPreferences>,
    pub(crate) resources: Arc<ResourceLocator>,
    pub(crate) shutdown: Arc<ShutdownCoordinator>,
    pub(crate) errors: Arc<ErrorReporter>,
}

impl AppState {
    #[must_use]
    pub(crate) fn new(resource_directory: std::path::PathBuf) -> Self {
        Self {
            system: Arc::new(SystemService::new()),
            host_preferences: Arc::new(HostPreferences::new()),
            resources: Arc::new(ResourceLocator::new(resource_directory)),
            shutdown: Arc::new(ShutdownCoordinator::default()),
            errors: Arc::new(ErrorReporter::default()),
        }
    }
}
