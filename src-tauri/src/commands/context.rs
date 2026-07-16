use codez_contracts::{
    CommandError,
    context::{LedgerAppendRequest, LedgerEvent, SessionRuntimeSnapshot},
};
use codez_core::{AppError, SessionId};
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
    let session_id = command_result(&state.errors, parse_session_id(session_id))?;
    let event = append_request_from_wire(event);
    command_result(
        &state.errors,
        state
            .model_ledger
            .append_event_for(&session_id, event)
            .await
            .map(event_to_wire)
            .map_err(AppError::from),
    )
}

#[command]
pub async fn ledger_get_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionRuntimeSnapshot>, CommandError> {
    let session_id = command_result(&state.errors, parse_session_id(session_id))?;
    command_result(
        &state.errors,
        state
            .model_ledger
            .get_snapshot(&session_id)
            .await
            .map(|snapshot| snapshot.map(snapshot_to_wire))
            .map_err(AppError::from),
    )
}

fn parse_session_id(value: String) -> Result<SessionId, AppError> {
    SessionId::parse(value)
        .map_err(|error| AppError::validation(format!("Invalid session id: {error}")))
}
