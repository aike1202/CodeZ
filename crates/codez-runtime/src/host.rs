use std::sync::{
    RwLock,
    atomic::{AtomicBool, Ordering},
};

use codez_core::HostThemeSource;

#[derive(Debug)]
pub struct HostPreferences {
    theme_source: RwLock<HostThemeSource>,
}

impl Default for HostPreferences {
    fn default() -> Self {
        Self::new()
    }
}

impl HostPreferences {
    #[must_use]
    pub fn new() -> Self {
        Self {
            theme_source: RwLock::new(HostThemeSource::System),
        }
    }

    #[must_use]
    pub fn theme_source(&self) -> HostThemeSource {
        *self
            .theme_source
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn set_theme_source(&self, source: HostThemeSource) {
        *self
            .theme_source
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = source;
    }
}

#[derive(Debug, Default)]
pub struct ShutdownCoordinator {
    shutting_down: AtomicBool,
}

impl ShutdownCoordinator {
    #[must_use]
    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::AcqRel)
    }

    #[must_use]
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use codez_core::HostThemeSource;

    use super::{HostPreferences, ShutdownCoordinator};

    #[test]
    fn host_preferences_default_to_the_system_theme() {
        assert_eq!(
            HostPreferences::new().theme_source(),
            HostThemeSource::System
        );
    }

    #[test]
    fn shutdown_only_starts_once() {
        let shutdown = ShutdownCoordinator::default();

        assert!(shutdown.begin_shutdown());
        assert!(!shutdown.begin_shutdown());
        assert!(shutdown.is_shutting_down());
    }
}
