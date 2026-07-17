//! Coordinates ordinary session activity with exclusive maintenance operations.

use std::{
    collections::{HashMap, hash_map::Entry},
    sync::{Arc, Mutex, MutexGuard},
};

use codez_core::{AppError, SessionId};
use thiserror::Error;

/// Failure to acquire a session activity or maintenance lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SessionMaintenanceError {
    /// Exclusive activity or maintenance currently owns the session.
    #[error("session activity is blocked by exclusive work or maintenance")]
    ActivityBlocked,
    /// Activity or another maintenance operation currently owns the session.
    #[error("session maintenance is blocked by active work or maintenance")]
    MaintenanceBlocked,
    /// The activity counter cannot represent another concurrent lease.
    #[error("session activity capacity is exhausted")]
    ActivityCapacityExceeded,
    /// An interrupted maintenance operation must be recovered before new work begins.
    #[error("session recovery is required before new activity or maintenance can begin")]
    RecoveryRequired,
}

impl From<SessionMaintenanceError> for AppError {
    fn from(error: SessionMaintenanceError) -> Self {
        match error {
            error @ (SessionMaintenanceError::ActivityBlocked
            | SessionMaintenanceError::MaintenanceBlocked
            | SessionMaintenanceError::RecoveryRequired) => AppError::run_active(error.to_string()),
            SessionMaintenanceError::ActivityCapacityExceeded => {
                AppError::internal(SessionMaintenanceError::ActivityCapacityExceeded.to_string())
            }
        }
    }
}

#[derive(Debug, Default)]
struct SessionState {
    active_activities: usize,
    exclusive_activity_active: bool,
    maintenance_active: bool,
    recovery_required: bool,
}

impl SessionState {
    fn is_empty(&self) -> bool {
        self.active_activities == 0
            && !self.exclusive_activity_active
            && !self.maintenance_active
            && !self.recovery_required
    }
}

#[derive(Debug, Default)]
struct CoordinatorInner {
    sessions: Mutex<HashMap<SessionId, SessionState>>,
}

impl CoordinatorInner {
    fn sessions(&self) -> MutexGuard<'_, HashMap<SessionId, SessionState>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn release_activity(&self, session_id: &SessionId) {
        let mut sessions = self.sessions();
        let should_remove = sessions.get_mut(session_id).is_some_and(|state| {
            state.active_activities = state.active_activities.saturating_sub(1);
            state.is_empty()
        });
        if should_remove {
            sessions.remove(session_id);
        }
    }

    fn release_exclusive_activity(&self, session_id: &SessionId) {
        let mut sessions = self.sessions();
        let should_remove = sessions.get_mut(session_id).is_some_and(|state| {
            state.exclusive_activity_active = false;
            state.is_empty()
        });
        if should_remove {
            sessions.remove(session_id);
        }
    }

    fn release_maintenance(&self, session_id: &SessionId) {
        let mut sessions = self.sessions();
        let should_remove = sessions.get_mut(session_id).is_some_and(|state| {
            state.maintenance_active = false;
            state.is_empty()
        });
        if should_remove {
            sessions.remove(session_id);
        }
    }

    fn try_begin_maintenance(
        self: &Arc<Self>,
        session_id: SessionId,
        allow_recovery: bool,
    ) -> Result<SessionMaintenanceLease, SessionMaintenanceError> {
        let mut sessions = self.sessions();
        match sessions.entry(session_id.clone()) {
            Entry::Occupied(mut entry) => {
                let state = entry.get_mut();
                if state.recovery_required && !allow_recovery {
                    return Err(SessionMaintenanceError::RecoveryRequired);
                }
                if state.active_activities != 0
                    || state.exclusive_activity_active
                    || state.maintenance_active
                {
                    return Err(SessionMaintenanceError::MaintenanceBlocked);
                }
                state.maintenance_active = true;
            }
            Entry::Vacant(entry) => {
                entry.insert(SessionState {
                    active_activities: 0,
                    exclusive_activity_active: false,
                    maintenance_active: true,
                    recovery_required: false,
                });
            }
        }
        drop(sessions);

        Ok(SessionMaintenanceLease {
            session_id,
            inner: Arc::clone(self),
        })
    }

    #[cfg(test)]
    fn tracked_session_count(&self) -> usize {
        self.sessions().len()
    }
}

/// Coordinates shared activity and exclusive maintenance independently per session.
#[derive(Debug, Clone, Default)]
pub struct SessionMaintenanceCoordinator {
    inner: Arc<CoordinatorInner>,
}

impl SessionMaintenanceCoordinator {
    /// Creates an empty coordinator.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Begins ordinary activity when the session is not under maintenance.
    ///
    /// Multiple activity leases may coexist for one session. The returned lease
    /// releases its activity slot when dropped.
    ///
    /// # Errors
    ///
    /// Returns [`SessionMaintenanceError::ActivityBlocked`] while exclusive activity or
    /// maintenance is active, [`SessionMaintenanceError::RecoveryRequired`] while an
    /// interrupted operation requires recovery, or
    /// [`SessionMaintenanceError::ActivityCapacityExceeded`] if the activity counter
    /// cannot be increased.
    pub fn try_begin_activity(
        &self,
        session_id: SessionId,
    ) -> Result<SessionActivityLease, SessionMaintenanceError> {
        let mut sessions = self.inner.sessions();
        match sessions.entry(session_id.clone()) {
            Entry::Occupied(mut entry) => {
                let state = entry.get_mut();
                if state.recovery_required {
                    return Err(SessionMaintenanceError::RecoveryRequired);
                }
                if state.exclusive_activity_active || state.maintenance_active {
                    return Err(SessionMaintenanceError::ActivityBlocked);
                }
                state.active_activities = state
                    .active_activities
                    .checked_add(1)
                    .ok_or(SessionMaintenanceError::ActivityCapacityExceeded)?;
            }
            Entry::Vacant(entry) => {
                entry.insert(SessionState {
                    active_activities: 1,
                    exclusive_activity_active: false,
                    maintenance_active: false,
                    recovery_required: false,
                });
            }
        }
        drop(sessions);

        Ok(SessionActivityLease {
            session_id,
            inner: Arc::clone(&self.inner),
        })
    }

    /// Begins activity that must not overlap other activity or maintenance.
    ///
    /// The returned lease releases exclusive activity ownership when dropped.
    /// Acquisition is immediate and never waits for another lease.
    ///
    /// # Errors
    ///
    /// Returns [`SessionMaintenanceError::ActivityBlocked`] while shared activity,
    /// exclusive activity, or maintenance owns the session, or
    /// [`SessionMaintenanceError::RecoveryRequired`] while an interrupted operation
    /// requires recovery.
    pub fn try_begin_exclusive_activity(
        &self,
        session_id: SessionId,
    ) -> Result<SessionExclusiveActivityLease, SessionMaintenanceError> {
        let mut sessions = self.inner.sessions();
        match sessions.entry(session_id.clone()) {
            Entry::Occupied(mut entry) => {
                let state = entry.get_mut();
                if state.recovery_required {
                    return Err(SessionMaintenanceError::RecoveryRequired);
                }
                if state.active_activities != 0
                    || state.exclusive_activity_active
                    || state.maintenance_active
                {
                    return Err(SessionMaintenanceError::ActivityBlocked);
                }
                state.exclusive_activity_active = true;
            }
            Entry::Vacant(entry) => {
                entry.insert(SessionState {
                    active_activities: 0,
                    exclusive_activity_active: true,
                    maintenance_active: false,
                    recovery_required: false,
                });
            }
        }
        drop(sessions);

        Ok(SessionExclusiveActivityLease {
            session_id,
            inner: Arc::clone(&self.inner),
        })
    }

    /// Begins exclusive maintenance when the session has no activity or maintenance.
    ///
    /// The returned lease releases exclusive ownership when dropped.
    ///
    /// # Errors
    ///
    /// Returns [`SessionMaintenanceError::MaintenanceBlocked`] while any activity
    /// or another maintenance lease owns the session, or
    /// [`SessionMaintenanceError::RecoveryRequired`] while an interrupted operation
    /// requires recovery.
    pub fn try_begin_maintenance(
        &self,
        session_id: SessionId,
    ) -> Result<SessionMaintenanceLease, SessionMaintenanceError> {
        self.inner.try_begin_maintenance(session_id, false)
    }

    /// Begins maintenance used to recover an interrupted durable operation.
    ///
    /// Unlike [`Self::try_begin_maintenance`], this acquisition is allowed while
    /// the session is marked as requiring recovery. It remains mutually exclusive
    /// with every activity and maintenance lease.
    ///
    /// # Errors
    ///
    /// Returns [`SessionMaintenanceError::MaintenanceBlocked`] while any activity
    /// or another maintenance lease owns the session.
    pub fn try_begin_recovery_maintenance(
        &self,
        session_id: SessionId,
    ) -> Result<SessionMaintenanceLease, SessionMaintenanceError> {
        self.inner.try_begin_maintenance(session_id, true)
    }

    /// Prevents new work from entering a session after an interrupted durable operation.
    ///
    /// The marker survives the current maintenance lease and must be cleared while
    /// holding a later maintenance lease acquired through
    /// [`Self::try_begin_recovery_maintenance`].
    ///
    /// # Errors
    ///
    /// Returns [`SessionMaintenanceError::MaintenanceBlocked`] unless maintenance
    /// currently owns the session and no activity lease is present.
    pub fn mark_recovery_required(
        &self,
        session_id: &SessionId,
    ) -> Result<(), SessionMaintenanceError> {
        let mut sessions = self.inner.sessions();
        let Some(state) = sessions.get_mut(session_id) else {
            return Err(SessionMaintenanceError::MaintenanceBlocked);
        };
        if !state.maintenance_active
            || state.active_activities != 0
            || state.exclusive_activity_active
        {
            return Err(SessionMaintenanceError::MaintenanceBlocked);
        }
        state.recovery_required = true;
        Ok(())
    }

    /// Clears the durable recovery marker while recovery maintenance owns the session.
    ///
    /// # Errors
    ///
    /// Returns [`SessionMaintenanceError::MaintenanceBlocked`] unless maintenance
    /// currently owns the session.
    pub fn clear_recovery_required(
        &self,
        session_id: &SessionId,
    ) -> Result<(), SessionMaintenanceError> {
        let mut sessions = self.inner.sessions();
        let Some(state) = sessions.get_mut(session_id) else {
            return Err(SessionMaintenanceError::MaintenanceBlocked);
        };
        if !state.maintenance_active {
            return Err(SessionMaintenanceError::MaintenanceBlocked);
        }
        state.recovery_required = false;
        Ok(())
    }
}

/// RAII ownership of one ordinary activity slot for a session.
#[derive(Debug)]
#[must_use = "dropping the lease immediately releases the session activity slot"]
pub struct SessionActivityLease {
    session_id: SessionId,
    inner: Arc<CoordinatorInner>,
}

impl SessionActivityLease {
    /// Returns the session protected by this lease.
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }
}

impl Drop for SessionActivityLease {
    fn drop(&mut self) {
        self.inner.release_activity(&self.session_id);
    }
}

/// RAII ownership of exclusive session activity, such as compaction.
#[derive(Debug)]
#[must_use = "dropping the lease immediately releases exclusive session activity"]
pub struct SessionExclusiveActivityLease {
    session_id: SessionId,
    inner: Arc<CoordinatorInner>,
}

impl SessionExclusiveActivityLease {
    /// Returns the session protected by this lease.
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }
}

impl Drop for SessionExclusiveActivityLease {
    fn drop(&mut self) {
        self.inner.release_exclusive_activity(&self.session_id);
    }
}

/// RAII ownership of exclusive maintenance access for a session.
#[derive(Debug)]
#[must_use = "dropping the lease immediately releases session maintenance ownership"]
pub struct SessionMaintenanceLease {
    session_id: SessionId,
    inner: Arc<CoordinatorInner>,
}

impl SessionMaintenanceLease {
    /// Returns the session protected by this lease.
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }
}

impl Drop for SessionMaintenanceLease {
    fn drop(&mut self) {
        self.inner.release_maintenance(&self.session_id);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc, Barrier,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
    };

    use codez_core::{AppError, AppErrorKind, SessionId};

    use super::{
        SessionActivityLease, SessionExclusiveActivityLease, SessionMaintenanceCoordinator,
        SessionMaintenanceError, SessionMaintenanceLease, SessionState,
    };

    fn session_id(value: &str) -> SessionId {
        SessionId::parse(value).expect("fixture session ID must be valid")
    }

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn activity_blocked_should_convert_to_retryable_run_active_error() {
        let error = AppError::from(SessionMaintenanceError::ActivityBlocked);

        assert_eq!(
            (error.kind(), error.retryable(), error.public_message()),
            (
                AppErrorKind::RunActive,
                true,
                "session activity is blocked by exclusive work or maintenance",
            )
        );
    }

    #[test]
    fn maintenance_blocked_should_convert_to_retryable_run_active_error() {
        let error = AppError::from(SessionMaintenanceError::MaintenanceBlocked);

        assert_eq!(
            (error.kind(), error.retryable(), error.public_message()),
            (
                AppErrorKind::RunActive,
                true,
                "session maintenance is blocked by active work or maintenance",
            )
        );
    }

    #[test]
    fn activity_capacity_exceeded_should_convert_to_internal_error() {
        let error = AppError::from(SessionMaintenanceError::ActivityCapacityExceeded);

        assert_eq!(
            (error.kind(), error.retryable(), error.public_message()),
            (AppErrorKind::Internal, false, "An internal error occurred",)
        );
    }

    #[test]
    fn recovery_required_should_convert_to_retryable_run_active_error() {
        let error = AppError::from(SessionMaintenanceError::RecoveryRequired);

        assert_eq!(
            (error.kind(), error.retryable(), error.public_message()),
            (
                AppErrorKind::RunActive,
                true,
                "session recovery is required before new activity or maintenance can begin",
            )
        );
    }

    #[test]
    fn coordinator_and_leases_are_send_and_sync() {
        assert_send_sync::<SessionMaintenanceCoordinator>();
        assert_send_sync::<SessionActivityLease>();
        assert_send_sync::<SessionExclusiveActivityLease>();
        assert_send_sync::<SessionMaintenanceLease>();
    }

    #[test]
    fn maintenance_should_remain_blocked_until_last_activity_drops() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-1");
        let first = coordinator
            .try_begin_activity(id.clone())
            .expect("first activity must begin");
        let second = coordinator
            .try_begin_activity(id.clone())
            .expect("second activity must begin");
        drop(first);

        assert_eq!(
            coordinator
                .try_begin_maintenance(id.clone())
                .expect_err("one remaining activity must block maintenance"),
            SessionMaintenanceError::MaintenanceBlocked
        );

        drop(second);
        assert!(coordinator.try_begin_maintenance(id).is_ok());
    }

    #[test]
    fn maintenance_should_block_new_activity() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-1");
        let _maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");

        assert_eq!(
            coordinator
                .try_begin_activity(id)
                .expect_err("maintenance must block activity"),
            SessionMaintenanceError::ActivityBlocked
        );
    }

    #[test]
    fn shared_activity_should_block_exclusive_activity_until_the_last_lease_drops() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-1");
        let first = coordinator
            .try_begin_activity(id.clone())
            .expect("first shared activity must begin");
        let second = coordinator
            .try_begin_activity(id.clone())
            .expect("second shared activity must begin");

        assert_eq!(
            coordinator
                .try_begin_exclusive_activity(id.clone())
                .expect_err("shared activity must block exclusive activity"),
            SessionMaintenanceError::ActivityBlocked
        );

        drop(first);
        drop(second);
        assert!(coordinator.try_begin_exclusive_activity(id).is_ok());
    }

    #[test]
    fn exclusive_activity_should_block_every_other_owner_until_drop() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-1");
        let exclusive = coordinator
            .try_begin_exclusive_activity(id.clone())
            .expect("exclusive activity must begin");

        assert_eq!(
            coordinator
                .try_begin_activity(id.clone())
                .expect_err("exclusive activity must block shared activity"),
            SessionMaintenanceError::ActivityBlocked
        );
        assert_eq!(
            coordinator
                .try_begin_exclusive_activity(id.clone())
                .expect_err("exclusive activity must block a duplicate"),
            SessionMaintenanceError::ActivityBlocked
        );
        assert_eq!(
            coordinator
                .try_begin_maintenance(id.clone())
                .expect_err("exclusive activity must block maintenance"),
            SessionMaintenanceError::MaintenanceBlocked
        );

        drop(exclusive);
        assert!(coordinator.try_begin_maintenance(id).is_ok());
    }

    #[test]
    fn maintenance_should_block_exclusive_activity() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-1");
        let _maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");

        assert_eq!(
            coordinator
                .try_begin_exclusive_activity(id)
                .expect_err("maintenance must block exclusive activity"),
            SessionMaintenanceError::ActivityBlocked
        );
    }

    #[test]
    fn duplicate_maintenance_should_be_blocked_until_lease_drops() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-1");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("first maintenance must begin");

        assert_eq!(
            coordinator
                .try_begin_maintenance(id.clone())
                .expect_err("duplicate maintenance must be blocked"),
            SessionMaintenanceError::MaintenanceBlocked
        );

        drop(maintenance);
        assert!(coordinator.try_begin_maintenance(id).is_ok());
    }

    #[test]
    fn recovery_marker_should_require_maintenance_ownership() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery");

        assert_eq!(
            coordinator
                .mark_recovery_required(&id)
                .expect_err("a marker without maintenance ownership must be rejected"),
            SessionMaintenanceError::MaintenanceBlocked
        );
    }

    #[test]
    fn clearing_recovery_marker_should_require_maintenance_ownership() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery");

        assert_eq!(
            coordinator
                .clear_recovery_required(&id)
                .expect_err("clearing without maintenance ownership must be rejected"),
            SessionMaintenanceError::MaintenanceBlocked
        );
    }

    #[test]
    fn dropping_maintenance_should_preserve_recovery_block() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");
        coordinator
            .mark_recovery_required(&id)
            .expect("maintenance owner must be able to mark recovery");
        drop(maintenance);

        assert_eq!(
            coordinator
                .try_begin_activity(id)
                .expect_err("recovery marker must outlive the maintenance lease"),
            SessionMaintenanceError::RecoveryRequired
        );
    }

    #[test]
    fn recovery_marker_should_block_all_ordinary_owners() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");
        coordinator
            .mark_recovery_required(&id)
            .expect("maintenance owner must be able to mark recovery");
        drop(maintenance);

        assert_eq!(
            coordinator
                .try_begin_activity(id.clone())
                .expect_err("recovery must block shared activity"),
            SessionMaintenanceError::RecoveryRequired
        );
        assert_eq!(
            coordinator
                .try_begin_exclusive_activity(id.clone())
                .expect_err("recovery must block exclusive activity"),
            SessionMaintenanceError::RecoveryRequired
        );
        assert_eq!(
            coordinator
                .try_begin_maintenance(id)
                .expect_err("recovery must block ordinary maintenance"),
            SessionMaintenanceError::RecoveryRequired
        );
    }

    #[test]
    fn recovery_maintenance_should_clear_marker_and_release_session_state() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");
        coordinator
            .mark_recovery_required(&id)
            .expect("maintenance owner must be able to mark recovery");
        drop(maintenance);
        assert_eq!(coordinator.inner.tracked_session_count(), 1);

        let recovery = coordinator
            .try_begin_recovery_maintenance(id.clone())
            .expect("recovery maintenance must bypass the recovery marker");
        coordinator
            .clear_recovery_required(&id)
            .expect("recovery maintenance must be able to clear the marker");
        drop(recovery);

        assert_eq!(coordinator.inner.tracked_session_count(), 0);
    }

    #[test]
    fn dropping_recovery_maintenance_without_clear_should_preserve_block() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");
        coordinator
            .mark_recovery_required(&id)
            .expect("maintenance owner must be able to mark recovery");
        drop(maintenance);

        let recovery = coordinator
            .try_begin_recovery_maintenance(id.clone())
            .expect("recovery maintenance must begin");
        drop(recovery);

        assert_eq!(
            coordinator
                .try_begin_maintenance(id)
                .expect_err("dropping recovery maintenance must not imply recovery success"),
            SessionMaintenanceError::RecoveryRequired
        );
    }

    #[test]
    fn recovery_maintenance_should_remain_exclusive() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");
        coordinator
            .mark_recovery_required(&id)
            .expect("maintenance owner must be able to mark recovery");
        drop(maintenance);
        let _recovery = coordinator
            .try_begin_recovery_maintenance(id.clone())
            .expect("recovery maintenance must begin");

        assert_eq!(
            coordinator
                .try_begin_recovery_maintenance(id)
                .expect_err("a second recovery owner must be blocked"),
            SessionMaintenanceError::MaintenanceBlocked
        );
    }

    #[test]
    fn dropping_last_lease_should_remove_empty_session_entry() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let activity = coordinator
            .try_begin_activity(session_id("session-1"))
            .expect("activity must begin");
        drop(activity);

        assert_eq!(coordinator.inner.tracked_session_count(), 0);
    }

    #[test]
    fn dropping_exclusive_activity_should_remove_empty_session_entry() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let exclusive = coordinator
            .try_begin_exclusive_activity(session_id("session-1"))
            .expect("exclusive activity must begin");
        drop(exclusive);

        assert_eq!(coordinator.inner.tracked_session_count(), 0);
    }

    #[test]
    fn maintenance_for_one_session_should_not_block_another_session() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let _maintenance = coordinator
            .try_begin_maintenance(session_id("session-1"))
            .expect("maintenance must begin");

        assert!(
            coordinator
                .try_begin_activity(session_id("session-2"))
                .is_ok()
        );
    }

    #[test]
    fn cloned_coordinator_should_share_lease_state() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let cloned = coordinator.clone();
        let id = session_id("session-1");
        let _maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");

        assert_eq!(
            cloned
                .try_begin_activity(id)
                .expect_err("a clone must observe maintenance ownership"),
            SessionMaintenanceError::ActivityBlocked
        );
    }

    #[test]
    fn concurrent_activity_and_maintenance_should_never_overlap() {
        const WORKER_COUNT: usize = 32;
        let coordinator = Arc::new(SessionMaintenanceCoordinator::new());
        let start = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let acquired = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let release = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let activity_successes = Arc::new(AtomicUsize::new(0));
        let maintenance_successes = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::with_capacity(WORKER_COUNT);

        for index in 0..WORKER_COUNT {
            let coordinator = Arc::clone(&coordinator);
            let start = Arc::clone(&start);
            let acquired = Arc::clone(&acquired);
            let release = Arc::clone(&release);
            let activity_successes = Arc::clone(&activity_successes);
            let maintenance_successes = Arc::clone(&maintenance_successes);
            workers.push(thread::spawn(move || {
                start.wait();
                if index % 2 == 0 {
                    let lease = coordinator
                        .try_begin_activity(session_id("race-session"))
                        .ok();
                    if lease.is_some() {
                        activity_successes.fetch_add(1, Ordering::Relaxed);
                    }
                    acquired.wait();
                    release.wait();
                    drop(lease);
                } else {
                    let lease = coordinator
                        .try_begin_maintenance(session_id("race-session"))
                        .ok();
                    if lease.is_some() {
                        maintenance_successes.fetch_add(1, Ordering::Relaxed);
                    }
                    acquired.wait();
                    release.wait();
                    drop(lease);
                }
            }));
        }

        start.wait();
        acquired.wait();
        let activity_successes = activity_successes.load(Ordering::Relaxed);
        let maintenance_successes = maintenance_successes.load(Ordering::Relaxed);
        release.wait();
        for worker in workers {
            worker.join().expect("race worker must finish");
        }

        assert_ne!(activity_successes > 0, maintenance_successes > 0);
    }

    #[test]
    fn concurrent_shared_exclusive_and_maintenance_owners_should_never_overlap() {
        const WORKER_COUNT: usize = 48;
        let coordinator = Arc::new(SessionMaintenanceCoordinator::new());
        let start = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let acquired = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let release = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let shared_successes = Arc::new(AtomicUsize::new(0));
        let exclusive_successes = Arc::new(AtomicUsize::new(0));
        let maintenance_successes = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::with_capacity(WORKER_COUNT);

        for index in 0..WORKER_COUNT {
            let coordinator = Arc::clone(&coordinator);
            let start = Arc::clone(&start);
            let acquired = Arc::clone(&acquired);
            let release = Arc::clone(&release);
            let shared_successes = Arc::clone(&shared_successes);
            let exclusive_successes = Arc::clone(&exclusive_successes);
            let maintenance_successes = Arc::clone(&maintenance_successes);
            workers.push(thread::spawn(move || {
                start.wait();
                let lease: Option<Box<dyn Send>> = match index % 3 {
                    0 => coordinator
                        .try_begin_activity(session_id("three-way-race"))
                        .ok()
                        .map(|lease| {
                            shared_successes.fetch_add(1, Ordering::Relaxed);
                            Box::new(lease) as Box<dyn Send>
                        }),
                    1 => coordinator
                        .try_begin_exclusive_activity(session_id("three-way-race"))
                        .ok()
                        .map(|lease| {
                            exclusive_successes.fetch_add(1, Ordering::Relaxed);
                            Box::new(lease) as Box<dyn Send>
                        }),
                    _ => coordinator
                        .try_begin_maintenance(session_id("three-way-race"))
                        .ok()
                        .map(|lease| {
                            maintenance_successes.fetch_add(1, Ordering::Relaxed);
                            Box::new(lease) as Box<dyn Send>
                        }),
                };
                acquired.wait();
                release.wait();
                drop(lease);
            }));
        }

        start.wait();
        acquired.wait();
        let owner_kinds = usize::from(shared_successes.load(Ordering::Relaxed) > 0)
            + usize::from(exclusive_successes.load(Ordering::Relaxed) > 0)
            + usize::from(maintenance_successes.load(Ordering::Relaxed) > 0);
        release.wait();
        for worker in workers {
            worker.join().expect("race worker must finish");
        }

        assert_eq!(owner_kinds, 1);
    }

    #[test]
    fn concurrent_recovery_attempts_should_admit_only_one_recovery_owner() {
        const WORKER_COUNT: usize = 32;
        let coordinator = Arc::new(SessionMaintenanceCoordinator::new());
        let id = session_id("recovery-race");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");
        coordinator
            .mark_recovery_required(&id)
            .expect("maintenance owner must be able to mark recovery");
        drop(maintenance);

        let start = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let acquired = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let release = Arc::new(Barrier::new(WORKER_COUNT + 1));
        let recovery_successes = Arc::new(AtomicUsize::new(0));
        let ordinary_successes = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::with_capacity(WORKER_COUNT);

        for index in 0..WORKER_COUNT {
            let coordinator = Arc::clone(&coordinator);
            let start = Arc::clone(&start);
            let acquired = Arc::clone(&acquired);
            let release = Arc::clone(&release);
            let recovery_successes = Arc::clone(&recovery_successes);
            let ordinary_successes = Arc::clone(&ordinary_successes);
            let id = id.clone();
            workers.push(thread::spawn(move || {
                start.wait();
                let lease: Option<Box<dyn Send>> = match index % 4 {
                    0 => coordinator
                        .try_begin_recovery_maintenance(id)
                        .ok()
                        .map(|lease| {
                            recovery_successes.fetch_add(1, Ordering::Relaxed);
                            Box::new(lease) as Box<dyn Send>
                        }),
                    1 => coordinator.try_begin_activity(id).ok().map(|lease| {
                        ordinary_successes.fetch_add(1, Ordering::Relaxed);
                        Box::new(lease) as Box<dyn Send>
                    }),
                    2 => coordinator
                        .try_begin_exclusive_activity(id)
                        .ok()
                        .map(|lease| {
                            ordinary_successes.fetch_add(1, Ordering::Relaxed);
                            Box::new(lease) as Box<dyn Send>
                        }),
                    _ => coordinator.try_begin_maintenance(id).ok().map(|lease| {
                        ordinary_successes.fetch_add(1, Ordering::Relaxed);
                        Box::new(lease) as Box<dyn Send>
                    }),
                };
                acquired.wait();
                release.wait();
                drop(lease);
            }));
        }

        start.wait();
        acquired.wait();
        let outcome = (
            recovery_successes.load(Ordering::Relaxed),
            ordinary_successes.load(Ordering::Relaxed),
        );
        release.wait();
        for worker in workers {
            worker.join().expect("recovery race worker must finish");
        }

        assert_eq!(outcome, (1, 0));
    }

    #[test]
    fn unwind_should_drop_exclusive_activity_lease() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-unwind");

        let unwind = std::panic::catch_unwind({
            let coordinator = coordinator.clone();
            let id = id.clone();
            move || {
                let _exclusive = coordinator
                    .try_begin_exclusive_activity(id)
                    .expect("exclusive activity must begin");
                panic!("release exclusive activity during unwind");
            }
        });

        assert!(unwind.is_err());
        assert!(coordinator.try_begin_maintenance(id).is_ok());
    }

    #[test]
    fn activity_capacity_error_should_not_change_existing_ownership() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-capacity");
        coordinator.inner.sessions().insert(
            id.clone(),
            SessionState {
                active_activities: usize::MAX,
                exclusive_activity_active: false,
                maintenance_active: false,
                recovery_required: false,
            },
        );

        assert_eq!(
            coordinator
                .try_begin_activity(id.clone())
                .expect_err("activity count overflow must be rejected"),
            SessionMaintenanceError::ActivityCapacityExceeded
        );
        assert_eq!(
            coordinator
                .try_begin_maintenance(id)
                .expect_err("existing shared ownership must remain intact"),
            SessionMaintenanceError::MaintenanceBlocked
        );
    }

    #[test]
    fn poisoned_registry_should_recover_and_release_leases() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let inner = Arc::clone(&coordinator.inner);
        let _panic = thread::spawn(move || {
            let _sessions = inner
                .sessions
                .lock()
                .expect("registry must initially be healthy");
            panic!("poison registry for recovery coverage");
        })
        .join();

        let lease = coordinator
            .try_begin_exclusive_activity(session_id("session-after-poison"))
            .expect("poison recovery must admit exclusive activity");
        drop(lease);

        assert_eq!(coordinator.inner.tracked_session_count(), 0);
    }

    #[test]
    fn poisoned_registry_should_preserve_recovery_marker() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let id = session_id("session-recovery-after-poison");
        let maintenance = coordinator
            .try_begin_maintenance(id.clone())
            .expect("maintenance must begin");
        coordinator
            .mark_recovery_required(&id)
            .expect("maintenance owner must be able to mark recovery");
        drop(maintenance);

        let inner = Arc::clone(&coordinator.inner);
        let _panic = thread::spawn(move || {
            let _sessions = inner
                .sessions
                .lock()
                .expect("registry must initially be healthy");
            panic!("poison registry while recovery is required");
        })
        .join();

        assert_eq!(
            coordinator
                .try_begin_activity(id)
                .expect_err("poison recovery must retain the durable recovery block"),
            SessionMaintenanceError::RecoveryRequired
        );
    }
}
