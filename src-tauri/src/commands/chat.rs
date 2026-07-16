use std::{path::Path, sync::Arc};

use codez_contracts::{
    CommandError,
    chat::{
        ChatAskUserAnswer, ChatCompactionResponse, ChatFileDiff, ChatPermissionApprovalResponse,
        ChatRuntimeStatus, ChatSteerInput, ChatSteerResult, ChatStreamFrame, ChatStreamRequest,
        ChatStreamStopResult, ChatToolInterruptResult, PromptPredictionRequest,
        PromptPredictionResponse,
    },
};
use codez_core::{AppError, SessionId, StreamId, ToolCallId, WorkspaceRoot};
use codez_runtime::edit_transaction::{EditTransactionFileDiff, EditTransactionService};
use tauri::{AppHandle, State, ipc::Channel};

use crate::{
    chat_compaction::compact_chat_session,
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
    let workspace_root = command_result(
        &state.errors,
        resolve_chat_workspace_root(request.workspace_root.as_deref()).await,
    )?;
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
            workspace_root,
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
    let tool_call_id = command_result(
        &state.errors,
        ToolCallId::parse(tool_call_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    Ok(state.chat_runtime.interrupt_tool(&tool_call_id))
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, instructions))]
pub async fn chat_compact(
    state: State<'_, AppState>,
    session_id: String,
    instructions: Option<String>,
) -> Result<ChatCompactionResponse, CommandError> {
    let session_id = command_result(
        &state.errors,
        SessionId::parse(session_id).map_err(|error| AppError::validation(error.to_string())),
    )?;
    if state
        .chat_runtime
        .runtime_status(&session_id)
        .main_runner_active
    {
        return command_result(
            &state.errors,
            Err(AppError::conflict(
                "Stop the active chat run before compacting its session",
            )),
        );
    }
    command_result(
        &state.errors,
        compact_chat_session(
            Arc::clone(&state.provider_service),
            Arc::clone(&state.model_ledger),
            state.cancellation.application_token(),
            session_id,
            instructions,
        )
        .await,
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, tx_id, file_path))]
pub async fn chat_accept_file(
    state: State<'_, AppState>,
    tx_id: String,
    file_path: String,
) -> Result<bool, CommandError> {
    let result = accept_transaction_file(state.edit_transaction.as_ref(), &tx_id, &file_path).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, tx_id, file_path))]
pub async fn chat_reject_file(
    state: State<'_, AppState>,
    tx_id: String,
    file_path: String,
) -> Result<bool, CommandError> {
    let result = reject_transaction_file(state.edit_transaction.as_ref(), &tx_id, &file_path).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, tx_id))]
pub async fn chat_get_diff(
    state: State<'_, AppState>,
    tx_id: String,
) -> Result<Vec<ChatFileDiff>, CommandError> {
    let result = get_transaction_diffs(state.edit_transaction.as_ref(), &tx_id).await;
    command_result(&state.errors, result)
}

async fn accept_transaction_file(
    service: &EditTransactionService,
    tx_id: &str,
    file_path: &str,
) -> Result<bool, AppError> {
    validate_transaction_input(tx_id, file_path)?;
    service.accept_file(tx_id, Path::new(file_path)).await
}

async fn reject_transaction_file(
    service: &EditTransactionService,
    tx_id: &str,
    file_path: &str,
) -> Result<bool, AppError> {
    validate_transaction_input(tx_id, file_path)?;
    service.reject_file(tx_id, Path::new(file_path)).await
}

async fn get_transaction_diffs(
    service: &EditTransactionService,
    tx_id: &str,
) -> Result<Vec<ChatFileDiff>, AppError> {
    validate_transaction_id(tx_id)?;
    service
        .get_diffs(tx_id)
        .await?
        .into_iter()
        .map(chat_file_diff_from_runtime)
        .collect()
}

fn chat_file_diff_from_runtime(diff: EditTransactionFileDiff) -> Result<ChatFileDiff, AppError> {
    let EditTransactionFileDiff { path, diff, .. } = diff;
    let path = path.into_os_string().into_string().map_err(|_| {
        AppError::validation(
            "An edit transaction path cannot be represented in the desktop contract",
        )
    })?;

    Ok(ChatFileDiff { path, diff })
}

fn validate_transaction_input(tx_id: &str, file_path: &str) -> Result<(), AppError> {
    if tx_id.trim().is_empty() || file_path.trim().is_empty() {
        return Err(AppError::validation(
            "A transaction ID and file path are required",
        ));
    }
    validate_transaction_id(tx_id)
}

fn validate_transaction_id(tx_id: &str) -> Result<(), AppError> {
    if tx_id.trim().is_empty() {
        return Err(AppError::validation("A transaction ID is required"));
    }
    if tx_id == "."
        || tx_id == ".."
        || tx_id.contains('/')
        || tx_id.contains('\\')
        || tx_id.contains('\0')
    {
        return Err(AppError::validation("The transaction ID is malformed"));
    }
    Ok(())
}

async fn resolve_chat_workspace_root(
    workspace_root: Option<&str>,
) -> Result<Option<WorkspaceRoot>, AppError> {
    let Some(workspace_root) = workspace_root else {
        return Ok(None);
    };
    if workspace_root.trim().is_empty() || workspace_root.len() > 32 * 1024 {
        return Err(AppError::validation("The chat workspace path is invalid"));
    }
    let canonical = tokio::fs::canonicalize(Path::new(workspace_root))
        .await
        .map_err(|error| {
            AppError::validation(format!("The chat workspace cannot be resolved: {error}"))
        })?;
    let metadata = tokio::fs::metadata(&canonical).await.map_err(|error| {
        AppError::validation(format!("The chat workspace cannot be inspected: {error}"))
    })?;
    if !metadata.is_dir() {
        return Err(AppError::validation(
            "The chat workspace must be an existing directory",
        ));
    }
    WorkspaceRoot::from_canonical(canonical)
        .map(Some)
        .map_err(|error| AppError::validation(error.to_string()))
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
    command_result(
        &state.errors,
        state
            .chat_runtime
            .respond_permission_approval(&request_id, response),
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, answers))]
pub fn chat_respond_ask_user(
    state: State<'_, AppState>,
    request_id: String,
    answers: Vec<ChatAskUserAnswer>,
) -> Result<(), CommandError> {
    if request_id.trim().is_empty() {
        return command_result(
            &state.errors,
            Err(AppError::validation("An ask-user request ID is required")),
        );
    }
    command_result(
        &state.errors,
        state.chat_runtime.respond_ask_user(&request_id, answers),
    )
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };

    use codez_contracts::ErrorCode;
    use codez_core::AppPaths;
    use codez_runtime::edit_transaction::EditTransactionService;
    use tempfile::TempDir;
    use tokio::fs;

    use crate::error::{ErrorReporter, command_result};

    use super::{
        accept_transaction_file, get_transaction_diffs, reject_transaction_file,
        resolve_chat_workspace_root,
    };

    fn app_paths(root: &Path) -> Arc<AppPaths> {
        Arc::new(
            AppPaths::new(
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
            )
            .expect("temporary test paths must be absolute"),
        )
    }

    async fn transaction_fixture() -> (TempDir, EditTransactionService, String, PathBuf) {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let root = temp_dir.path().to_path_buf();
        let service = EditTransactionService::new(app_paths(&root));
        let tx_id = "desktop-edit-transaction".to_owned();
        service
            .register_transaction(&tx_id, "session-test")
            .await
            .expect("edit transaction must be registered");
        (temp_dir, service, tx_id, root)
    }

    #[tokio::test]
    async fn chat_workspace_resolution_keeps_tools_disabled_when_no_workspace_is_supplied() {
        let root = resolve_chat_workspace_root(None)
            .await
            .expect("an omitted workspace must keep normal chat available");

        assert!(root.is_none());
    }

    #[tokio::test]
    async fn chat_workspace_resolution_canonicalizes_an_existing_directory() {
        let directory = tempfile::tempdir().expect("temporary workspace directory must exist");
        let expected = fs::canonicalize(directory.path())
            .await
            .expect("temporary workspace must canonicalize");

        let root = resolve_chat_workspace_root(directory.path().to_str())
            .await
            .expect("existing workspace must become typed authority")
            .expect("a supplied workspace must be retained");

        assert_eq!(root.as_path(), expected);
    }

    async fn stage_file_mutation(
        service: &EditTransactionService,
        tx_id: &str,
        file_path: &Path,
        original: &str,
        changed: &str,
    ) {
        fs::write(file_path, original)
            .await
            .expect("original test file must be written");
        assert!(
            service
                .backup_file(tx_id, file_path, Some(original.to_owned()))
                .await
                .expect("edit backup must be staged")
        );
        fs::write(file_path, changed)
            .await
            .expect("changed test file must be written");
        service
            .record_mutation(tx_id, file_path.to_path_buf(), true)
            .await
            .expect("edit mutation must be recorded");
    }

    #[tokio::test]
    async fn accept_file_boundary_commits_a_registered_mutation() {
        let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
        let file_path = root.join("accepted.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;

        let accepted = accept_transaction_file(&service, &tx_id, &file_path_text)
            .await
            .expect("accept boundary must resolve the transaction");

        assert!(accepted);
        assert_eq!(
            fs::read_to_string(&file_path)
                .await
                .expect("accepted file must remain readable"),
            "after\n"
        );
    }

    #[tokio::test]
    async fn reject_file_boundary_restores_a_registered_mutation() {
        let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
        let file_path = root.join("rejected.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;

        let rejected = reject_transaction_file(&service, &tx_id, &file_path_text)
            .await
            .expect("reject boundary must resolve the transaction");

        assert!(rejected);
        assert_eq!(
            fs::read_to_string(&file_path)
                .await
                .expect("restored file must be readable"),
            "before\n"
        );
    }

    #[tokio::test]
    async fn diff_boundary_maps_the_runtime_path_and_diff() {
        let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
        let file_path = root.join("diff.txt");
        let expected_path = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;

        let diffs = get_transaction_diffs(&service, &tx_id)
            .await
            .expect("diff boundary must resolve the transaction");
        let [diff] = diffs.as_slice() else {
            panic!("one tracked file must produce one desktop diff");
        };

        assert_eq!(diff.path, expected_path);
        assert!(diff.diff.contains("-before") && diff.diff.contains("+after"));
    }

    #[tokio::test]
    async fn accept_file_boundary_maps_empty_input_to_a_validation_error() {
        let (_temp_dir, service, _tx_id, _root) = transaction_fixture().await;
        let reporter = ErrorReporter::default();
        let error = command_result(&reporter, accept_transaction_file(&service, " ", " ").await)
            .expect_err("empty transaction input must be rejected");

        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[tokio::test]
    async fn diff_boundary_maps_malformed_transaction_ids_to_validation_errors() {
        let (_temp_dir, service, _tx_id, _root) = transaction_fixture().await;
        let reporter = ErrorReporter::default();
        let error = command_result(
            &reporter,
            get_transaction_diffs(&service, "../escape").await,
        )
        .expect_err("path-like transaction IDs must be rejected");

        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[tokio::test]
    async fn accept_file_boundary_maps_relative_paths_to_a_validation_error() {
        let (_temp_dir, service, tx_id, _root) = transaction_fixture().await;
        let reporter = ErrorReporter::default();
        let error = command_result(
            &reporter,
            accept_transaction_file(&service, &tx_id, "relative.txt").await,
        )
        .expect_err("relative paths must be rejected");

        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[tokio::test]
    async fn unknown_transaction_operations_are_harmless_no_ops() {
        let (_temp_dir, service, _tx_id, root) = transaction_fixture().await;
        let file_path = root.join("untracked.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();

        let rejected = reject_transaction_file(&service, "unknown-transaction", &file_path_text)
            .await
            .expect("unknown transaction rejection must be harmless");

        assert!(!rejected);
    }

    #[tokio::test]
    async fn unknown_transaction_diffs_are_an_empty_no_op() {
        let (_temp_dir, service, _tx_id, _root) = transaction_fixture().await;

        let diffs = get_transaction_diffs(&service, "unknown-transaction")
            .await
            .expect("unknown transaction diff lookup must be harmless");

        assert!(diffs.is_empty());
    }

    #[tokio::test]
    async fn reject_file_boundary_maps_external_edit_conflicts_to_contract_errors() {
        let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
        let file_path = root.join("conflict.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;
        fs::write(&file_path, "external\n")
            .await
            .expect("external edit must be written");
        let reporter = ErrorReporter::default();
        let error = command_result(
            &reporter,
            reject_transaction_file(&service, &tx_id, &file_path_text).await,
        )
        .expect_err("external edits must not be overwritten");

        assert_eq!(error.code, ErrorCode::Conflict);
    }
}
