use codez_contracts::{
    CommandError,
    provider::{ConnectionTestResult, ProviderFormData, ProviderInfo},
};
use tauri::State;

use crate::{
    error::command_result,
    provider_boundary::{connection_to_wire, provider_form_from_wire, provider_info_to_wire},
    state::AppState,
};

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn provider_get_all(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderInfo>, CommandError> {
    let result = state
        .provider_service
        .get_all()
        .await
        .map(|providers| providers.into_iter().map(provider_info_to_wire).collect());
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, data))]
pub async fn provider_create(
    data: ProviderFormData,
    state: State<'_, AppState>,
) -> Result<ProviderInfo, CommandError> {
    let result = async {
        let data = provider_form_from_wire(data)?;
        state
            .provider_service
            .create(data)
            .await
            .map(provider_info_to_wire)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, data))]
pub async fn provider_update(
    id: String,
    data: ProviderFormData,
    state: State<'_, AppState>,
) -> Result<ProviderInfo, CommandError> {
    let result = async {
        let data = provider_form_from_wire(data)?;
        state
            .provider_service
            .update(&id, data)
            .await
            .map(provider_info_to_wire)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn provider_delete(id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
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
    let result = state
        .provider_service
        .test_connection(&id)
        .await
        .map(connection_to_wire);
    command_result(&state.errors, result)
}
