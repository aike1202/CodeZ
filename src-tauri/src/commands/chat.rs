use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_contracts::{
    CommandError, ErrorCode,
    chat::{
        ChatAskUserAnswer, ChatCompactionResponse, ChatFileDiff, ChatHistoryRevertPreview,
        ChatHistoryRevertResult, ChatPermissionApprovalResponse, ChatRuntimeStatus, ChatSteerInput,
        ChatSteerResult, ChatStreamFrame, ChatStreamRequest, ChatStreamStopResult,
        ChatToolInterruptResult, PromptPredictionRequest, PromptPredictionResponse,
    },
};
use codez_core::{
    AppError, SessionId, StreamId, ToolCallId, WorkspaceRoot, context::ContextScopeId,
};
use codez_runtime::{
    edit_transaction::{
        EditTransactionFileDiff, EditTransactionRevertPreview, EditTransactionService,
    },
    history_revert::{
        HistoryRevertError, HistoryRevertErrorCode, HistoryRevertRequest, HistoryRevertService,
    },
    mutation_coordinator::FileMutationCoordinator,
    session_maintenance::{
        SessionActivityLease, SessionMaintenanceCoordinator, SessionMaintenanceLease,
    },
};
use tauri::{AppHandle, State, ipc::Channel};

use crate::{
    chat_compaction::compact_chat_session,
    chat_runtime::{ProviderRunStart, predict_next_input, validate_stream_request},
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
    let session_id = command_result(
        &state.errors,
        SessionId::parse(request.session_id.clone())
            .map_err(|error| AppError::validation(error.to_string())),
    )?;
    let activity = command_result(
        &state.errors,
        state
            .session_maintenance
            .try_begin_activity(session_id)
            .map_err(AppError::from),
    )?;
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
        state
            .chat_runtime
            .start_provider_run(
                app,
                ProviderRunStart {
                    providers: Arc::clone(&state.provider_service),
                    request,
                    resolved,
                    workspace_root,
                    events,
                    activity,
                },
            )
            .await,
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
    let exclusive_activity = command_result(
        &state.errors,
        state
            .session_maintenance
            .try_begin_exclusive_activity(session_id)
            .map_err(AppError::from),
    )?;
    command_result(
        &state.errors,
        compact_chat_session(
            Arc::clone(&state.provider_service),
            Arc::clone(&state.model_ledger),
            state.cancellation.application_token(),
            exclusive_activity,
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
    let result = accept_transaction_file(
        state.edit_transaction.as_ref(),
        state.session_maintenance.as_ref(),
        state.mutation_coordinator.as_ref(),
        &tx_id,
        &file_path,
    )
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, tx_id, file_path))]
pub async fn chat_reject_file(
    state: State<'_, AppState>,
    tx_id: String,
    file_path: String,
) -> Result<bool, CommandError> {
    let result = reject_transaction_file(
        state.edit_transaction.as_ref(),
        state.session_maintenance.as_ref(),
        state.mutation_coordinator.as_ref(),
        &tx_id,
        &file_path,
    )
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, tx_id))]
pub async fn chat_get_diff(
    state: State<'_, AppState>,
    tx_id: String,
) -> Result<Vec<ChatFileDiff>, CommandError> {
    let result = get_transaction_diffs(
        state.edit_transaction.as_ref(),
        state.session_maintenance.as_ref(),
        &tx_id,
    )
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, transaction_ids))]
pub async fn chat_preview_history_revert(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
    transaction_ids: Vec<String>,
) -> Result<ChatHistoryRevertPreview, CommandError> {
    let result = preview_history_revert(&state, &session_id, &message_id, &transaction_ids).await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, transaction_ids))]
pub async fn chat_revert_history(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
    transaction_ids: Vec<String>,
) -> Result<ChatHistoryRevertResult, CommandError> {
    revert_history(
        state.history_revert.as_ref(),
        state.session_maintenance.as_ref(),
        state.errors.as_ref(),
        &session_id,
        &message_id,
        &transaction_ids,
    )
    .await
}

async fn preview_history_revert(
    state: &AppState,
    session_id: &str,
    message_id: &str,
    transaction_ids: &[String],
) -> Result<ChatHistoryRevertPreview, AppError> {
    let maintenance = begin_history_maintenance(state, session_id)?;
    let session_id = maintenance.session_id();
    state
        .model_ledger
        .plan_history_revert(session_id, &ContextScopeId::Main, message_id)
        .await?;
    let preview = state
        .edit_transaction
        .preview_revert_transactions(session_id.as_str(), transaction_ids)
        .await?;
    history_revert_preview_from_runtime(preview)
}

async fn revert_history(
    history_revert: &HistoryRevertService,
    coordinator: &SessionMaintenanceCoordinator,
    reporter: &crate::error::ErrorReporter,
    session_id: &str,
    message_id: &str,
    transaction_ids: &[String],
) -> Result<ChatHistoryRevertResult, CommandError> {
    let session_id = command_result(
        reporter,
        SessionId::parse(session_id.to_owned())
            .map_err(|error| AppError::validation(error.to_string())),
    )?;
    let maintenance = command_result(
        reporter,
        acquire_history_maintenance(coordinator, session_id),
    )?;
    let request = HistoryRevertRequest {
        session_id: maintenance.session_id().clone(),
        context_scope_id: ContextScopeId::Main,
        target_ui_message_id: message_id.to_owned(),
        transaction_ids: transaction_ids.to_vec(),
    };
    match history_revert.execute(request).await {
        Ok(result) => Ok(ChatHistoryRevertResult {
            history_version: result.history_version,
        }),
        Err(error) => {
            if error.code() == HistoryRevertErrorCode::RecoveryRequired
                && let Err(marker_error) =
                    coordinator.mark_recovery_required(maintenance.session_id())
            {
                return Err(reporter.report_as(
                    AppError::internal(format!(
                        "History revert recovery could not be blocked for session {}: {marker_error}",
                        maintenance.session_id().as_str()
                    )),
                    ErrorCode::RecoveryRequired,
                    true,
                ));
            }
            Err(report_history_revert_error(reporter, error))
        }
    }
}

fn begin_history_maintenance(
    state: &AppState,
    session_id: &str,
) -> Result<SessionMaintenanceLease, AppError> {
    let session_id =
        SessionId::parse(session_id).map_err(|error| AppError::validation(error.to_string()))?;
    acquire_history_maintenance(&state.session_maintenance, session_id)
}

fn acquire_history_maintenance(
    coordinator: &SessionMaintenanceCoordinator,
    session_id: SessionId,
) -> Result<SessionMaintenanceLease, AppError> {
    coordinator
        .try_begin_maintenance(session_id)
        .map_err(AppError::from)
}

fn report_history_revert_error(
    reporter: &crate::error::ErrorReporter,
    error: HistoryRevertError,
) -> CommandError {
    let code = error.code();
    let app_error = AppError::from(error);
    match code {
        HistoryRevertErrorCode::Validation => reporter.report(app_error),
        HistoryRevertErrorCode::HistoryRevertStale => {
            reporter.report_as(app_error, ErrorCode::HistoryRevertStale, true)
        }
        HistoryRevertErrorCode::RecoveryRequired => {
            reporter.report_as(app_error, ErrorCode::RecoveryRequired, true)
        }
    }
}

fn history_revert_preview_from_runtime(
    preview: EditTransactionRevertPreview,
) -> Result<ChatHistoryRevertPreview, AppError> {
    Ok(ChatHistoryRevertPreview {
        to_delete: desktop_paths(preview.to_delete, "history revert")?,
        to_restore: desktop_paths(preview.to_restore, "history revert")?,
    })
}

fn desktop_paths(paths: Vec<PathBuf>, operation: &str) -> Result<Vec<String>, AppError> {
    paths
        .into_iter()
        .map(|path| desktop_path(path, operation))
        .collect()
}

fn desktop_path(path: PathBuf, operation: &str) -> Result<String, AppError> {
    path.into_os_string().into_string().map_err(|_| {
        AppError::validation(format!(
            "A {operation} path cannot be represented in the desktop contract"
        ))
    })
}

async fn accept_transaction_file(
    service: &EditTransactionService,
    session_maintenance: &SessionMaintenanceCoordinator,
    mutation_coordinator: &FileMutationCoordinator,
    tx_id: &str,
    file_path: &str,
) -> Result<bool, AppError> {
    validate_transaction_input(tx_id, file_path)?;
    let _activity = acquire_transaction_activity(service, session_maintenance, tx_id).await?;
    mutation_coordinator
        .run(
            Path::new(file_path),
            || service.accept_file(tx_id, Path::new(file_path)),
            None,
        )
        .await
}

async fn reject_transaction_file(
    service: &EditTransactionService,
    session_maintenance: &SessionMaintenanceCoordinator,
    mutation_coordinator: &FileMutationCoordinator,
    tx_id: &str,
    file_path: &str,
) -> Result<bool, AppError> {
    validate_transaction_input(tx_id, file_path)?;
    let _activity = acquire_transaction_activity(service, session_maintenance, tx_id).await?;
    mutation_coordinator
        .run(
            Path::new(file_path),
            || service.reject_file(tx_id, Path::new(file_path)),
            None,
        )
        .await
}

async fn get_transaction_diffs(
    service: &EditTransactionService,
    session_maintenance: &SessionMaintenanceCoordinator,
    tx_id: &str,
) -> Result<Vec<ChatFileDiff>, AppError> {
    validate_transaction_id(tx_id)?;
    let _activity = acquire_transaction_activity(service, session_maintenance, tx_id).await?;
    service
        .get_diffs(tx_id)
        .await?
        .into_iter()
        .map(chat_file_diff_from_runtime)
        .collect()
}

async fn acquire_transaction_activity(
    service: &EditTransactionService,
    session_maintenance: &SessionMaintenanceCoordinator,
    tx_id: &str,
) -> Result<SessionActivityLease, AppError> {
    let hint = service.lookup_transaction_activity_hint(tx_id).await?;
    let activity = session_maintenance
        .try_begin_activity(hint.session_id.clone())
        .map_err(AppError::from)?;
    let provenance = service
        .lookup_transaction_provenance_with_hint(tx_id, &hint)
        .await?;
    if &provenance.session_id != activity.session_id() {
        return Err(AppError::conflict(format!(
            "Edit transaction {tx_id} session changed while acquiring activity"
        )));
    }
    Ok(activity)
}

fn chat_file_diff_from_runtime(diff: EditTransactionFileDiff) -> Result<ChatFileDiff, AppError> {
    let EditTransactionFileDiff { path, diff, .. } = diff;
    let path = desktop_path(path, "edit transaction")?;

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

    use async_trait::async_trait;
    use codez_contracts::ErrorCode;
    use codez_core::{
        AppError, AppPaths, AtomicPersistence, SessionId, StreamId, WorkspaceRoot,
        context::{ContextScopeId, LedgerAppendRequest, LedgerEventType},
    };
    use codez_runtime::{
        context::ledger::ModelLedgerStore,
        edit_transaction::{EditTransactionRegistration, EditTransactionService},
        history_revert::{
            HistoryRevertError, HistoryRevertOperation, HistoryRevertService,
            HistoryRevertWorkspace, HistoryRevertWorkspaceOutcome,
        },
        mutation_coordinator::FileMutationCoordinator,
        session_maintenance::{SessionMaintenanceCoordinator, SessionMaintenanceError},
    };
    use codez_storage::AtomicFileStore;
    use tempfile::TempDir;
    use tokio::fs;

    use crate::error::{ErrorReporter, command_result};

    use super::{
        accept_transaction_file, acquire_history_maintenance, get_transaction_diffs,
        reject_transaction_file, report_history_revert_error, resolve_chat_workspace_root,
        revert_history,
    };

    struct FailingHistoryWorkspace;

    #[async_trait]
    impl HistoryRevertWorkspace for FailingHistoryWorkspace {
        async fn prepare_backup(
            &self,
            _operation: &HistoryRevertOperation,
        ) -> Result<(), AppError> {
            Ok(())
        }

        async fn apply_revert(&self, _operation: &HistoryRevertOperation) -> Result<(), AppError> {
            Err(AppError::storage(
                "The history revert workspace is unavailable",
                "injected apply failure",
                true,
            ))
        }

        async fn rollback_revert(
            &self,
            _operation: &HistoryRevertOperation,
        ) -> Result<(), AppError> {
            Ok(())
        }

        async fn finalize_backup(
            &self,
            _operation: &HistoryRevertOperation,
            _outcome: HistoryRevertWorkspaceOutcome,
        ) -> Result<(), AppError> {
            Ok(())
        }
    }

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

    async fn transaction_fixture() -> (
        TempDir,
        EditTransactionService,
        SessionMaintenanceCoordinator,
        FileMutationCoordinator,
        String,
        PathBuf,
    ) {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let root = temp_dir.path().to_path_buf();
        let service = EditTransactionService::new(app_paths(&root));
        let tx_id = "desktop-edit-transaction".to_owned();
        service
            .register_transaction(&tx_id, "session-test")
            .await
            .expect("edit transaction must be registered");
        (
            temp_dir,
            service,
            SessionMaintenanceCoordinator::new(),
            FileMutationCoordinator::new(),
            tx_id,
            root,
        )
    }

    fn ledger_request(
        session_id: &SessionId,
        event_id: &str,
        message_id: &str,
        ui_message_id: &str,
    ) -> LedgerAppendRequest {
        LedgerAppendRequest {
            event_id: event_id.to_owned(),
            session_id: session_id.as_str().to_owned(),
            context_scope_id: ContextScopeId::Main,
            turn_id: Some("turn-history".to_owned()),
            created_at: "2026-07-17T00:00:00.000Z".to_owned(),
            r#type: LedgerEventType::UserMessage,
            payload: serde_json::json!({
                "message": {
                    "id": message_id,
                    "clientMessageId": ui_message_id,
                    "turnId": "turn-history",
                    "role": "user",
                    "content": message_id,
                    "status": "complete",
                    "createdAt": "2026-07-17T00:00:00.000Z"
                },
                "providerId": "provider-history",
                "model": "model-history"
            }),
        }
    }

    fn history_service_fixture(
        root: &Path,
        workspace: Arc<dyn HistoryRevertWorkspace>,
    ) -> (Arc<ModelLedgerStore>, HistoryRevertService) {
        let storage = Arc::new(AtomicFileStore::default());
        let persistence: Arc<dyn AtomicPersistence> = storage;
        let ledger = Arc::new(ModelLedgerStore::new(
            root.join("session-runtime"),
            Arc::clone(&persistence),
        ));
        let service = HistoryRevertService::new(root, persistence, Arc::clone(&ledger), workspace);
        (ledger, service)
    }

    async fn seed_history(ledger: &ModelLedgerStore, session_id: &SessionId) {
        ledger
            .append_event(ledger_request(
                session_id,
                "event-history-1",
                "message-history-1",
                "ui-history-1",
            ))
            .await
            .expect("first history message must persist");
        ledger
            .append_event(ledger_request(
                session_id,
                "event-history-2",
                "message-history-2",
                "ui-history-2",
            ))
            .await
            .expect("target history message must persist");
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

    #[test]
    fn history_maintenance_maps_active_work_to_retryable_run_active_command_error() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let session_id = SessionId::parse("session-1").expect("fixture session ID must parse");
        let _activity = coordinator
            .try_begin_activity(session_id.clone())
            .expect("fixture activity must begin");

        let app_error = acquire_history_maintenance(&coordinator, session_id)
            .expect_err("active work must block history maintenance");
        let reporter = ErrorReporter::default();
        let error = command_result::<()>(&reporter, Err(app_error))
            .expect_err("active work must map to a desktop command error");

        assert_eq!((error.code, error.retryable), (ErrorCode::RunActive, true));
    }

    #[tokio::test]
    async fn history_revert_command_uses_the_real_edit_transaction_workspace_adapter() {
        let temp = tempfile::tempdir().expect("history command fixture must exist");
        let root = temp.path().to_path_buf();
        let workspace_directory = root.join("workspace");
        fs::create_dir(&workspace_directory)
            .await
            .expect("workspace fixture must be created");
        let canonical_workspace = fs::canonicalize(&workspace_directory)
            .await
            .expect("workspace fixture must canonicalize");
        let workspace_root = WorkspaceRoot::from_canonical(canonical_workspace)
            .expect("canonical workspace must be valid authority");
        let session_id = SessionId::parse("session-history-command")
            .expect("history fixture session must parse");
        let edit_transaction = Arc::new(EditTransactionService::new(app_paths(&root)));
        edit_transaction
            .register_chat_transaction(
                "transaction-history-command",
                EditTransactionRegistration {
                    session_id: session_id.clone(),
                    context_scope_id: ContextScopeId::Main,
                    turn_id: StreamId::parse("turn-history")
                        .expect("history fixture turn must parse"),
                    workspace_root,
                },
            )
            .await
            .expect("history transaction must register");
        let file_path = workspace_directory.join("tracked.txt");
        stage_file_mutation(
            edit_transaction.as_ref(),
            "transaction-history-command",
            &file_path,
            "before\n",
            "after\n",
        )
        .await;
        let workspace_port: Arc<dyn HistoryRevertWorkspace> =
            Arc::<EditTransactionService>::clone(&edit_transaction);
        let (ledger, history_revert) = history_service_fixture(&root, workspace_port);
        seed_history(&ledger, &session_id).await;
        let maintenance = SessionMaintenanceCoordinator::new();
        let reporter = ErrorReporter::default();

        let result = revert_history(
            &history_revert,
            &maintenance,
            &reporter,
            session_id.as_str(),
            "ui-history-2",
            &["transaction-history-command".to_owned()],
        )
        .await
        .expect("history command must finish the durable revert");

        assert_eq!(result.history_version, 3);
        assert_eq!(
            fs::read_to_string(&file_path)
                .await
                .expect("reverted workspace file must remain readable"),
            "before\n"
        );
        assert!(
            edit_transaction
                .lookup_transaction_provenance("transaction-history-command")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn recovery_required_command_error_leaves_the_session_blocked() {
        let temp = tempfile::tempdir().expect("recovery command fixture must exist");
        let root = temp.path().to_path_buf();
        let workspace: Arc<dyn HistoryRevertWorkspace> = Arc::new(FailingHistoryWorkspace);
        let (ledger, history_revert) = history_service_fixture(&root, workspace);
        let session_id = SessionId::parse("session-history-recovery")
            .expect("recovery fixture session must parse");
        seed_history(&ledger, &session_id).await;
        let maintenance = SessionMaintenanceCoordinator::new();
        let reporter = ErrorReporter::default();

        let error = revert_history(
            &history_revert,
            &maintenance,
            &reporter,
            session_id.as_str(),
            "ui-history-2",
            &[],
        )
        .await
        .expect_err("workspace failure must require durable recovery");

        assert_eq!(
            (error.code, error.retryable),
            (ErrorCode::RecoveryRequired, true)
        );
        assert!(matches!(
            maintenance.try_begin_activity(session_id),
            Err(SessionMaintenanceError::RecoveryRequired)
        ));
    }

    #[test]
    fn stale_history_revert_maps_to_the_typed_desktop_error() {
        let reporter = ErrorReporter::default();

        let error = report_history_revert_error(
            &reporter,
            HistoryRevertError::Stale {
                operation_id: "history-revert-stale".to_owned(),
                expected: 2,
                actual: 3,
            },
        );

        assert_eq!(
            (error.code, error.retryable),
            (ErrorCode::HistoryRevertStale, true)
        );
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
        let (_temp_dir, service, maintenance, mutations, tx_id, root) = transaction_fixture().await;
        let file_path = root.join("accepted.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;

        let accepted =
            accept_transaction_file(&service, &maintenance, &mutations, &tx_id, &file_path_text)
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
        let (_temp_dir, service, maintenance, mutations, tx_id, root) = transaction_fixture().await;
        let file_path = root.join("rejected.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;

        let rejected =
            reject_transaction_file(&service, &maintenance, &mutations, &tx_id, &file_path_text)
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
        let (_temp_dir, service, maintenance, _mutations, tx_id, root) =
            transaction_fixture().await;
        let file_path = root.join("diff.txt");
        let expected_path = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;

        let diffs = get_transaction_diffs(&service, &maintenance, &tx_id)
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
        let (_temp_dir, service, maintenance, mutations, _tx_id, _root) =
            transaction_fixture().await;
        let reporter = ErrorReporter::default();
        let error = command_result(
            &reporter,
            accept_transaction_file(&service, &maintenance, &mutations, " ", " ").await,
        )
        .expect_err("empty transaction input must be rejected");

        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[tokio::test]
    async fn diff_boundary_maps_malformed_transaction_ids_to_validation_errors() {
        let (_temp_dir, service, maintenance, _mutations, _tx_id, _root) =
            transaction_fixture().await;
        let reporter = ErrorReporter::default();
        let error = command_result(
            &reporter,
            get_transaction_diffs(&service, &maintenance, "../escape").await,
        )
        .expect_err("path-like transaction IDs must be rejected");

        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[tokio::test]
    async fn accept_file_boundary_maps_relative_paths_to_a_validation_error() {
        let (_temp_dir, service, maintenance, mutations, tx_id, _root) =
            transaction_fixture().await;
        let reporter = ErrorReporter::default();
        let error = command_result(
            &reporter,
            accept_transaction_file(&service, &maintenance, &mutations, &tx_id, "relative.txt")
                .await,
        )
        .expect_err("relative paths must be rejected");

        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[tokio::test]
    async fn transaction_boundary_maps_active_maintenance_to_retryable_run_active() {
        let (_temp_dir, service, maintenance, mutations, tx_id, root) = transaction_fixture().await;
        let session_id = SessionId::parse("session-test").expect("fixture session ID must parse");
        let _maintenance_lease = maintenance
            .try_begin_maintenance(session_id)
            .expect("fixture maintenance must begin");
        let file_path = root.join("blocked.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();

        let app_error =
            accept_transaction_file(&service, &maintenance, &mutations, &tx_id, &file_path_text)
                .await
                .expect_err("maintenance must block edit transaction activity");
        let reporter = ErrorReporter::default();
        let error = command_result::<()>(&reporter, Err(app_error))
            .expect_err("active maintenance must map to a desktop command error");

        assert_eq!((error.code, error.retryable), (ErrorCode::RunActive, true));
    }

    #[tokio::test]
    async fn unknown_transaction_operations_return_not_found() {
        let (_temp_dir, service, maintenance, mutations, _tx_id, root) =
            transaction_fixture().await;
        let file_path = root.join("untracked.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();

        let error = reject_transaction_file(
            &service,
            &maintenance,
            &mutations,
            "unknown-transaction",
            &file_path_text,
        )
        .await
        .expect_err("unknown transaction rejection must fail before mutation locking");
        let reporter = ErrorReporter::default();
        let error = command_result::<()>(&reporter, Err(error))
            .expect_err("missing transactions must map to a desktop command error");

        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn unknown_transaction_diffs_return_not_found() {
        let (_temp_dir, service, maintenance, _mutations, _tx_id, _root) =
            transaction_fixture().await;

        let error = get_transaction_diffs(&service, &maintenance, "unknown-transaction")
            .await
            .expect_err("unknown transaction diff lookup must fail before transaction access");
        let reporter = ErrorReporter::default();
        let error = command_result::<()>(&reporter, Err(error))
            .expect_err("missing transactions must map to a desktop command error");

        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn reject_file_boundary_maps_external_edit_conflicts_to_contract_errors() {
        let (_temp_dir, service, maintenance, mutations, tx_id, root) = transaction_fixture().await;
        let file_path = root.join("conflict.txt");
        let file_path_text = file_path.to_string_lossy().into_owned();
        stage_file_mutation(&service, &tx_id, &file_path, "before\n", "after\n").await;
        fs::write(&file_path, "external\n")
            .await
            .expect("external edit must be written");
        let reporter = ErrorReporter::default();
        let error = command_result(
            &reporter,
            reject_transaction_file(&service, &maintenance, &mutations, &tx_id, &file_path_text)
                .await,
        )
        .expect_err("external edits must not be overwritten");

        assert_eq!(error.code, ErrorCode::Conflict);
    }
}
