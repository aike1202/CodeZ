use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::fs;
use tokio::sync::Mutex;
use dashmap::DashMap;

use codez_core::{AppError, AppPaths, CancellationToken};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TransactionState {
    pub id: String,
    pub session_id: String,
    pub backed_up_files: HashMap<PathBuf, PathBuf>,
    pub expected_post_mutation_sha256: HashMap<PathBuf, Option<String>>,
    pub expected_post_mutation_modes: HashMap<PathBuf, Option<u32>>,
    pub original_file_modes: HashMap<PathBuf, u32>,
    pub created_at: u64,
}

pub struct EditTransactionService {
    transactions: DashMap<String, Arc<Mutex<TransactionState>>>,
    transaction_queues: DashMap<String, Arc<Mutex<()>>>,
    closing_sessions: DashMap<String, bool>,
    backup_root: PathBuf,
}

impl EditTransactionService {
    #[must_use]
    pub fn new(app_paths: Arc<AppPaths>) -> Self {
        Self {
            transactions: DashMap::new(),
            transaction_queues: DashMap::new(),
            closing_sessions: DashMap::new(),
            backup_root: app_paths.data_directory().join("edit-backups"),
        }
    }

    fn backup_directory(&self, session_id: &str, tx_id: Option<&str>) -> Result<PathBuf, AppError> {
        let assert_segment = |value: &str, label: &str| -> Result<(), AppError> {
            if value.is_empty() || value == "." || value == ".." || value.contains('/') || value.contains('\\') || value.contains('\0') {
                return Err(AppError::validation(format!("Unsafe edit-backup {} path: {}", label, value)));
            }
            Ok(())
        };

        assert_segment(session_id, "session")?;
        let mut target = self.backup_root.join(session_id);
        
        if let Some(tid) = tx_id {
            assert_segment(tid, "transaction")?;
            target = target.join(tid);
        }

        // Just basic path traversal prevention, already done by assert_segment.
        Ok(target)
    }

    pub async fn run_exclusive<F, Fut, T>(
        &self,
        tx_id: &str,
        op: F,
        abort_signal: Option<&CancellationToken>,
        allow_closing: bool,
    ) -> Result<T, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, AppError>>,
    {
        let lock = self.transaction_queues
            .entry(tx_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();

        let execute = async {
            let guard = lock.lock().await;

            if !allow_closing {
                if let Some(tx_arc) = self.transactions.get(tx_id) {
                    let tx = tx_arc.lock().await;
                    if self.closing_sessions.contains_key(&tx.session_id) {
                        return Err(AppError::conflict(format!("Session {} is closing; edit transaction work is no longer accepted.", tx.session_id)));
                    }
                }
            }

            op().await
        };

        if let Some(token) = abort_signal {
            tokio::select! {
                res = execute => res,
                _ = token.cancelled() => Err(AppError::cancelled("Edit transaction was aborted while waiting for its lock.")),
            }
        } else {
            execute.await
        }
    }

    pub async fn save_metadata(&self, tx_id: &str) -> Result<(), AppError> {
        let tx = {
            let tx_arc = match self.transactions.get(tx_id) {
                Some(arc) => arc.clone(),
                None => return Ok(()),
            };
            tx_arc.lock().await.clone()
        };

        let tx_dir = self.backup_directory(&tx.session_id, Some(tx_id))?;
        fs::create_dir_all(&tx_dir).await.map_err(|e| AppError::internal(format!("Failed to create tx dir: {}", e)))?;
        let metadata_path = tx_dir.join("metadata.json");

        let json = serde_json::to_string(&tx).map_err(|e| AppError::internal(format!("Failed to serialize tx metadata: {}", e)))?;
        let tmp_path = metadata_path.with_extension("tmp");
        fs::write(&tmp_path, json).await.map_err(|e| AppError::internal(format!("Failed to write tx metadata: {}", e)))?;
        fs::rename(&tmp_path, &metadata_path).await.map_err(|e| AppError::internal(format!("Failed to rename tx metadata: {}", e)))?;

        Ok(())
    }

    pub async fn register_transaction(&self, tx_id: &str, session_id: &str) -> Result<(), AppError> {
        let tx = TransactionState {
            id: tx_id.to_string(),
            session_id: session_id.to_string(),
            backed_up_files: HashMap::new(),
            expected_post_mutation_sha256: HashMap::new(),
            expected_post_mutation_modes: HashMap::new(),
            original_file_modes: HashMap::new(),
            created_at: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        };
        self.transactions.insert(tx_id.to_string(), Arc::new(Mutex::new(tx)));
        self.save_metadata(tx_id).await?;
        Ok(())
    }

    pub async fn backup_file(&self, tx_id: &str, file_path: &Path, content: Option<String>) -> Result<bool, AppError> {
        // Find transaction
        let tx_arc = match self.transactions.get(tx_id) {
            Some(arc) => arc.clone(),
            None => return Err(AppError::not_found(format!("Transaction {} not found", tx_id))),
        };

        let mut tx = tx_arc.lock().await;

        if tx.backed_up_files.contains_key(file_path) {
            return Ok(false); // Already backed up in this transaction
        }

        let tx_dir = self.backup_directory(&tx.session_id, Some(tx_id))?;
        fs::create_dir_all(&tx_dir).await.map_err(|e| AppError::internal(format!("Failed to create tx dir: {}", e)))?;
        
        // Generate a random UUID string for the backup file name.
        let backup_name = format!("{}.bak", uuid::Uuid::new_v4());
        let backup_path = tx_dir.join(backup_name);
        
        if let Some(c) = content {
            fs::write(&backup_path, c).await.map_err(|e| AppError::internal(format!("Failed to write backup: {}", e)))?;
        } else {
            // Null content means the file did not exist before this mutation (creation).
            // We just record an empty path or don't write anything.
            // When restoring, if there is no file, it means delete.
            fs::write(&backup_path, "").await.map_err(|e| AppError::internal(format!("Failed to write empty backup: {}", e)))?;
        }

        tx.backed_up_files.insert(file_path.to_path_buf(), backup_path);
        drop(tx);
        self.save_metadata(tx_id).await?;
        
        Ok(true)
    }

    pub async fn discard_staged_backup(&self, tx_id: &str, file_path: &Path) -> Result<(), AppError> {
        let tx_arc = match self.transactions.get(tx_id) {
            Some(arc) => arc.clone(),
            None => return Ok(()),
        };
        let mut tx = tx_arc.lock().await;
        if let Some(backup_path) = tx.backed_up_files.remove(file_path) {
            let _ = fs::remove_file(backup_path).await;
        }
        drop(tx);
        self.save_metadata(tx_id).await?;
        Ok(())
    }

    pub async fn record_mutation(&self, tx_id: &str, file_path: PathBuf, staged_backup: bool) -> Result<(), AppError> {
        let tx_arc = match self.transactions.get(tx_id) {
            Some(arc) => arc.clone(),
            None => return Ok(()),
        };
        let mut tx = tx_arc.lock().await;
        
        if let Ok(content) = fs::read(&file_path).await {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&content);
            let sha = hex::encode(hasher.finalize());
            tx.expected_post_mutation_sha256.insert(file_path.clone(), Some(sha));
        } else {
            tx.expected_post_mutation_sha256.insert(file_path.clone(), None);
        }
        
        drop(tx);
        self.save_metadata(tx_id).await?;
        Ok(())
    }
}
