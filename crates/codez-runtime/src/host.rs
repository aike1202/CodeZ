use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use codez_core::{AppError, HostThemeSource};
use tokio::time::timeout;

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

const LIFECYCLE_RUNNING: u8 = 0;
const LIFECYCLE_CLAIMED: u8 = 1;
const LIFECYCLE_EXECUTING: u8 = 2;
const LIFECYCLE_COMPLETE: u8 = 3;

/// Observable lifecycle of application shutdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownState {
    /// The application can still accept work and register cleanup hooks.
    Running,
    /// One owner has claimed shutdown and cleanup is pending or executing.
    ShuttingDown,
    /// Every phase has completed or reached its deadline.
    Complete,
}

/// Ordered phases applied to every registered shutdown hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownPhase {
    /// Rejects new work and detaches host-level integrations.
    StopAccepting,
    /// Requests cooperative cancellation from active work.
    Cancel,
    /// Terminates resources that did not stop cooperatively.
    ForceCleanup,
    /// Flushes durable state and diagnostics.
    Flush,
}

/// Deadline allotted to each shutdown phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShutdownPolicy {
    /// Deadline for rejecting new work and detaching host integrations.
    pub stop_accepting_timeout: Duration,
    /// Deadline for cooperative task cancellation.
    pub cancel_timeout: Duration,
    /// Deadline for terminating work that did not cancel cooperatively.
    pub force_cleanup_timeout: Duration,
    /// Deadline for flushing durable state and diagnostics.
    pub flush_timeout: Duration,
}

impl Default for ShutdownPolicy {
    fn default() -> Self {
        Self {
            stop_accepting_timeout: Duration::from_millis(250),
            cancel_timeout: Duration::from_secs(3),
            force_cleanup_timeout: Duration::from_secs(2),
            flush_timeout: Duration::from_secs(1),
        }
    }
}

impl ShutdownPolicy {
    /// Returns the maximum time spent awaiting all phases.
    #[must_use]
    pub fn maximum_duration(self) -> Duration {
        self.stop_accepting_timeout
            .saturating_add(self.cancel_timeout)
            .saturating_add(self.force_cleanup_timeout)
            .saturating_add(self.flush_timeout)
    }

    const fn timeout_for(self, phase: ShutdownPhase) -> Duration {
        match phase {
            ShutdownPhase::StopAccepting => self.stop_accepting_timeout,
            ShutdownPhase::Cancel => self.cancel_timeout,
            ShutdownPhase::ForceCleanup => self.force_cleanup_timeout,
            ShutdownPhase::Flush => self.flush_timeout,
        }
    }
}

/// Boxed hook future; dynamic dispatch is confined to the service registration boundary.
pub type ShutdownFuture<'a> = Pin<Box<dyn Future<Output = Result<(), AppError>> + Send + 'a>>;

/// Service-owned cleanup invoked once for each ordered shutdown phase.
pub trait ShutdownHook: Send + Sync {
    /// Returns the stable service name used in shutdown diagnostics.
    fn name(&self) -> &'static str;

    /// Performs the cleanup owned by this service for one shutdown phase.
    fn run(&self, phase: ShutdownPhase) -> ShutdownFuture<'_>;
}

/// One hook failure captured without preventing remaining cleanup.
#[derive(Debug)]
pub struct ShutdownFailure {
    /// Stable name of the hook that failed.
    pub hook: &'static str,
    /// Phase during which the failure occurred.
    pub phase: ShutdownPhase,
    /// Structured service failure, retained for redacted host reporting.
    pub error: AppError,
}

/// Bounded shutdown outcome used for diagnostics and host exit decisions.
#[derive(Debug, Default)]
pub struct ShutdownReport {
    /// Whether this call owned and executed shutdown.
    pub started: bool,
    /// Phases that finished before their deadlines.
    pub completed_phases: Vec<ShutdownPhase>,
    /// Phases cancelled after exceeding their deadlines.
    pub timed_out_phases: Vec<ShutdownPhase>,
    /// Hook failures isolated while other cleanup continued.
    pub failures: Vec<ShutdownFailure>,
}

/// Owns the single bounded shutdown sequence for all registered services.
pub struct ShutdownCoordinator {
    lifecycle: AtomicU8,
    hooks: RwLock<Vec<Arc<dyn ShutdownHook>>>,
    policy: ShutdownPolicy,
}

impl std::fmt::Debug for ShutdownCoordinator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ShutdownCoordinator")
            .field("state", &self.state())
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self::new(ShutdownPolicy::default())
    }
}

impl ShutdownCoordinator {
    /// Creates a coordinator with bounded per-phase deadlines.
    #[must_use]
    pub fn new(policy: ShutdownPolicy) -> Self {
        Self {
            lifecycle: AtomicU8::new(LIFECYCLE_RUNNING),
            hooks: RwLock::new(Vec::new()),
            policy,
        }
    }

    /// Registers a service hook before shutdown begins.
    ///
    /// # Errors
    ///
    /// Returns an [`AppError`] with [`codez_core::AppErrorKind::Conflict`] after
    /// shutdown has been claimed.
    pub fn register(&self, hook: Arc<dyn ShutdownHook>) -> Result<(), AppError> {
        if self.state() != ShutdownState::Running {
            return Err(AppError::conflict(
                "Shutdown hooks cannot be registered after shutdown begins",
            ));
        }
        let mut hooks = self
            .hooks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.state() != ShutdownState::Running {
            return Err(AppError::conflict(
                "Shutdown hooks cannot be registered after shutdown begins",
            ));
        }
        hooks.push(hook);
        Ok(())
    }

    /// Claims shutdown ownership for one event-loop callback.
    #[must_use]
    pub fn begin_shutdown(&self) -> bool {
        let _hooks = self
            .hooks
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.lifecycle
            .compare_exchange(
                LIFECYCLE_RUNNING,
                LIFECYCLE_CLAIMED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    /// Runs all registered hooks in bounded phase order after a successful claim.
    pub async fn execute(&self) -> ShutdownReport {
        if self
            .lifecycle
            .compare_exchange(
                LIFECYCLE_CLAIMED,
                LIFECYCLE_EXECUTING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return ShutdownReport::default();
        }

        let hooks = self
            .hooks
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut report = ShutdownReport {
            started: true,
            ..ShutdownReport::default()
        };

        for phase in [
            ShutdownPhase::StopAccepting,
            ShutdownPhase::Cancel,
            ShutdownPhase::ForceCleanup,
            ShutdownPhase::Flush,
        ] {
            let phase_result = timeout(
                self.policy.timeout_for(phase),
                run_phase(&hooks, phase, &mut report.failures),
            )
            .await;
            if phase_result.is_ok() {
                report.completed_phases.push(phase);
            } else {
                report.timed_out_phases.push(phase);
            }
        }

        self.lifecycle.store(LIFECYCLE_COMPLETE, Ordering::Release);
        report
    }

    /// Returns the current observable shutdown state.
    #[must_use]
    pub fn state(&self) -> ShutdownState {
        match self.lifecycle.load(Ordering::Acquire) {
            LIFECYCLE_RUNNING => ShutdownState::Running,
            LIFECYCLE_CLAIMED | LIFECYCLE_EXECUTING => ShutdownState::ShuttingDown,
            LIFECYCLE_COMPLETE => ShutdownState::Complete,
            _ => ShutdownState::Complete,
        }
    }

    /// Reports whether shutdown is currently executing.
    #[must_use]
    pub fn is_shutting_down(&self) -> bool {
        self.state() == ShutdownState::ShuttingDown
    }

    /// Reports whether every bounded shutdown phase has finished or timed out.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.state() == ShutdownState::Complete
    }
}

async fn run_phase(
    hooks: &[Arc<dyn ShutdownHook>],
    phase: ShutdownPhase,
    failures: &mut Vec<ShutdownFailure>,
) {
    for hook in hooks {
        if let Err(error) = hook.run(phase).await {
            failures.push(ShutdownFailure {
                hook: hook.name(),
                phase,
                error,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use codez_core::AppError;
    use codez_core::HostThemeSource;

    use super::{
        HostPreferences, ShutdownCoordinator, ShutdownFuture, ShutdownHook, ShutdownPhase,
        ShutdownPolicy, ShutdownState,
    };

    struct RecordingHook {
        events: Arc<Mutex<Vec<ShutdownPhase>>>,
        delayed_phase: Option<ShutdownPhase>,
        failing_phase: Option<ShutdownPhase>,
    }

    impl ShutdownHook for RecordingHook {
        fn name(&self) -> &'static str {
            "recording"
        }

        fn run(&self, phase: ShutdownPhase) -> ShutdownFuture<'_> {
            Box::pin(async move {
                if self.delayed_phase == Some(phase) {
                    std::future::pending::<()>().await;
                }
                self.events
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(phase);
                if self.failing_phase == Some(phase) {
                    return Err(AppError::internal("fixture hook failure"));
                }
                Ok(())
            })
        }
    }

    fn test_policy() -> ShutdownPolicy {
        ShutdownPolicy {
            stop_accepting_timeout: Duration::from_millis(20),
            cancel_timeout: Duration::from_millis(20),
            force_cleanup_timeout: Duration::from_millis(20),
            flush_timeout: Duration::from_millis(20),
        }
    }

    #[test]
    fn host_preferences_default_to_the_system_theme() {
        assert_eq!(
            HostPreferences::new().theme_source(),
            HostThemeSource::System
        );
    }

    #[test]
    fn shutdown_only_starts_once() {
        let shutdown = ShutdownCoordinator::new(test_policy());

        assert!(shutdown.begin_shutdown());
        assert!(!shutdown.begin_shutdown());
        assert!(shutdown.is_shutting_down());
    }

    #[tokio::test]
    async fn shutdown_runs_hooks_in_required_phase_order() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let shutdown = ShutdownCoordinator::new(test_policy());
        shutdown
            .register(Arc::new(RecordingHook {
                events: Arc::clone(&events),
                delayed_phase: None,
                failing_phase: None,
            }))
            .expect("fixture registration must succeed");
        assert!(shutdown.begin_shutdown());

        let report = shutdown.execute().await;

        assert_eq!(
            (
                events
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone(),
                report.completed_phases,
                shutdown.state(),
            ),
            (
                vec![
                    ShutdownPhase::StopAccepting,
                    ShutdownPhase::Cancel,
                    ShutdownPhase::ForceCleanup,
                    ShutdownPhase::Flush,
                ],
                vec![
                    ShutdownPhase::StopAccepting,
                    ShutdownPhase::Cancel,
                    ShutdownPhase::ForceCleanup,
                    ShutdownPhase::Flush,
                ],
                ShutdownState::Complete,
            )
        );
    }

    #[tokio::test]
    async fn shutdown_continues_after_a_phase_timeout() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let shutdown = ShutdownCoordinator::new(test_policy());
        shutdown
            .register(Arc::new(RecordingHook {
                events: Arc::clone(&events),
                delayed_phase: Some(ShutdownPhase::Cancel),
                failing_phase: None,
            }))
            .expect("fixture registration must succeed");
        assert!(shutdown.begin_shutdown());

        let report = shutdown.execute().await;

        assert_eq!(
            (
                report.timed_out_phases,
                events
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone(),
            ),
            (
                vec![ShutdownPhase::Cancel],
                vec![
                    ShutdownPhase::StopAccepting,
                    ShutdownPhase::ForceCleanup,
                    ShutdownPhase::Flush,
                ],
            )
        );
    }

    #[tokio::test]
    async fn shutdown_isolates_hook_failures() {
        let first_events = Arc::new(Mutex::new(Vec::new()));
        let second_events = Arc::new(Mutex::new(Vec::new()));
        let shutdown = ShutdownCoordinator::new(test_policy());
        shutdown
            .register(Arc::new(RecordingHook {
                events: first_events,
                delayed_phase: None,
                failing_phase: Some(ShutdownPhase::Cancel),
            }))
            .expect("fixture registration must succeed");
        shutdown
            .register(Arc::new(RecordingHook {
                events: Arc::clone(&second_events),
                delayed_phase: None,
                failing_phase: None,
            }))
            .expect("fixture registration must succeed");
        assert!(shutdown.begin_shutdown());

        let report = shutdown.execute().await;

        assert_eq!(
            (
                report.failures.len(),
                second_events.lock().map_or(0, |events| events.len())
            ),
            (1, 4)
        );
    }
}
