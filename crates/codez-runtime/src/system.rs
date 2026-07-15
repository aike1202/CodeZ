use std::time::Instant;

use codez_core::SystemHealth;

#[derive(Debug)]
pub struct SystemService {
    started_at: Instant,
}

impl Default for SystemService {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemService {
    #[must_use]
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }

    #[must_use]
    pub fn health(&self) -> SystemHealth {
        let elapsed = self.started_at.elapsed().as_millis();
        let uptime_ms = u64::try_from(elapsed).unwrap_or(u64::MAX);

        SystemHealth {
            backend_version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SystemService;

    #[test]
    fn health_reports_the_runtime_version() {
        let health = SystemService::new().health();

        assert_eq!(health.backend_version, env!("CARGO_PKG_VERSION"));
    }
}
