use std::sync::Arc;

use codez_platform::ResourceLocator;
use codez_runtime::{HostPreferences, ShutdownCoordinator, SystemService};

pub struct AppState {
    pub system: Arc<SystemService>,
    pub host_preferences: Arc<HostPreferences>,
    pub resources: Arc<ResourceLocator>,
    pub shutdown: Arc<ShutdownCoordinator>,
}

impl AppState {
    #[must_use]
    pub fn new(resource_directory: std::path::PathBuf) -> Self {
        Self {
            system: Arc::new(SystemService::new()),
            host_preferences: Arc::new(HostPreferences::new()),
            resources: Arc::new(ResourceLocator::new(resource_directory)),
            shutdown: Arc::new(ShutdownCoordinator::default()),
        }
    }
}
