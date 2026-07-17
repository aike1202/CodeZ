use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    io::{self, Write as _},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use dashmap::{DashMap, mapref::entry::Entry};
use sha2::{Digest, Sha256};
use tempfile::{Builder as TempFileBuilder, NamedTempFile};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

use codez_core::{
    AppError, AppPaths, CancellationToken, SafeWorkspacePath, SessionId, StreamId, WorkspaceRoot,
    context::ContextScopeId,
};

const MAX_RENDERED_DIFF_BYTES: usize = 1024 * 1024;
const MAX_TRANSACTION_METADATA_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRANSACTION_LOCATOR_BYTES: usize = 16 * 1024;
const MAX_BACKUP_SEGMENT_BYTES: usize = 512;
const TRANSACTION_LOCATOR_DIRECTORY: &str = ".transaction-index";

mod history_revert_workspace;

/// Stable preview of the final workspace effects produced by reverting transactions in order.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTransactionRevertPreview {
    /// Files that did not exist before the oldest requested transaction.
    pub to_delete: Vec<PathBuf>,
    /// Files whose contents will be restored from a transaction backup.
    pub to_restore: Vec<PathBuf>,
}

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

/// Content identity persisted before a workspace mutation is committed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTransactionContentVersion {
    pub sha256: String,
    pub size: u64,
}

/// Durable token for one prepared workspace mutation.
///
/// Callers use the token either to verify the committed bytes or to abort the prepare. The
/// previous intent remains private so only this service can perform the compare-and-swap rollback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditMutationPreparation {
    intended: EditTransactionContentVersion,
    previous_intended: Option<EditTransactionContentVersion>,
}

impl EditMutationPreparation {
    /// Returns the exact content version this prepare authorized.
    #[must_use]
    pub fn intended(&self) -> &EditTransactionContentVersion {
        &self.intended
    }
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

/// Trusted chat-run identity persisted with a new edit transaction.
#[derive(Debug, Clone)]
pub struct EditTransactionRegistration {
    pub session_id: SessionId,
    pub context_scope_id: ContextScopeId,
    pub turn_id: StreamId,
    pub workspace_root: WorkspaceRoot,
}

/// Persisted transaction ownership used by history and rollback callers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTransactionProvenance {
    pub session_id: SessionId,
    pub generation_id: String,
    pub context_scope_id: Option<String>,
    pub turn_id: Option<String>,
    pub workspace_root: Option<PathBuf>,
}

/// Read-only locator identity used to acquire session activity before transaction recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditTransactionActivityHint {
    pub session_id: SessionId,
    generation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum TransactionLocatorPhase {
    Prepared,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionLocator {
    tx_id: String,
    session_id: SessionId,
    generation_id: String,
    phase: TransactionLocatorPhase,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct TransactionFileRecord {
    backup_path: Option<PathBuf>,
    original: EditTransactionFileVersion,
    #[serde(default)]
    intended_post_mutation: Option<EditTransactionContentVersion>,
    expected_post_mutation: Option<EditTransactionFileVersion>,
    parent_identity: PersistedDirectoryIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum PersistedDirectoryIdentity {
    Stable(StableDirectoryIdentity),
    LegacyPath(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StableDirectoryIdentity {
    path: PathBuf,
    file_id: String,
}

impl PersistedDirectoryIdentity {
    fn path(&self) -> &Path {
        match self {
            Self::Stable(identity) => identity.path(),
            Self::LegacyPath(path) => path,
        }
    }
}

impl StableDirectoryIdentity {
    fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TransactionState {
    id: String,
    session_id: String,
    #[serde(default)]
    generation_id: String,
    #[serde(default)]
    context_scope_id: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    workspace_root: Option<PathBuf>,
    files: HashMap<PathBuf, TransactionFileRecord>,
    created_at: u64,
}

struct ReadFileState {
    version: EditTransactionFileVersion,
    contents: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RevertAction {
    Delete,
    Restore,
}

/// Persists edit backups below the CodeZ data root and safely resolves file decisions.
pub struct EditTransactionService {
    transactions: DashMap<String, Arc<Mutex<TransactionState>>>,
    transaction_queues: DashMap<String, Arc<Mutex<()>>>,
    closing_transactions: DashMap<String, bool>,
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
            closing_transactions: DashMap::new(),
            closing_sessions: DashMap::new(),
            backup_root: app_paths.data_directory().join("edit-backups"),
        }
    }

    /// Discards every persisted edit backup and in-memory transaction for one deleted session.
    ///
    /// This operation never restores workspace files. It only removes CodeZ's rollback data
    /// after callers have stopped the session that owns the transactions.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the backup directory is unsafe or cannot be removed.
    pub async fn cleanup_session(&self, session_id: &str) -> Result<(), AppError> {
        let typed_session_id = SessionId::parse(session_id.to_owned())
            .map_err(|_| AppError::validation("The edit transaction session ID is malformed"))?;
        let session_directory = self.backup_directory(session_id, None)?;
        self.closing_sessions.insert(session_id.to_owned(), true);
        let result = async {
            let locators = self
                .transaction_locators_for_session(&typed_session_id)
                .await?;
            let transactions = self
                .transactions
                .iter()
                .map(|entry| (entry.key().clone(), Arc::clone(entry.value())))
                .collect::<Vec<_>>();
            let mut transaction_ids = locators
                .iter()
                .map(|locator| locator.tx_id.clone())
                .collect::<HashSet<_>>();
            for (transaction_id, transaction) in transactions {
                if transaction.lock().await.session_id == session_id {
                    transaction_ids.insert(transaction_id);
                }
            }

            for transaction_id in &transaction_ids {
                self.run_exclusive(transaction_id, || async { Ok(()) }, None, true)
                    .await?;
            }
            self.remove_session_backup_directory(&session_directory)
                .await?;
            for locator in &locators {
                self.remove_transaction_locator_if_matches(locator).await?;
            }
            for transaction_id in transaction_ids {
                self.transactions.remove(&transaction_id);
                self.transaction_queues.remove(&transaction_id);
                self.closing_transactions.remove(&transaction_id);
            }
            Ok(())
        }
        .await;
        self.closing_sessions.remove(session_id);
        result
    }

    /// Previews the final file actions produced by reverting the supplied transactions in order.
    ///
    /// Later entries in `tx_ids` are older transactions and therefore replace the preview action
    /// chosen by a newer transaction for the same canonical path. Returned paths are sorted.
    ///
    /// # Errors
    ///
    /// Returns an error when request identifiers are unsafe or duplicated, persisted metadata is
    /// unavailable or untrusted, or a requested transaction belongs to another session.
    pub async fn preview_revert_transactions(
        &self,
        session_id: &str,
        tx_ids: &[String],
    ) -> Result<EditTransactionRevertPreview, AppError> {
        let transactions = self
            .load_transactions_for_session(session_id, tx_ids)
            .await?;
        let mut actions: Vec<(PathBuf, RevertAction)> = Vec::new();

        for transaction in transactions {
            let transaction = transaction.lock().await;
            let mut files = transaction.files.iter().collect::<Vec<_>>();
            files.sort_by_key(|(path, _)| *path);
            for (path, record) in files {
                let action = match &record.original {
                    EditTransactionFileVersion::Absent => RevertAction::Delete,
                    EditTransactionFileVersion::File { .. } => RevertAction::Restore,
                };
                if let Some((stored_path, stored_action)) = actions
                    .iter_mut()
                    .find(|(stored_path, _)| paths_equal(stored_path, path))
                {
                    *stored_path = path.clone();
                    *stored_action = action;
                } else {
                    actions.push((path.clone(), action));
                }
            }
        }

        actions.sort_by(|(left, _), (right, _)| left.cmp(right));
        let mut preview = EditTransactionRevertPreview::default();
        for (path, action) in actions {
            match action {
                RevertAction::Delete => preview.to_delete.push(path),
                RevertAction::Restore => preview.to_restore.push(path),
            }
        }
        Ok(preview)
    }

    /// Restores persisted transactions in the exact order supplied by the caller.
    ///
    /// Every requested transaction is safely loaded before the first workspace mutation. Within
    /// one transaction, independent files are attempted in stable path order. Failed entries and
    /// their backups remain tracked for retry; successfully restored entries are removed.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid request, untrusted persisted state, a restore conflict, or
    /// a persistence failure. An error may follow successful restores from earlier entries.
    pub async fn revert_transactions(
        &self,
        session_id: &str,
        tx_ids: &[String],
    ) -> Result<(), AppError> {
        let transactions = self
            .load_transactions_for_session(session_id, tx_ids)
            .await?;
        for (tx_id, transaction) in tx_ids.iter().zip(transactions) {
            self.revert_loaded_transaction(session_id, tx_id, transaction)
                .await?;
        }
        Ok(())
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

        let _guard = if let Some(token) = abort_signal {
            tokio::select! {
                guard = lock.lock() => guard,
                _ = token.cancelled() => {
                    return Err(AppError::cancelled(
                        "Edit transaction was aborted while waiting for its lock.",
                    ));
                }
            }
        } else {
            lock.lock().await
        };

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
        self.register_transaction_state(
            tx_id,
            TransactionState {
                id: tx_id.to_owned(),
                session_id: session_id.to_owned(),
                generation_id: uuid::Uuid::new_v4().to_string(),
                context_scope_id: None,
                turn_id: None,
                workspace_root: None,
                files: HashMap::new(),
                created_at: transaction_timestamp(),
            },
        )
        .await
    }

    /// Registers a chat-owned transaction with durable turn and workspace provenance.
    ///
    /// # Errors
    ///
    /// Returns an error when an identity is unsafe, the transaction already exists, the
    /// workspace authority is no longer canonical, or metadata cannot be persisted.
    pub async fn register_chat_transaction(
        &self,
        tx_id: &str,
        registration: EditTransactionRegistration,
    ) -> Result<(), AppError> {
        let workspace_root =
            normalize_canonical_path(registration.workspace_root.as_path().to_path_buf());
        validate_canonical_workspace_root(&workspace_root).await?;
        self.register_transaction_state(
            tx_id,
            TransactionState {
                id: tx_id.to_owned(),
                session_id: registration.session_id.as_str().to_owned(),
                generation_id: uuid::Uuid::new_v4().to_string(),
                context_scope_id: Some(registration.context_scope_id.to_string()),
                turn_id: Some(registration.turn_id.as_str().to_owned()),
                workspace_root: Some(workspace_root),
                files: HashMap::new(),
                created_at: transaction_timestamp(),
            },
        )
        .await
    }

    async fn register_transaction_state(
        &self,
        tx_id: &str,
        tx: TransactionState,
    ) -> Result<(), AppError> {
        let session_id = tx.session_id.clone();
        let typed_session_id = SessionId::parse(session_id.clone())
            .map_err(|_| AppError::validation("The edit transaction session ID is malformed"))?;
        self.backup_directory(&session_id, Some(tx_id))?;
        validate_generation_id(&tx.generation_id)?;
        if self.closing_sessions.contains_key(&session_id) {
            return Err(AppError::conflict(format!(
                "Session {session_id} is closing; edit transactions are no longer accepted."
            )));
        }

        let queue = self
            .transaction_queues
            .entry(tx_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = queue.lock().await;
        if self.closing_sessions.contains_key(&session_id) {
            return Err(AppError::conflict(format!(
                "Session {session_id} is closing; edit transactions are no longer accepted."
            )));
        }
        match self.transactions.entry(tx_id.to_owned()) {
            Entry::Occupied(_) => {
                return Err(AppError::conflict(format!(
                    "Edit transaction {tx_id} is already registered"
                )));
            }
            Entry::Vacant(_) => {}
        }

        let locator = TransactionLocator {
            tx_id: tx_id.to_owned(),
            session_id: typed_session_id,
            generation_id: tx.generation_id.clone(),
            phase: TransactionLocatorPhase::Prepared,
        };
        self.prepare_transaction_locator(&locator).await?;
        self.transactions
            .insert(tx_id.to_owned(), Arc::new(Mutex::new(tx)));
        if let Err(error) = self.save_metadata(tx_id).await {
            self.transactions.remove(tx_id);
            return Err(error);
        }
        self.commit_transaction_locator(locator).await?;

        Ok(())
    }

    /// Resolves a transaction to typed ownership using only durable service metadata.
    ///
    /// The locator is never trusted by itself. Its session and generation must match the targeted
    /// transaction metadata before the result is returned. A prepared locator is committed after
    /// that validation, which makes registration recoverable after a process interruption.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the transaction is missing or its locator, generation, persisted
    /// identity, or workspace authority is invalid.
    pub async fn lookup_transaction_provenance(
        &self,
        tx_id: &str,
    ) -> Result<EditTransactionProvenance, AppError> {
        let transaction = self.load_transaction_from_locator(tx_id).await?;
        let transaction = transaction.lock().await;
        transaction_provenance(tx_id, &transaction)
    }

    /// Reads the stable locator identity without repairing or committing transaction state.
    ///
    /// Callers use this hint only to acquire the matching session activity lease. The hint is
    /// revalidated by [`Self::lookup_transaction_provenance_with_hint`] before any durable
    /// transaction recovery is allowed.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the transaction ID or durable locator is missing or invalid.
    pub async fn lookup_transaction_activity_hint(
        &self,
        tx_id: &str,
    ) -> Result<EditTransactionActivityHint, AppError> {
        validate_backup_segment(tx_id, "transaction")?;
        let locator = self
            .read_transaction_locator_if_present(tx_id)
            .await?
            .ok_or_else(|| transaction_not_found(tx_id))?;
        Ok(EditTransactionActivityHint {
            session_id: locator.session_id,
            generation_id: locator.generation_id,
        })
    }

    /// Resolves trusted provenance after the caller acquired activity for the hinted session.
    ///
    /// The current locator must still match the read-only hint before stale-locator cleanup or a
    /// prepared-locator commit can modify durable state.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the locator changed or the transaction cannot be loaded safely.
    pub async fn lookup_transaction_provenance_with_hint(
        &self,
        tx_id: &str,
        hint: &EditTransactionActivityHint,
    ) -> Result<EditTransactionProvenance, AppError> {
        let transaction = self
            .load_transaction_from_locator_with_hint(tx_id, Some(hint))
            .await?;
        let transaction = transaction.lock().await;
        transaction_provenance(tx_id, &transaction)
    }

    /// Revalidates that a durable transaction still has exactly the expected ownership identity.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the transaction disappeared, was reused, or its persisted
    /// provenance changed.
    pub async fn verify_transaction_provenance(
        &self,
        tx_id: &str,
        expected: &EditTransactionProvenance,
    ) -> Result<(), AppError> {
        let actual = self.lookup_transaction_provenance(tx_id).await?;
        if &actual != expected {
            return Err(AppError::conflict(format!(
                "Edit transaction {tx_id} provenance changed while acquiring session activity"
            )));
        }
        Ok(())
    }

    /// Returns trusted ownership metadata for one session transaction, loading it after restart.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction is missing, belongs to another session, or its
    /// persisted identity or workspace authority is invalid.
    pub async fn get_provenance_for_session(
        &self,
        session_id: &str,
        tx_id: &str,
    ) -> Result<EditTransactionProvenance, AppError> {
        let provenance = self.lookup_transaction_provenance(tx_id).await?;
        if provenance.session_id.as_str() != session_id {
            return Err(AppError::conflict(format!(
                "Edit transaction {tx_id} does not belong to session {session_id}"
            )));
        }
        Ok(provenance)
    }

    /// Removes a transaction only when it still belongs to `session_id` and tracks no files.
    ///
    /// Callers must invoke this after all tool work for the transaction has quiesced. A closing
    /// marker also prevents a concurrently finishing backup from becoming newly tracked.
    ///
    /// # Errors
    ///
    /// Returns an error when persisted state is unsafe, belongs to another session, or cannot be
    /// removed. A non-empty transaction returns `false` and remains intact.
    pub async fn discard_empty_transaction_for_session(
        &self,
        session_id: &str,
        tx_id: &str,
    ) -> Result<bool, AppError> {
        let transaction = self.load_transaction_for_session(session_id, tx_id).await?;
        let transaction_for_cleanup = Arc::clone(&transaction);
        let removed = self
            .run_exclusive(
                tx_id,
                || async {
                    self.closing_transactions.insert(tx_id.to_owned(), true);
                    let result = async {
                        let transaction = transaction_for_cleanup.lock().await;
                        if transaction.id != tx_id || transaction.session_id != session_id {
                            return Err(AppError::conflict(format!(
                                "Edit transaction {tx_id} does not belong to session {session_id}"
                            )));
                        }
                        if !transaction.files.is_empty() {
                            return Ok(false);
                        }
                        self.validate_transaction_state(session_id, tx_id, &transaction)
                            .await?;
                        self.remove_empty_transaction_directory(session_id, tx_id)
                            .await?;
                        Ok(true)
                    }
                    .await;
                    self.closing_transactions.remove(tx_id);
                    result
                },
                None,
                true,
            )
            .await?;
        if removed {
            self.transactions.remove(tx_id);
            self.transaction_queues.remove(tx_id);
        }
        Ok(removed)
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
        let json = serde_json::to_vec(&tx).map_err(|error| {
            AppError::internal(format!("Failed to serialize edit metadata: {error}"))
        })?;
        validate_metadata_size(json.len())?;
        atomic_persist_file(&metadata_path, &json, None).await
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
        self.run_exclusive(
            tx_id,
            || self.backup_file_locked(tx_id, file_path, content),
            None,
            false,
        )
        .await
    }

    async fn backup_file_locked(
        &self,
        tx_id: &str,
        file_path: &Path,
        content: Option<String>,
    ) -> Result<bool, AppError> {
        if self.closing_transactions.contains_key(tx_id) {
            return Err(AppError::conflict(format!(
                "Edit transaction {tx_id} is closing; new backups are no longer accepted"
            )));
        }
        let tx_arc = self.transaction_arc(tx_id)?;
        let registered_path = canonical_transaction_path(file_path).await?;

        let (session_id, workspace_root, existing) = {
            let tx = tx_arc.lock().await;
            (
                tx.session_id.clone(),
                tx.workspace_root.clone(),
                tx.files.contains_key(&registered_path),
            )
        };
        if let Some(workspace_root) = workspace_root {
            let workspace_root = WorkspaceRoot::from_canonical(workspace_root).map_err(|_| {
                AppError::conflict("Edit transaction workspace authority is invalid")
            })?;
            SafeWorkspacePath::from_canonical(&workspace_root, &registered_path).map_err(|_| {
                AppError::permission_denied(
                    "The edit transaction cannot track a file outside its workspace",
                )
            })?;
        }
        if existing {
            return Ok(false);
        }

        let parent_identity = capture_parent_identity(&registered_path).await?;
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
                    generation_id: String::new(),
                    context_scope_id: None,
                    turn_id: None,
                    workspace_root: None,
                    files: HashMap::new(),
                    created_at: 0,
                };
                let tx_dir = self.prepare_transaction_directory(&tx).await?;
                let backup_path = tx_dir.join(format!("{}.bak", uuid::Uuid::new_v4()));
                write_new_file(&backup_path, &bytes).await?;
                if let Err(error) = apply_mode_and_sync(&backup_path, mode).await {
                    return Err(cleanup_backup_after_error(Some(&backup_path), error).await);
                }

                TransactionFileRecord {
                    backup_path: Some(backup_path),
                    original: EditTransactionFileVersion::File { sha256, mode, size },
                    intended_post_mutation: None,
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
                    intended_post_mutation: None,
                    expected_post_mutation: None,
                    parent_identity,
                }
            }
        };

        let staged_backup = record.backup_path.clone();
        {
            let mut tx = tx_arc.lock().await;
            if self.closing_transactions.contains_key(tx_id) {
                drop(tx);
                let error = AppError::conflict(format!(
                    "Edit transaction {tx_id} closed before its backup could be registered"
                ));
                return Err(cleanup_backup_after_error(staged_backup.as_deref(), error).await);
            }
            if tx.files.contains_key(&registered_path) {
                drop(tx);
                remove_backup_if_present(staged_backup.as_deref()).await?;
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
            return Err(cleanup_backup_after_error(staged_backup.as_deref(), error).await);
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
        self.run_exclusive(
            tx_id,
            || self.discard_staged_backup_locked(tx_id, file_path),
            None,
            true,
        )
        .await
    }

    async fn discard_staged_backup_locked(
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

        if let Err(remove_error) = self.remove_record_backup(tx_id, &record).await {
            {
                let mut tx = tx_arc.lock().await;
                tx.files.insert(registered_path, record);
            }
            if let Err(metadata_error) = self.save_metadata(tx_id).await {
                return Err(AppError::storage(
                    "The staged backup could not be discarded or restored to transaction metadata",
                    format!(
                        "backup cleanup error: {remove_error}; metadata recovery error: {metadata_error}"
                    ),
                    false,
                ));
            }
            return Err(remove_error);
        }
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
        staged_backup: bool,
    ) -> Result<(), AppError> {
        self.run_exclusive(
            tx_id,
            || self.record_mutation_locked(tx_id, file_path, staged_backup),
            None,
            false,
        )
        .await
    }

    /// Durably records the exact content CodeZ intends to commit before the workspace write.
    pub async fn prepare_mutation(
        &self,
        tx_id: &str,
        file_path: &Path,
        intended: EditTransactionContentVersion,
    ) -> Result<EditMutationPreparation, AppError> {
        validate_content_version(&intended)?;
        self.run_exclusive(
            tx_id,
            || self.prepare_mutation_locked(tx_id, file_path, intended),
            None,
            false,
        )
        .await
    }

    async fn prepare_mutation_locked(
        &self,
        tx_id: &str,
        file_path: &Path,
        intended: EditTransactionContentVersion,
    ) -> Result<EditMutationPreparation, AppError> {
        let tx_arc = self.transaction_arc(tx_id)?;
        let Some(registered_path) = self.find_registered_path(&tx_arc, file_path).await? else {
            return Err(AppError::not_found(format!(
                "No edit backup is registered for {}",
                file_path.display()
            )));
        };
        let record = {
            let tx = tx_arc.lock().await;
            tx.files.get(&registered_path).cloned()
        }
        .ok_or_else(|| {
            AppError::not_found(format!(
                "No edit backup is registered for {}",
                registered_path.display()
            ))
        })?;
        self.verify_parent_identity(&registered_path, &record.parent_identity)
            .await?;
        let current = read_workspace_file(&registered_path).await?.version;
        self.verify_parent_identity(&registered_path, &record.parent_identity)
            .await?;
        if !record_accepts_current_state(&record, &current) {
            return Err(AppError::conflict(format!(
                "File {} changed before its intended mutation could be persisted",
                registered_path.display()
            )));
        }

        let previous_intended = {
            let mut tx = tx_arc.lock().await;
            let record = tx.files.get_mut(&registered_path).ok_or_else(|| {
                AppError::not_found(format!(
                    "No edit backup is registered for {}",
                    registered_path.display()
                ))
            })?;
            record.intended_post_mutation.replace(intended.clone())
        };
        if let Err(error) = self.save_metadata(tx_id).await {
            let mut tx = tx_arc.lock().await;
            if let Some(record) = tx.files.get_mut(&registered_path) {
                record.intended_post_mutation = previous_intended;
            }
            return Err(error);
        }
        Ok(EditMutationPreparation {
            intended,
            previous_intended,
        })
    }

    /// Aborts one durable prepare if it is still the current intent for the tracked file.
    ///
    /// For an existing transaction record, abort restores the preceding intent. When the caller
    /// staged the record for this attempt, abort removes both the record and its backup. A newer
    /// prepare causes a conflict instead of being overwritten.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction changed after prepare or durable cleanup fails.
    pub async fn abort_prepared_mutation(
        &self,
        tx_id: &str,
        file_path: &Path,
        preparation: EditMutationPreparation,
        staged_backup: bool,
    ) -> Result<(), AppError> {
        self.run_exclusive(
            tx_id,
            || self.abort_prepared_mutation_locked(tx_id, file_path, preparation, staged_backup),
            None,
            false,
        )
        .await
    }

    async fn abort_prepared_mutation_locked(
        &self,
        tx_id: &str,
        file_path: &Path,
        preparation: EditMutationPreparation,
        staged_backup: bool,
    ) -> Result<(), AppError> {
        let tx_arc = self.transaction_arc(tx_id)?;
        let Some(registered_path) = self.find_registered_path(&tx_arc, file_path).await? else {
            return Err(AppError::conflict(format!(
                "The prepared mutation record for {} is no longer available",
                file_path.display()
            )));
        };
        let record = {
            let tx = tx_arc.lock().await;
            tx.files.get(&registered_path).cloned()
        }
        .ok_or_else(|| {
            AppError::conflict(format!(
                "The prepared mutation record for {} is no longer available",
                registered_path.display()
            ))
        })?;
        if record.intended_post_mutation.as_ref() != Some(&preparation.intended) {
            return Err(AppError::conflict(format!(
                "The mutation intent for {} changed before the prepare could be aborted",
                registered_path.display()
            )));
        }

        if !staged_backup {
            {
                let mut tx = tx_arc.lock().await;
                let tracked = tx.files.get_mut(&registered_path).ok_or_else(|| {
                    AppError::conflict(format!(
                        "The prepared mutation record for {} is no longer available",
                        registered_path.display()
                    ))
                })?;
                if tracked.intended_post_mutation.as_ref() != Some(&preparation.intended) {
                    return Err(AppError::conflict(format!(
                        "The mutation intent for {} changed before the prepare could be aborted",
                        registered_path.display()
                    )));
                }
                tracked.intended_post_mutation = preparation.previous_intended;
            }
            if let Err(error) = self.save_metadata(tx_id).await {
                let mut tx = tx_arc.lock().await;
                if let Some(tracked) = tx.files.get_mut(&registered_path) {
                    tracked.intended_post_mutation = Some(preparation.intended);
                }
                return Err(error);
            }
            return Ok(());
        }

        if preparation.previous_intended.is_some() || record.expected_post_mutation.is_some() {
            return Err(AppError::conflict(format!(
                "The prepared mutation for {} cannot discard an existing transaction record",
                registered_path.display()
            )));
        }
        {
            let mut tx = tx_arc.lock().await;
            if tx.files.get(&registered_path) != Some(&record) {
                return Err(AppError::conflict(format!(
                    "The prepared mutation record for {} changed before cleanup",
                    registered_path.display()
                )));
            }
            tx.files.remove(&registered_path);
        }
        if let Err(error) = self.save_metadata(tx_id).await {
            tx_arc.lock().await.files.insert(registered_path, record);
            return Err(error);
        }
        if let Err(cleanup_error) = self.remove_record_backup(tx_id, &record).await {
            tx_arc.lock().await.files.insert(registered_path, record);
            if let Err(recovery_error) = self.save_metadata(tx_id).await {
                return Err(AppError::storage(
                    "The aborted mutation backup could not be cleaned up or restored to transaction metadata",
                    format!(
                        "backup cleanup error: {cleanup_error}; metadata recovery error: {recovery_error}"
                    ),
                    false,
                ));
            }
            return Err(AppError::storage(
                "The aborted mutation backup could not be cleaned up",
                cleanup_error.to_string(),
                false,
            ));
        }
        Ok(())
    }

    /// Verifies the committed bytes against the durable intent before recording exact file state.
    pub async fn record_verified_mutation(
        &self,
        tx_id: &str,
        file_path: PathBuf,
        intended: &EditTransactionContentVersion,
    ) -> Result<(), AppError> {
        validate_content_version(intended)?;
        self.run_exclusive(
            tx_id,
            || self.record_verified_mutation_locked(tx_id, file_path, intended),
            None,
            false,
        )
        .await
    }

    async fn record_verified_mutation_locked(
        &self,
        tx_id: &str,
        file_path: PathBuf,
        intended: &EditTransactionContentVersion,
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
        }
        .ok_or_else(|| {
            AppError::not_found(format!(
                "No edit backup is registered for {}",
                registered_path.display()
            ))
        })?;
        if tracked_record.intended_post_mutation.as_ref() != Some(intended) {
            return Err(AppError::conflict(format!(
                "The committed content does not match the durable mutation intent for {}",
                registered_path.display()
            )));
        }
        self.verify_parent_identity(&registered_path, &tracked_record.parent_identity)
            .await?;
        let current = read_workspace_file(&registered_path).await?.version;
        self.verify_parent_identity(&registered_path, &tracked_record.parent_identity)
            .await?;
        if content_version(&current).as_ref() != Some(intended) {
            return Err(AppError::conflict(format!(
                "File {} does not match the content CodeZ intended to commit",
                registered_path.display()
            )));
        }

        let previous_expected = {
            let mut tx = tx_arc.lock().await;
            let record = tx.files.get_mut(&registered_path).ok_or_else(|| {
                AppError::not_found(format!(
                    "No edit backup is registered for {}",
                    registered_path.display()
                ))
            })?;
            record.expected_post_mutation.replace(current)
        };
        if let Err(error) = self.save_metadata(tx_id).await {
            let mut tx = tx_arc.lock().await;
            if let Some(record) = tx.files.get_mut(&registered_path) {
                record.expected_post_mutation = previous_expected;
            }
            return Err(error);
        }
        Ok(())
    }

    async fn record_mutation_locked(
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
        let previous_expected = record.expected_post_mutation.replace(current);
        drop(tx);
        if let Err(error) = self.save_metadata(tx_id).await {
            let mut tx = tx_arc.lock().await;
            if let Some(record) = tx.files.get_mut(&registered_path) {
                record.expected_post_mutation = previous_expected;
            }
            return Err(error);
        }
        Ok(())
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
            let current_matches_expected = (record.expected_post_mutation.is_some()
                || record.intended_post_mutation.is_some())
            .then(|| record_accepts_committed_state(record, &current.version));
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

                if let Err(remove_error) = self.remove_record_backup(tx_id, &record).await {
                    {
                        let mut tx = tx_arc.lock().await;
                        tx.files.insert(registered_path, record);
                    }
                    if let Err(metadata_error) = self.save_metadata(tx_id).await {
                        return Err(AppError::storage(
                            "The accepted backup could not be removed or restored to transaction metadata",
                            format!(
                                "backup cleanup error: {remove_error}; metadata recovery error: {metadata_error}"
                            ),
                            false,
                        ));
                    }
                    return Err(remove_error);
                }
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
                    tx_arc
                        .lock()
                        .await
                        .files
                        .insert(registered_path.clone(), record);
                    tracing::error!(
                        transaction_id = tx_id,
                        path = %registered_path.display(),
                        "edit reject restored the file but could not persist backup cleanup"
                    );
                    return Err(error);
                }

                if let Err(remove_error) = self.remove_record_backup(tx_id, &record).await {
                    {
                        let mut tx = tx_arc.lock().await;
                        tx.files.insert(registered_path, record);
                    }
                    if let Err(metadata_error) = self.save_metadata(tx_id).await {
                        return Err(AppError::storage(
                            "The rejected backup could not be removed or restored to transaction metadata",
                            format!(
                                "backup cleanup error: {remove_error}; metadata recovery error: {metadata_error}"
                            ),
                            false,
                        ));
                    }
                    return Err(remove_error);
                }
                Ok(true)
            },
            None,
            false,
        )
        .await
    }

    fn transaction_locator_directory(&self) -> PathBuf {
        self.backup_root.join(TRANSACTION_LOCATOR_DIRECTORY)
    }

    fn transaction_locator_path(&self, tx_id: &str) -> Result<PathBuf, AppError> {
        validate_backup_segment(tx_id, "transaction")?;
        Ok(self
            .transaction_locator_directory()
            .join(format!("{tx_id}.json")))
    }

    async fn prepare_transaction_locator(
        &self,
        locator: &TransactionLocator,
    ) -> Result<(), AppError> {
        validate_transaction_locator(locator)?;
        if let Some(existing) = self
            .read_transaction_locator_if_present(&locator.tx_id)
            .await?
        {
            if self.transaction_directory_exists(&existing).await? {
                return Err(AppError::conflict(format!(
                    "Edit transaction {} already has durable ownership metadata",
                    locator.tx_id
                )));
            }
            self.remove_transaction_locator_if_matches(&existing)
                .await?;
        } else if self.transaction_directory_exists(locator).await? {
            return Err(AppError::conflict(format!(
                "Edit transaction {} has unindexed durable metadata",
                locator.tx_id
            )));
        }

        self.write_transaction_locator(locator).await
    }

    async fn commit_transaction_locator(
        &self,
        mut locator: TransactionLocator,
    ) -> Result<(), AppError> {
        let Some(current) = self
            .read_transaction_locator_if_present(&locator.tx_id)
            .await?
        else {
            return Err(AppError::conflict(format!(
                "Edit transaction {} lost its prepared locator",
                locator.tx_id
            )));
        };
        if current != locator {
            return Err(AppError::conflict(format!(
                "Edit transaction {} locator changed before commit",
                locator.tx_id
            )));
        }
        let transaction = self
            .read_persisted_transaction(locator.session_id.as_str(), &locator.tx_id)
            .await?;
        validate_locator_target(&locator, &transaction)?;
        locator.phase = TransactionLocatorPhase::Committed;
        self.write_transaction_locator(&locator).await
    }

    async fn load_transaction_from_locator(
        &self,
        tx_id: &str,
    ) -> Result<Arc<Mutex<TransactionState>>, AppError> {
        self.load_transaction_from_locator_with_hint(tx_id, None)
            .await
    }

    async fn load_transaction_from_locator_with_hint(
        &self,
        tx_id: &str,
        expected_hint: Option<&EditTransactionActivityHint>,
    ) -> Result<Arc<Mutex<TransactionState>>, AppError> {
        validate_backup_segment(tx_id, "transaction")?;
        let queue = self
            .transaction_queues
            .entry(tx_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = queue.lock().await;

        let Some(locator) = self.read_transaction_locator_if_present(tx_id).await? else {
            return Err(transaction_not_found(tx_id));
        };
        if expected_hint.is_some_and(|hint| {
            locator.session_id != hint.session_id || locator.generation_id != hint.generation_id
        }) {
            return Err(AppError::conflict(format!(
                "Edit transaction {tx_id} locator changed while acquiring session activity"
            )));
        }
        if self
            .closing_sessions
            .contains_key(locator.session_id.as_str())
        {
            return Err(AppError::run_active(format!(
                "Session {} is closing; edit transaction work is no longer accepted.",
                locator.session_id.as_str()
            )));
        }
        if !self.transaction_metadata_exists(&locator).await? {
            self.remove_transaction_locator_if_matches(&locator).await?;
            return Err(transaction_not_found(tx_id));
        }
        let transaction = match self
            .read_persisted_transaction(locator.session_id.as_str(), tx_id)
            .await
        {
            Ok(transaction) => transaction,
            Err(error) => {
                if !self.transaction_metadata_exists(&locator).await? {
                    self.remove_transaction_locator_if_matches(&locator).await?;
                    return Err(transaction_not_found(tx_id));
                }
                return Err(error);
            }
        };
        validate_locator_target(&locator, &transaction)?;

        if locator.phase == TransactionLocatorPhase::Prepared {
            self.commit_transaction_locator(locator.clone()).await?;
        }

        match self.transactions.entry(tx_id.to_owned()) {
            Entry::Vacant(entry) => Ok(entry.insert(Arc::new(Mutex::new(transaction))).clone()),
            Entry::Occupied(entry) => {
                let existing = entry.get().clone();
                let existing_provenance = {
                    let existing = existing.lock().await;
                    transaction_provenance(tx_id, &existing)?
                };
                let persisted_provenance = transaction_provenance(tx_id, &transaction)?;
                if existing_provenance != persisted_provenance {
                    return Err(AppError::conflict(format!(
                        "Edit transaction {tx_id} durable provenance differs from active state"
                    )));
                }
                Ok(existing)
            }
        }
    }

    async fn transaction_locators_for_session(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<TransactionLocator>, AppError> {
        let locator_directory = self.transaction_locator_directory();
        match fs::symlink_metadata(&locator_directory).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(storage_error(
                    "inspect edit transaction locator directory",
                    &locator_directory,
                    error,
                ));
            }
            Ok(_) => self.validate_transaction_locator_directory().await?,
        }

        let mut entries = fs::read_dir(&locator_directory).await.map_err(|error| {
            storage_error(
                "read edit transaction locator directory",
                &locator_directory,
                error,
            )
        })?;
        let mut locators = Vec::new();
        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            storage_error(
                "read edit transaction locator directory",
                &locator_directory,
                error,
            )
        })? {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).await.map_err(|error| {
                storage_error("inspect edit transaction locator entry", &path, error)
            })?;
            if !is_safe_regular_file(&metadata) {
                return Err(AppError::conflict(
                    "Edit transaction index contains an unsafe entry",
                ));
            }
            let Some(tx_id) = path
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|_| {
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                })
            else {
                return Err(AppError::conflict(
                    "Edit transaction index contains an unexpected entry",
                ));
            };
            if let Some(locator) = self.read_transaction_locator_if_present(tx_id).await?
                && locator.session_id == *session_id
            {
                locators.push(locator);
            }
        }
        locators.sort_by(|left, right| left.tx_id.cmp(&right.tx_id));
        Ok(locators)
    }

    async fn transaction_metadata_exists(
        &self,
        locator: &TransactionLocator,
    ) -> Result<bool, AppError> {
        let metadata_path = self
            .backup_directory(locator.session_id.as_str(), Some(&locator.tx_id))?
            .join("metadata.json");
        match fs::symlink_metadata(&metadata_path).await {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(storage_error(
                "inspect edit transaction metadata target",
                &metadata_path,
                error,
            )),
        }
    }

    async fn transaction_directory_exists(
        &self,
        locator: &TransactionLocator,
    ) -> Result<bool, AppError> {
        let transaction_directory =
            self.backup_directory(locator.session_id.as_str(), Some(&locator.tx_id))?;
        match fs::symlink_metadata(&transaction_directory).await {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(storage_error(
                "inspect edit transaction directory target",
                &transaction_directory,
                error,
            )),
        }
    }

    async fn read_transaction_locator_if_present(
        &self,
        tx_id: &str,
    ) -> Result<Option<TransactionLocator>, AppError> {
        let locator_path = self.transaction_locator_path(tx_id)?;
        match fs::symlink_metadata(&locator_path).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(storage_error(
                    "inspect edit transaction locator",
                    &locator_path,
                    error,
                ));
            }
            Ok(metadata) if is_safe_regular_file(&metadata) => {}
            Ok(_) => {
                return Err(AppError::conflict(
                    "Edit transaction locator is not a safe regular file",
                ));
            }
        }
        self.validate_transaction_locator_directory().await?;
        let bytes = read_bounded_regular_file(
            &locator_path,
            MAX_TRANSACTION_LOCATOR_BYTES as u64,
            "edit transaction locator",
        )
        .await?;
        let locator: TransactionLocator = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::storage(
                "Edit transaction locator could not be loaded safely",
                format!(
                    "parse edit transaction locator at {}: {error}",
                    locator_path.display()
                ),
                false,
            )
        })?;
        validate_transaction_locator(&locator)?;
        if locator.tx_id != tx_id {
            return Err(AppError::conflict(format!(
                "Edit transaction locator identity mismatch for {tx_id}"
            )));
        }
        Ok(Some(locator))
    }

    async fn write_transaction_locator(
        &self,
        locator: &TransactionLocator,
    ) -> Result<(), AppError> {
        validate_transaction_locator(locator)?;
        let locator_path = self.transaction_locator_path(&locator.tx_id)?;
        self.prepare_transaction_locator_directory().await?;
        let json = serde_json::to_vec(locator).map_err(|error| {
            AppError::internal(format!(
                "Failed to serialize edit transaction locator: {error}"
            ))
        })?;
        if json.len() > MAX_TRANSACTION_LOCATOR_BYTES {
            return Err(AppError::internal(
                "Edit transaction locator exceeds its safety limit",
            ));
        }
        atomic_persist_file(&locator_path, &json, None).await
    }

    async fn remove_transaction_locator_if_matches(
        &self,
        expected: &TransactionLocator,
    ) -> Result<(), AppError> {
        let Some(current) = self
            .read_transaction_locator_if_present(&expected.tx_id)
            .await?
        else {
            return Ok(());
        };
        if !locator_has_same_generation(&current, expected) {
            return Err(AppError::conflict(format!(
                "Edit transaction {} locator changed before stale cleanup",
                expected.tx_id
            )));
        }
        let locator_path = self.transaction_locator_path(&expected.tx_id)?;
        fs::remove_file(&locator_path).await.map_err(|error| {
            storage_error(
                "remove stale edit transaction locator",
                &locator_path,
                error,
            )
        })?;
        let locator_directory = self.transaction_locator_directory();
        sync_parent_directory(&locator_directory, &locator_path).await
    }

    async fn prepare_transaction_locator_directory(&self) -> Result<PathBuf, AppError> {
        let locator_directory = self.transaction_locator_directory();
        fs::create_dir_all(&locator_directory)
            .await
            .map_err(|error| {
                storage_error(
                    "create edit transaction locator directory",
                    &locator_directory,
                    error,
                )
            })?;
        self.validate_transaction_locator_directory().await?;
        canonicalize_safe_path(&locator_directory, "edit transaction locator directory").await
    }

    async fn validate_transaction_locator_directory(&self) -> Result<(), AppError> {
        inspect_safe_directory(&self.backup_root, "edit backup root").await?;
        let locator_directory = self.transaction_locator_directory();
        inspect_safe_directory(&locator_directory, "edit transaction locator directory").await?;
        let canonical_root = canonicalize_safe_path(&self.backup_root, "edit backup root").await?;
        let canonical_locator =
            canonicalize_safe_path(&locator_directory, "edit transaction locator directory")
                .await?;
        if !canonical_locator
            .parent()
            .is_some_and(|parent| paths_equal(parent, &canonical_root))
        {
            return Err(AppError::conflict(
                "Edit transaction locator directory escapes the edit backup root",
            ));
        }
        Ok(())
    }

    async fn load_transactions_for_session(
        &self,
        session_id: &str,
        tx_ids: &[String],
    ) -> Result<Vec<Arc<Mutex<TransactionState>>>, AppError> {
        validate_revert_request(session_id, tx_ids)?;
        if self.closing_sessions.contains_key(session_id) {
            return Err(AppError::conflict(format!(
                "Session {session_id} is closing; edit transactions cannot be reverted."
            )));
        }

        let mut transactions = Vec::with_capacity(tx_ids.len());
        for tx_id in tx_ids {
            transactions.push(self.load_transaction_for_session(session_id, tx_id).await?);
        }
        Ok(transactions)
    }

    async fn load_transaction_for_session(
        &self,
        session_id: &str,
        tx_id: &str,
    ) -> Result<Arc<Mutex<TransactionState>>, AppError> {
        let queue = self
            .transaction_queues
            .entry(tx_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = queue.lock().await;

        if let Some(existing) = self.transactions.get(tx_id).map(|entry| entry.clone()) {
            let snapshot = existing.lock().await.clone();
            self.validate_transaction_state(session_id, tx_id, &snapshot)
                .await?;
            return Ok(existing);
        }

        let transaction = self.read_persisted_transaction(session_id, tx_id).await?;
        let transaction = Arc::new(Mutex::new(transaction));
        match self.transactions.entry(tx_id.to_owned()) {
            Entry::Vacant(entry) => {
                entry.insert(Arc::clone(&transaction));
                Ok(transaction)
            }
            Entry::Occupied(entry) => {
                let existing = entry.get().clone();
                let snapshot = existing.lock().await.clone();
                self.validate_transaction_state(session_id, tx_id, &snapshot)
                    .await?;
                Ok(existing)
            }
        }
    }

    async fn read_persisted_transaction(
        &self,
        session_id: &str,
        tx_id: &str,
    ) -> Result<TransactionState, AppError> {
        let tx_dir = self
            .existing_transaction_directory(session_id, tx_id)
            .await?;
        let metadata_path = tx_dir.join("metadata.json");
        let bytes = read_bounded_regular_file(
            &metadata_path,
            MAX_TRANSACTION_METADATA_BYTES as u64,
            "edit transaction metadata",
        )
        .await?;
        let transaction: TransactionState = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::storage(
                "Edit transaction metadata could not be loaded safely",
                format!(
                    "parse edit transaction metadata at {}: {error}",
                    metadata_path.display()
                ),
                false,
            )
        })?;
        self.validate_transaction_state(session_id, tx_id, &transaction)
            .await?;
        Ok(transaction)
    }

    async fn validate_transaction_state(
        &self,
        session_id: &str,
        tx_id: &str,
        transaction: &TransactionState,
    ) -> Result<(), AppError> {
        if transaction.id != tx_id || transaction.session_id != session_id {
            return Err(AppError::conflict(format!(
                "Edit transaction metadata identity mismatch for {tx_id}"
            )));
        }
        validate_generation_id(&transaction.generation_id)?;
        let workspace_root = match (
            transaction.context_scope_id.as_deref(),
            transaction.turn_id.as_deref(),
            transaction.workspace_root.as_deref(),
        ) {
            (None, None, None) => None,
            (Some(context_scope_id), Some(turn_id), Some(workspace_root)) => {
                ContextScopeId::parse(context_scope_id).map_err(|_| {
                    AppError::conflict(format!(
                        "Edit transaction metadata has an invalid context scope for {tx_id}"
                    ))
                })?;
                StreamId::parse(turn_id.to_owned()).map_err(|_| {
                    AppError::conflict(format!(
                        "Edit transaction metadata has an invalid turn identity for {tx_id}"
                    ))
                })?;
                validate_canonical_workspace_root(workspace_root).await?;
                Some(
                    WorkspaceRoot::from_canonical(workspace_root.to_path_buf()).map_err(|_| {
                        AppError::conflict(format!(
                            "Edit transaction metadata has an invalid workspace root for {tx_id}"
                        ))
                    })?,
                )
            }
            _ => {
                return Err(AppError::conflict(format!(
                    "Edit transaction metadata has incomplete provenance for {tx_id}"
                )));
            }
        };
        let tx_dir = self
            .existing_transaction_directory(session_id, tx_id)
            .await?;
        for (path, record) in &transaction.files {
            if let Some(workspace_root) = workspace_root.as_ref() {
                SafeWorkspacePath::from_canonical(workspace_root, path).map_err(|_| {
                    AppError::conflict(format!(
                        "Edit transaction file escapes its registered workspace for {tx_id}"
                    ))
                })?;
            }
            validate_transaction_record(path, record)?;
            if let Some(backup_path) = record.backup_path.as_deref() {
                validate_backup_file_path(&tx_dir, backup_path).await?;
            }
        }
        Ok(())
    }

    async fn existing_transaction_directory(
        &self,
        session_id: &str,
        tx_id: &str,
    ) -> Result<PathBuf, AppError> {
        let session_directory = self.backup_directory(session_id, None)?;
        let transaction_directory = self.backup_directory(session_id, Some(tx_id))?;
        inspect_safe_directory(&self.backup_root, "edit backup root").await?;
        inspect_safe_directory(&session_directory, "edit session backup directory").await?;
        inspect_safe_directory(&transaction_directory, "edit transaction backup directory").await?;

        let canonical_root = canonicalize_safe_path(&self.backup_root, "edit backup root").await?;
        let canonical_session =
            canonicalize_safe_path(&session_directory, "edit session backup directory").await?;
        let canonical_transaction =
            canonicalize_safe_path(&transaction_directory, "edit transaction backup directory")
                .await?;
        if !canonical_session
            .parent()
            .is_some_and(|parent| paths_equal(parent, &canonical_root))
            || !canonical_transaction
                .parent()
                .is_some_and(|parent| paths_equal(parent, &canonical_session))
        {
            return Err(AppError::conflict(
                "Edit transaction backup path escapes its expected directory",
            ));
        }
        Ok(canonical_transaction)
    }

    async fn revert_loaded_transaction(
        &self,
        session_id: &str,
        tx_id: &str,
        transaction: Arc<Mutex<TransactionState>>,
    ) -> Result<(), AppError> {
        let transaction_for_work = Arc::clone(&transaction);
        let empty = self
            .run_exclusive(
                tx_id,
                || async {
                    let snapshot = transaction_for_work.lock().await.clone();
                    if snapshot.id != tx_id || snapshot.session_id != session_id {
                        return Err(AppError::conflict(format!(
                            "Edit transaction {tx_id} does not belong to session {session_id}"
                        )));
                    }
                    self.validate_transaction_state(session_id, tx_id, &snapshot)
                        .await?;

                    let mut files = snapshot.files.iter().collect::<Vec<_>>();
                    files.sort_by_key(|(path, _)| *path);
                    let mut failed_entries = 0usize;
                    for (path, record) in files {
                        if let Err(error) = self.restore_record(&snapshot, path, record).await {
                            failed_entries = failed_entries.saturating_add(1);
                            tracing::warn!(
                                transaction_id = tx_id,
                                path = %path.display(),
                                error = %error,
                                "edit transaction entry could not be reverted"
                            );
                            continue;
                        }
                        if let Err(error) = self
                            .remove_successfully_reverted_record(
                                tx_id,
                                &transaction_for_work,
                                path,
                                record,
                            )
                            .await
                        {
                            failed_entries = failed_entries.saturating_add(1);
                            tracing::warn!(
                                transaction_id = tx_id,
                                path = %path.display(),
                                error = %error,
                                "edit transaction entry was restored but cleanup failed"
                            );
                        }
                    }

                    if failed_entries > 0 {
                        return Err(AppError::conflict(format!(
                            "Edit transaction {tx_id} could not revert {failed_entries} file(s); failed entries were retained for retry"
                        )));
                    }

                    let is_empty = transaction_for_work.lock().await.files.is_empty();
                    if is_empty {
                        self.remove_empty_transaction_directory(session_id, tx_id)
                            .await?;
                    }
                    Ok(is_empty)
                },
                None,
                false,
            )
            .await?;

        if empty {
            self.transactions.remove(tx_id);
            self.transaction_queues.remove(tx_id);
        }
        Ok(())
    }

    async fn remove_successfully_reverted_record(
        &self,
        tx_id: &str,
        transaction: &Arc<Mutex<TransactionState>>,
        path: &Path,
        record: &TransactionFileRecord,
    ) -> Result<(), AppError> {
        let removed = {
            let mut transaction = transaction.lock().await;
            if transaction.files.get(path) != Some(record) {
                return Err(AppError::conflict(format!(
                    "Edit transaction tracking changed while reverting {}",
                    path.display()
                )));
            }
            transaction.files.remove(path)
        };
        let Some(removed) = removed else {
            return Err(AppError::conflict(format!(
                "Edit transaction tracking disappeared while reverting {}",
                path.display()
            )));
        };

        if let Err(error) = self.save_metadata(tx_id).await {
            transaction
                .lock()
                .await
                .files
                .insert(path.to_path_buf(), removed);
            return Err(error);
        }
        if let Err(error) = self.remove_record_backup(tx_id, record).await {
            transaction
                .lock()
                .await
                .files
                .insert(path.to_path_buf(), removed);
            if let Err(persist_error) = self.save_metadata(tx_id).await {
                tracing::error!(
                    transaction_id = tx_id,
                    path = %path.display(),
                    error = %persist_error,
                    "restored edit transaction entry could not be re-persisted after backup cleanup failure"
                );
            }
            return Err(error);
        }
        Ok(())
    }

    async fn remove_empty_transaction_directory(
        &self,
        session_id: &str,
        tx_id: &str,
    ) -> Result<(), AppError> {
        let locator = self.read_transaction_locator_if_present(tx_id).await?;
        if let Some(locator) = locator.as_ref() {
            let transaction = self.read_persisted_transaction(session_id, tx_id).await?;
            validate_locator_target(locator, &transaction)?;
        }
        let tx_dir = self
            .existing_transaction_directory(session_id, tx_id)
            .await?;
        let metadata_path = tx_dir.join("metadata.json");
        let mut entries = fs::read_dir(&tx_dir).await.map_err(|error| {
            storage_error("read empty edit transaction directory", &tx_dir, error)
        })?;
        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            storage_error("read empty edit transaction directory", &tx_dir, error)
        })? {
            if entry.file_name() != "metadata.json" {
                return Err(AppError::conflict(
                    "An empty edit transaction directory contains unexpected files",
                ));
            }
        }
        drop(entries);

        match fs::symlink_metadata(&metadata_path).await {
            Ok(metadata) if is_safe_regular_file(&metadata) => {
                fs::remove_file(&metadata_path).await.map_err(|error| {
                    storage_error(
                        "remove empty edit transaction metadata",
                        &metadata_path,
                        error,
                    )
                })?;
            }
            Ok(_) => {
                return Err(AppError::conflict(
                    "Edit transaction metadata is not a safe regular file",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(storage_error(
                    "inspect empty edit transaction metadata",
                    &metadata_path,
                    error,
                ));
            }
        }
        fs::remove_dir(&tx_dir).await.map_err(|error| {
            storage_error("remove empty edit transaction directory", &tx_dir, error)
        })?;
        if let Some(locator) = locator.as_ref() {
            self.remove_transaction_locator_if_matches(locator).await?;
        }

        let Some(session_directory) = tx_dir.parent() else {
            return Ok(());
        };
        match fs::remove_dir(session_directory).await {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::NotFound
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(storage_error(
                "remove empty edit session backup directory",
                session_directory,
                error,
            )),
        }
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

        let Ok(resolved) = canonical_transaction_path(&requested_path).await else {
            return Ok(None);
        };
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
            || metadata_is_link_or_reparse(&metadata)
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
        let current_matches_expected = (record.expected_post_mutation.is_some()
            || record.intended_post_mutation.is_some())
        .then(|| record_accepts_committed_state(&record, &current));
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
        if !is_safe_regular_file(&metadata) {
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
        let current = read_workspace_file(path).await?.version;
        if current == record.original {
            match &record.original {
                EditTransactionFileVersion::Absent => {
                    if record.backup_path.is_some() {
                        return Err(AppError::conflict(
                            "An absent original file must not have an edit backup file",
                        ));
                    }
                }
                EditTransactionFileVersion::File { .. } => {
                    self.read_backup_contents(tx, record).await?;
                }
            }
            return Ok(());
        }
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
                    .map_err(|error| storage_error("remove rejected created file", path, error))?;
                let parent = path.parent().ok_or_else(|| {
                    AppError::validation("Edit transaction file path has no parent")
                })?;
                sync_parent_directory(parent, path).await
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
        parent_identity: &PersistedDirectoryIdentity,
        record: &TransactionFileRecord,
        contents: &[u8],
        original_mode: u32,
    ) -> Result<(), AppError> {
        let Some(parent) = path.parent() else {
            return Err(AppError::validation(
                "Edit transaction file path has no parent",
            ));
        };
        let temporary = create_synced_temporary_file(
            parent,
            ".codez-edit-restore-",
            contents,
            Some(original_mode),
        )
        .await?;

        // There is still an unavoidable external CAS window between this check and the OS rename.
        self.verify_parent_identity(path, parent_identity).await?;
        self.assert_expected_mutation(path, record).await?;
        persist_temporary_file(temporary, path, Some(original_mode)).await
    }

    async fn assert_expected_mutation(
        &self,
        path: &Path,
        record: &TransactionFileRecord,
    ) -> Result<(), AppError> {
        let current = read_workspace_file(path).await?.version;
        if record_accepts_committed_state(record, &current) {
            return Ok(());
        }
        if record.expected_post_mutation.is_none() && record.intended_post_mutation.is_none() {
            return Err(AppError::conflict(format!(
                "Reject cannot verify the post-mutation state for {}",
                path.display()
            )));
        }
        Err(AppError::conflict(format!(
            "Reject conflict for {}: the file changed after CodeZ recorded its mutation",
            path.display()
        )))
    }

    async fn verify_parent_identity(
        &self,
        path: &Path,
        expected_parent: &PersistedDirectoryIdentity,
    ) -> Result<(), AppError> {
        let current_parent = capture_directory_identity(expected_parent.path()).await?;
        let matches = match expected_parent {
            PersistedDirectoryIdentity::Stable(expected) => {
                matches!(&current_parent, PersistedDirectoryIdentity::Stable(current) if current == expected)
            }
            PersistedDirectoryIdentity::LegacyPath(expected) => {
                paths_equal(current_parent.path(), expected)
            }
        };
        if !matches {
            return Err(AppError::conflict(format!(
                "Reject refused because the parent directory changed for {}",
                path.display()
            )));
        }
        validate_directory_chain(expected_parent.path(), path).await
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

    async fn remove_session_backup_directory(
        &self,
        session_directory: &Path,
    ) -> Result<(), AppError> {
        match fs::symlink_metadata(&self.backup_root).await {
            Ok(metadata)
                if metadata_is_link_or_reparse(&metadata) || !metadata.file_type().is_dir() =>
            {
                return Err(AppError::conflict(
                    "Edit backup root is no longer a safe directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(storage_error(
                    "inspect edit backup root",
                    &self.backup_root,
                    error,
                ));
            }
        }
        match fs::symlink_metadata(session_directory).await {
            Ok(metadata)
                if metadata_is_link_or_reparse(&metadata) || !metadata.file_type().is_dir() =>
            {
                Err(AppError::conflict(
                    "Edit session backup directory is no longer safe to remove",
                ))
            }
            Ok(_) => fs::remove_dir_all(session_directory)
                .await
                .map_err(|error| {
                    storage_error("remove edit session backups", session_directory, error)
                }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(storage_error(
                "inspect edit session backup directory",
                session_directory,
                error,
            )),
        }
    }
}

fn validate_revert_request(session_id: &str, tx_ids: &[String]) -> Result<(), AppError> {
    validate_backup_segment(session_id, "session")?;
    let mut seen = HashSet::with_capacity(tx_ids.len());
    for tx_id in tx_ids {
        validate_backup_segment(tx_id, "transaction")?;
        let identity = backup_segment_identity(tx_id);
        if !seen.insert(identity) {
            return Err(AppError::validation(format!(
                "Duplicate edit transaction ID: {tx_id}"
            )));
        }
    }
    Ok(())
}

fn transaction_provenance(
    tx_id: &str,
    transaction: &TransactionState,
) -> Result<EditTransactionProvenance, AppError> {
    if transaction.id != tx_id {
        return Err(AppError::conflict(format!(
            "Edit transaction metadata identity mismatch for {tx_id}"
        )));
    }
    let session_id = SessionId::parse(transaction.session_id.clone()).map_err(|_| {
        AppError::conflict(format!(
            "Edit transaction metadata has an invalid session identity for {tx_id}"
        ))
    })?;
    validate_generation_id(&transaction.generation_id)?;
    Ok(EditTransactionProvenance {
        session_id,
        generation_id: transaction.generation_id.clone(),
        context_scope_id: transaction.context_scope_id.clone(),
        turn_id: transaction.turn_id.clone(),
        workspace_root: transaction.workspace_root.clone(),
    })
}

fn validate_transaction_locator(locator: &TransactionLocator) -> Result<(), AppError> {
    validate_backup_segment(&locator.tx_id, "transaction")?;
    validate_generation_id(&locator.generation_id)
}

fn validate_locator_target(
    locator: &TransactionLocator,
    transaction: &TransactionState,
) -> Result<(), AppError> {
    if transaction.id != locator.tx_id
        || transaction.session_id != locator.session_id.as_str()
        || transaction.generation_id != locator.generation_id
    {
        return Err(AppError::conflict(format!(
            "Edit transaction {} locator does not match durable metadata",
            locator.tx_id
        )));
    }
    Ok(())
}

fn locator_has_same_generation(left: &TransactionLocator, right: &TransactionLocator) -> bool {
    left.tx_id == right.tx_id
        && left.session_id == right.session_id
        && left.generation_id == right.generation_id
}

fn validate_generation_id(generation_id: &str) -> Result<(), AppError> {
    uuid::Uuid::parse_str(generation_id).map_err(|_| {
        AppError::conflict("Edit transaction metadata has an invalid generation identity")
    })?;
    Ok(())
}

fn transaction_not_found(tx_id: &str) -> AppError {
    AppError::not_found(format!("Edit transaction {tx_id} was not found"))
}

fn backup_segment_identity(value: &str) -> String {
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value.to_owned()
    }
}

fn validate_transaction_record(
    path: &Path,
    record: &TransactionFileRecord,
) -> Result<(), AppError> {
    let normalized = lexical_normalize_absolute_path(path)?;
    if !paths_equal(&normalized, path) {
        return Err(AppError::conflict(
            "Edit transaction metadata contains a non-normalized workspace path",
        ));
    }
    let Some(parent) = path.parent() else {
        return Err(AppError::conflict(
            "Edit transaction metadata contains a path without a parent",
        ));
    };
    let persisted_parent = record.parent_identity.path();
    let normalized_parent = lexical_normalize_absolute_path(persisted_parent)?;
    let parent_matches_identity = match &record.parent_identity {
        PersistedDirectoryIdentity::Stable(_) => path_starts_with(parent, persisted_parent),
        PersistedDirectoryIdentity::LegacyPath(_) => paths_equal(parent, persisted_parent),
    };
    if !paths_equal(&normalized_parent, persisted_parent) || !parent_matches_identity {
        return Err(AppError::conflict(
            "Edit transaction metadata contains a parent identity mismatch",
        ));
    }

    validate_file_version(&record.original)?;
    if let Some(intended) = record.intended_post_mutation.as_ref() {
        validate_content_version(intended)?;
    }
    if let Some(expected) = record.expected_post_mutation.as_ref() {
        validate_file_version(expected)?;
    }
    match (&record.original, &record.backup_path) {
        (EditTransactionFileVersion::Absent, None)
        | (EditTransactionFileVersion::File { .. }, Some(_)) => Ok(()),
        (EditTransactionFileVersion::Absent, Some(_)) => Err(AppError::conflict(
            "An absent original file must not have an edit backup path",
        )),
        (EditTransactionFileVersion::File { .. }, None) => Err(AppError::conflict(
            "An existing original file is missing its edit backup path",
        )),
    }
}

async fn validate_canonical_workspace_root(workspace_root: &Path) -> Result<(), AppError> {
    WorkspaceRoot::from_canonical(workspace_root.to_path_buf()).map_err(|_| {
        AppError::conflict("Edit transaction workspace root is not a canonical absolute path")
    })?;
    let canonical =
        normalize_canonical_path(fs::canonicalize(workspace_root).await.map_err(|error| {
            storage_error(
                "resolve edit transaction workspace root",
                workspace_root,
                error,
            )
        })?);
    let metadata = fs::symlink_metadata(&canonical).await.map_err(|error| {
        storage_error(
            "inspect edit transaction workspace root",
            workspace_root,
            error,
        )
    })?;
    if !metadata.file_type().is_dir()
        || metadata_is_link_or_reparse(&metadata)
        || !paths_equal(
            &canonical,
            &normalize_canonical_path(workspace_root.to_path_buf()),
        )
    {
        return Err(AppError::conflict(
            "Edit transaction workspace root is no longer a stable canonical directory",
        ));
    }
    Ok(())
}

fn validate_file_version(version: &EditTransactionFileVersion) -> Result<(), AppError> {
    let EditTransactionFileVersion::File { sha256, .. } = version else {
        return Ok(());
    };
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::conflict(
            "Edit transaction metadata contains an invalid file digest",
        ));
    }
    Ok(())
}

fn validate_content_version(version: &EditTransactionContentVersion) -> Result<(), AppError> {
    if version.sha256.len() != 64 || !version.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::conflict(
            "Edit transaction metadata contains an invalid intended digest",
        ));
    }
    Ok(())
}

fn content_version(version: &EditTransactionFileVersion) -> Option<EditTransactionContentVersion> {
    match version {
        EditTransactionFileVersion::Absent => None,
        EditTransactionFileVersion::File { sha256, size, .. } => {
            Some(EditTransactionContentVersion {
                sha256: sha256.clone(),
                size: *size,
            })
        }
    }
}

fn record_accepts_current_state(
    record: &TransactionFileRecord,
    current: &EditTransactionFileVersion,
) -> bool {
    current == &record.original || record_accepts_committed_state(record, current)
}

fn record_accepts_committed_state(
    record: &TransactionFileRecord,
    current: &EditTransactionFileVersion,
) -> bool {
    record.expected_post_mutation.as_ref() == Some(current)
        || record
            .intended_post_mutation
            .as_ref()
            .is_some_and(|intended| content_version(current).as_ref() == Some(intended))
}

fn validate_metadata_size(size: usize) -> Result<(), AppError> {
    if size > MAX_TRANSACTION_METADATA_BYTES {
        return Err(AppError::storage(
            "Edit transaction metadata exceeds its safety limit",
            format!(
                "serialized edit transaction metadata is {size} bytes; maximum is {MAX_TRANSACTION_METADATA_BYTES} bytes"
            ),
            false,
        ));
    }
    Ok(())
}

async fn validate_backup_file_path(tx_dir: &Path, backup_path: &Path) -> Result<(), AppError> {
    let normalized = lexical_normalize_absolute_path(backup_path)?;
    if !paths_equal(&normalized, backup_path)
        || backup_path
            .extension()
            .is_none_or(|extension| extension != "bak")
        || !backup_path
            .parent()
            .is_some_and(|parent| paths_equal(parent, tx_dir))
    {
        return Err(AppError::conflict(
            "Edit backup path escapes its transaction directory",
        ));
    }
    let metadata = fs::symlink_metadata(backup_path)
        .await
        .map_err(|error| storage_error("inspect persisted edit backup", backup_path, error))?;
    if !is_safe_regular_file(&metadata) {
        return Err(AppError::conflict(
            "Persisted edit backup is not a safe regular file",
        ));
    }
    let canonical_backup = canonicalize_safe_path(backup_path, "persisted edit backup").await?;
    if !canonical_backup
        .parent()
        .is_some_and(|parent| paths_equal(parent, tx_dir))
    {
        return Err(AppError::conflict(
            "Persisted edit backup resolves outside its transaction directory",
        ));
    }
    Ok(())
}

async fn inspect_safe_directory(path: &Path, label: &str) -> Result<std::fs::Metadata, AppError> {
    let metadata = fs::symlink_metadata(path)
        .await
        .map_err(|error| storage_error(&format!("inspect {label}"), path, error))?;
    if !metadata.file_type().is_dir() || metadata_is_link_or_reparse(&metadata) {
        return Err(AppError::conflict(format!(
            "The {label} is not a safe directory"
        )));
    }
    Ok(metadata)
}

async fn canonicalize_safe_path(path: &Path, label: &str) -> Result<PathBuf, AppError> {
    fs::canonicalize(path)
        .await
        .map(normalize_canonical_path)
        .map_err(|error| storage_error(&format!("resolve {label}"), path, error))
}

async fn read_bounded_regular_file(
    path: &Path,
    maximum_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, AppError> {
    let before = fs::symlink_metadata(path)
        .await
        .map_err(|error| storage_error(&format!("inspect {label}"), path, error))?;
    if !is_safe_regular_file(&before) {
        return Err(AppError::conflict(format!(
            "The {label} is not a safe regular file"
        )));
    }
    if before.len() > maximum_bytes {
        return Err(AppError::storage(
            format!("The {label} exceeds its safety limit"),
            format!(
                "{label} at {} is {} bytes; maximum is {maximum_bytes}",
                path.display(),
                before.len()
            ),
            false,
        ));
    }

    let file = fs::OpenOptions::new()
        .read(true)
        .open(path)
        .await
        .map_err(|error| storage_error(&format!("open {label}"), path, error))?;
    let opened = file
        .metadata()
        .await
        .map_err(|error| storage_error(&format!("inspect opened {label}"), path, error))?;
    if !is_safe_regular_file(&opened) || opened.len() > maximum_bytes {
        return Err(AppError::conflict(format!(
            "The {label} changed before it could be read safely"
        )));
    }

    let mut contents = Vec::with_capacity(usize::try_from(opened.len()).unwrap_or(0));
    file.take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut contents)
        .await
        .map_err(|error| storage_error(&format!("read {label}"), path, error))?;
    if contents.len() as u64 > maximum_bytes {
        return Err(AppError::storage(
            format!("The {label} exceeds its safety limit"),
            format!("{label} at {} grew while being read", path.display()),
            false,
        ));
    }

    let after = fs::symlink_metadata(path)
        .await
        .map_err(|error| storage_error(&format!("reinspect {label}"), path, error))?;
    if !is_safe_regular_file(&after) || !metadata_is_stable(&before, &after) {
        return Err(AppError::conflict(format!(
            "The {label} changed while it was being read"
        )));
    }
    Ok(contents)
}

fn is_safe_regular_file(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_file() && !metadata_is_link_or_reparse(metadata)
}

fn metadata_is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn validate_backup_segment(value: &str, label: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > MAX_BACKUP_SEGMENT_BYTES
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
        || value
            .chars()
            .any(|character| matches!(character, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        || value.chars().any(char::is_control)
        || value.ends_with(' ')
        || value.ends_with('.')
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
    let (canonical_parent, _) = resolve_directory_with_missing_tail(parent).await?;
    Ok(canonical_parent.join(file_name))
}

async fn resolve_directory_with_missing_tail(path: &Path) -> Result<(PathBuf, PathBuf), AppError> {
    let mut cursor = path.to_path_buf();
    let mut missing = Vec::<OsString>::new();
    loop {
        match fs::symlink_metadata(&cursor).await {
            Ok(metadata) => {
                if !metadata.file_type().is_dir() || metadata_is_link_or_reparse(&metadata) {
                    return Err(AppError::conflict(
                        "Edit transaction file parent is not a safe directory",
                    ));
                }
                let canonical =
                    normalize_canonical_path(fs::canonicalize(&cursor).await.map_err(|error| {
                        storage_error("resolve edit transaction file parent", &cursor, error)
                    })?);
                let mut resolved = canonical.clone();
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok((resolved, canonical));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let component = cursor.file_name().ok_or_else(|| {
                    AppError::validation("Edit transaction file parent has no existing ancestor")
                })?;
                missing.push(component.to_os_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| {
                        AppError::validation(
                            "Edit transaction file parent has no existing ancestor",
                        )
                    })?
                    .to_path_buf();
            }
            Err(error) => {
                return Err(storage_error(
                    "inspect edit transaction file parent",
                    &cursor,
                    error,
                ));
            }
        }
    }
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

async fn capture_parent_identity(path: &Path) -> Result<PersistedDirectoryIdentity, AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::validation("Edit transaction file path has no parent"))?;
    let (_, existing_ancestor) = resolve_directory_with_missing_tail(parent).await?;
    capture_directory_identity(&existing_ancestor).await
}

async fn capture_directory_identity(
    directory: &Path,
) -> Result<PersistedDirectoryIdentity, AppError> {
    let canonical =
        normalize_canonical_path(fs::canonicalize(directory).await.map_err(|error| {
            storage_error("resolve edit transaction file parent", directory, error)
        })?);
    let metadata = fs::symlink_metadata(&canonical).await.map_err(|error| {
        storage_error("inspect edit transaction file parent", &canonical, error)
    })?;
    if !metadata.file_type().is_dir() || metadata_is_link_or_reparse(&metadata) {
        return Err(AppError::conflict(
            "Edit transaction file parent is not a safe directory",
        ));
    }

    let identity_path = canonical.clone();
    let file_id = tokio::task::spawn_blocking(move || file_id::get_file_id(&identity_path))
        .await
        .map_err(|error| {
            AppError::internal(format!("Edit transaction identity task failed: {error}"))
        })?
        .map_err(|error| {
            storage_error("read edit transaction parent identity", &canonical, error)
        })?;
    let file_id = serde_json::to_string(&file_id).map_err(|error| {
        AppError::internal(format!("Failed to serialize edit parent identity: {error}"))
    })?;
    Ok(PersistedDirectoryIdentity::Stable(
        StableDirectoryIdentity {
            path: canonical,
            file_id,
        },
    ))
}

async fn validate_directory_chain(ancestor: &Path, file_path: &Path) -> Result<(), AppError> {
    let parent = file_path
        .parent()
        .ok_or_else(|| AppError::validation("Edit transaction file path has no parent"))?;
    if !path_starts_with(parent, ancestor) {
        return Err(AppError::conflict(
            "Edit transaction file parent escapes its persisted directory identity",
        ));
    }

    let ancestor_depth = ancestor.components().count();
    let mut cursor = ancestor.to_path_buf();
    for component in parent.components().skip(ancestor_depth) {
        cursor.push(component.as_os_str());
        let metadata = match fs::symlink_metadata(&cursor).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(storage_error(
                    "inspect edit transaction descendant directory",
                    &cursor,
                    error,
                ));
            }
        };
        if !metadata.file_type().is_dir() || metadata_is_link_or_reparse(&metadata) {
            return Err(AppError::conflict(
                "Edit transaction descendant parent is not a safe directory",
            ));
        }
        let canonical =
            normalize_canonical_path(fs::canonicalize(&cursor).await.map_err(|error| {
                storage_error(
                    "resolve edit transaction descendant directory",
                    &cursor,
                    error,
                )
            })?);
        if !paths_equal(&canonical, &cursor) {
            return Err(AppError::conflict(
                "Edit transaction descendant parent changed identity",
            ));
        }
    }
    Ok(())
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

fn path_starts_with(path: &Path, base: &Path) -> bool {
    #[cfg(windows)]
    {
        let mut path_components = path.components();
        base.components().all(|base_component| {
            path_components.next().is_some_and(|path_component| {
                path_component
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&base_component.as_os_str().to_string_lossy())
            })
        })
    }
    #[cfg(not(windows))]
    {
        path.starts_with(base)
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
    if !is_safe_regular_file(&before) {
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
    is_safe_regular_file(before)
        && is_safe_regular_file(after)
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

async fn apply_mode_and_sync(path: &Path, mode: u32) -> Result<(), AppError> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(|error| storage_error("open edit transaction file for mode sync", path, error))?;
    apply_mode(path, mode).await?;
    file.sync_all()
        .await
        .map_err(|error| storage_error("sync edit transaction file mode", path, error))
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
            .map_err(|error| storage_error("flush edit transaction file", path, error))?;
        file.sync_all()
            .await
            .map_err(|error| storage_error("sync edit transaction file", path, error))
    }
    .await;
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path).await;
        return result;
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::validation("Edit transaction persistence path has no parent"))?;
    sync_parent_directory(parent, path).await
}

async fn atomic_persist_file(
    target: &Path,
    contents: &[u8],
    mode: Option<u32>,
) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::validation("Edit transaction persistence path has no parent"))?;
    let temporary =
        create_synced_temporary_file(parent, ".codez-transaction-", contents, mode).await?;
    persist_temporary_file(temporary, target, mode).await
}

async fn create_synced_temporary_file(
    parent: &Path,
    prefix: &str,
    contents: &[u8],
    mode: Option<u32>,
) -> Result<NamedTempFile, AppError> {
    let parent = parent.to_path_buf();
    let prefix = prefix.to_owned();
    let contents = contents.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut temporary = TempFileBuilder::new()
            .prefix(&prefix)
            .suffix(".tmp")
            .tempfile_in(&parent)
            .map_err(|error| {
                storage_error("create edit transaction temporary file", &parent, error)
            })?;
        temporary.write_all(&contents).map_err(|error| {
            storage_error(
                "write edit transaction temporary file",
                temporary.path(),
                error,
            )
        })?;
        temporary.flush().map_err(|error| {
            storage_error(
                "flush edit transaction temporary file",
                temporary.path(),
                error,
            )
        })?;
        temporary.as_file().sync_all().map_err(|error| {
            storage_error(
                "sync edit transaction temporary file",
                temporary.path(),
                error,
            )
        })?;
        if let Some(mode) = mode {
            apply_mode_to_file(temporary.as_file(), temporary.path(), mode)?;
            temporary.as_file().sync_all().map_err(|error| {
                storage_error(
                    "sync edit transaction temporary mode",
                    temporary.path(),
                    error,
                )
            })?;
        }
        sync_directory_blocking(&parent, temporary.path())?;
        Ok(temporary)
    })
    .await
    .map_err(|error| AppError::internal(format!("Edit transaction sync task failed: {error}")))?
}

async fn persist_temporary_file(
    temporary: NamedTempFile,
    target: &Path,
    mode: Option<u32>,
) -> Result<(), AppError> {
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let parent = target.parent().ok_or_else(|| {
            AppError::validation("Edit transaction persistence path has no parent")
        })?;
        let previous_permissions = match std::fs::symlink_metadata(&target) {
            Ok(metadata) => Some(metadata.permissions()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(storage_error(
                    "inspect edit transaction replacement target",
                    &target,
                    error,
                ));
            }
        };
        let relaxed = relax_readonly_target(&target, previous_permissions.as_ref())?;
        let persisted = match temporary.persist(&target) {
            Ok(file) => file,
            Err(error) => {
                if relaxed {
                    if let Some(permissions) = previous_permissions {
                        std::fs::set_permissions(&target, permissions).map_err(
                            |restore_error| {
                                storage_error(
                                    "restore edit transaction target permissions",
                                    &target,
                                    io::Error::other(format!(
                                        "replace error: {}; permission error: {restore_error}",
                                        error.error
                                    )),
                                )
                            },
                        )?;
                    }
                }
                return Err(storage_error(
                    "atomically replace edit transaction file",
                    &target,
                    error.error,
                ));
            }
        };
        if let Some(mode) = mode {
            apply_mode_to_file(&persisted, &target, mode)?;
        }
        persisted.sync_all().map_err(|error| {
            storage_error("sync replaced edit transaction file", &target, error)
        })?;
        sync_directory_blocking(parent, &target)
    })
    .await
    .map_err(|error| AppError::internal(format!("Edit transaction persist task failed: {error}")))?
}

#[cfg(unix)]
fn apply_mode_to_file(file: &std::fs::File, path: &Path, mode: u32) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(std::fs::Permissions::from_mode(mode))
        .map_err(|error| storage_error("set edit transaction temporary mode", path, error))
}

#[cfg(not(unix))]
fn apply_mode_to_file(file: &std::fs::File, path: &Path, mode: u32) -> Result<(), AppError> {
    let mut permissions = file
        .metadata()
        .map_err(|error| storage_error("inspect edit transaction temporary mode", path, error))?
        .permissions();
    permissions.set_readonly(mode & 0o200 == 0);
    file.set_permissions(permissions)
        .map_err(|error| storage_error("set edit transaction temporary mode", path, error))
}

#[cfg(windows)]
#[expect(
    clippy::permissions_set_readonly_false,
    reason = "Windows readonly is a single file attribute, not Unix write-mode bits"
)]
fn relax_readonly_target(
    target: &Path,
    permissions: Option<&std::fs::Permissions>,
) -> Result<bool, AppError> {
    let Some(permissions) = permissions.filter(|permissions| permissions.readonly()) else {
        return Ok(false);
    };
    let mut writable = permissions.clone();
    writable.set_readonly(false);
    std::fs::set_permissions(target, writable).map_err(|error| {
        storage_error("prepare readonly edit transaction target", target, error)
    })?;
    Ok(true)
}

#[cfg(not(windows))]
fn relax_readonly_target(
    _target: &Path,
    _permissions: Option<&std::fs::Permissions>,
) -> Result<bool, AppError> {
    Ok(false)
}

async fn sync_parent_directory(parent: &Path, target: &Path) -> Result<(), AppError> {
    let parent = parent.to_path_buf();
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || sync_directory_blocking(&parent, &target))
        .await
        .map_err(|error| {
            AppError::internal(format!(
                "Edit transaction directory sync task failed: {error}"
            ))
        })?
}

#[cfg(unix)]
fn sync_directory_blocking(parent: &Path, target: &Path) -> Result<(), AppError> {
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| storage_error("sync edit transaction parent directory", target, error))
}

#[cfg(windows)]
fn sync_directory_blocking(parent: &Path, target: &Path) -> Result<(), AppError> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let result = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(parent)
        .and_then(|directory| directory.sync_all());
    match result {
        Ok(()) => Ok(()),
        // Windows commonly rejects FlushFileBuffers for directory handles even when opened with
        // backup semantics. The file itself is still synced and the replacement is atomic.
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidInput
            ) =>
        {
            tracing::debug!(
                path = %target.display(),
                error = %error,
                "Windows did not permit syncing the edit transaction parent directory"
            );
            Ok(())
        }
        Err(error) => Err(storage_error(
            "sync edit transaction parent directory",
            target,
            error,
        )),
    }
}

#[cfg(not(any(unix, windows)))]
fn sync_directory_blocking(_parent: &Path, _target: &Path) -> Result<(), AppError> {
    Ok(())
}

async fn remove_backup_if_present(backup_path: Option<&Path>) -> Result<(), AppError> {
    if let Some(backup_path) = backup_path {
        match fs::remove_file(backup_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(storage_error(
                    "remove unused edit backup",
                    backup_path,
                    error,
                ));
            }
        }
    }
    Ok(())
}

async fn cleanup_backup_after_error(backup_path: Option<&Path>, error: AppError) -> AppError {
    match remove_backup_if_present(backup_path).await {
        Ok(()) => error,
        Err(cleanup_error) => AppError::storage(
            "The edit operation failed and its unused backup could not be removed",
            format!("operation error: {error}; backup cleanup error: {cleanup_error}"),
            false,
        ),
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

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use codez_core::{AppErrorKind, AppPaths};

    use super::{
        EditTransactionService, MAX_TRANSACTION_METADATA_BYTES, TransactionLocatorPhase,
        validate_metadata_size,
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

    #[test]
    fn metadata_writer_accepts_the_reader_limit() {
        assert!(validate_metadata_size(MAX_TRANSACTION_METADATA_BYTES).is_ok());
    }

    #[test]
    fn metadata_writer_rejects_one_byte_over_the_reader_limit() {
        let error = validate_metadata_size(MAX_TRANSACTION_METADATA_BYTES + 1)
            .expect_err("metadata larger than the reader limit must be rejected");

        assert_eq!(error.kind(), codez_core::AppErrorKind::Storage);
    }

    #[tokio::test]
    async fn durable_provenance_lookup_returns_not_found_for_an_unknown_transaction() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let service = EditTransactionService::new(app_paths(temp_dir.path()));

        let error = service
            .lookup_transaction_provenance("missing-transaction")
            .await
            .expect_err("an unknown transaction must not acquire inferred ownership");

        assert_eq!(error.kind(), AppErrorKind::NotFound);
    }

    #[tokio::test]
    async fn prepared_locator_is_committed_after_its_metadata_is_validated() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let tx_id = "prepared-transaction";
        let service = EditTransactionService::new(app_paths(temp_dir.path()));
        service
            .register_transaction(tx_id, "session-prepared")
            .await
            .expect("fixture transaction must register");
        let mut locator = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("fixture locator must be readable")
            .expect("fixture locator must exist");
        locator.phase = TransactionLocatorPhase::Prepared;
        service
            .write_transaction_locator(&locator)
            .await
            .expect("prepared fixture locator must persist");
        drop(service);
        let restarted = EditTransactionService::new(app_paths(temp_dir.path()));

        restarted
            .lookup_transaction_provenance(tx_id)
            .await
            .expect("valid prepared locator must recover");
        let recovered = restarted
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("recovered locator must be readable")
            .expect("recovered locator must exist");

        assert_eq!(recovered.phase, TransactionLocatorPhase::Committed);
    }

    #[tokio::test]
    async fn activity_hint_does_not_commit_a_prepared_locator() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let tx_id = "hinted-prepared-transaction";
        let service = EditTransactionService::new(app_paths(temp_dir.path()));
        service
            .register_transaction(tx_id, "session-hinted")
            .await
            .expect("fixture transaction must register");
        let mut locator = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("fixture locator must be readable")
            .expect("fixture locator must exist");
        locator.phase = TransactionLocatorPhase::Prepared;
        service
            .write_transaction_locator(&locator)
            .await
            .expect("prepared fixture locator must persist");

        let hint = service
            .lookup_transaction_activity_hint(tx_id)
            .await
            .expect("activity hint must resolve without recovery");
        let unchanged = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("hinted locator must remain readable")
            .expect("hinted locator must remain present");

        assert_eq!(
            (hint.session_id.as_str(), unchanged.phase),
            ("session-hinted", TransactionLocatorPhase::Prepared)
        );
    }

    #[tokio::test]
    async fn guarded_provenance_lookup_rejects_a_changed_locator_before_recovery() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let tx_id = "changed-hint-transaction";
        let service = EditTransactionService::new(app_paths(temp_dir.path()));
        service
            .register_transaction(tx_id, "session-hinted")
            .await
            .expect("fixture transaction must register");
        let hint = service
            .lookup_transaction_activity_hint(tx_id)
            .await
            .expect("fixture activity hint must resolve");
        let mut changed = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("fixture locator must be readable")
            .expect("fixture locator must exist");
        changed.phase = TransactionLocatorPhase::Prepared;
        changed.generation_id = uuid::Uuid::new_v4().to_string();
        service
            .write_transaction_locator(&changed)
            .await
            .expect("changed fixture locator must persist");

        let error = service
            .lookup_transaction_provenance_with_hint(tx_id, &hint)
            .await
            .expect_err("a changed locator must be rejected before recovery");
        let unchanged = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("changed locator must remain readable")
            .expect("changed locator must remain present");

        assert_eq!(
            (error.kind(), unchanged.phase),
            (AppErrorKind::Conflict, TransactionLocatorPhase::Prepared)
        );
    }

    #[tokio::test]
    async fn provenance_verification_rejects_a_reused_transaction_generation() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let tx_id = "reused-transaction";
        let service = EditTransactionService::new(app_paths(temp_dir.path()));
        service
            .register_transaction(tx_id, "session-old")
            .await
            .expect("old fixture transaction must register");
        let expected = service
            .lookup_transaction_provenance(tx_id)
            .await
            .expect("old provenance must resolve");
        service
            .cleanup_session("session-old")
            .await
            .expect("old fixture session must be removed");
        service
            .register_transaction(tx_id, "session-new")
            .await
            .expect("the deleted transaction ID may be reused with a new generation");

        let error = service
            .verify_transaction_provenance(tx_id, &expected)
            .await
            .expect_err("a reused transaction must not match stale provenance");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn cleanup_session_removes_locators_for_transactions_not_loaded_after_restart() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let tx_id = "unloaded-cleanup-transaction";
        let service = EditTransactionService::new(app_paths(temp_dir.path()));
        service
            .register_transaction(tx_id, "session-unloaded-cleanup")
            .await
            .expect("fixture transaction must register");
        drop(service);
        let restarted = EditTransactionService::new(app_paths(temp_dir.path()));

        restarted
            .cleanup_session("session-unloaded-cleanup")
            .await
            .expect("session cleanup must remove unloaded durable transactions");
        let locator = restarted
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("locator cleanup result must be readable");

        assert!(locator.is_none());
    }

    #[tokio::test]
    async fn discarding_an_empty_transaction_removes_its_locator() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let tx_id = "empty-discard-transaction";
        let service = EditTransactionService::new(app_paths(temp_dir.path()));
        service
            .register_transaction(tx_id, "session-empty-discard")
            .await
            .expect("fixture transaction must register");

        service
            .discard_empty_transaction_for_session("session-empty-discard", tx_id)
            .await
            .expect("empty transaction discard must succeed");
        let locator = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("locator cleanup result must be readable");

        assert!(locator.is_none());
    }

    #[tokio::test]
    async fn closing_session_does_not_commit_a_prepared_locator() {
        let temp_dir = tempfile::tempdir().expect("temporary test directory must be created");
        let tx_id = "closing-prepared-transaction";
        let session_id = "session-closing-prepared";
        let service = EditTransactionService::new(app_paths(temp_dir.path()));
        service
            .register_transaction(tx_id, session_id)
            .await
            .expect("fixture transaction must register");
        let mut locator = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("fixture locator must be readable")
            .expect("fixture locator must exist");
        locator.phase = TransactionLocatorPhase::Prepared;
        service
            .write_transaction_locator(&locator)
            .await
            .expect("prepared fixture locator must persist");
        service.closing_sessions.insert(session_id.to_owned(), true);

        let error = service
            .lookup_transaction_provenance(tx_id)
            .await
            .expect_err("closing sessions must reject locator recovery");
        let retained = service
            .read_transaction_locator_if_present(tx_id)
            .await
            .expect("retained locator must be readable")
            .expect("retained locator must exist");

        assert_eq!(
            (error.kind(), retained.phase),
            (AppErrorKind::RunActive, TransactionLocatorPhase::Prepared)
        );
    }
}
