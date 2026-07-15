use std::sync::Arc;

use codez_runtime::{HostPreferences, ShutdownCoordinator, SystemService};

pub struct AppState {
    pub system: Arc<SystemService>,
    pub host_preferences: Arc<HostPreferences>,
    pub shutdown: Arc<ShutdownCoordinator>,
}

impl AppState {
    #[must_use]
    pub fn new() -> Self {
        Self {
            system: Arc::new(SystemService::new()),
            host_preferences: Arc::new(HostPreferences::new()),
            shutdown: Arc::new(ShutdownCoordinator::default()),
        }
    }
}
