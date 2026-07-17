use codez_contracts::{
    CommandError,
    subagent::{
        SubAgentDetailResult, SubAgentInfo, SubAgentModelSelection, SubAgentRunCancelResult,
        SubAgentRunRequest, SubAgentRunState,
    },
};
use codez_core::{AppError, SessionId};
use std::sync::Arc;
use tauri::{AppHandle, State, command};

use crate::{
    error::command_result,
    state::AppState,
    subagent_boundary::{
        detail_for_subagent, find_known_subagent, list_subagents, provider_model_catalog,
        read_settings, resolve_run_configuration, save_settings, validate_model_selections,
    },
    subagent_runtime::TauriSubAgentEventSink,
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

/// Starts one bounded, tool-free Provider-backed built-in sub-agent run.
#[command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(app, state, request))]
pub async fn subagent_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SubAgentRunRequest,
) -> Result<SubAgentRunState, CommandError> {
    let result = async {
        let session_id = SessionId::parse(request.session_id.clone())
            .map_err(|error| AppError::validation(error.to_string()))?;
        let activity = state
            .session_maintenance
            .try_begin_activity(session_id)
            .map_err(AppError::from)?;
        let settings = read_settings(&state).await?;
        let configuration = resolve_run_configuration(&request.subagent_type, settings.settings())?;
        // Resolve before admission so a missing credential or disabled model does not create a
        // run that can only fail asynchronously. The runtime resolves again when it owns the
        // request, avoiding persistence or cross-task transfer of credentials.
        let _resolved = state
            .provider_service
            .resolve_chat_config(
                Some(&configuration.selection.provider_id),
                Some(&configuration.selection.model),
            )
            .await?;
        state
            .subagent_runtime
            .start(
                request,
                configuration,
                Arc::new(TauriSubAgentEventSink::new(app, Arc::clone(&state.errors))),
                activity,
            )
            .await
    }
    .await;
    command_result(&state.errors, result)
}

/// Reads an active run or its persisted terminal state.
#[command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn subagent_get_run(
    state: State<'_, AppState>,
    session_id: String,
    run_id: String,
) -> Result<SubAgentRunState, CommandError> {
    let result = async {
        let session_id = SessionId::parse(session_id)
            .map_err(|error| AppError::validation(error.to_string()))?;
        let activity = state
            .session_maintenance
            .try_begin_activity(session_id)
            .map_err(AppError::from)?;
        state
            .subagent_runtime
            .status(activity.session_id(), &run_id)
            .await
    }
    .await;
    command_result(&state.errors, result)
}

/// Requests cancellation and returns the last state observed before the
/// Provider task finishes its interruption cleanup.
#[command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn subagent_cancel_run(
    state: State<'_, AppState>,
    session_id: String,
    run_id: String,
) -> Result<SubAgentRunCancelResult, CommandError> {
    let result = async {
        let session_id = SessionId::parse(session_id)
            .map_err(|error| AppError::validation(error.to_string()))?;
        let activity = state
            .session_maintenance
            .try_begin_activity(session_id)
            .map_err(AppError::from)?;
        state
            .subagent_runtime
            .cancel(activity.session_id(), &run_id)
            .await
    }
    .await;
    command_result(&state.errors, result)
}
