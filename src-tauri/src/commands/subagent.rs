use codez_contracts::{
    CommandError,
    subagent::{SubAgentDetailResult, SubAgentInfo, SubAgentModelSelection},
};
use tauri::{State, command};

use crate::{
    error::command_result,
    state::AppState,
    subagent_boundary::{
        detail_for_subagent, find_known_subagent, list_subagents, provider_model_catalog,
        read_settings, save_settings, validate_model_selections,
    },
};

/// Lists each built-in sub-agent with its persisted enablement and model choices.
#[command]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn subagent_list(state: State<'_, AppState>) -> Result<Vec<SubAgentInfo>, CommandError> {
    let result = async {
        let settings = read_settings(&state).await?;
        list_subagents(settings.settings())
    }
    .await;
    command_result(&state.errors, result)
}

/// Enables or disables one known built-in sub-agent using Electron-compatible settings.
#[command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn subagent_toggle(
    state: State<'_, AppState>,
    subagent_type: String,
    enabled: bool,
) -> Result<(), CommandError> {
    let result = async {
        let agent = find_known_subagent(&subagent_type)?;
        let _settings_mutation = state.subagent_settings.lock().await;
        let mut settings = read_settings(&state).await?;
        settings.settings_mut().set_enabled(agent.role(), enabled);
        save_settings(&state, settings).await
    }
    .await;
    command_result(&state.errors, result)
}

/// Returns only static sub-agent metadata owned by Rust and explicitly names unavailable fields.
#[command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn subagent_get_detail(
    state: State<'_, AppState>,
    subagent_type: String,
) -> Result<SubAgentDetailResult, CommandError> {
    let result = async {
        let settings = read_settings(&state).await?;
        detail_for_subagent(&subagent_type, settings.settings())
    }
    .await;
    command_result(&state.errors, result)
}

/// Replaces the ordered model candidates for one known built-in sub-agent.
#[command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, selections))]
pub async fn subagent_set_model(
    state: State<'_, AppState>,
    subagent_type: String,
    selections: Vec<SubAgentModelSelection>,
) -> Result<(), CommandError> {
    let result = async {
        let agent = find_known_subagent(&subagent_type)?;
        let providers = state.provider_service.get_all().await?;
        let selections =
            validate_model_selections(selections, &provider_model_catalog(&providers))?;
        let _settings_mutation = state.subagent_settings.lock().await;
        let mut settings = read_settings(&state).await?;
        settings.settings_mut().set_models(agent.role(), selections);
        save_settings(&state, settings).await
    }
    .await;
    command_result(&state.errors, result)
}
