#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemHealth {
    pub backend_version: String,
    pub uptime_ms: u64,
}
