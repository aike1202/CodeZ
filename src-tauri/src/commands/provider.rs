use codez_contracts::{
    provider::{ConnectionTestResult, ProviderFormData, ProviderInfo},
    CommandError,
};
use tauri::State;

use crate::{error::command_result, state::AppState};

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn provider_get_all(state: State<'_, AppState>) -> Result<Vec<ProviderInfo>, CommandError> {
    command_result(&state.errors, state.provider_service.get_all().await)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, data))]
pub async fn provider_create(
    data: ProviderFormData,
    state: State<'_, AppState>,
) -> Result<ProviderInfo, CommandError> {
    command_result(&state.errors, state.provider_service.create(data).await)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, data))]
pub async fn provider_update(
    id: String,
    data: ProviderFormData,
    state: State<'_, AppState>,
) -> Result<ProviderInfo, CommandError> {
    command_result(&state.errors, state.provider_service.update(&id, data).await)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn provider_delete(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    command_result(&state.errors, state.provider_service.delete(&id).await)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn provider_set_active(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    command_result(&state.errors, state.provider_service.set_active(&id).await)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn provider_test_connection(
    id: String,
    state: State<'_, AppState>,
) -> Result<ConnectionTestResult, CommandError> {
    command_result(&state.errors, state.provider_service.test_connection(&id).await)
}
