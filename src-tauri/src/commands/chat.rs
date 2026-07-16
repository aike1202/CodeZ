use std::sync::Arc;

use codez_contracts::{
    CommandError,
    chat::{
        ChatAskUserAnswer, ChatFileDiff, ChatPermissionApprovalResponse, ChatRuntimeStatus,
        ChatSteerInput, ChatSteerResult, ChatStreamFrame, ChatStreamRequest, ChatStreamStopResult,
        ChatToolInterruptResult, PromptPredictionRequest, PromptPredictionResponse,
    },
};
use codez_core::{AppError, SessionId, StreamId, ToolCallId};
use tauri::{AppHandle, State, ipc::Channel};

use crate::{
    chat_runtime::{predict_next_input, validate_stream_request},
    error::command_result,
    state::AppState,
};

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, request))]
pub async fn chat_predict_next_input(
    state: State<'_, AppState>,
    request: PromptPredictionRequest,
) -> Result<PromptPredictionResponse, CommandError> {
    let result = predict_next_input(
        &state.provider_service,
        state.cancellation.application_token(),
        request,
    )
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(app, state, request, events))]
pub async fn chat_stream_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ChatStreamRequest,
    events: Channel<ChatStreamFrame>,
) -> Result<String, CommandError> {
    command_result(&state.errors, validate_stream_request(&request))?;
    let resolved = command_result(
        &state.errors,
        state
            .provider_service
            .resolve_chat_config(Some(&request.provider_id), Some(&request.model))
            .await,
    )?;
    command_result(
        &state.errors,
        state.chat_runtime.start_provider_run(
            app,
            Arc::clone(&state.provider_service),
            request,
            resolved,
            events,
        ),
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn chat_stream_ack(
    state: State<'_, AppState>,
    run_id: String,
    sequence: u64,
) -> Result<(), CommandError> {
    let run_id = command_result(
        &state.errors,
        StreamId::parse(run_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    let result = state.chat_runtime.acknowledge(&run_id, sequence).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(app, state))]
pub fn chat_stream_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<ChatStreamStopResult, CommandError> {
    let run_id = command_result(
        &state.errors,
        StreamId::parse(run_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    command_result(&state.errors, state.chat_runtime.request_stop(&app, run_id))
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub fn chat_get_runtime_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ChatRuntimeStatus, CommandError> {
    let session_id = command_result(
        &state.errors,
        SessionId::parse(session_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    Ok(state.chat_runtime.runtime_status(&session_id))
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, input))]
pub async fn chat_steer(
    state: State<'_, AppState>,
    session_id: String,
    input: ChatSteerInput,
) -> Result<ChatSteerResult, CommandError> {
    let session_id = command_result(
        &state.errors,
        SessionId::parse(session_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    Ok(state.chat_runtime.steer(&session_id, input).await)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub fn chat_interrupt_tool(
    state: State<'_, AppState>,
    tool_call_id: String,
) -> Result<ChatToolInterruptResult, CommandError> {
    command_result(
        &state.errors,
        ToolCallId::parse(tool_call_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    unsupported(
        &state,
        "Tool interruption is unavailable until the Rust Agent loop owns tool processes",
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, instructions))]
pub fn chat_compact(
    state: State<'_, AppState>,
    session_id: String,
    instructions: Option<String>,
) -> Result<(), CommandError> {
    command_result(
        &state.errors,
        SessionId::parse(session_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    drop(instructions);
    unsupported(
        &state,
        "Chat compaction is unavailable until the Rust context ledger can commit snapshots",
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub fn chat_accept_file(
    state: State<'_, AppState>,
    tx_id: String,
    file_path: String,
) -> Result<bool, CommandError> {
    validate_transaction_input(&state, &tx_id, &file_path)?;
    unsupported(
        &state,
        "File acceptance is unavailable until Rust edit transactions implement commit",
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub fn chat_reject_file(
    state: State<'_, AppState>,
    tx_id: String,
    file_path: String,
) -> Result<bool, CommandError> {
    validate_transaction_input(&state, &tx_id, &file_path)?;
    unsupported(
        &state,
        "File rejection is unavailable until Rust edit transactions implement rollback",
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub fn chat_get_diff(
    state: State<'_, AppState>,
    tx_id: String,
) -> Result<Vec<ChatFileDiff>, CommandError> {
    if tx_id.trim().is_empty() {
        return command_result(
            &state.errors,
            Err(AppError::validation("A transaction ID is required")),
        );
    }
    unsupported(
        &state,
        "Transaction diffs are unavailable until the Rust edit transaction reader is implemented",
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, response))]
pub fn chat_respond_to_approval(
    state: State<'_, AppState>,
    request_id: String,
    response: ChatPermissionApprovalResponse,
) -> Result<(), CommandError> {
    if request_id.trim().is_empty() {
        return command_result(
            &state.errors,
            Err(AppError::validation("An approval request ID is required")),
        );
    }
    let _ = response;
    unsupported(
        &state,
        "No Rust Agent permission request is awaiting a response",
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, answers))]
pub fn chat_respond_ask_user(
    state: State<'_, AppState>,
    request_id: String,
    answers: Vec<ChatAskUserAnswer>,
) -> Result<(), CommandError> {
    command_result(
        &state.errors,
        state.chat_runtime.respond_ask_user(&request_id, answers),
    )
}

fn validate_transaction_input(
    state: &State<'_, AppState>,
    tx_id: &str,
    file_path: &str,
) -> Result<(), CommandError> {
    if tx_id.trim().is_empty() || file_path.trim().is_empty() {
        return command_result(
            &state.errors,
            Err(AppError::validation(
                "A transaction ID and file path are required",
            )),
        );
    }
    Ok(())
}

fn unsupported<T>(state: &State<'_, AppState>, message: &'static str) -> Result<T, CommandError> {
    command_result(&state.errors, Err(AppError::unsupported(message)))
}
