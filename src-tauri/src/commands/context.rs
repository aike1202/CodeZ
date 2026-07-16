use tauri::{command, State};
use codez_contracts::{CommandError, context::{LedgerEvent, SessionRuntimeSnapshot}};
use codez_core::AppError;
use crate::state::AppState;

#[command]
pub async fn ledger_append_event(
    state: State<'_, AppState>,
    event: LedgerEvent,
) -> Result<(), CommandError> {
    state.model_ledger.append_event(event).await.map_err(|e| {
        state.errors.report(AppError::internal(format!("Ledger append failed: {}", e)))
    })?;
    Ok(())
}

#[command]
pub async fn ledger_get_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionRuntimeSnapshot>, CommandError> {
    // TODO: Delegate to ModelLedgerStore.get_snapshot
    Ok(None)
}
