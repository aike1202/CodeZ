use std::sync::Arc;

use codez_core::{AppError, PortFuture, SessionId};
use codez_runtime::{
    attachment::AttachmentService,
    context::ledger::ModelLedgerStore,
    edit_transaction::EditTransactionService,
    fingerprint::ReadFingerprintStore,
    history_revert::HistoryRevertService,
    session_deletion::{SessionDeletionOperations, SessionDeletionStep},
};
use codez_storage::SessionStore;

use crate::{chat_runtime::ChatRuntime, subagent_runtime::SubAgentRuntime};

pub(crate) struct SessionDeletionDependencies {
    pub(crate) chat_runtime: Arc<ChatRuntime>,
    pub(crate) history_revert: Arc<HistoryRevertService>,
    pub(crate) edit_transaction: Arc<EditTransactionService>,
    pub(crate) subagent_runtime: Arc<SubAgentRuntime>,
    pub(crate) attachment: Arc<AttachmentService>,
    pub(crate) model_ledger: Arc<ModelLedgerStore>,
    pub(crate) fingerprint: Arc<ReadFingerprintStore>,
    pub(crate) session_store: SessionStore,
}

pub(crate) fn desktop_session_deletion_operations(
    dependencies: SessionDeletionDependencies,
) -> Arc<dyn SessionDeletionOperations> {
    Arc::new(DesktopSessionDeletionOperations { dependencies })
}

struct DesktopSessionDeletionOperations {
    dependencies: SessionDeletionDependencies,
}

impl SessionDeletionOperations for DesktopSessionDeletionOperations {
    fn execute<'a>(
        &'a self,
        step: SessionDeletionStep,
        session_id: &'a SessionId,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            match step {
                SessionDeletionStep::Permissions => {
                    self.dependencies
                        .chat_runtime
                        .clear_session_permissions(session_id)
                        .await;
                }
                SessionDeletionStep::EditTransactions => {
                    cleanup_history_and_edit_transactions(
                        self.dependencies.history_revert.as_ref(),
                        self.dependencies.edit_transaction.as_ref(),
                        session_id,
                    )
                    .await?;
                }
                SessionDeletionStep::SubAgentRuns => {
                    self.dependencies
                        .subagent_runtime
                        .cleanup_session(session_id)
                        .await?;
                }
                SessionDeletionStep::Attachments => {
                    self.dependencies
                        .attachment
                        .delete_session(session_id.as_str())
                        .await?;
                }
                SessionDeletionStep::Ledger => {
                    self.dependencies
                        .model_ledger
                        .delete_session(session_id)
                        .await
                        .map_err(AppError::from)?;
                }
                SessionDeletionStep::Fingerprints => {
                    self.dependencies
                        .fingerprint
                        .clear_session(session_id.as_str())
                        .await;
                }
                SessionDeletionStep::SessionDocument => {
                    self.dependencies.session_store.delete(session_id).await?;
                }
            }
            Ok(())
        })
    }
}

async fn cleanup_history_and_edit_transactions(
    history_revert: &HistoryRevertService,
    edit_transaction: &EditTransactionService,
    session_id: &SessionId,
) -> Result<(), AppError> {
    history_revert
        .cleanup_session(session_id)
        .await
        .map_err(AppError::from)?;
    edit_transaction
        .cleanup_session_history_reverts(session_id.as_str())
        .await?;
    edit_transaction.cleanup_session(session_id.as_str()).await
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };

    use async_trait::async_trait;
    use codez_core::{
        AppError, AppPaths, AtomicPersistence, SessionId,
        context::{ContextScopeId, LedgerAppendRequest, LedgerEventType},
    };
    use codez_runtime::{
        context::ledger::ModelLedgerStore,
        edit_transaction::EditTransactionService,
        history_revert::{
            HistoryRevertOperation, HistoryRevertRequest, HistoryRevertService,
            HistoryRevertWorkspace, HistoryRevertWorkspaceOutcome,
        },
    };
    use codez_storage::AtomicFileStore;
    use tokio::fs;

    use super::cleanup_history_and_edit_transactions;

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
                "injected deletion recovery failure",
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
            .expect("temporary deletion paths must be absolute"),
        )
    }

    fn persistence() -> Arc<dyn AtomicPersistence> {
        Arc::new(AtomicFileStore::default())
    }

    fn ledger_request(session_id: &SessionId) -> LedgerAppendRequest {
        LedgerAppendRequest {
            event_id: "event-deletion-history".to_owned(),
            session_id: session_id.as_str().to_owned(),
            context_scope_id: ContextScopeId::Main,
            turn_id: Some("turn-deletion-history".to_owned()),
            created_at: "2026-07-17T00:00:00.000Z".to_owned(),
            r#type: LedgerEventType::UserMessage,
            payload: serde_json::json!({
                "message": {
                    "id": "message-deletion-history",
                    "clientMessageId": "ui-deletion-history",
                    "turnId": "turn-deletion-history",
                    "role": "user",
                    "content": "deletion history",
                    "status": "complete",
                    "createdAt": "2026-07-17T00:00:00.000Z"
                },
                "providerId": "provider-deletion",
                "model": "model-deletion"
            }),
        }
    }

    async fn seed_ledger(ledger: &ModelLedgerStore, session_id: &SessionId) {
        ledger
            .append_event(ledger_request(session_id))
            .await
            .expect("deletion history fixture must persist");
    }

    fn request(session_id: &SessionId) -> HistoryRevertRequest {
        HistoryRevertRequest {
            session_id: session_id.clone(),
            context_scope_id: ContextScopeId::Main,
            target_ui_message_id: "ui-deletion-history".to_owned(),
            transaction_ids: Vec::new(),
        }
    }

    fn journal_path(root: &Path, request: &HistoryRevertRequest) -> PathBuf {
        let operation_id = HistoryRevertService::operation_id(request)
            .expect("deletion history operation ID must be valid");
        root.join("history-reverts")
            .join(format!("{operation_id}.json"))
    }

    #[tokio::test]
    async fn deletion_cleanup_removes_completed_history_and_edit_transaction_state_once() {
        let temp = tempfile::tempdir().expect("deletion cleanup fixture must exist");
        let root = temp.path().to_path_buf();
        let persistence = persistence();
        let ledger = Arc::new(ModelLedgerStore::new(
            root.join("session-runtime"),
            Arc::clone(&persistence),
        ));
        let session_id =
            SessionId::parse("session-deletion-cleanup").expect("deletion session must parse");
        seed_ledger(&ledger, &session_id).await;
        let edit_transaction = Arc::new(EditTransactionService::new(app_paths(&root)));
        edit_transaction
            .register_transaction("transaction-deletion-cleanup", session_id.as_str())
            .await
            .expect("deletion edit transaction must register");
        let workspace: Arc<dyn HistoryRevertWorkspace> =
            Arc::<EditTransactionService>::clone(&edit_transaction);
        let history_revert = HistoryRevertService::new(&root, persistence, ledger, workspace);
        let history_request = request(&session_id);
        let persisted_journal = journal_path(&root, &history_request);
        history_revert
            .execute(history_request)
            .await
            .expect("deletion history operation must finalize");
        assert!(
            fs::try_exists(&persisted_journal)
                .await
                .expect("completed history journal existence must be readable")
        );

        cleanup_history_and_edit_transactions(
            &history_revert,
            edit_transaction.as_ref(),
            &session_id,
        )
        .await
        .expect("session deletion must clean every history and edit resource");

        assert!(
            !fs::try_exists(&persisted_journal)
                .await
                .expect("deleted history journal existence must be readable")
        );
        assert!(
            edit_transaction
                .lookup_transaction_provenance("transaction-deletion-cleanup")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn deletion_cleanup_retains_edit_state_when_history_recovery_is_pending() {
        let temp = tempfile::tempdir().expect("pending deletion fixture must exist");
        let root = temp.path().to_path_buf();
        let persistence = persistence();
        let ledger = Arc::new(ModelLedgerStore::new(
            root.join("session-runtime"),
            Arc::clone(&persistence),
        ));
        let session_id =
            SessionId::parse("session-deletion-pending").expect("pending session must parse");
        seed_ledger(&ledger, &session_id).await;
        let edit_transaction = Arc::new(EditTransactionService::new(app_paths(&root)));
        edit_transaction
            .register_transaction("transaction-deletion-pending", session_id.as_str())
            .await
            .expect("pending deletion edit transaction must register");
        let workspace: Arc<dyn HistoryRevertWorkspace> = Arc::new(AlwaysFailWorkspace);
        let history_revert = HistoryRevertService::new(&root, persistence, ledger, workspace);
        let history_request = request(&session_id);
        history_revert
            .execute(history_request)
            .await
            .expect_err("pending deletion fixture must require recovery");

        cleanup_history_and_edit_transactions(
            &history_revert,
            edit_transaction.as_ref(),
            &session_id,
        )
        .await
        .expect_err("session deletion must retain pending recovery evidence");

        edit_transaction
            .lookup_transaction_provenance("transaction-deletion-pending")
            .await
            .expect("blocked deletion must retain the edit transaction");
    }
}
