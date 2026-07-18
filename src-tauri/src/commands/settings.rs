use std::path::PathBuf;

use codez_contracts::CommandError;
use codez_core::{AppError, SessionId};
use codez_runtime::{
    session_deletion::SessionDeletionService, session_maintenance::SessionMaintenanceCoordinator,
};
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
    let result = async {
        let snapshot = state.session_deletion.begin_list_snapshot()?;
        let sessions = session_store(&state).list().await?;
        state.session_deletion.ensure_list_unchanged(snapshot)?;
        Ok(sessions)
    }
    .await;
    command_result(&state.errors, result)
}

#[command(rename_all = "camelCase")]
pub async fn session_get(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<Value>, CommandError> {
    let result = async {
        let session_id = parse_session_id(&session_id)?;
        let activity = state
            .session_maintenance
            .try_begin_activity(session_id)
            .map_err(AppError::from)?;
        state
            .session_deletion
            .ensure_available(activity.session_id())?;
        session_store(&state).get(activity.session_id()).await
    }
    .await;
    command_result(&state.errors, result)
}

#[command]
pub async fn session_save(state: State<'_, AppState>, session: Value) -> Result<(), CommandError> {
    let result = save_session_document(
        &session_store(&state),
        state.session_maintenance.as_ref(),
        state.session_deletion.as_ref(),
        &session,
    )
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
        delete_session_document(
            &session_store(&state),
            state.session_maintenance.as_ref(),
            state.session_deletion.as_ref(),
            state.fingerprint.as_ref(),
            session_id,
            chrono::Utc::now().timestamp_millis(),
        )
        .await
    }
    .await;
    command_result(&state.errors, result)
}

async fn save_session_document(
    store: &SessionStore,
    maintenance: &SessionMaintenanceCoordinator,
    deletion: &SessionDeletionService,
    session: &Value,
) -> Result<(), AppError> {
    let raw_id = session
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("Session ID is required"))?;
    let session_id = parse_session_id(raw_id)?;
    let activity = maintenance
        .try_begin_activity(session_id)
        .map_err(AppError::from)?;
    deletion.ensure_available(activity.session_id())?;
    store.save(activity.session_id(), session).await
}

async fn delete_session_document(
    store: &SessionStore,
    maintenance: &SessionMaintenanceCoordinator,
    deletion: &SessionDeletionService,
    fingerprint: &codez_runtime::fingerprint::ReadFingerprintStore,
    session_id: SessionId,
    deleted_at: i64,
) -> Result<(), AppError> {
    let fingerprint_session_id = session_id.as_str().to_owned();
    let maintenance = maintenance
        .try_begin_maintenance(session_id)
        .map_err(AppError::from)?;
    deletion.ensure_available(maintenance.session_id())?;
    let Some(mut session) = store.get(maintenance.session_id()).await? else {
        return Err(AppError::not_found("Session was not found"));
    };

    if session.get("isDeleted").and_then(Value::as_bool) != Some(true) {
        let fields = session
            .as_object_mut()
            .ok_or_else(|| AppError::validation("Session document must be an object"))?;
        fields.insert("isDeleted".to_owned(), Value::Bool(true));
        fields.insert("deletedAt".to_owned(), Value::from(deleted_at));
        store.save(maintenance.session_id(), &session).await?;
    } else {
        deletion.delete_with_maintenance(maintenance).await?;
    }

    fingerprint.clear_session(&fingerprint_session_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    use codez_core::{AppErrorKind, AtomicPersistence, PortFuture, SessionId};
    use codez_runtime::{
        fingerprint::ReadFingerprintStore,
        session_deletion::{
            SessionDeletionOperations, SessionDeletionService, SessionDeletionStep,
        },
        session_maintenance::SessionMaintenanceCoordinator,
    };
    use codez_storage::{AtomicFileStore, SessionStore};
    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::{delete_session_document, save_session_document};

    struct SessionResources {
        data_directory: PathBuf,
        files: AtomicFileStore,
        steps: Mutex<Vec<SessionDeletionStep>>,
        attachment_present: AtomicBool,
        ledger_present: AtomicBool,
    }

    impl SessionResources {
        fn steps(&self) -> Vec<SessionDeletionStep> {
            self.steps
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl SessionDeletionOperations for SessionResources {
        fn execute<'a>(
            &'a self,
            step: SessionDeletionStep,
            session_id: &'a SessionId,
        ) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.steps
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(step);
                match step {
                    SessionDeletionStep::Attachments => {
                        self.attachment_present.store(false, Ordering::SeqCst);
                    }
                    SessionDeletionStep::Ledger => {
                        self.ledger_present.store(false, Ordering::SeqCst);
                    }
                    SessionDeletionStep::SessionDocument => {
                        SessionStore::new(self.data_directory.clone(), self.files.clone())
                            .delete(session_id)
                            .await?;
                    }
                    SessionDeletionStep::Permissions
                    | SessionDeletionStep::EditTransactions
                    | SessionDeletionStep::Todos
                    | SessionDeletionStep::Fingerprints => {}
                }
                Ok(())
            })
        }
    }

    struct Fixture {
        _temp: TempDir,
        data_directory: PathBuf,
        store: SessionStore,
        maintenance: Arc<SessionMaintenanceCoordinator>,
        deletion: SessionDeletionService,
        fingerprint: ReadFingerprintStore,
        resources: Arc<SessionResources>,
    }

    impl Fixture {
        async fn new() -> Self {
            let temp = tempfile::tempdir().expect("session fixture data root must exist");
            let data_directory = temp.path().to_path_buf();
            let files = AtomicFileStore::default();
            let persistence: Arc<dyn AtomicPersistence> = Arc::new(files.clone());
            let maintenance = Arc::new(SessionMaintenanceCoordinator::new());
            let resources = Arc::new(SessionResources {
                data_directory: data_directory.clone(),
                files: files.clone(),
                steps: Mutex::new(Vec::new()),
                attachment_present: AtomicBool::new(true),
                ledger_present: AtomicBool::new(true),
            });
            let operations: Arc<dyn SessionDeletionOperations> = resources.clone();
            let deletion = SessionDeletionService::new(
                &data_directory,
                persistence,
                operations,
                Arc::clone(&maintenance),
            );
            let store = SessionStore::new(data_directory.clone(), files);
            let fingerprint = ReadFingerprintStore::default();
            fingerprint.record_delivery(
                session_id().as_str(),
                "main",
                std::path::Path::new("fixture.txt"),
                "fixture-sha",
            );
            store
                .save(&session_id(), &active_session())
                .await
                .expect("fixture session must persist");
            Self {
                _temp: temp,
                data_directory,
                store,
                maintenance,
                deletion,
                fingerprint,
                resources,
            }
        }

        async fn delete(&self, deleted_at: i64) -> Result<(), codez_core::AppError> {
            delete_session_document(
                &self.store,
                self.maintenance.as_ref(),
                &self.deletion,
                &self.fingerprint,
                session_id(),
                deleted_at,
            )
            .await
        }

        fn resources_present(&self) -> bool {
            self.resources.attachment_present.load(Ordering::SeqCst)
                && self.resources.ledger_present.load(Ordering::SeqCst)
        }
    }

    fn session_id() -> SessionId {
        SessionId::parse("session-two-stage-delete").expect("fixture session ID must parse")
    }

    fn active_session() -> Value {
        json!({
            "id": session_id().as_str(),
            "summary": "Keep runtime resources",
            "messages": []
        })
    }

    #[tokio::test]
    async fn first_delete_only_persists_deleted_marker_across_store_restart() {
        let fixture = Fixture::new().await;

        fixture
            .delete(1_721_177_200_123)
            .await
            .expect("first delete must persist a soft-delete marker");
        let restarted =
            SessionStore::new(fixture.data_directory.clone(), AtomicFileStore::default());
        let listed = restarted.list().await.expect("restarted store must list");

        assert_eq!(
            (
                listed
                    .first()
                    .and_then(|session| session["isDeleted"].as_bool()),
                listed
                    .first()
                    .and_then(|session| session["deletedAt"].as_i64()),
                fixture.resources.steps(),
                fixture.resources_present(),
                fixture.fingerprint.has_delivery(
                    session_id().as_str(),
                    "main",
                    std::path::Path::new("fixture.txt"),
                    "fixture-sha",
                ),
            ),
            (Some(true), Some(1_721_177_200_123), Vec::new(), true, false)
        );
    }

    #[tokio::test]
    async fn restore_after_soft_delete_preserves_ledger_and_attachments() {
        let fixture = Fixture::new().await;
        fixture
            .delete(1_721_177_200_123)
            .await
            .expect("first delete must persist a soft-delete marker");
        let mut restored = fixture
            .store
            .get(&session_id())
            .await
            .expect("soft-deleted session must load")
            .expect("soft-deleted session must remain present");
        let fields = restored
            .as_object_mut()
            .expect("fixture session must remain an object");
        fields.insert("isDeleted".to_owned(), Value::Bool(false));
        fields.remove("deletedAt");

        save_session_document(
            &fixture.store,
            fixture.maintenance.as_ref(),
            &fixture.deletion,
            &restored,
        )
        .await
        .expect("restore must persist through normal session save");
        let persisted = fixture
            .store
            .get(&session_id())
            .await
            .expect("restored session must remain readable")
            .expect("restored session must remain present");

        assert_eq!(
            (
                persisted["isDeleted"].as_bool(),
                persisted.get("deletedAt"),
                fixture.resources_present(),
                fixture.resources.steps(),
            ),
            (Some(false), None, true, Vec::new())
        );
    }

    #[tokio::test]
    async fn second_delete_runs_durable_physical_cleanup() {
        let fixture = Fixture::new().await;
        fixture
            .delete(1_721_177_200_123)
            .await
            .expect("first delete must remain soft");

        fixture
            .delete(1_721_177_200_456)
            .await
            .expect("second delete must physically clean the session");

        assert_eq!(
            (
                fixture
                    .store
                    .get(&session_id())
                    .await
                    .expect("session repository must remain readable"),
                fixture.resources_present(),
                fixture.resources.steps(),
            ),
            (
                None,
                false,
                vec![
                    SessionDeletionStep::Permissions,
                    SessionDeletionStep::EditTransactions,
                    SessionDeletionStep::Todos,
                    SessionDeletionStep::Attachments,
                    SessionDeletionStep::Ledger,
                    SessionDeletionStep::Fingerprints,
                    SessionDeletionStep::SessionDocument,
                ],
            )
        );
    }

    #[tokio::test]
    async fn concurrent_session_activity_blocks_physical_delete_without_resource_loss() {
        let fixture = Fixture::new().await;
        fixture
            .delete(1_721_177_200_123)
            .await
            .expect("first delete must remain soft");
        let restore_activity = fixture
            .maintenance
            .try_begin_activity(session_id())
            .expect("concurrent restore activity must begin");

        let error = fixture
            .delete(1_721_177_200_456)
            .await
            .expect_err("active restore must block physical deletion");
        drop(restore_activity);

        assert_eq!(
            (
                error.kind(),
                fixture.resources_present(),
                fixture.resources.steps(),
            ),
            (AppErrorKind::RunActive, true, Vec::new())
        );
    }

    #[tokio::test]
    async fn concurrent_first_delete_requests_do_not_turn_soft_delete_into_physical_cleanup() {
        let fixture = Fixture::new().await;

        let (first, second) = tokio::join!(
            fixture.delete(1_721_177_200_123),
            fixture.delete(1_721_177_200_124),
        );
        let successful_requests = usize::from(first.is_ok()) + usize::from(second.is_ok());
        let rejected_kind = first
            .err()
            .or_else(|| second.err())
            .map(|error| error.kind());
        let persisted = fixture
            .store
            .get(&session_id())
            .await
            .expect("concurrently soft-deleted session must remain readable")
            .expect("concurrently soft-deleted session must remain present");

        assert_eq!(
            (
                successful_requests,
                rejected_kind,
                persisted["isDeleted"].as_bool(),
                fixture.resources_present(),
                fixture.resources.steps(),
            ),
            (
                1,
                Some(AppErrorKind::RunActive),
                Some(true),
                true,
                Vec::new()
            )
        );
    }

    #[tokio::test]
    async fn deleting_a_missing_session_returns_not_found_without_starting_cleanup() {
        let fixture = Fixture::new().await;
        let missing = SessionId::parse("session-missing").expect("missing session ID must parse");

        let error = delete_session_document(
            &fixture.store,
            fixture.maintenance.as_ref(),
            &fixture.deletion,
            &fixture.fingerprint,
            missing,
            1_721_177_200_123,
        )
        .await
        .expect_err("missing session must not create a deletion tombstone");

        assert_eq!(
            (error.kind(), fixture.resources.steps()),
            (AppErrorKind::NotFound, Vec::new())
        );
    }
}
