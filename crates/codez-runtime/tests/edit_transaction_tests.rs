use std::{path::PathBuf, sync::Arc};

use codez_core::{
    AppErrorKind, AppPaths, SessionId, StreamId, WorkspaceRoot, context::ContextScopeId,
};
use codez_runtime::edit_transaction::{
    EditTransactionContentVersion, EditTransactionFileVersion, EditTransactionRegistration,
    EditTransactionRevertPreview, EditTransactionService,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::fs;
use uuid::Uuid;

fn app_paths(root: &std::path::Path) -> Arc<AppPaths> {
    Arc::new(
        AppPaths::new(
            root.to_path_buf(),
            root.to_path_buf(),
            root.to_path_buf(),
            root.to_path_buf(),
            root.to_path_buf(),
            root.to_path_buf(),
        )
        .expect("temporary test paths are absolute"),
    )
}

async fn transaction_fixture() -> (TempDir, EditTransactionService, String, PathBuf) {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let service = EditTransactionService::new(app_paths(&root));
    let tx_id = Uuid::new_v4().to_string();
    service
        .register_transaction(&tx_id, "session-123")
        .await
        .expect("transaction registration must succeed");
    (temp_dir, service, tx_id, root)
}

fn service_for(root: &std::path::Path) -> EditTransactionService {
    EditTransactionService::new(app_paths(root))
}

fn transaction_directory(root: &std::path::Path, session_id: &str, tx_id: &str) -> PathBuf {
    root.join("edit-backups").join(session_id).join(tx_id)
}

fn metadata_path(root: &std::path::Path, session_id: &str, tx_id: &str) -> PathBuf {
    transaction_directory(root, session_id, tx_id).join("metadata.json")
}

async fn stage_existing_file(
    service: &EditTransactionService,
    tx_id: &str,
    path: &std::path::Path,
    original: &str,
    mutation: &str,
) {
    fs::write(path, original)
        .await
        .expect("original file must be written");
    service
        .backup_file(tx_id, path, Some(original.to_owned()))
        .await
        .expect("existing file backup must be staged");
    fs::write(path, mutation)
        .await
        .expect("file mutation must be written");
    service
        .record_mutation(tx_id, path.to_path_buf(), true)
        .await
        .expect("file mutation must be recorded");
}

async fn read_metadata(path: &std::path::Path) -> Value {
    let bytes = fs::read(path)
        .await
        .expect("transaction metadata must be readable");
    serde_json::from_slice(&bytes).expect("transaction metadata must be valid JSON")
}

async fn write_metadata(path: &std::path::Path, metadata: &Value) {
    fs::write(
        path,
        serde_json::to_vec(metadata).expect("test metadata must serialize"),
    )
    .await
    .expect("test metadata must be written");
}

fn first_record_mut(metadata: &mut Value) -> &mut Value {
    metadata
        .get_mut("files")
        .and_then(Value::as_object_mut)
        .and_then(|files| files.values_mut().next())
        .expect("transaction metadata must contain one file record")
}

fn content_version(contents: &[u8]) -> EditTransactionContentVersion {
    EditTransactionContentVersion {
        sha256: hex::encode(Sha256::digest(contents)),
        size: contents.len() as u64,
    }
}

async fn prepare_and_commit(
    service: &EditTransactionService,
    tx_id: &str,
    path: &std::path::Path,
    contents: &[u8],
) {
    let intended = content_version(contents);
    service
        .prepare_mutation(tx_id, path, intended.clone())
        .await
        .expect("mutation intent must be persisted");
    fs::write(path, contents)
        .await
        .expect("prepared mutation must be written");
    service
        .record_verified_mutation(tx_id, path.to_path_buf(), &intended)
        .await
        .expect("prepared mutation must be verified");
}

#[tokio::test]
async fn reject_file_restores_the_original_regular_file() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("notes.txt");
    fs::write(&file_path, "original\n")
        .await
        .expect("original file must be written");

    assert!(
        service
            .backup_file(&tx_id, &file_path, Some("original\n".to_owned()))
            .await
            .expect("backup must be staged")
    );
    fs::write(&file_path, "changed\n")
        .await
        .expect("mutation must be written");
    service
        .record_mutation(&tx_id, file_path.clone(), true)
        .await
        .expect("mutation result must be recorded");

    assert!(
        service
            .reject_file(&tx_id, &file_path)
            .await
            .expect("reject must restore the original")
    );
    assert_eq!(
        fs::read_to_string(&file_path)
            .await
            .expect("restored file must be readable"),
        "original\n"
    );
    assert!(
        !service
            .reject_file(&tx_id, &file_path)
            .await
            .expect("repeating a completed reject must be harmless")
    );
}

#[tokio::test]
async fn reject_file_removes_a_file_that_was_created_by_the_transaction() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("created.txt");

    assert!(
        service
            .backup_file(&tx_id, &file_path, None)
            .await
            .expect("created-file state must be staged")
    );
    fs::write(&file_path, "created by CodeZ\n")
        .await
        .expect("created file must be written");
    service
        .record_mutation(&tx_id, file_path.clone(), true)
        .await
        .expect("created-file mutation must be recorded");

    assert!(
        service
            .reject_file(&tx_id, &file_path)
            .await
            .expect("reject must remove the created file")
    );
    assert!(!file_path.exists());
}

#[tokio::test]
async fn reject_file_refuses_to_overwrite_an_external_edit() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("external-edit.txt");
    fs::write(&file_path, "original")
        .await
        .expect("original file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    fs::write(&file_path, "codez mutation")
        .await
        .expect("CodeZ mutation must be written");
    service
        .record_mutation(&tx_id, file_path.clone(), true)
        .await
        .expect("CodeZ mutation must be recorded");
    fs::write(&file_path, "external edit")
        .await
        .expect("external edit must be written");

    let error = service
        .reject_file(&tx_id, &file_path)
        .await
        .expect_err("reject must refuse an external edit");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
    assert_eq!(
        fs::read_to_string(&file_path)
            .await
            .expect("external content must remain readable"),
        "external edit"
    );
    assert!(
        service
            .get_file_status(&tx_id, &file_path)
            .await
            .expect("conflicted file must remain tracked")
            .is_some()
    );
}

#[tokio::test]
async fn accept_file_discards_its_backup_and_cannot_be_rejected_later() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("accepted.txt");
    fs::write(&file_path, "original")
        .await
        .expect("original file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    fs::write(&file_path, "accepted mutation")
        .await
        .expect("mutation must be written");
    service
        .record_mutation(&tx_id, file_path.clone(), true)
        .await
        .expect("mutation must be recorded");

    assert!(
        service
            .accept_file(&tx_id, &file_path)
            .await
            .expect("accept must discard the backup")
    );
    assert_eq!(
        fs::read_to_string(&file_path)
            .await
            .expect("accepted file must remain readable"),
        "accepted mutation"
    );
    assert!(
        !service
            .reject_file(&tx_id, &file_path)
            .await
            .expect("accepted file must no longer be rejectable")
    );
    let backup_directory = root.join("edit-backups").join("session-123").join(&tx_id);
    let mut backup_entries = fs::read_dir(&backup_directory)
        .await
        .expect("transaction backup directory must remain readable");
    let mut has_backup_file = false;
    while let Some(entry) = backup_entries
        .next_entry()
        .await
        .expect("transaction backup directory entries must be readable")
    {
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "bak")
        {
            has_backup_file = true;
        }
    }
    assert!(!has_backup_file);
    assert!(
        service
            .get_diffs(&tx_id)
            .await
            .expect("accepted file must no longer appear in diffs")
            .is_empty()
    );
}

#[tokio::test]
async fn diffs_and_statuses_reflect_the_backup_and_current_contents() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("diff.txt");
    fs::write(&file_path, "before\n")
        .await
        .expect("original file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("before\n".to_owned()))
        .await
        .expect("backup must be staged");
    fs::write(&file_path, "after\n")
        .await
        .expect("mutation must be written");
    service
        .record_mutation(&tx_id, file_path.clone(), true)
        .await
        .expect("mutation must be recorded");

    let diff = service
        .get_diffs(&tx_id)
        .await
        .expect("diff lookup must succeed")
        .pop()
        .expect("one tracked file must produce one diff");

    assert!(diff.diff.contains("-before"));
    assert!(diff.diff.contains("+after"));
    assert_eq!(diff.path, file_path);
    assert!(
        diff.current_matches_expected
            .expect("mutation was recorded")
    );
}

#[tokio::test]
async fn status_distinguishes_an_empty_original_file_from_an_absent_original_file() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let empty_path = root.join("empty.txt");
    let created_path = root.join("created.txt");
    fs::write(&empty_path, "")
        .await
        .expect("empty original file must be written");

    service
        .backup_file(&tx_id, &empty_path, Some(String::new()))
        .await
        .expect("empty existing file must be staged");
    service
        .backup_file(&tx_id, &created_path, None)
        .await
        .expect("absent original file must be staged");

    let empty_status = service
        .get_file_status(&tx_id, &empty_path)
        .await
        .expect("empty-file status must be readable")
        .expect("empty file must be tracked");
    let created_status = service
        .get_file_status(&tx_id, &created_path)
        .await
        .expect("created-file status must be readable")
        .expect("created file must be tracked");

    assert!(matches!(
        empty_status.original,
        EditTransactionFileVersion::File { size: 0, .. }
    ));
    assert_eq!(created_status.original, EditTransactionFileVersion::Absent);
}

#[tokio::test]
async fn unknown_and_repeated_operations_are_harmless() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("missing.txt");

    assert!(
        !service
            .accept_file("unknown-transaction", &file_path)
            .await
            .expect("unknown accept must be harmless")
    );
    assert!(
        !service
            .reject_file("unknown-transaction", &file_path)
            .await
            .expect("unknown reject must be harmless")
    );
    assert!(
        service
            .get_diffs("unknown-transaction")
            .await
            .expect("unknown diff lookup must be harmless")
            .is_empty()
    );

    fs::write(&file_path, "original")
        .await
        .expect("original file must be written");
    assert!(
        service
            .backup_file(&tx_id, &file_path, Some("original".to_owned()))
            .await
            .expect("first backup must be staged")
    );
    assert!(
        !service
            .backup_file(&tx_id, &file_path, Some("original".to_owned()))
            .await
            .expect("duplicate backup must be ignored")
    );
    assert!(
        service
            .discard_staged_backup(&tx_id, &file_path)
            .await
            .expect("first discard must remove the staged backup")
    );
    assert!(
        !service
            .discard_staged_backup(&tx_id, &file_path)
            .await
            .expect("repeated discard must be harmless")
    );
}

#[tokio::test]
async fn cleanup_session_discards_its_backups_without_restoring_workspace_files() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("deleted-session.txt");
    fs::write(&file_path, "original")
        .await
        .expect("original file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    fs::write(&file_path, "mutated")
        .await
        .expect("workspace mutation must be written");
    service
        .record_mutation(&tx_id, file_path.clone(), true)
        .await
        .expect("mutation must be recorded");

    service
        .cleanup_session("session-123")
        .await
        .expect("session cleanup must succeed");

    assert_eq!(
        fs::read_to_string(&file_path)
            .await
            .expect("workspace file must remain readable"),
        "mutated"
    );
    assert!(!root.join("edit-backups").join("session-123").exists());
    assert!(
        service
            .get_diffs(&tx_id)
            .await
            .expect("removed transaction lookup must succeed")
            .is_empty()
    );
}

#[tokio::test]
async fn persisted_preview_is_sorted_and_folds_older_actions_over_newer_actions() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-preview";
    let older_tx = Uuid::new_v4().to_string();
    let newer_tx = Uuid::new_v4().to_string();
    let first_created = root.join("a-created.txt");
    let second_created = root.join("z-created.txt");
    let restored = root.join("m-restored.txt");
    let service = service_for(&root);

    service
        .register_transaction(&older_tx, session_id)
        .await
        .expect("older transaction must register");
    for path in [&second_created, &first_created] {
        service
            .backup_file(&older_tx, path, None)
            .await
            .expect("created file must be staged");
        fs::write(path, "created by older transaction")
            .await
            .expect("created file mutation must be written");
        service
            .record_mutation(&older_tx, path.clone(), true)
            .await
            .expect("created file mutation must be recorded");
    }
    stage_existing_file(&service, &older_tx, &restored, "base", "older mutation").await;

    service
        .register_transaction(&newer_tx, session_id)
        .await
        .expect("newer transaction must register");
    stage_existing_file(
        &service,
        &newer_tx,
        &first_created,
        "created by older transaction",
        "newer mutation",
    )
    .await;
    drop(service);

    let preview = service_for(&root)
        .preview_revert_transactions(session_id, &[newer_tx, older_tx])
        .await
        .expect("persisted transaction preview must load safely");

    assert_eq!(
        preview,
        EditTransactionRevertPreview {
            to_delete: vec![first_created, second_created],
            to_restore: vec![restored],
        }
    );
}

#[tokio::test]
async fn persisted_transactions_revert_in_the_supplied_order_after_service_recreation() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-ordered-revert";
    let older_tx = Uuid::new_v4().to_string();
    let newer_tx = Uuid::new_v4().to_string();
    let file_path = root.join("ordered.txt");
    let service = service_for(&root);

    service
        .register_transaction(&older_tx, session_id)
        .await
        .expect("older transaction must register");
    stage_existing_file(&service, &older_tx, &file_path, "version 0", "version 1").await;
    service
        .register_transaction(&newer_tx, session_id)
        .await
        .expect("newer transaction must register");
    stage_existing_file(&service, &newer_tx, &file_path, "version 1", "version 2").await;
    drop(service);

    service_for(&root)
        .revert_transactions(session_id, &[newer_tx.clone(), older_tx.clone()])
        .await
        .expect("persisted transactions must revert in supplied order");

    assert_eq!(
        fs::read_to_string(&file_path)
            .await
            .expect("reverted file must be readable"),
        "version 0"
    );
    assert!(!transaction_directory(&root, session_id, &newer_tx).exists());
    assert!(!transaction_directory(&root, session_id, &older_tx).exists());
}

#[tokio::test]
async fn duplicate_transaction_ids_are_rejected_before_any_workspace_restore() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-duplicate";
    let tx_id = Uuid::new_v4().to_string();
    let file_path = root.join("duplicate.txt");
    let service = service_for(&root);
    service
        .register_transaction(&tx_id, session_id)
        .await
        .expect("transaction must register");
    stage_existing_file(&service, &tx_id, &file_path, "original", "mutation").await;

    let error = service
        .revert_transactions(session_id, &[tx_id.clone(), tx_id])
        .await
        .expect_err("duplicate transaction IDs must fail validation");

    assert_eq!(error.kind(), AppErrorKind::Validation);
    assert_eq!(
        fs::read_to_string(&file_path)
            .await
            .expect("unreverted file must remain readable"),
        "mutation"
    );
}

#[tokio::test]
async fn partial_revert_removes_only_successful_records_and_retains_conflicted_backups() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-partial";
    let tx_id = Uuid::new_v4().to_string();
    let successful_path = root.join("a-success.txt");
    let conflicted_path = root.join("z-conflict.txt");
    let service = service_for(&root);
    service
        .register_transaction(&tx_id, session_id)
        .await
        .expect("transaction must register");
    stage_existing_file(
        &service,
        &tx_id,
        &successful_path,
        "success original",
        "success mutation",
    )
    .await;
    stage_existing_file(
        &service,
        &tx_id,
        &conflicted_path,
        "conflict original",
        "conflict mutation",
    )
    .await;
    fs::write(&conflicted_path, "external edit")
        .await
        .expect("external edit must be written");
    drop(service);
    let service = service_for(&root);

    let error = service
        .revert_transactions(session_id, std::slice::from_ref(&tx_id))
        .await
        .expect_err("conflicted transaction must report partial failure");
    let preview = service
        .preview_revert_transactions(session_id, std::slice::from_ref(&tx_id))
        .await
        .expect("failed transaction must remain previewable");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
    assert_eq!(
        fs::read_to_string(&successful_path)
            .await
            .expect("successful restore must remain readable"),
        "success original"
    );
    assert_eq!(
        fs::read_to_string(&conflicted_path)
            .await
            .expect("conflicted file must remain readable"),
        "external edit"
    );
    assert_eq!(preview.to_restore, vec![conflicted_path]);
    assert!(preview.to_delete.is_empty());
    assert!(transaction_directory(&root, session_id, &tx_id).exists());
}

#[tokio::test]
async fn persisted_metadata_identity_mismatch_is_rejected() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-identity";
    let tx_id = Uuid::new_v4().to_string();
    let file_path = root.join("identity.txt");
    let service = service_for(&root);
    service
        .register_transaction(&tx_id, session_id)
        .await
        .expect("transaction must register");
    stage_existing_file(&service, &tx_id, &file_path, "original", "mutation").await;
    drop(service);
    let metadata_path = metadata_path(&root, session_id, &tx_id);
    let mut metadata = read_metadata(&metadata_path).await;
    metadata["session_id"] = Value::String("another-session".to_owned());
    write_metadata(&metadata_path, &metadata).await;

    let error = service_for(&root)
        .preview_revert_transactions(session_id, &[tx_id])
        .await
        .expect_err("metadata identity mismatch must be rejected");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
}

#[tokio::test]
async fn oversized_persisted_metadata_is_rejected_before_deserialization() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-oversized";
    let tx_id = Uuid::new_v4().to_string();
    let service = service_for(&root);
    service
        .register_transaction(&tx_id, session_id)
        .await
        .expect("transaction must register");
    drop(service);
    fs::write(
        metadata_path(&root, session_id, &tx_id),
        vec![b' '; 4 * 1024 * 1024 + 1],
    )
    .await
    .expect("oversized metadata must be written");

    let error = service_for(&root)
        .preview_revert_transactions(session_id, &[tx_id])
        .await
        .expect_err("oversized metadata must be rejected");

    assert_eq!(error.kind(), AppErrorKind::Storage);
}

#[tokio::test]
async fn persisted_backup_path_that_escapes_its_transaction_is_rejected() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-escape";
    let tx_id = Uuid::new_v4().to_string();
    let file_path = root.join("escape.txt");
    let service = service_for(&root);
    service
        .register_transaction(&tx_id, session_id)
        .await
        .expect("transaction must register");
    stage_existing_file(&service, &tx_id, &file_path, "original", "mutation").await;
    drop(service);
    let metadata_path = metadata_path(&root, session_id, &tx_id);
    let mut metadata = read_metadata(&metadata_path).await;
    first_record_mut(&mut metadata)["backup_path"] =
        Value::String(root.join("outside.bak").to_string_lossy().to_string());
    write_metadata(&metadata_path, &metadata).await;

    let error = service_for(&root)
        .preview_revert_transactions(session_id, &[tx_id])
        .await
        .expect_err("escaping backup path must be rejected");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
}

#[cfg(unix)]
#[tokio::test]
async fn persisted_symlink_backup_is_rejected() {
    use std::os::unix::fs::symlink;

    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let session_id = "session-symlink";
    let tx_id = Uuid::new_v4().to_string();
    let file_path = root.join("symlink.txt");
    let external_backup = root.join("external.bak");
    let service = service_for(&root);
    service
        .register_transaction(&tx_id, session_id)
        .await
        .expect("transaction must register");
    stage_existing_file(&service, &tx_id, &file_path, "original", "mutation").await;
    drop(service);
    let metadata = read_metadata(&metadata_path(&root, session_id, &tx_id)).await;
    let backup_path = metadata
        .get("files")
        .and_then(Value::as_object)
        .and_then(|files| files.values().next())
        .and_then(|record| record.get("backup_path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .expect("metadata must contain its backup path");
    fs::write(&external_backup, "original")
        .await
        .expect("external backup target must be written");
    fs::remove_file(&backup_path)
        .await
        .expect("real backup must be removed before creating symlink");
    symlink(&external_backup, &backup_path).expect("backup symlink must be created");

    let error = service_for(&root)
        .preview_revert_transactions(session_id, &[tx_id])
        .await
        .expect_err("symlink backup must be rejected");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
}

fn chat_registration(root: &std::path::Path) -> EditTransactionRegistration {
    let canonical_root = dunce::canonicalize(root).expect("fixture workspace must canonicalize");
    EditTransactionRegistration {
        session_id: SessionId::parse("session-chat").expect("fixture session must parse"),
        context_scope_id: ContextScopeId::Main,
        turn_id: StreamId::parse("turn-chat").expect("fixture turn must parse"),
        workspace_root: WorkspaceRoot::from_canonical(canonical_root)
            .expect("fixture workspace authority must be valid"),
    }
}

#[tokio::test]
async fn chat_transaction_provenance_survives_service_restart() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let tx_id = Uuid::new_v4().to_string();
    let service = service_for(&root);
    service
        .register_chat_transaction(&tx_id, chat_registration(&root))
        .await
        .expect("chat transaction must register");
    drop(service);

    let provenance = service_for(&root)
        .get_provenance_for_session("session-chat", &tx_id)
        .await
        .expect("persisted provenance must load after restart");

    assert_eq!(
        (
            provenance.context_scope_id.as_deref(),
            provenance.turn_id.as_deref(),
            provenance.workspace_root.as_deref(),
        ),
        (
            Some("main"),
            Some("turn-chat"),
            Some(
                dunce::canonicalize(&root)
                    .expect("fixture workspace must canonicalize")
                    .as_path()
            ),
        )
    );
}

#[tokio::test]
async fn incomplete_persisted_chat_provenance_is_rejected_after_restart() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let tx_id = Uuid::new_v4().to_string();
    let service = service_for(&root);
    service
        .register_chat_transaction(&tx_id, chat_registration(&root))
        .await
        .expect("chat transaction must register");
    drop(service);
    let metadata_path = metadata_path(&root, "session-chat", &tx_id);
    let mut metadata = read_metadata(&metadata_path).await;
    metadata
        .as_object_mut()
        .expect("metadata must be an object")
        .remove("turn_id");
    write_metadata(&metadata_path, &metadata).await;

    let error = service_for(&root)
        .get_provenance_for_session("session-chat", &tx_id)
        .await
        .expect_err("incomplete provenance must not load");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
}

#[tokio::test]
async fn empty_cleanup_waits_for_a_queued_backup_and_keeps_the_nonempty_transaction() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let file_path = root.join("queued.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    let tx_id = Uuid::new_v4().to_string();
    let service = Arc::new(service_for(&root));
    service
        .register_transaction(&tx_id, "session-queue")
        .await
        .expect("transaction must register");
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let holder_service = Arc::clone(&service);
    let holder_tx_id = tx_id.clone();
    let holder = tokio::spawn(async move {
        holder_service
            .run_exclusive(
                &holder_tx_id,
                || async move {
                    let _ = entered_tx.send(());
                    let _ = release_rx.await;
                    Ok(())
                },
                None,
                true,
            )
            .await
    });
    entered_rx
        .await
        .expect("exclusive holder must acquire the queue");
    let backup_service = Arc::clone(&service);
    let backup_tx_id = tx_id.clone();
    let backup_path = file_path.clone();
    let backup = tokio::spawn(async move {
        backup_service
            .backup_file(&backup_tx_id, &backup_path, Some("original".to_string()))
            .await
    });
    tokio::task::yield_now().await;
    let cleanup_service = Arc::clone(&service);
    let cleanup_tx_id = tx_id.clone();
    let cleanup = tokio::spawn(async move {
        cleanup_service
            .discard_empty_transaction_for_session("session-queue", &cleanup_tx_id)
            .await
    });
    release_tx
        .send(())
        .expect("exclusive holder must still be waiting");

    tokio::time::timeout(std::time::Duration::from_secs(2), holder)
        .await
        .expect("exclusive holder must not deadlock")
        .expect("exclusive holder task must join")
        .expect("exclusive holder must succeed");
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), backup)
            .await
            .expect("queued backup must not deadlock")
            .expect("backup task must join")
            .expect("queued backup must succeed")
    );
    assert!(
        !tokio::time::timeout(std::time::Duration::from_secs(2), cleanup)
            .await
            .expect("empty cleanup must not deadlock")
            .expect("cleanup task must join")
            .expect("cleanup query must succeed")
    );
}

#[tokio::test]
async fn failed_backup_removal_restores_the_transaction_record() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("orphan.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_string()))
        .await
        .expect("backup must be staged");
    let metadata_file = metadata_path(&root, "session-123", &tx_id);
    let metadata = read_metadata(&metadata_file).await;
    let backup_path = metadata
        .get("files")
        .and_then(Value::as_object)
        .and_then(|files| files.values().next())
        .and_then(|record| record.get("backup_path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .expect("metadata must contain its backup path");
    fs::remove_file(&backup_path)
        .await
        .expect("backup file must be replaceable by a directory");
    fs::create_dir(&backup_path)
        .await
        .expect("backup-path directory must be created");

    service
        .discard_staged_backup(&tx_id, &file_path)
        .await
        .expect_err("directory backup path must fail file removal");
    let recovered = read_metadata(&metadata_file).await;

    assert_eq!(
        recovered
            .get("files")
            .and_then(Value::as_object)
            .map(serde_json::Map::len),
        Some(1)
    );
}

#[tokio::test]
async fn prepare_mutation_persists_intent_before_workspace_commit() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("prepared.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    let intended = content_version(b"prepared mutation");

    service
        .prepare_mutation(&tx_id, &file_path, intended.clone())
        .await
        .expect("mutation intent must be durable");

    let metadata = read_metadata(&metadata_path(&root, "session-123", &tx_id)).await;
    let record = metadata
        .get("files")
        .and_then(Value::as_object)
        .and_then(|files| files.values().next())
        .expect("metadata must contain the staged file");
    assert_eq!(
        (
            record
                .get("intended_post_mutation")
                .and_then(|value| value.get("sha256"))
                .and_then(Value::as_str),
            record
                .get("intended_post_mutation")
                .and_then(|value| value.get("size"))
                .and_then(Value::as_u64),
            fs::read_to_string(&file_path)
                .await
                .expect("workspace file must remain readable")
        ),
        (
            Some(intended.sha256.as_str()),
            Some(intended.size),
            "original".to_owned()
        )
    );
}

#[tokio::test]
async fn reject_after_restart_recovers_a_commit_from_durable_intent() {
    let (temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("crash-recovery.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    let intended = content_version(b"committed before crash");
    service
        .prepare_mutation(&tx_id, &file_path, intended)
        .await
        .expect("mutation intent must be durable");
    fs::write(&file_path, "committed before crash")
        .await
        .expect("simulated commit must be written");
    drop(service);

    let restarted = service_for(temp_dir.path());
    restarted
        .get_provenance_for_session("session-123", &tx_id)
        .await
        .expect("persisted transaction must load after restart");
    restarted
        .reject_file(&tx_id, &file_path)
        .await
        .expect("durable intent must make the committed mutation rejectable");

    assert_eq!(
        fs::read_to_string(&file_path)
            .await
            .expect("restored file must be readable"),
        "original"
    );
}

#[tokio::test]
async fn record_verified_mutation_refuses_unexpected_external_content() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("unexpected-final.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    let intended = content_version(b"CodeZ result");
    service
        .prepare_mutation(&tx_id, &file_path, intended.clone())
        .await
        .expect("mutation intent must be durable");
    fs::write(&file_path, "external result")
        .await
        .expect("external mutation must be written");

    let error = service
        .record_verified_mutation(&tx_id, file_path.clone(), &intended)
        .await
        .expect_err("unexpected content must not be recorded as CodeZ output");
    let reject_error = service
        .reject_file(&tx_id, &file_path)
        .await
        .expect_err("reject must not overwrite unexpected content");

    assert_eq!(
        (
            error.kind(),
            reject_error.kind(),
            fs::read_to_string(&file_path)
                .await
                .expect("external content must remain readable")
        ),
        (
            AppErrorKind::Conflict,
            AppErrorKind::Conflict,
            "external result".to_owned()
        )
    );
}

#[tokio::test]
async fn stale_second_intent_does_not_make_external_content_rejectable() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("stale-intent.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    prepare_and_commit(&service, &tx_id, &file_path, b"first mutation").await;
    service
        .prepare_mutation(
            &tx_id,
            &file_path,
            content_version(b"cancelled second mutation"),
        )
        .await
        .expect("second intent must be durable before cancellation");
    fs::write(&file_path, "external result")
        .await
        .expect("external mutation must be written");

    let error = service
        .reject_file(&tx_id, &file_path)
        .await
        .expect_err("stale intent must not authorize overwriting external content");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
}

#[tokio::test]
async fn aborting_a_new_preparation_removes_its_record_and_backup() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("aborted-first-mutation.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    let staged = service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    let preparation = service
        .prepare_mutation(&tx_id, &file_path, content_version(b"cancelled mutation"))
        .await
        .expect("mutation intent must be durable");

    service
        .abort_prepared_mutation(&tx_id, &file_path, preparation, staged)
        .await
        .expect("unused mutation preparation must be discarded");

    let status = service
        .get_file_status(&tx_id, &file_path)
        .await
        .expect("transaction status lookup must succeed");
    let mut entries = fs::read_dir(transaction_directory(&root, "session-123", &tx_id))
        .await
        .expect("transaction directory must remain readable");
    let mut backup_count = 0;
    while let Some(entry) = entries
        .next_entry()
        .await
        .expect("transaction directory entry must be readable")
    {
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "bak")
        {
            backup_count += 1;
        }
    }

    assert!(status.is_none() && backup_count == 0);
}

#[tokio::test]
async fn failed_abort_backup_cleanup_returns_storage_error_and_restores_the_record() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("abort-cleanup-failure.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    let staged = service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    let preparation = service
        .prepare_mutation(&tx_id, &file_path, content_version(b"cancelled mutation"))
        .await
        .expect("mutation intent must be durable");
    let metadata = read_metadata(&metadata_path(&root, "session-123", &tx_id)).await;
    let backup_path = metadata
        .get("files")
        .and_then(Value::as_object)
        .and_then(|files| files.values().next())
        .and_then(|record| record.get("backup_path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .expect("existing-file record must contain its backup path");
    fs::remove_file(&backup_path)
        .await
        .expect("fixture backup file must be removable");
    fs::create_dir(&backup_path)
        .await
        .expect("fixture cleanup blocker must be created");

    let error = service
        .abort_prepared_mutation(&tx_id, &file_path, preparation, staged)
        .await
        .expect_err("backup cleanup failure must be surfaced");
    let status = service
        .get_file_status(&tx_id, &file_path)
        .await
        .expect("restored transaction status must be readable");

    assert!(error.kind() == AppErrorKind::Storage && status.is_some());
}

#[tokio::test]
async fn aborting_a_second_preparation_restores_the_previous_intent_across_restart() {
    let (temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("aborted-second-mutation.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    prepare_and_commit(&service, &tx_id, &file_path, b"first mutation").await;
    let second = service
        .prepare_mutation(
            &tx_id,
            &file_path,
            content_version(b"cancelled second mutation"),
        )
        .await
        .expect("second intent must be durable");

    service
        .abort_prepared_mutation(&tx_id, &file_path, second, false)
        .await
        .expect("second intent must roll back to the first intent");
    drop(service);

    let restarted = service_for(temp_dir.path());
    restarted
        .get_provenance_for_session("session-123", &tx_id)
        .await
        .expect("persisted transaction must load after restart");
    let rejected = restarted
        .reject_file(&tx_id, &file_path)
        .await
        .expect("the first committed mutation must remain rejectable");
    let restored = fs::read_to_string(&file_path)
        .await
        .expect("restored file must be readable");

    assert!(rejected && restored == "original");
}

#[tokio::test]
async fn aborting_with_a_stale_prepare_token_does_not_replace_a_newer_intent() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("prepare-cas.txt");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    let stale = service
        .prepare_mutation(&tx_id, &file_path, content_version(b"first intent"))
        .await
        .expect("first intent must be durable");
    let current = service
        .prepare_mutation(&tx_id, &file_path, content_version(b"newer intent"))
        .await
        .expect("newer intent must be durable");

    let error = service
        .abort_prepared_mutation(&tx_id, &file_path, stale, false)
        .await
        .expect_err("a stale prepare token must lose the compare-and-swap");
    service
        .abort_prepared_mutation(&tx_id, &file_path, current, false)
        .await
        .expect("the current prepare token must still restore its predecessor");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
}

#[tokio::test]
async fn replacing_a_parent_directory_at_the_same_path_invalidates_reject() {
    let temp_dir = TempDir::new().expect("temporary directory must be created");
    let root = temp_dir.path().to_path_buf();
    let parent = root.join("workspace").join("tracked-parent");
    fs::create_dir_all(&parent)
        .await
        .expect("tracked parent must be created");
    let file_path = parent.join("identity.txt");
    let tx_id = Uuid::new_v4().to_string();
    let service = service_for(&root);
    service
        .register_transaction(&tx_id, "session-parent-identity")
        .await
        .expect("transaction must register");
    fs::write(&file_path, "original")
        .await
        .expect("fixture file must be written");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("backup must be staged");
    prepare_and_commit(&service, &tx_id, &file_path, b"mutation").await;
    drop(service);

    let displaced_parent = root.join("workspace").join("displaced-parent");
    fs::rename(&parent, &displaced_parent)
        .await
        .expect("tracked parent must be displaced");
    fs::create_dir(&parent)
        .await
        .expect("replacement parent must be created");
    fs::write(&file_path, "mutation")
        .await
        .expect("replacement file must be written");
    let restarted = service_for(&root);
    restarted
        .get_provenance_for_session("session-parent-identity", &tx_id)
        .await
        .expect("persisted transaction must load");

    let error = restarted
        .reject_file(&tx_id, &file_path)
        .await
        .expect_err("same-path directory replacement must invalidate reject");

    assert_eq!(error.kind(), AppErrorKind::Conflict);
}

#[cfg(windows)]
#[tokio::test]
#[expect(
    clippy::permissions_set_readonly_false,
    reason = "Windows readonly is a single file attribute, not Unix write-mode bits"
)]
async fn reject_restores_original_content_and_readonly_attribute_on_windows() {
    let (_temp_dir, service, tx_id, root) = transaction_fixture().await;
    let file_path = root.join("readonly.txt");
    std::fs::write(&file_path, "original").expect("fixture file must be written");
    let mut permissions = std::fs::metadata(&file_path)
        .expect("fixture metadata must be readable")
        .permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&file_path, permissions).expect("fixture file must become readonly");
    service
        .backup_file(&tx_id, &file_path, Some("original".to_owned()))
        .await
        .expect("readonly backup must be staged");
    let intended = content_version(b"mutation");
    service
        .prepare_mutation(&tx_id, &file_path, intended.clone())
        .await
        .expect("mutation intent must be durable");
    let mut writable = std::fs::metadata(&file_path)
        .expect("readonly metadata must be readable")
        .permissions();
    writable.set_readonly(false);
    std::fs::set_permissions(&file_path, writable)
        .expect("fixture must be writable for simulated commit");
    std::fs::write(&file_path, "mutation").expect("simulated commit must be written");
    let mut readonly = std::fs::metadata(&file_path)
        .expect("mutated metadata must be readable")
        .permissions();
    readonly.set_readonly(true);
    std::fs::set_permissions(&file_path, readonly)
        .expect("simulated commit must preserve readonly");
    service
        .record_verified_mutation(&tx_id, file_path.clone(), &intended)
        .await
        .expect("readonly mutation must be recorded");

    service
        .reject_file(&tx_id, &file_path)
        .await
        .expect("readonly mutation must be rejectable");

    assert_eq!(
        (
            std::fs::read_to_string(&file_path).expect("restored file must be readable"),
            std::fs::metadata(&file_path)
                .expect("restored metadata must be readable")
                .permissions()
                .readonly()
        ),
        ("original".to_owned(), true)
    );
}
