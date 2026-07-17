use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_core::{AppError, AppPathError, AppPaths, AtomicPersistence};
use codez_mcp::{McpProjectConfigService, McpSecretService, McpUserConfigService};
use codez_platform::ResourceLocator;
use codez_runtime::{
    CancellationTree, HostPreferences, ShutdownCoordinator, SystemService,
    history_revert::{HistoryRevertError, HistoryRevertService, HistoryRevertWorkspace},
    permission::store::{PermissionStoreError, WorkspacePermissionStore},
    session_deletion::SessionDeletionService,
    session_maintenance::{SessionMaintenanceCoordinator, SessionMaintenanceError},
};
use codez_storage::{AtomicFileStore, OsCredentialStore, RecentProjectsStore, SessionStore};
use tauri::{App, Manager};
use thiserror::Error;

use crate::{
    chat_runtime::{ChatPromptSources, ChatRuntime},
    chat_tool_runtime::ChatToolRuntime,
    error::ErrorReporter,
    logging::{self, LoggingError},
    mcp_boundary::StorageMcpSecretStore,
    mcp_runtime::McpRuntimeManager,
    provider_boundary::{StorageProviderCredentials, StorageProviderRepository},
    session_deletion::{SessionDeletionDependencies, desktop_session_deletion_operations},
    state::AppState,
    subagent_runtime::SubAgentRuntime,
};

#[derive(Debug, Error)]
pub(crate) enum CompositionError {
    #[error("failed to resolve {kind} path: {source}")]
    ResolvePath {
        kind: &'static str,
        source: tauri::Error,
    },
    #[error("failed to initialize {kind} directory {path}: {source}")]
    InitializeDirectory {
        kind: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error(transparent)]
    InvalidPaths(#[from] AppPathError),
    #[error(transparent)]
    Logging(#[from] LoggingError),
    #[error("failed to initialize provider storage: {source}")]
    Provider {
        #[source]
        source: AppError,
    },
    #[error("failed to initialize sub-agent runtime: {source}")]
    SubAgentRuntime {
        #[source]
        source: AppError,
    },
    #[error("failed to recover pending session deletion: {source}")]
    SessionDeletionRecovery {
        #[source]
        source: AppError,
    },
    #[error("failed to recover pending history revert: {source}")]
    HistoryRevertRecovery {
        #[source]
        source: Box<HistoryRevertStartupError>,
    },
    #[error("failed to initialize permission storage: {source}")]
    Permission {
        #[from]
        source: PermissionStoreError,
    },
    #[error(transparent)]
    ChatTools(#[from] crate::chat_tool_runtime::ChatToolRuntimeError),
}

pub(crate) fn compose_app_state(
    app: &App,
    pty_tx: tokio::sync::mpsc::Sender<codez_platform::pty::PtyEvent>,
) -> Result<AppState, CompositionError> {
    let path_resolver = app.path();
    let home_directory = resolve_path("user home", path_resolver.home_dir())?;
    let resource_directory = resolve_path("application resource", path_resolver.resource_dir())?;
    let paths = create_app_paths(home_directory, resource_directory)?;

    ensure_directory("application data", paths.data_directory())?;
    ensure_directory("application cache", paths.cache_directory())?;
    ensure_directory("application log", paths.log_directory())?;
    ensure_directory("application temporary", paths.temporary_directory())?;
    let logging = logging::initialize(paths.log_directory())?;
    let storage = Arc::new(AtomicFileStore::default());
    let persistence: Arc<dyn AtomicPersistence> = storage.clone();
    let credentials = Arc::new(OsCredentialStore::default());
    let cancellation = Arc::new(CancellationTree::new());
    let session_maintenance = Arc::new(SessionMaintenanceCoordinator::new());
    let errors = Arc::new(ErrorReporter::default());
    let model_ledger = Arc::new(codez_runtime::context::ledger::ModelLedgerStore::new(
        paths.data_directory().join("session-runtime"),
        Arc::clone(&persistence),
    ));
    let workspace_permissions = Arc::new(WorkspacePermissionStore::new(
        paths.data_directory(),
        Arc::clone(&persistence),
    )?);
    let fingerprint = Arc::new(codez_runtime::fingerprint::ReadFingerprintStore::default());
    let mutation_coordinator =
        Arc::new(codez_runtime::mutation_coordinator::FileMutationCoordinator::default());
    let process_runner = Arc::new(codez_platform::NativeProcessRunner::new());
    let edit_transaction =
        Arc::new(codez_runtime::edit_transaction::EditTransactionService::new(paths.clone()));
    let history_workspace: Arc<dyn HistoryRevertWorkspace> =
        Arc::<codez_runtime::edit_transaction::EditTransactionService>::clone(&edit_transaction);
    let history_revert = Arc::new(HistoryRevertService::new(
        paths.data_directory(),
        Arc::clone(&persistence),
        Arc::clone(&model_ledger),
        history_workspace,
    ));
    tauri::async_runtime::block_on(recover_pending_history_reverts(
        history_revert.as_ref(),
        session_maintenance.as_ref(),
    ))
    .map_err(|source| CompositionError::HistoryRevertRecovery {
        source: Box::new(source),
    })?;
    let chat_tools = Arc::new(ChatToolRuntime::new(
        paths.as_ref(),
        Arc::clone(&persistence),
        Arc::clone(&workspace_permissions),
        Arc::clone(&fingerprint),
        Arc::clone(&mutation_coordinator),
        Arc::clone(&edit_transaction),
    )?);
    let attachment = Arc::new(codez_runtime::attachment::AttachmentService::new(
        paths.clone(),
    ));
    let chat_runtime = Arc::new(ChatRuntime::new(
        Arc::clone(&cancellation),
        Arc::clone(&errors),
        Arc::clone(&model_ledger),
        Arc::clone(&attachment),
        chat_tools,
        Arc::clone(&edit_transaction),
        ChatPromptSources::new(
            paths.data_directory().to_path_buf(),
            Arc::clone(&workspace_permissions),
            process_runner.clone(),
        ),
    ));
    let provider_service = {
        let providers_path = paths.data_directory().join("providers.json");
        let repository = Arc::new(StorageProviderRepository::new(
            Arc::clone(&storage),
            providers_path,
        ));
        let provider_credentials = Arc::new(StorageProviderCredentials::new(credentials.clone()));
        let service = tauri::async_runtime::block_on(
            codez_providers::service::ProviderService::new(repository, provider_credentials),
        )
        .map_err(|source| CompositionError::Provider { source })?;
        Arc::new(service)
    };
    let subagent_runtime = Arc::new(
        SubAgentRuntime::new(
            paths.data_directory(),
            Arc::clone(&persistence),
            Arc::clone(&provider_service),
        )
        .map_err(|source| CompositionError::SubAgentRuntime { source })?,
    );
    let session_deletion = Arc::new(SessionDeletionService::new(
        paths.data_directory(),
        Arc::clone(&persistence),
        desktop_session_deletion_operations(SessionDeletionDependencies {
            chat_runtime: Arc::clone(&chat_runtime),
            history_revert: Arc::clone(&history_revert),
            edit_transaction: Arc::clone(&edit_transaction),
            subagent_runtime: Arc::clone(&subagent_runtime),
            attachment: Arc::clone(&attachment),
            model_ledger: Arc::clone(&model_ledger),
            fingerprint: Arc::clone(&fingerprint),
            session_store: SessionStore::new(
                paths.data_directory().to_path_buf(),
                storage.as_ref().clone(),
            ),
        }),
        Arc::clone(&session_maintenance),
    ));
    tauri::async_runtime::block_on(session_deletion.recover_pending())
        .map_err(|source| CompositionError::SessionDeletionRecovery { source })?;
    let recent_projects = Arc::new(RecentProjectsStore::new(
        paths.data_directory().to_path_buf(),
        storage.as_ref().clone(),
    ));
    let mcp_config = Arc::new(McpUserConfigService::new(
        Arc::clone(&persistence),
        paths.data_directory().join("mcp.json"),
    ));
    let mcp_project_config = Arc::new(McpProjectConfigService::new(
        Arc::clone(&persistence),
        paths.data_directory().join("mcp-project-trust.json"),
    ));
    let mcp_credentials: Arc<dyn codez_storage::CredentialStore> = credentials.clone();
    let mcp_secret_store: Arc<dyn codez_mcp::McpSecretStore> =
        Arc::new(StorageMcpSecretStore::new(mcp_credentials));
    let mcp_secrets = Arc::new(McpSecretService::new(
        Arc::clone(&persistence),
        paths.data_directory().join("mcp-secret-index.json"),
        Arc::clone(&mcp_secret_store),
    ));
    let mcp_runtime = Arc::new(McpRuntimeManager::with_desktop_reverse_requests(
        mcp_secret_store,
        app.handle().clone(),
        Arc::clone(&provider_service),
        cancellation.application_token(),
    ));
    Ok(AppState {
        system: Arc::new(SystemService::new()),
        host_preferences: Arc::new(HostPreferences::new()),
        resources: Arc::new(ResourceLocator::new(
            paths.resource_directory().to_path_buf(),
        )),
        storage: Arc::clone(&storage),
        persistence: Arc::clone(&persistence),
        recent_projects,
        credentials: Arc::clone(&credentials),
        cancellation,
        session_maintenance,
        session_deletion,
        shutdown: Arc::new(ShutdownCoordinator::default()),
        errors,
        attachment,
        fingerprint,
        mutation_coordinator,
        edit_transaction,
        history_revert,
        _logging: logging,
        paths: paths.clone(),
        process_runner,
        pty_manager: Arc::new(codez_platform::PtyManager::new(pty_tx)),
        provider_service,
        subagent_settings: tokio::sync::Mutex::new(()),
        subagent_runtime,
        workspace_permissions,
        mcp_config,
        mcp_project_config,
        mcp_secrets,
        mcp_runtime,
        model_ledger,
        chat_runtime,
    })
}

#[derive(Debug, Error)]
pub(crate) enum HistoryRevertStartupError {
    #[error(transparent)]
    HistoryRevert(#[from] HistoryRevertError),
    #[error("failed to {action} history revert recovery for session {session_id}: {source}")]
    Maintenance {
        action: &'static str,
        session_id: String,
        #[source]
        source: SessionMaintenanceError,
    },
}

async fn recover_pending_history_reverts(
    service: &HistoryRevertService,
    coordinator: &SessionMaintenanceCoordinator,
) -> Result<(), HistoryRevertStartupError> {
    let pending = service.pending_recoveries().await?;
    let mut sessions = Vec::new();
    for operation in pending {
        if !sessions.contains(&operation.session_id) {
            sessions.push(operation.session_id);
        }
    }

    for session_id in &sessions {
        let maintenance = coordinator
            .try_begin_maintenance(session_id.clone())
            .map_err(|source| HistoryRevertStartupError::Maintenance {
                action: "establish a persistent block for",
                session_id: session_id.as_str().to_owned(),
                source,
            })?;
        coordinator
            .mark_recovery_required(maintenance.session_id())
            .map_err(|source| HistoryRevertStartupError::Maintenance {
                action: "mark",
                session_id: session_id.as_str().to_owned(),
                source,
            })?;
    }

    let mut recovery_leases = Vec::with_capacity(sessions.len());
    for session_id in sessions {
        let session_label = session_id.as_str().to_owned();
        recovery_leases.push(
            coordinator
                .try_begin_recovery_maintenance(session_id)
                .map_err(|source| HistoryRevertStartupError::Maintenance {
                    action: "begin",
                    session_id: session_label,
                    source,
                })?,
        );
    }

    service.recover_pending().await?;
    for recovery in &recovery_leases {
        coordinator
            .clear_recovery_required(recovery.session_id())
            .map_err(|source| HistoryRevertStartupError::Maintenance {
                action: "finish",
                session_id: recovery.session_id().as_str().to_owned(),
                source,
            })?;
    }
    Ok(())
}

fn create_app_paths(
    home_directory: PathBuf,
    resource_directory: PathBuf,
) -> Result<Arc<AppPaths>, CompositionError> {
    Ok(Arc::new(AppPaths::for_user_home(
        home_directory,
        resource_directory,
    )?))
}

fn resolve_path(
    kind: &'static str,
    result: Result<PathBuf, tauri::Error>,
) -> Result<PathBuf, CompositionError> {
    result.map_err(|source| CompositionError::ResolvePath { kind, source })
}

fn ensure_directory(kind: &'static str, path: &Path) -> Result<(), CompositionError> {
    fs::create_dir_all(path).map_err(|source| CompositionError::InitializeDirectory {
        kind,
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use async_trait::async_trait;
    use codez_core::{
        AppError, AppPaths, AtomicPersistence, SessionId, StreamId, WorkspaceRoot,
        context::{ContextScopeId, LedgerAppendRequest, LedgerEventType},
    };
    use codez_runtime::{
        context::ledger::ModelLedgerStore,
        edit_transaction::{EditTransactionRegistration, EditTransactionService},
        history_revert::{
            HistoryRevertErrorCode, HistoryRevertOperation, HistoryRevertRequest,
            HistoryRevertService, HistoryRevertWorkspace, HistoryRevertWorkspaceOutcome,
        },
        session_maintenance::{SessionMaintenanceCoordinator, SessionMaintenanceError},
    };
    use codez_storage::AtomicFileStore;
    use tokio::fs;

    use super::{create_app_paths, recover_pending_history_reverts};

    struct ApplyThenFailWorkspace {
        inner: Arc<EditTransactionService>,
        fail_after_apply: AtomicBool,
    }

    #[async_trait]
    impl HistoryRevertWorkspace for ApplyThenFailWorkspace {
        async fn prepare_backup(&self, operation: &HistoryRevertOperation) -> Result<(), AppError> {
            HistoryRevertWorkspace::prepare_backup(self.inner.as_ref(), operation).await
        }

        async fn apply_revert(&self, operation: &HistoryRevertOperation) -> Result<(), AppError> {
            HistoryRevertWorkspace::apply_revert(self.inner.as_ref(), operation).await?;
            if self.fail_after_apply.swap(false, Ordering::SeqCst) {
                return Err(AppError::storage(
                    "The history revert transition was interrupted",
                    "injected crash after workspace apply",
                    true,
                ));
            }
            Ok(())
        }

        async fn rollback_revert(
            &self,
            operation: &HistoryRevertOperation,
        ) -> Result<(), AppError> {
            HistoryRevertWorkspace::rollback_revert(self.inner.as_ref(), operation).await
        }

        async fn finalize_backup(
            &self,
            operation: &HistoryRevertOperation,
            outcome: HistoryRevertWorkspaceOutcome,
        ) -> Result<(), AppError> {
            HistoryRevertWorkspace::finalize_backup(self.inner.as_ref(), operation, outcome).await
        }
    }

    struct AlwaysFailWorkspace;

    #[async_trait]
    impl HistoryRevertWorkspace for AlwaysFailWorkspace {
        async fn prepare_backup(
            &self,
            _operation: &HistoryRevertOperation,
        ) -> Result<(), AppError> {
            Ok(())
        }

        async fn apply_revert(&self, _operation: &HistoryRevertOperation) -> Result<(), AppError> {
            Err(AppError::storage(
                "The history revert workspace is unavailable",
                "injected recovery failure",
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

    fn test_app_paths(root: &Path) -> Arc<AppPaths> {
        Arc::new(
            AppPaths::new(
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
                root.to_path_buf(),
            )
            .expect("temporary startup paths must be absolute"),
        )
    }

    fn test_persistence() -> Arc<dyn AtomicPersistence> {
        Arc::new(AtomicFileStore::default())
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
            turn_id: Some("turn-startup".to_owned()),
            created_at: "2026-07-17T00:00:00.000Z".to_owned(),
            r#type: LedgerEventType::UserMessage,
            payload: serde_json::json!({
                "message": {
                    "id": message_id,
                    "clientMessageId": ui_message_id,
                    "turnId": "turn-startup",
                    "role": "user",
                    "content": message_id,
                    "status": "complete",
                    "createdAt": "2026-07-17T00:00:00.000Z"
                },
                "providerId": "provider-startup",
                "model": "model-startup"
            }),
        }
    }

    async fn seed_history(ledger: &ModelLedgerStore, session_id: &SessionId) {
        ledger
            .append_event(ledger_request(
                session_id,
                "event-startup-1",
                "message-startup-1",
                "ui-startup-1",
            ))
            .await
            .expect("first startup history message must persist");
        ledger
            .append_event(ledger_request(
                session_id,
                "event-startup-2",
                "message-startup-2",
                "ui-startup-2",
            ))
            .await
            .expect("target startup history message must persist");
    }

    async fn stage_file_mutation(
        service: &EditTransactionService,
        transaction_id: &str,
        path: &Path,
    ) {
        fs::write(path, "before\n")
            .await
            .expect("startup original file must be written");
        service
            .backup_file(transaction_id, path, Some("before\n".to_owned()))
            .await
            .expect("startup edit backup must persist");
        fs::write(path, "after\n")
            .await
            .expect("startup changed file must be written");
        service
            .record_mutation(transaction_id, path.to_path_buf(), true)
            .await
            .expect("startup edit mutation must be recorded");
    }

    #[test]
    fn startup_paths_use_only_the_fresh_codez_directory() {
        let home = std::env::temp_dir().join("codez-composition-home");
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");

        let paths = create_app_paths(home.clone(), resources)
            .expect("absolute fixture roots must compose fresh application paths");

        assert_eq!(paths.data_directory(), home.join(".codez"));
    }

    #[tokio::test]
    async fn startup_recovery_resumes_a_real_workspace_adapter_after_restart() {
        let temp = tempfile::tempdir().expect("startup recovery fixture must exist");
        let root = temp.path().to_path_buf();
        let workspace_directory = root.join("workspace");
        fs::create_dir(&workspace_directory)
            .await
            .expect("startup workspace must be created");
        let canonical_workspace = fs::canonicalize(&workspace_directory)
            .await
            .expect("startup workspace must canonicalize");
        let session_id =
            SessionId::parse("session-startup-recovery").expect("startup session must parse");
        let persistence = test_persistence();
        let ledger = Arc::new(ModelLedgerStore::new(
            root.join("session-runtime"),
            Arc::clone(&persistence),
        ));
        seed_history(&ledger, &session_id).await;
        let first_edit_transaction = Arc::new(EditTransactionService::new(test_app_paths(&root)));
        first_edit_transaction
            .register_chat_transaction(
                "transaction-startup-recovery",
                EditTransactionRegistration {
                    session_id: session_id.clone(),
                    context_scope_id: ContextScopeId::Main,
                    turn_id: StreamId::parse("turn-startup").expect("startup turn must parse"),
                    workspace_root: WorkspaceRoot::from_canonical(canonical_workspace)
                        .expect("startup workspace authority must be valid"),
                },
            )
            .await
            .expect("startup transaction must register");
        let tracked_file = workspace_directory.join("tracked.txt");
        stage_file_mutation(
            first_edit_transaction.as_ref(),
            "transaction-startup-recovery",
            &tracked_file,
        )
        .await;
        let interrupted_workspace: Arc<dyn HistoryRevertWorkspace> =
            Arc::new(ApplyThenFailWorkspace {
                inner: Arc::clone(&first_edit_transaction),
                fail_after_apply: AtomicBool::new(true),
            });
        let interrupted_service = HistoryRevertService::new(
            &root,
            Arc::clone(&persistence),
            Arc::clone(&ledger),
            interrupted_workspace,
        );
        let request = HistoryRevertRequest {
            session_id: session_id.clone(),
            context_scope_id: ContextScopeId::Main,
            target_ui_message_id: "ui-startup-2".to_owned(),
            transaction_ids: vec!["transaction-startup-recovery".to_owned()],
        };

        let interrupted = interrupted_service
            .execute(request)
            .await
            .expect_err("injected crash must leave a pending history revert");
        assert_eq!(interrupted.code(), HistoryRevertErrorCode::RecoveryRequired);

        let restarted_edit_transaction =
            Arc::new(EditTransactionService::new(test_app_paths(&root)));
        let restarted_workspace: Arc<dyn HistoryRevertWorkspace> =
            Arc::<EditTransactionService>::clone(&restarted_edit_transaction);
        let restarted_ledger = Arc::new(ModelLedgerStore::new(
            root.join("session-runtime"),
            Arc::clone(&persistence),
        ));
        let restarted_service =
            HistoryRevertService::new(&root, persistence, restarted_ledger, restarted_workspace);
        let coordinator = SessionMaintenanceCoordinator::new();

        recover_pending_history_reverts(&restarted_service, &coordinator)
            .await
            .expect("startup must recover the interrupted real workspace operation");

        assert!(
            restarted_service
                .pending_recoveries()
                .await
                .expect("recovered journal catalog must remain readable")
                .is_empty()
        );
        assert_eq!(
            fs::read_to_string(&tracked_file)
                .await
                .expect("recovered workspace file must remain readable"),
            "before\n"
        );
        assert!(coordinator.try_begin_activity(session_id).is_ok());
    }

    #[tokio::test]
    async fn startup_recovery_failure_keeps_the_session_blocked() {
        let temp = tempfile::tempdir().expect("failed startup recovery fixture must exist");
        let root = temp.path().to_path_buf();
        let session_id = SessionId::parse("session-startup-blocked")
            .expect("blocked startup session must parse");
        let persistence = test_persistence();
        let ledger = Arc::new(ModelLedgerStore::new(
            root.join("session-runtime"),
            Arc::clone(&persistence),
        ));
        seed_history(&ledger, &session_id).await;
        let workspace: Arc<dyn HistoryRevertWorkspace> = Arc::new(AlwaysFailWorkspace);
        let service = HistoryRevertService::new(&root, persistence, ledger, workspace);
        let request = HistoryRevertRequest {
            session_id: session_id.clone(),
            context_scope_id: ContextScopeId::Main,
            target_ui_message_id: "ui-startup-2".to_owned(),
            transaction_ids: Vec::new(),
        };
        service
            .execute(request)
            .await
            .expect_err("fixture history revert must remain pending");
        let coordinator = SessionMaintenanceCoordinator::new();

        recover_pending_history_reverts(&service, &coordinator)
            .await
            .expect_err("startup must fail while durable recovery remains incomplete");

        assert!(matches!(
            coordinator.try_begin_activity(session_id),
            Err(SessionMaintenanceError::RecoveryRequired)
        ));
    }
}
