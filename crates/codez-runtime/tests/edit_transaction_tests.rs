use std::{path::PathBuf, sync::Arc};

use codez_core::{AppErrorKind, AppPaths};
use codez_runtime::edit_transaction::{EditTransactionFileVersion, EditTransactionService};
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
