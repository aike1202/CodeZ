use codez_core::AppPaths;
use codez_runtime::edit_transaction::EditTransactionService;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::fs;
use uuid::Uuid;

#[tokio::test]
async fn test_edit_transaction_backup_and_discard() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().to_path_buf();
    let app_paths = Arc::new(
        AppPaths::new(
            root.clone(),
            root.clone(),
            root.clone(),
            root.clone(),
            root.clone(),
            root.clone(),
        )
        .unwrap(),
    );

    let service = EditTransactionService::new(app_paths);
    let session_id = "session-123";
    let tx_id = Uuid::new_v4().to_string();

    // Register transaction
    service
        .register_transaction(&tx_id, session_id)
        .await
        .unwrap();

    let file_path = root.join("test_file.txt");
    fs::write(&file_path, "original content").await.unwrap();

    // Backup file
    let backed_up = service
        .backup_file(&tx_id, &file_path, Some("original content".to_string()))
        .await
        .unwrap();
    assert!(backed_up);

    // Backup again should be false
    let backed_up_again = service
        .backup_file(&tx_id, &file_path, Some("new content".to_string()))
        .await
        .unwrap();
    assert!(!backed_up_again);

    // Discard backup
    service
        .discard_staged_backup(&tx_id, &file_path)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_edit_transaction_record_mutation() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().to_path_buf();
    let app_paths = Arc::new(
        AppPaths::new(
            root.clone(),
            root.clone(),
            root.clone(),
            root.clone(),
            root.clone(),
            root.clone(),
        )
        .unwrap(),
    );

    let service = EditTransactionService::new(app_paths);
    let session_id = "session-123";
    let tx_id = Uuid::new_v4().to_string();

    service
        .register_transaction(&tx_id, session_id)
        .await
        .unwrap();

    let file_path = root.join("test_file.txt");
    fs::write(&file_path, "content").await.unwrap();

    // Record mutation
    service
        .record_mutation(&tx_id, file_path.clone(), true)
        .await
        .unwrap();
}
