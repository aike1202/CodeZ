use std::{
    collections::HashMap,
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use dashmap::{DashMap, mapref::entry::Entry};
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};

use codez_core::{AppError, AppPaths, CancellationToken};

const MAX_RENDERED_DIFF_BYTES: usize = 1024 * 1024;

/// A content and permission snapshot used to protect a tracked workspace file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditTransactionFileVersion {
    /// The file was not present.
    Absent,
    /// A regular file with an exact content digest and platform-normalized mode.
    File {
        /// SHA-256 of the file content.
        sha256: String,
        /// POSIX mode bits, or the portable writable/read-only representation on Windows.
        mode: u32,
        /// File size in bytes.
        size: u64,
    },
}

/// Read-only state for one file tracked by an edit transaction.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTransactionFileStatus {
    /// Canonical path registered by the transaction.
    pub path: PathBuf,
    /// State before CodeZ's first mutation in this transaction.
    pub original: EditTransactionFileVersion,
    /// Exact state that a reject operation is permitted to replace.
    pub expected_post_mutation: Option<EditTransactionFileVersion>,
    /// State observed when the transaction was queried.
    pub current: EditTransactionFileVersion,
    /// Whether the observed state matches the transaction's recorded mutation result.
    pub current_matches_expected: Option<bool>,
}

/// A rendered file diff together with the state used to generate it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTransactionFileDiff {
    /// Canonical path registered by the transaction.
    pub path: PathBuf,
    /// Textual unified-style diff, or a safe summary for large or binary files.
    pub diff: String,
    /// State before CodeZ's first mutation in this transaction.
    pub original: EditTransactionFileVersion,
    /// State observed when the transaction was queried.
    pub current: EditTransactionFileVersion,
    /// Whether the observed state matches the transaction's recorded mutation result.
    pub current_matches_expected: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct TransactionFileRecord {
    backup_path: Option<PathBuf>,
    original: EditTransactionFileVersion,
    expected_post_mutation: Option<EditTransactionFileVersion>,
    parent_identity: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TransactionState {
    id: String,
    session_id: String,
    files: HashMap<PathBuf, TransactionFileRecord>,
    created_at: u64,
}

struct ReadFileState {
    version: EditTransactionFileVersion,
    contents: Option<Vec<u8>>,
}

/// Persists edit backups below the CodeZ data root and safely resolves file decisions.
pub struct EditTransactionService {
    transactions: DashMap<String, Arc<Mutex<TransactionState>>>,
    transaction_queues: DashMap<String, Arc<Mutex<()>>>,
    closing_sessions: DashMap<String, bool>,
    backup_root: PathBuf,
}

impl EditTransactionService {
    /// Creates an edit transaction service rooted at `<data-directory>/edit-backups`.
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
        validate_backup_segment(session_id, "session")?;
        let mut target = self.backup_root.join(session_id);

        if let Some(tx_id) = tx_id {
            validate_backup_segment(tx_id, "transaction")?;
            target.push(tx_id);
        }

        Ok(target)
    }

    /// Serializes work belonging to one transaction and rejects new work for closing sessions.
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
        let lock = self
            .transaction_queues
            .entry(tx_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();

        let execute = async {
            let _guard = lock.lock().await;

            if !allow_closing {
                if let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) {
                    let tx = tx_arc.lock().await;
                    if self.closing_sessions.contains_key(&tx.session_id) {
                        return Err(AppError::conflict(format!(
                            "Session {} is closing; edit transaction work is no longer accepted.",
                            tx.session_id
                        )));
                    }
                }
            }

            op().await
        };

        if let Some(token) = abort_signal {
            tokio::select! {
                result = execute => result,
                _ = token.cancelled() => Err(AppError::cancelled("Edit transaction was aborted while waiting for its lock.")),
            }
        } else {
            execute.await
        }
    }

    /// Registers a transaction before its first file mutation.
    ///
    /// # Errors
    ///
    /// Returns an error when the identifiers are unsafe, already registered, or their metadata
    /// cannot be persisted.
    pub async fn register_transaction(
        &self,
        tx_id: &str,
        session_id: &str,
    ) -> Result<(), AppError> {
        self.backup_directory(session_id, Some(tx_id))?;

        let tx = TransactionState {
            id: tx_id.to_owned(),
            session_id: session_id.to_owned(),
            files: HashMap::new(),
            created_at: transaction_timestamp(),
        };

        match self.transactions.entry(tx_id.to_owned()) {
            Entry::Occupied(_) => {
                return Err(AppError::conflict(format!(
                    "Edit transaction {tx_id} is already registered"
                )));
            }
            Entry::Vacant(entry) => {
                entry.insert(Arc::new(Mutex::new(tx)));
            }
        }

        if let Err(error) = self.save_metadata(tx_id).await {
            self.transactions.remove(tx_id);
            return Err(error);
        }

        Ok(())
    }

    /// Saves the currently registered transaction metadata.
    ///
    /// Missing transactions are treated as already cleaned up.
    pub async fn save_metadata(&self, tx_id: &str) -> Result<(), AppError> {
        let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) else {
            return Ok(());
        };
        let tx = tx_arc.lock().await.clone();
        let tx_dir = self.prepare_transaction_directory(&tx).await?;
        let metadata_path = tx_dir.join("metadata.json");
        let temporary_path = tx_dir.join(format!(".metadata-{}.tmp", uuid::Uuid::new_v4()));
        let json = serde_json::to_vec(&tx).map_err(|error| {
            AppError::internal(format!("Failed to serialize edit metadata: {error}"))
        })?;

        let result = async {
            write_new_file(&temporary_path, &json).await?;
            fs::rename(&temporary_path, &metadata_path)
                .await
                .map_err(|error| {
                    storage_error("replace edit transaction metadata", &metadata_path, error)
                })
        }
        .await;

        if result.is_err() {
            let _ = fs::remove_file(&temporary_path).await;
        }

        result
    }

    /// Stages the original file contents before a mutation.
    ///
    /// `Some(content)` represents an existing file, including an existing empty file. `None`
    /// represents a file that did not exist and is expected to be created by the mutation.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction is unknown, the path is unsafe, the supplied content
    /// no longer matches the file, or the backup cannot be persisted.
    pub async fn backup_file(
        &self,
        tx_id: &str,
        file_path: &Path,
        content: Option<String>,
    ) -> Result<bool, AppError> {
        let tx_arc = self.transaction_arc(tx_id)?;
        let registered_path = canonical_transaction_path(file_path).await?;

        let (session_id, existing) = {
            let tx = tx_arc.lock().await;
            (
                tx.session_id.clone(),
                tx.files.contains_key(&registered_path),
            )
        };
        if existing {
            return Ok(false);
        }

        let parent_identity = parent_identity(&registered_path)?;
        let record = match content {
            Some(content) => {
                let current = read_workspace_file(&registered_path).await?;
                let current_version = current.version;
                let EditTransactionFileVersion::File { sha256, mode, size } = current_version
                else {
                    return Err(AppError::conflict(format!(
                        "Cannot stage an existing-file backup because {} is absent",
                        registered_path.display()
                    )));
                };
                let bytes = content.into_bytes();
                if sha256 != sha256_for(&bytes) || size != bytes.len() as u64 {
                    return Err(AppError::conflict(format!(
                        "File {} changed before its edit backup was staged",
                        registered_path.display()
                    )));
                }

                let tx = TransactionState {
                    id: tx_id.to_owned(),
                    session_id,
                    files: HashMap::new(),
                    created_at: 0,
                };
                let tx_dir = self.prepare_transaction_directory(&tx).await?;
                let backup_path = tx_dir.join(format!("{}.bak", uuid::Uuid::new_v4()));
                write_new_file(&backup_path, &bytes).await?;
                if let Err(error) = apply_mode(&backup_path, mode).await {
                    let _ = fs::remove_file(&backup_path).await;
                    return Err(error);
                }

                TransactionFileRecord {
                    backup_path: Some(backup_path),
                    original: EditTransactionFileVersion::File { sha256, mode, size },
                    expected_post_mutation: None,
                    parent_identity,
                }
            }
            None => {
                let current = read_workspace_file(&registered_path).await?;
                if current.version != EditTransactionFileVersion::Absent {
                    return Err(AppError::conflict(format!(
                        "Cannot stage a created-file backup because {} already exists",
                        registered_path.display()
                    )));
                }

                TransactionFileRecord {
                    backup_path: None,
                    original: EditTransactionFileVersion::Absent,
                    expected_post_mutation: None,
                    parent_identity,
                }
            }
        };

        let staged_backup = record.backup_path.clone();
        {
            let mut tx = tx_arc.lock().await;
            if tx.files.contains_key(&registered_path) {
                drop(tx);
                remove_backup_if_present(staged_backup.as_deref()).await;
                return Ok(false);
            }
            tx.files.insert(registered_path.clone(), record.clone());
        }

        if let Err(error) = self.save_metadata(tx_id).await {
            let mut tx = tx_arc.lock().await;
            if tx.files.get(&registered_path) == Some(&record) {
                tx.files.remove(&registered_path);
            }
            drop(tx);
            remove_backup_if_present(staged_backup.as_deref()).await;
            return Err(error);
        }

        Ok(true)
    }

    /// Discards a backup that was staged for a mutation which never completed.
    ///
    /// Missing transactions and already-discarded files return `false`.
    pub async fn discard_staged_backup(
        &self,
        tx_id: &str,
        file_path: &Path,
    ) -> Result<bool, AppError> {
        let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) else {
            return Ok(false);
        };
        let Some(registered_path) = self.find_registered_path(&tx_arc, file_path).await? else {
            return Ok(false);
        };

        let removed = {
            let mut tx = tx_arc.lock().await;
            tx.files.remove(&registered_path)
        };
        let Some(record) = removed else {
            return Ok(false);
        };

        if let Err(error) = self.save_metadata(tx_id).await {
            let mut tx = tx_arc.lock().await;
            tx.files.insert(registered_path, record);
            return Err(error);
        }

        self.remove_record_backup(tx_id, &record).await?;
        Ok(true)
    }

    /// Records the exact file state that a later reject operation is allowed to replace.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction or staged file is missing, or when the current path
    /// is no longer a regular file (or absent file) that can be safely tracked.
    pub async fn record_mutation(
        &self,
        tx_id: &str,
        file_path: PathBuf,
        _staged_backup: bool,
    ) -> Result<(), AppError> {
        let tx_arc = self.transaction_arc(tx_id)?;
        let Some(registered_path) = self.find_registered_path(&tx_arc, &file_path).await? else {
            return Err(AppError::not_found(format!(
                "No edit backup is registered for {}",
                file_path.display()
            )));
        };
        let tracked_record = {
            let tx = tx_arc.lock().await;
            tx.files.get(&registered_path).cloned()
        };
        let Some(tracked_record) = tracked_record else {
            return Err(AppError::not_found(format!(
                "No edit backup is registered for {}",
                registered_path.display()
            )));
        };
        self.verify_parent_identity(&registered_path, &tracked_record.parent_identity)
            .await?;
        let current = read_workspace_file(&registered_path).await?.version;
        self.verify_parent_identity(&registered_path, &tracked_record.parent_identity)
            .await?;

        let mut tx = tx_arc.lock().await;
        let Some(record) = tx.files.get_mut(&registered_path) else {
            return Err(AppError::not_found(format!(
                "No edit backup is registered for {}",
                registered_path.display()
            )));
        };
        record.expected_post_mutation = Some(current);
        drop(tx);
        self.save_metadata(tx_id).await
    }

    /// Returns status for every file currently tracked by a transaction.
    ///
    /// Unknown transactions return an empty list.
    pub async fn get_file_statuses(
        &self,
        tx_id: &str,
    ) -> Result<Vec<EditTransactionFileStatus>, AppError> {
        let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) else {
            return Ok(Vec::new());
        };
        let files = {
            let tx = tx_arc.lock().await;
            tx.files
                .iter()
                .map(|(path, record)| (path.clone(), record.clone()))
                .collect::<Vec<_>>()
        };

        let mut statuses = Vec::with_capacity(files.len());
        for (path, record) in files {
            statuses.push(self.file_status(path, record).await?);
        }
        statuses.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(statuses)
    }

    /// Returns status for one tracked file.
    ///
    /// Unknown transactions and already accepted or rejected files return `None`.
    pub async fn get_file_status(
        &self,
        tx_id: &str,
        file_path: &Path,
    ) -> Result<Option<EditTransactionFileStatus>, AppError> {
        let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) else {
            return Ok(None);
        };
        let Some(registered_path) = self.find_registered_path(&tx_arc, file_path).await? else {
            return Ok(None);
        };
        let record = {
            let tx = tx_arc.lock().await;
            tx.files.get(&registered_path).cloned()
        };
        let Some(record) = record else {
            return Ok(None);
        };
        Ok(Some(self.file_status(registered_path, record).await?))
    }

    /// Returns textual diffs for all files still tracked by a transaction.
    ///
    /// Unknown transactions return an empty list. Large and binary files produce a summary rather
    /// than returning their full content through the desktop boundary.
    pub async fn get_diffs(&self, tx_id: &str) -> Result<Vec<EditTransactionFileDiff>, AppError> {
        let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) else {
            return Ok(Vec::new());
        };
        let tx = tx_arc.lock().await.clone();
        let mut diffs = Vec::with_capacity(tx.files.len());
        for (path, record) in &tx.files {
            self.verify_parent_identity(path, &record.parent_identity)
                .await?;
            let original_contents = self.read_backup_contents(&tx, record).await?;
            let current = read_workspace_file(path).await?;
            self.verify_parent_identity(path, &record.parent_identity)
                .await?;
            let current_matches_expected = record
                .expected_post_mutation
                .as_ref()
                .map(|expected| expected == &current.version);
            diffs.push(EditTransactionFileDiff {
                path: path.clone(),
                diff: render_diff(
                    path,
                    original_contents.as_deref(),
                    current.contents.as_deref(),
                ),
                original: record.original.clone(),
                current: current.version,
                current_matches_expected,
            });
        }
        diffs.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(diffs)
    }

    /// Accepts one file's current contents and permanently discards its transaction backup.
    ///
    /// Missing transactions and repeated accepts return `false`.
    pub async fn accept_file(&self, tx_id: &str, file_path: &Path) -> Result<bool, AppError> {
        self.run_exclusive(
            tx_id,
            || async {
                let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) else {
                    return Ok(false);
                };
                let Some(registered_path) = self.find_registered_path(&tx_arc, file_path).await?
                else {
                    return Ok(false);
                };

                let removed = {
                    let mut tx = tx_arc.lock().await;
                    tx.files.remove(&registered_path)
                };
                let Some(record) = removed else {
                    return Ok(false);
                };

                if let Err(error) = self.save_metadata(tx_id).await {
                    let mut tx = tx_arc.lock().await;
                    tx.files.insert(registered_path, record);
                    return Err(error);
                }

                self.remove_record_backup(tx_id, &record).await?;
                Ok(true)
            },
            None,
            false,
        )
        .await
    }

    /// Rejects one file's current mutation when it still exactly matches CodeZ's recorded result.
    ///
    /// A conflict leaves the current file and its backup intact. Missing transactions and repeated
    /// rejects return `false`.
    pub async fn reject_file(&self, tx_id: &str, file_path: &Path) -> Result<bool, AppError> {
        self.run_exclusive(
            tx_id,
            || async {
                let Some(tx_arc) = self.transactions.get(tx_id).map(|entry| entry.clone()) else {
                    return Ok(false);
                };
                let Some(registered_path) = self.find_registered_path(&tx_arc, file_path).await?
                else {
                    return Ok(false);
                };
                let mut current_tx = tx_arc.lock().await;
                let Some(record) = current_tx.files.get(&registered_path).cloned() else {
                    return Ok(false);
                };
                let tx = current_tx.clone();
                self.restore_record(&tx, &registered_path, &record).await?;
                let removed = current_tx.files.remove(&registered_path);
                drop(current_tx);
                let Some(_removed) = removed else {
                    return Err(AppError::conflict(format!(
                        "Edit transaction tracking changed while rejecting {}",
                        registered_path.display()
                    )));
                };

                if let Err(error) = self.save_metadata(tx_id).await {
                    tracing::error!(
                        transaction_id = tx_id,
                        path = %registered_path.display(),
                        "edit reject restored the file but could not persist backup cleanup"
                    );
                    return Err(error);
                }

                self.remove_record_backup(tx_id, &record).await?;
                Ok(true)
            },
            None,
            false,
        )
        .await
    }

    fn transaction_arc(&self, tx_id: &str) -> Result<Arc<Mutex<TransactionState>>, AppError> {
        self.transactions
            .get(tx_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| AppError::not_found(format!("Edit transaction {tx_id} was not found")))
    }

    async fn find_registered_path(
        &self,
        tx_arc: &Arc<Mutex<TransactionState>>,
        requested_path: &Path,
    ) -> Result<Option<PathBuf>, AppError> {
        let requested_path = lexical_normalize_absolute_path(requested_path)?;
        let keys = {
            let tx = tx_arc.lock().await;
            tx.files.keys().cloned().collect::<Vec<_>>()
        };
        if let Some(path) = keys
            .iter()
            .find(|path| paths_equal(path, &requested_path))
            .cloned()
        {
            return Ok(Some(path));
        }

        let Some(file_name) = requested_path.file_name() else {
            return Ok(None);
        };
        let Some(parent) = requested_path.parent() else {
            return Ok(None);
        };
        let Ok(canonical_parent) = fs::canonicalize(parent).await else {
            return Ok(None);
        };
        let resolved = normalize_canonical_path(canonical_parent).join(file_name);
        Ok(keys
            .iter()
            .find(|path| paths_equal(path, &resolved))
            .cloned())
    }

    async fn prepare_transaction_directory(
        &self,
        tx: &TransactionState,
    ) -> Result<PathBuf, AppError> {
        let tx_dir = self.backup_directory(&tx.session_id, Some(&tx.id))?;
        fs::create_dir_all(&self.backup_root)
            .await
            .map_err(|error| storage_error("create edit backup root", &self.backup_root, error))?;
        fs::create_dir_all(&tx_dir)
            .await
            .map_err(|error| storage_error("create edit transaction directory", &tx_dir, error))?;

        let canonical_root =
            normalize_canonical_path(fs::canonicalize(&self.backup_root).await.map_err(
                |error| storage_error("resolve edit backup root", &self.backup_root, error),
            )?);
        let canonical_tx_dir =
            normalize_canonical_path(fs::canonicalize(&tx_dir).await.map_err(|error| {
                storage_error("resolve edit transaction directory", &tx_dir, error)
            })?);
        let metadata = fs::symlink_metadata(&canonical_tx_dir)
            .await
            .map_err(|error| {
                storage_error(
                    "inspect edit transaction directory",
                    &canonical_tx_dir,
                    error,
                )
            })?;

        if !canonical_tx_dir.starts_with(&canonical_root)
            || !metadata.file_type().is_dir()
            || metadata.file_type().is_symlink()
        {
            return Err(AppError::conflict(
                "Edit transaction backup directory is no longer safe to use",
            ));
        }

        Ok(canonical_tx_dir)
    }

    async fn file_status(
        &self,
        path: PathBuf,
        record: TransactionFileRecord,
    ) -> Result<EditTransactionFileStatus, AppError> {
        self.verify_parent_identity(&path, &record.parent_identity)
            .await?;
        let current = read_workspace_file(&path).await?.version;
        self.verify_parent_identity(&path, &record.parent_identity)
            .await?;
        let current_matches_expected = record
            .expected_post_mutation
            .as_ref()
            .map(|expected| expected == &current);
        Ok(EditTransactionFileStatus {
            path,
            original: record.original,
            expected_post_mutation: record.expected_post_mutation,
            current,
            current_matches_expected,
        })
    }

    async fn read_backup_contents(
        &self,
        tx: &TransactionState,
        record: &TransactionFileRecord,
    ) -> Result<Option<Vec<u8>>, AppError> {
        let EditTransactionFileVersion::File { sha256, size, .. } = &record.original else {
            if record.backup_path.is_some() {
                return Err(AppError::conflict(
                    "An absent original file must not have an edit backup file",
                ));
            }
            return Ok(None);
        };
        let Some(backup_path) = record.backup_path.as_deref() else {
            return Err(AppError::conflict(
                "An existing original file is missing its edit backup",
            ));
        };
        let tx_dir = self.prepare_transaction_directory(tx).await?;
        if !backup_path.starts_with(&tx_dir) {
            return Err(AppError::conflict(
                "Edit backup path escapes its transaction directory",
            ));
        }

        let metadata = fs::symlink_metadata(backup_path)
            .await
            .map_err(|error| storage_error("inspect edit backup", backup_path, error))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(AppError::conflict("Edit backup is not a regular file"));
        }
        let contents = fs::read(backup_path)
            .await
            .map_err(|error| storage_error("read edit backup", backup_path, error))?;
        if *size != contents.len() as u64 || *sha256 != sha256_for(&contents) {
            return Err(AppError::conflict(
                "Edit backup content no longer matches its metadata",
            ));
        }
        Ok(Some(contents))
    }

    async fn restore_record(
        &self,
        tx: &TransactionState,
        path: &Path,
        record: &TransactionFileRecord,
    ) -> Result<(), AppError> {
        self.verify_parent_identity(path, &record.parent_identity)
            .await?;
        self.assert_expected_mutation(path, record).await?;

        match &record.original {
            EditTransactionFileVersion::Absent => {
                if record.backup_path.is_some() {
                    return Err(AppError::conflict(
                        "An absent original file must not have an edit backup file",
                    ));
                }
                self.verify_parent_identity(path, &record.parent_identity)
                    .await?;
                self.assert_expected_mutation(path, record).await?;
                fs::remove_file(path)
                    .await
                    .map_err(|error| storage_error("remove rejected created file", path, error))
            }
            EditTransactionFileVersion::File { mode, .. } => {
                let Some(contents) = self.read_backup_contents(tx, record).await? else {
                    return Err(AppError::conflict(
                        "An existing original file is missing its edit backup",
                    ));
                };
                self.restore_existing_file(path, &record.parent_identity, record, &contents, *mode)
                    .await
            }
        }
    }

    async fn restore_existing_file(
        &self,
        path: &Path,
        parent_identity: &Path,
        record: &TransactionFileRecord,
        contents: &[u8],
        original_mode: u32,
    ) -> Result<(), AppError> {
        let Some(parent) = path.parent() else {
            return Err(AppError::validation(
                "Edit transaction file path has no parent",
            ));
        };
        let temporary_path =
            parent.join(format!(".codez-edit-restore-{}.tmp", uuid::Uuid::new_v4()));
        let result = async {
            write_new_file(&temporary_path, contents).await?;
            apply_mode(&temporary_path, original_mode).await?;

            // Re-check immediately before the replacement to narrow a user-edit race.
            self.verify_parent_identity(path, parent_identity).await?;
            self.assert_expected_mutation(path, record).await?;
            replace_file(&temporary_path, path).await
        }
        .await;

        if result.is_err() {
            let _ = fs::remove_file(&temporary_path).await;
        }
        result
    }

    async fn assert_expected_mutation(
        &self,
        path: &Path,
        record: &TransactionFileRecord,
    ) -> Result<(), AppError> {
        let Some(expected) = record.expected_post_mutation.as_ref() else {
            return Err(AppError::conflict(format!(
                "Reject cannot verify the post-mutation state for {}",
                path.display()
            )));
        };
        let current = read_workspace_file(path).await?.version;
        if current == *expected {
            Ok(())
        } else {
            Err(AppError::conflict(format!(
                "Reject conflict for {}: the file changed after CodeZ recorded its mutation",
                path.display()
            )))
        }
    }

    async fn verify_parent_identity(
        &self,
        path: &Path,
        expected_parent: &Path,
    ) -> Result<(), AppError> {
        let Some(parent) = path.parent() else {
            return Err(AppError::validation(
                "Edit transaction file path has no parent",
            ));
        };
        let current_parent =
            normalize_canonical_path(fs::canonicalize(parent).await.map_err(|error| {
                storage_error("resolve edit transaction file parent", parent, error)
            })?);
        let metadata = fs::symlink_metadata(&current_parent)
            .await
            .map_err(|error| {
                storage_error(
                    "inspect edit transaction file parent",
                    &current_parent,
                    error,
                )
            })?;
        if !metadata.file_type().is_dir()
            || metadata.file_type().is_symlink()
            || !paths_equal(&current_parent, expected_parent)
        {
            return Err(AppError::conflict(format!(
                "Reject refused because the parent directory changed for {}",
                path.display()
            )));
        }
        Ok(())
    }

    async fn remove_record_backup(
        &self,
        tx_id: &str,
        record: &TransactionFileRecord,
    ) -> Result<(), AppError> {
        let Some(backup_path) = record.backup_path.as_deref() else {
            return Ok(());
        };
        let tx_arc = self.transaction_arc(tx_id)?;
        let tx = tx_arc.lock().await.clone();
        let tx_dir = self.prepare_transaction_directory(&tx).await?;
        if !backup_path.starts_with(&tx_dir) {
            return Err(AppError::conflict(
                "Edit backup path escapes its transaction directory",
            ));
        }
        match fs::remove_file(backup_path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(storage_error("discard edit backup", backup_path, error)),
        }
    }
}

fn validate_backup_segment(value: &str, label: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(AppError::validation(format!(
            "Unsafe edit-backup {label} path"
        )));
    }
    Ok(())
}

fn transaction_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn storage_error(action: &str, path: &Path, error: io::Error) -> AppError {
    AppError::storage(
        format!("Unable to {action}"),
        format!("{action} at {}: {error}", path.display()),
        false,
    )
}

async fn canonical_transaction_path(file_path: &Path) -> Result<PathBuf, AppError> {
    let normalized = lexical_normalize_absolute_path(file_path)?;
    let Some(file_name) = normalized.file_name() else {
        return Err(AppError::validation(
            "Edit transaction file path must name a file",
        ));
    };
    let Some(parent) = normalized.parent() else {
        return Err(AppError::validation(
            "Edit transaction file path has no parent",
        ));
    };
    let canonical_parent =
        normalize_canonical_path(fs::canonicalize(parent).await.map_err(|error| {
            storage_error("resolve edit transaction file parent", parent, error)
        })?);
    let metadata = fs::symlink_metadata(&canonical_parent)
        .await
        .map_err(|error| {
            storage_error(
                "inspect edit transaction file parent",
                &canonical_parent,
                error,
            )
        })?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(AppError::conflict(
            "Edit transaction file parent is not a safe directory",
        ));
    }
    Ok(canonical_parent.join(file_name))
}

fn lexical_normalize_absolute_path(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::validation(
            "Edit transaction file path must be absolute",
        ));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AppError::validation(
                        "Edit transaction file path escapes its root",
                    ));
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    if normalized.is_absolute() {
        Ok(normalized)
    } else {
        Err(AppError::validation(
            "Edit transaction file path must be absolute",
        ))
    }
}

fn parent_identity(path: &Path) -> Result<PathBuf, AppError> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::validation("Edit transaction file path has no parent"))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        dunce::simplified(&path).to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

async fn read_workspace_file(path: &Path) -> Result<ReadFileState, AppError> {
    let before = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ReadFileState {
                version: EditTransactionFileVersion::Absent,
                contents: None,
            });
        }
        Err(error) => return Err(storage_error("inspect edit transaction file", path, error)),
    };
    if !before.file_type().is_file() || before.file_type().is_symlink() {
        return Err(AppError::conflict(format!(
            "Edit transaction target is not a regular file: {}",
            path.display()
        )));
    }

    let contents = fs::read(path)
        .await
        .map_err(|error| storage_error("read edit transaction file", path, error))?;
    let after = fs::symlink_metadata(path)
        .await
        .map_err(|error| storage_error("reinspect edit transaction file", path, error))?;
    if !metadata_is_stable(&before, &after) {
        return Err(AppError::conflict(format!(
            "Edit transaction target changed while it was being read: {}",
            path.display()
        )));
    }

    Ok(ReadFileState {
        version: EditTransactionFileVersion::File {
            sha256: sha256_for(&contents),
            mode: mode_bits(&after),
            size: contents.len() as u64,
        },
        contents: Some(contents),
    })
}

fn metadata_is_stable(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    before.file_type().is_file()
        && !before.file_type().is_symlink()
        && after.file_type().is_file()
        && !after.file_type().is_symlink()
        && before.len() == after.len()
        && mode_bits(before) == mode_bits(after)
        && before.modified().ok() == after.modified().ok()
}

#[cfg(unix)]
fn mode_bits(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
fn mode_bits(metadata: &std::fs::Metadata) -> u32 {
    if metadata.permissions().readonly() {
        0o444
    } else {
        0o666
    }
}

async fn apply_mode(path: &Path, mode: u32) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .await
            .map_err(|error| storage_error("set edit transaction file mode", path, error))
    }
    #[cfg(not(unix))]
    {
        let metadata = fs::metadata(path)
            .await
            .map_err(|error| storage_error("inspect edit transaction file mode", path, error))?;
        let mut permissions = metadata.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(path, permissions)
            .await
            .map_err(|error| storage_error("set edit transaction file mode", path, error))
    }
}

async fn write_new_file(path: &Path, contents: &[u8]) -> Result<(), AppError> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| storage_error("create edit transaction file", path, error))?;
    let result = async {
        file.write_all(contents)
            .await
            .map_err(|error| storage_error("write edit transaction file", path, error))?;
        file.flush()
            .await
            .map_err(|error| storage_error("flush edit transaction file", path, error))
    }
    .await;
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path).await;
    }
    result
}

async fn replace_file(temporary_path: &Path, target_path: &Path) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        match fs::rename(temporary_path, target_path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                // Windows cannot replace an existing path with rename, so remove only after the
                // caller's second compare-and-swap check.
                fs::remove_file(target_path).await.map_err(|error| {
                    storage_error("replace rejected edit file", target_path, error)
                })?;
                fs::rename(temporary_path, target_path)
                    .await
                    .map_err(|error| {
                        storage_error("replace rejected edit file", target_path, error)
                    })
            }
            Err(error) => Err(storage_error(
                "replace rejected edit file",
                target_path,
                error,
            )),
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(temporary_path, target_path)
            .await
            .map_err(|error| storage_error("replace rejected edit file", target_path, error))
    }
}

async fn remove_backup_if_present(backup_path: Option<&Path>) {
    if let Some(backup_path) = backup_path {
        let _ = fs::remove_file(backup_path).await;
    }
}

fn sha256_for(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn render_diff(path: &Path, original: Option<&[u8]>, current: Option<&[u8]>) -> String {
    if original == current {
        return String::new();
    }
    let original_length = original.map_or(0, <[u8]>::len);
    let current_length = current.map_or(0, <[u8]>::len);
    if original_length > MAX_RENDERED_DIFF_BYTES || current_length > MAX_RENDERED_DIFF_BYTES {
        return format!(
            "File content changed (original: {original_length} bytes, current: {current_length} bytes); diff omitted because it exceeds the {MAX_RENDERED_DIFF_BYTES}-byte safety limit."
        );
    }

    match (
        original.map(std::str::from_utf8).transpose(),
        current.map(std::str::from_utf8).transpose(),
    ) {
        (Ok(original), Ok(current)) => render_text_diff(path, original, current),
        _ => format!(
            "Binary file content changed (original: {original_length} bytes, current: {current_length} bytes)."
        ),
    }
}

fn render_text_diff(path: &Path, original: Option<&str>, current: Option<&str>) -> String {
    let original_label = if original.is_some() {
        path.display().to_string()
    } else {
        "/dev/null".to_owned()
    };
    let current_label = if current.is_some() {
        path.display().to_string()
    } else {
        "/dev/null".to_owned()
    };
    let original_lines = original.map_or(0, count_lines);
    let current_lines = current.map_or(0, count_lines);
    let mut output = format!(
        "--- {original_label}\n+++ {current_label}\n@@ -1,{original_lines} +1,{current_lines} @@\n"
    );

    if let Some(original) = original {
        append_prefixed_lines(&mut output, '-', original);
    }
    if let Some(current) = current {
        append_prefixed_lines(&mut output, '+', current);
    }
    output
}

fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.lines().count()
    }
}

fn append_prefixed_lines(output: &mut String, prefix: char, text: &str) {
    if text.is_empty() {
        output.push(prefix);
        output.push_str("<empty file>\n");
        return;
    }
    for line in text.lines() {
        output.push(prefix);
        output.push_str(line);
        output.push('\n');
    }
}
