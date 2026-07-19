use codez_contracts::{
    CommandError,
    context::{LedgerAppendRequest, LedgerEvent, SessionRuntimeSnapshot},
};
use codez_core::{AppError, SessionId};
use codez_runtime::session_maintenance::{SessionActivityLease, SessionMaintenanceCoordinator};
use tauri::{State, command};

use crate::{
    context_boundary::{append_request_from_wire, event_to_wire, snapshot_to_wire},
    error::command_result,
    state::AppState,
};

#[command]
pub async fn ledger_append_event(
    state: State<'_, AppState>,
    session_id: String,
    event: LedgerAppendRequest,
) -> Result<LedgerEvent, CommandError> {
    let result = async {
        let activity = begin_session_activity(&state.session_maintenance, &session_id)?;
        let event = append_request_from_wire(event)?;
        state
            .model_ledger
            .append_event_for(activity.session_id(), event)
            .await
            .map(event_to_wire)
            .map_err(AppError::from)
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn ledger_get_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionRuntimeSnapshot>, CommandError> {
    let result = async {
        let activity = begin_session_activity(&state.session_maintenance, &session_id)?;
        state
            .model_ledger
            .get_snapshot(activity.session_id())
            .await
            .map(|snapshot| snapshot.map(snapshot_to_wire))
            .map_err(AppError::from)
    }
    .await;
    command_result(&state.errors, result)
}

fn parse_session_id(value: &str) -> Result<SessionId, AppError> {
    SessionId::parse(value)
        .map_err(|error| AppError::validation(format!("Invalid session id: {error}")))
}

fn begin_session_activity(
    coordinator: &SessionMaintenanceCoordinator,
    session_id: &str,
) -> Result<SessionActivityLease, AppError> {
    coordinator
        .try_begin_activity(parse_session_id(session_id)?)
        .map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use codez_core::{AppErrorKind, SessionId};
    use codez_runtime::session_maintenance::{
        SessionMaintenanceCoordinator, SessionMaintenanceError,
    };

    use super::begin_session_activity;

    fn session_id() -> SessionId {
        SessionId::parse("session-1").expect("fixture session ID must parse")
    }

    #[test]
    fn ledger_activity_should_reject_an_unportable_session_id() {
        let coordinator = SessionMaintenanceCoordinator::new();

        let error = begin_session_activity(&coordinator, "../outside")
            .expect_err("path-like session IDs must not become ledger authority");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn ledger_activity_should_block_maintenance_until_drop() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let activity = begin_session_activity(&coordinator, "session-1")
            .expect("fixture ledger activity must begin");

        let blocked = coordinator
            .try_begin_maintenance(session_id())
            .expect_err("ledger activity must block maintenance");
        assert_eq!(blocked, SessionMaintenanceError::MaintenanceBlocked);

        drop(activity);
        assert!(coordinator.try_begin_maintenance(session_id()).is_ok());
    }

    #[test]
    fn ledger_activity_should_reject_a_recovery_block() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let maintenance = coordinator
            .try_begin_maintenance(session_id())
            .expect("fixture maintenance must begin");
        coordinator
            .mark_recovery_required(maintenance.session_id())
            .expect("fixture recovery marker must be recorded");
        drop(maintenance);

        let error = begin_session_activity(&coordinator, "session-1")
            .expect_err("recovery must block ledger activity");

        assert_eq!(
            (error.kind(), error.retryable()),
            (AppErrorKind::RunActive, true)
        );
    }
}
