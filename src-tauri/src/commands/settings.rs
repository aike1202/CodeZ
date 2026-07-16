use std::path::PathBuf;

use codez_contracts::CommandError;
use codez_core::{AppError, SessionId};
use codez_storage::SessionStore;
use serde_json::Value;
use tauri::{State, command};

use crate::{error::command_result, state::AppState};

fn settings_path(state: &AppState) -> PathBuf {
    state.paths.data_directory().join("settings.json")
}

fn session_store(state: &AppState) -> SessionStore {
    SessionStore::new(
        state.paths.data_directory().to_path_buf(),
        state.storage.as_ref().clone(),
    )
}

fn parse_session_id(value: &str) -> Result<SessionId, AppError> {
    SessionId::parse(value).map_err(|_| AppError::validation("Session ID is invalid"))
}

#[command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<Value, CommandError> {
    let result = state
        .storage
        .read_json::<Value>(&settings_path(&state))
        .await
        .map(|settings| settings.unwrap_or_else(|| serde_json::json!({})))
        .map_err(AppError::from);
    command_result(&state.errors, result)
}

#[command]
pub async fn settings_save(
    state: State<'_, AppState>,
    settings: Value,
) -> Result<bool, CommandError> {
    let result = state
        .storage
        .write_json(&settings_path(&state), &settings)
        .await
        .map(|()| true)
        .map_err(AppError::from);
    command_result(&state.errors, result)
}

#[command]
pub async fn session_list(state: State<'_, AppState>) -> Result<Vec<Value>, CommandError> {
    let result = session_store(&state).list().await;
    command_result(&state.errors, result)
}

#[command(rename_all = "camelCase")]
pub async fn session_get(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<Value>, CommandError> {
    let result = async {
        let session_id = parse_session_id(&session_id)?;
        session_store(&state).get(&session_id).await
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn session_save(state: State<'_, AppState>, session: Value) -> Result<(), CommandError> {
    let result = async {
        let raw_id = session
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("Session ID is required"))?;
        let session_id = parse_session_id(raw_id)?;
        session_store(&state).save(&session_id, &session).await
    }
    .await;
    command_result(&state.errors, result)
}

#[command(rename_all = "camelCase")]
pub async fn session_delete(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), CommandError> {
    let result = async {
        let session_id = parse_session_id(&session_id)?;
        session_store(&state).delete(&session_id).await?;
        Ok(())
    }
    .await;
    command_result(&state.errors, result)
}
