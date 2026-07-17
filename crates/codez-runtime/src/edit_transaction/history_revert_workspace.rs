use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::history_revert::{
    HistoryRevertOperation, HistoryRevertService, HistoryRevertWorkspace,
    HistoryRevertWorkspaceOutcome,
};

use super::{
    EditTransactionFileVersion, EditTransactionService, PersistedDirectoryIdentity,
    StableDirectoryIdentity, TransactionFileRecord, TransactionState, apply_mode_and_sync,
    apply_mode_to_file, atomic_persist_file, canonicalize_safe_path, capture_parent_identity,
    create_synced_temporary_file, inspect_safe_directory, is_safe_regular_file,
    metadata_is_link_or_reparse, path_starts_with, paths_equal, persist_temporary_file,
    read_bounded_regular_file, read_workspace_file, record_accepts_committed_state, sha256_for,
    storage_error, sync_directory_blocking, sync_parent_directory, validate_backup_segment,
    write_new_file,
};

use codez_core::{AppError, SafeWorkspacePath, WorkspaceRoot};

const HISTORY_OPERATION_DIRECTORY: &str = ".history-revert-operations";
const HISTORY_MANIFEST_FILE: &str = "manifest.json";
const HISTORY_MANIFEST_SCHEMA_VERSION: u16 = 1;
const MAX_HISTORY_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_HISTORY_SNAPSHOT_FILE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WorkspaceOperationPhase {
    Prepared,
    Applied,
    RolledBack,
    FinalizingCommitted,
    FinalizingRolledBack,
    Finalized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WorkspaceFilePhase {
    Prepared,
    Applied,
    RolledBack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
enum PersistedWorkspaceOutcome {
    Committed {
        history_version: u32,
    },
    RolledBackStale {
        expected_history_version: u32,
        actual_history_version: u32,
    },
}

impl From<HistoryRevertWorkspaceOutcome> for PersistedWorkspaceOutcome {
    fn from(outcome: HistoryRevertWorkspaceOutcome) -> Self {
        match outcome {
            HistoryRevertWorkspaceOutcome::Committed { history_version } => {
                Self::Committed { history_version }
            }
            HistoryRevertWorkspaceOutcome::RolledBackStale {
                expected_history_version,
                actual_history_version,
            } => Self::RolledBackStale {
                expected_history_version,
                actual_history_version,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
enum WorkspaceSnapshotState {
    Absent,
    File {
        sha256: String,
        mode: u32,
        size: u64,
        payload_file: String,
    },
}

impl WorkspaceSnapshotState {
    fn version(&self) -> EditTransactionFileVersion {
        match self {
            Self::Absent => EditTransactionFileVersion::Absent,
            Self::File {
                sha256, mode, size, ..
            } => EditTransactionFileVersion::File {
                sha256: sha256.clone(),
                mode: *mode,
                size: *size,
            },
        }
    }

    fn payload_file(&self) -> Option<&str> {
        match self {
            Self::Absent => None,
            Self::File { payload_file, .. } => Some(payload_file),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct WorkspaceFileSnapshot {
    path: PathBuf,
    parent_identity: PersistedDirectoryIdentity,
    pre_revert: WorkspaceSnapshotState,
    target_revert: WorkspaceSnapshotState,
    phase: WorkspaceFilePhase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct WorkspaceTransactionSnapshot {
    transaction_id: String,
    generation_id: String,
    fingerprint: String,
    consumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct WorkspaceOperationManifest {
    schema_version: u16,
    operation_id: String,
    session_id: String,
    context_scope_id: String,
    target_ui_message_id: String,
    transaction_ids: Vec<String>,
    workspace_root: Option<PathBuf>,
    transactions: Vec<WorkspaceTransactionSnapshot>,
    files: Vec<WorkspaceFileSnapshot>,
    phase: WorkspaceOperationPhase,
    finalized_outcome: Option<PersistedWorkspaceOutcome>,
    cleanup_started: bool,
    cleanup_complete: bool,
}

struct PreparedFileSnapshot {
    path: PathBuf,
    parent_identity: PersistedDirectoryIdentity,
    pre_version: EditTransactionFileVersion,
    pre_contents: Option<Vec<u8>>,
    target_version: EditTransactionFileVersion,
    target_contents: Option<Vec<u8>>,
}

#[async_trait]
impl HistoryRevertWorkspace for EditTransactionService {
    async fn prepare_backup(&self, operation: &HistoryRevertOperation) -> Result<(), AppError> {
        self.prepare_history_workspace_backup(operation).await
    }

    async fn apply_revert(&self, operation: &HistoryRevertOperation) -> Result<(), AppError> {
        self.apply_history_workspace_revert(operation).await
    }

    async fn rollback_revert(&self, operation: &HistoryRevertOperation) -> Result<(), AppError> {
        self.rollback_history_workspace_revert(operation).await
    }

    async fn finalize_backup(
        &self,
        operation: &HistoryRevertOperation,
        outcome: HistoryRevertWorkspaceOutcome,
    ) -> Result<(), AppError> {
        self.finalize_history_workspace_backup(operation, outcome)
            .await
    }
}

impl EditTransactionService {
    async fn prepare_history_workspace_backup(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<(), AppError> {
        validate_operation(operation)?;
        if let Some(manifest) = self.load_workspace_manifest(operation).await? {
            validate_operation_identity(&manifest, operation)?;
            return Ok(());
        }

        let operation_directory = self
            .prepare_empty_history_operation_directory(operation)
            .await?;
        let (workspace_root, transactions, files) =
            self.build_prepared_workspace_snapshot(operation).await?;
        let mut manifest = WorkspaceOperationManifest {
            schema_version: HISTORY_MANIFEST_SCHEMA_VERSION,
            operation_id: operation.operation_id.clone(),
            session_id: operation.request.session_id.as_str().to_string(),
            context_scope_id: operation.request.context_scope_id.as_key().into_owned(),
            target_ui_message_id: operation.request.target_ui_message_id.clone(),
            transaction_ids: operation.request.transaction_ids.clone(),
            workspace_root,
            transactions,
            files: Vec::with_capacity(files.len()),
            phase: WorkspaceOperationPhase::Prepared,
            finalized_outcome: None,
            cleanup_started: false,
            cleanup_complete: false,
        };

        for (index, file) in files.into_iter().enumerate() {
            let pre_revert = persist_snapshot_state(
                &operation_directory,
                "pre",
                index,
                file.pre_version,
                file.pre_contents,
            )
            .await?;
            let target_revert = persist_snapshot_state(
                &operation_directory,
                "target",
                index,
                file.target_version,
                file.target_contents,
            )
            .await?;
            manifest.files.push(WorkspaceFileSnapshot {
                path: file.path,
                parent_identity: file.parent_identity,
                pre_revert,
                target_revert,
                phase: WorkspaceFilePhase::Prepared,
            });
        }
        self.persist_workspace_manifest(&operation_directory, &manifest)
            .await
    }

    async fn apply_history_workspace_revert(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<(), AppError> {
        validate_operation(operation)?;
        let operation_directory = self.history_operation_directory(operation)?;
        let mut manifest = self.require_workspace_manifest(operation).await?;
        match manifest.phase {
            WorkspaceOperationPhase::Prepared | WorkspaceOperationPhase::Applied => {}
            _ => {
                return Err(AppError::conflict(format!(
                    "History revert {} cannot apply workspace files from phase {:?}",
                    operation.operation_id, manifest.phase
                )));
            }
        }
        self.validate_transaction_snapshots(&manifest, false)
            .await?;

        for index in 0..manifest.files.len() {
            let file = &manifest.files[index];
            match file.phase {
                WorkspaceFilePhase::Prepared => {
                    apply_snapshot_transition(
                        self,
                        &operation_directory,
                        file,
                        &file.pre_revert,
                        &file.target_revert,
                        "apply history revert",
                    )
                    .await?;
                    manifest.files[index].phase = WorkspaceFilePhase::Applied;
                    self.persist_workspace_manifest(&operation_directory, &manifest)
                        .await?;
                }
                WorkspaceFilePhase::Applied => {
                    verify_workspace_state(self, &operation_directory, file, &file.target_revert)
                        .await?;
                }
                WorkspaceFilePhase::RolledBack => {
                    return Err(AppError::conflict(format!(
                        "History revert {} was already rolled back",
                        operation.operation_id
                    )));
                }
            }
        }
        manifest.phase = WorkspaceOperationPhase::Applied;
        self.persist_workspace_manifest(&operation_directory, &manifest)
            .await
    }

    async fn rollback_history_workspace_revert(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<(), AppError> {
        validate_operation(operation)?;
        let operation_directory = self.history_operation_directory(operation)?;
        let mut manifest = self.require_workspace_manifest(operation).await?;
        match manifest.phase {
            WorkspaceOperationPhase::Applied | WorkspaceOperationPhase::RolledBack => {}
            _ => {
                return Err(AppError::conflict(format!(
                    "History revert {} cannot roll back workspace files from phase {:?}",
                    operation.operation_id, manifest.phase
                )));
            }
        }
        self.validate_transaction_snapshots(&manifest, false)
            .await?;

        for index in (0..manifest.files.len()).rev() {
            let file = &manifest.files[index];
            match file.phase {
                WorkspaceFilePhase::Applied => {
                    apply_snapshot_transition(
                        self,
                        &operation_directory,
                        file,
                        &file.target_revert,
                        &file.pre_revert,
                        "roll back stale history revert",
                    )
                    .await?;
                    manifest.files[index].phase = WorkspaceFilePhase::RolledBack;
                    self.persist_workspace_manifest(&operation_directory, &manifest)
                        .await?;
                }
                WorkspaceFilePhase::RolledBack => {
                    verify_workspace_state(self, &operation_directory, file, &file.pre_revert)
                        .await?;
                }
                WorkspaceFilePhase::Prepared => {
                    return Err(AppError::conflict(format!(
                        "History revert {} has an unapplied workspace file",
                        operation.operation_id
                    )));
                }
            }
        }
        manifest.phase = WorkspaceOperationPhase::RolledBack;
        self.persist_workspace_manifest(&operation_directory, &manifest)
            .await
    }

    async fn finalize_history_workspace_backup(
        &self,
        operation: &HistoryRevertOperation,
        outcome: HistoryRevertWorkspaceOutcome,
    ) -> Result<(), AppError> {
        validate_operation(operation)?;
        let operation_directory = self.history_operation_directory(operation)?;
        let mut manifest = self.require_workspace_manifest(operation).await?;
        let persisted_outcome = PersistedWorkspaceOutcome::from(outcome);
        if manifest.cleanup_complete {
            if manifest.finalized_outcome.as_ref() != Some(&persisted_outcome) {
                return Err(AppError::conflict(
                    "History revert workspace outcome changed after finalization",
                ));
            }
            return Ok(());
        }
        if let Some(existing) = manifest.finalized_outcome.as_ref() {
            if existing != &persisted_outcome {
                return Err(AppError::conflict(
                    "History revert workspace outcome changed during recovery",
                ));
            }
        }

        match outcome {
            HistoryRevertWorkspaceOutcome::Committed { .. } => {
                self.finalize_committed_history_operation(
                    &operation_directory,
                    &mut manifest,
                    persisted_outcome,
                )
                .await?;
            }
            HistoryRevertWorkspaceOutcome::RolledBackStale { .. } => {
                self.finalize_rolled_back_history_operation(
                    &operation_directory,
                    &mut manifest,
                    persisted_outcome,
                )
                .await?;
            }
        }
        self.cleanup_history_operation_payloads(&operation_directory, &mut manifest)
            .await
    }

    /// Removes completed workspace snapshots for one deleted session.
    ///
    /// Unfinished snapshots are rejected so session deletion cannot erase recovery evidence.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when recovery is pending or the operation store is unsafe or corrupt.
    pub async fn cleanup_session_history_reverts(&self, session_id: &str) -> Result<(), AppError> {
        let typed_session_id = codez_core::SessionId::parse(session_id.to_owned())
            .map_err(|_| AppError::validation("The history revert session ID is malformed"))?;
        let Some(history_root) = self.existing_history_operation_root().await? else {
            return Ok(());
        };
        let operation_directories = discover_operation_directories(&history_root).await?;
        for operation_directory in operation_directories {
            let manifest = self
                .load_workspace_manifest_from_directory(&operation_directory)
                .await?;
            if manifest.session_id != typed_session_id.as_str() {
                continue;
            }
            if !manifest.cleanup_complete {
                return Err(AppError::run_active(format!(
                    "History revert {} still requires recovery",
                    manifest.operation_id
                )));
            }
            remove_completed_operation_directory(&operation_directory).await?;
        }
        remove_empty_directory_if_present(&history_root, "history revert operation root").await
    }

    async fn build_prepared_workspace_snapshot(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<
        (
            Option<PathBuf>,
            Vec<WorkspaceTransactionSnapshot>,
            Vec<PreparedFileSnapshot>,
        ),
        AppError,
    > {
        let loaded = self
            .load_transactions_for_session(
                operation.request.session_id.as_str(),
                &operation.request.transaction_ids,
            )
            .await?;
        let mut transactions = Vec::with_capacity(loaded.len());
        for (transaction_id, transaction) in operation.request.transaction_ids.iter().zip(loaded) {
            let snapshot = transaction.lock().await.clone();
            self.validate_history_transaction(operation, transaction_id, &snapshot)
                .await?;
            transactions.push(snapshot);
        }

        let workspace_root = common_workspace_root(&transactions)?;
        let authority = workspace_root
            .as_ref()
            .map(|root| WorkspaceRoot::from_canonical(root.clone()))
            .transpose()
            .map_err(|_| AppError::conflict("History revert workspace authority is invalid"))?;
        let mut paths = Vec::<PathBuf>::new();
        for transaction in &transactions {
            for path in transaction.files.keys() {
                if !paths.iter().any(|stored| paths_equal(stored, path)) {
                    paths.push(path.clone());
                }
            }
        }
        paths.sort_by_key(|path| path_sort_key(path));

        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            if let Some(authority) = authority.as_ref() {
                SafeWorkspacePath::from_canonical(authority, &path).map_err(|_| {
                    AppError::permission_denied(
                        "A history revert file escapes its registered workspace",
                    )
                })?;
            }
            let current = read_workspace_file(&path).await?;
            ensure_snapshot_size(&current.version)?;
            let parent_identity = capture_parent_identity(&path).await?;
            let mut simulated = current.version.clone();
            let mut target_source: Option<(&TransactionState, &TransactionFileRecord)> = None;

            for transaction in &transactions {
                let Some(record) = transaction.files.iter().find_map(|(record_path, record)| {
                    paths_equal(record_path, &path).then_some(record)
                }) else {
                    continue;
                };
                self.verify_parent_identity(&path, &record.parent_identity)
                    .await?;
                if simulated != record.original
                    && !record_accepts_committed_state(record, &simulated)
                {
                    return Err(AppError::conflict(format!(
                        "History revert cannot verify transaction order for {}",
                        path.display()
                    )));
                }
                ensure_snapshot_size(&record.original)?;
                simulated = record.original.clone();
                target_source = Some((transaction, record));
            }

            let target_contents = match &simulated {
                EditTransactionFileVersion::Absent => None,
                EditTransactionFileVersion::File { .. } => {
                    let Some((transaction, record)) = target_source else {
                        return Err(AppError::conflict(format!(
                            "History revert target has no transaction source for {}",
                            path.display()
                        )));
                    };
                    self.read_backup_contents(transaction, record)
                        .await?
                        .ok_or_else(|| {
                            AppError::conflict(format!(
                                "History revert target backup is missing for {}",
                                path.display()
                            ))
                        })?
                        .into()
                }
            };
            files.push(PreparedFileSnapshot {
                path,
                parent_identity,
                pre_version: current.version,
                pre_contents: current.contents,
                target_version: simulated,
                target_contents,
            });
        }

        let transaction_snapshots = transactions
            .iter()
            .map(|transaction| {
                Ok(WorkspaceTransactionSnapshot {
                    transaction_id: transaction.id.clone(),
                    generation_id: transaction.generation_id.clone(),
                    fingerprint: fingerprint_transaction(transaction)?,
                    consumed: false,
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        Ok((workspace_root, transaction_snapshots, files))
    }

    async fn validate_history_transaction(
        &self,
        operation: &HistoryRevertOperation,
        transaction_id: &str,
        transaction: &TransactionState,
    ) -> Result<(), AppError> {
        self.validate_transaction_state(
            operation.request.session_id.as_str(),
            transaction_id,
            transaction,
        )
        .await?;
        let scope = operation.request.context_scope_id.as_key();
        if transaction.context_scope_id.as_deref() != Some(scope.as_ref())
            || transaction.workspace_root.is_none()
        {
            return Err(AppError::conflict(format!(
                "Edit transaction {transaction_id} does not have matching durable chat provenance"
            )));
        }
        Ok(())
    }

    async fn validate_transaction_snapshots(
        &self,
        manifest: &WorkspaceOperationManifest,
        allow_consumed: bool,
    ) -> Result<(), AppError> {
        for (index, expected) in manifest.transactions.iter().enumerate() {
            let quarantine = self.history_consumed_transaction_path(manifest, index)?;
            if expected.consumed {
                if !allow_consumed {
                    return Err(AppError::conflict(
                        "History revert consumed a transaction before workspace finalization",
                    ));
                }
                self.validate_consumed_transaction_if_present(manifest, expected, &quarantine)
                    .await?;
                continue;
            }
            if path_exists(&quarantine).await? {
                if !allow_consumed {
                    return Err(AppError::conflict(
                        "History revert transaction consumption started before ledger commit",
                    ));
                }
                self.validate_consumed_transaction(manifest, expected, &quarantine)
                    .await?;
                continue;
            }
            let transaction = self
                .load_transaction_for_session(&manifest.session_id, &expected.transaction_id)
                .await?;
            let transaction = transaction.lock().await.clone();
            validate_transaction_fingerprint(expected, &transaction)?;
            self.validate_transaction_state(
                &manifest.session_id,
                &expected.transaction_id,
                &transaction,
            )
            .await?;
        }
        Ok(())
    }

    async fn finalize_committed_history_operation(
        &self,
        operation_directory: &Path,
        manifest: &mut WorkspaceOperationManifest,
        outcome: PersistedWorkspaceOutcome,
    ) -> Result<(), AppError> {
        match manifest.phase {
            WorkspaceOperationPhase::Applied | WorkspaceOperationPhase::FinalizingCommitted => {}
            WorkspaceOperationPhase::Finalized if manifest.finalized_outcome == Some(outcome) => {
                return Ok(());
            }
            _ => {
                return Err(AppError::conflict(
                    "Committed history revert has an invalid workspace snapshot phase",
                ));
            }
        }
        for file in &manifest.files {
            if file.phase != WorkspaceFilePhase::Applied {
                return Err(AppError::conflict(
                    "Committed history revert has an incomplete workspace file",
                ));
            }
            verify_workspace_state(self, operation_directory, file, &file.target_revert).await?;
        }
        manifest.phase = WorkspaceOperationPhase::FinalizingCommitted;
        manifest.finalized_outcome = Some(outcome);
        self.persist_workspace_manifest(operation_directory, manifest)
            .await?;
        self.validate_transaction_snapshots(manifest, true).await?;

        for index in 0..manifest.transactions.len() {
            self.consume_history_transaction(operation_directory, manifest, index)
                .await?;
            manifest.transactions[index].consumed = true;
            self.persist_workspace_manifest(operation_directory, manifest)
                .await?;
        }
        Ok(())
    }

    async fn finalize_rolled_back_history_operation(
        &self,
        operation_directory: &Path,
        manifest: &mut WorkspaceOperationManifest,
        outcome: PersistedWorkspaceOutcome,
    ) -> Result<(), AppError> {
        match manifest.phase {
            WorkspaceOperationPhase::RolledBack | WorkspaceOperationPhase::FinalizingRolledBack => {
            }
            WorkspaceOperationPhase::Finalized if manifest.finalized_outcome == Some(outcome) => {
                return Ok(());
            }
            _ => {
                return Err(AppError::conflict(
                    "Rolled-back history revert has an invalid workspace snapshot phase",
                ));
            }
        }
        for file in &manifest.files {
            if file.phase != WorkspaceFilePhase::RolledBack {
                return Err(AppError::conflict(
                    "Rolled-back history revert has an incomplete workspace file",
                ));
            }
            verify_workspace_state(self, operation_directory, file, &file.pre_revert).await?;
        }
        self.validate_transaction_snapshots(manifest, false).await?;
        if manifest
            .transactions
            .iter()
            .any(|transaction| transaction.consumed)
        {
            return Err(AppError::conflict(
                "A stale history revert must retain all edit transactions",
            ));
        }
        manifest.phase = WorkspaceOperationPhase::FinalizingRolledBack;
        manifest.finalized_outcome = Some(outcome);
        self.persist_workspace_manifest(operation_directory, manifest)
            .await
    }

    async fn cleanup_history_operation_payloads(
        &self,
        operation_directory: &Path,
        manifest: &mut WorkspaceOperationManifest,
    ) -> Result<(), AppError> {
        if !manifest.cleanup_started {
            manifest.cleanup_started = true;
            self.persist_workspace_manifest(operation_directory, manifest)
                .await?;
        }
        for file in &manifest.files {
            remove_snapshot_payload(operation_directory, &file.pre_revert).await?;
            remove_snapshot_payload(operation_directory, &file.target_revert).await?;
        }
        if matches!(
            manifest.finalized_outcome,
            Some(PersistedWorkspaceOutcome::Committed { .. })
        ) {
            for index in 0..manifest.transactions.len() {
                let quarantine = self.history_consumed_transaction_path(manifest, index)?;
                remove_consumed_transaction_if_present(&quarantine).await?;
            }
            let session_directory = self.backup_directory(&manifest.session_id, None)?;
            remove_empty_directory_if_present(
                &session_directory,
                "empty edit transaction session directory",
            )
            .await?;
        }
        manifest.phase = WorkspaceOperationPhase::Finalized;
        manifest.cleanup_complete = true;
        self.persist_workspace_manifest(operation_directory, manifest)
            .await
    }

    async fn consume_history_transaction(
        &self,
        operation_directory: &Path,
        manifest: &WorkspaceOperationManifest,
        index: usize,
    ) -> Result<(), AppError> {
        let expected = manifest.transactions.get(index).ok_or_else(|| {
            AppError::internal("history revert transaction index is out of bounds")
        })?;
        let quarantine = self.history_consumed_transaction_path(manifest, index)?;
        if expected.consumed {
            return self
                .validate_consumed_transaction_if_present(manifest, expected, &quarantine)
                .await;
        }

        if path_exists(&quarantine).await? {
            self.validate_consumed_transaction(manifest, expected, &quarantine)
                .await?;
        } else {
            let transaction = self
                .load_transaction_for_session(&manifest.session_id, &expected.transaction_id)
                .await?;
            let transaction = transaction.lock().await.clone();
            validate_transaction_fingerprint(expected, &transaction)?;
            self.validate_transaction_state(
                &manifest.session_id,
                &expected.transaction_id,
                &transaction,
            )
            .await?;
            let transaction_directory = self
                .existing_transaction_directory(&manifest.session_id, &expected.transaction_id)
                .await?;
            ensure_direct_child(operation_directory, &quarantine, "transaction quarantine")?;
            fs::rename(&transaction_directory, &quarantine)
                .await
                .map_err(|source| {
                    storage_error(
                        "quarantine committed edit transaction",
                        &transaction_directory,
                        source,
                    )
                })?;
            sync_parent_directory(operation_directory, &quarantine).await?;
            let source_parent = transaction_directory.parent().ok_or_else(|| {
                AppError::validation("Edit transaction directory has no session parent")
            })?;
            sync_parent_directory(source_parent, &transaction_directory).await?;
            self.validate_consumed_transaction(manifest, expected, &quarantine)
                .await?;
        }

        match self
            .read_transaction_locator_if_present(&expected.transaction_id)
            .await?
        {
            Some(locator)
                if locator.session_id.as_str() == manifest.session_id
                    && locator.generation_id == expected.generation_id =>
            {
                self.remove_transaction_locator_if_matches(&locator).await?;
            }
            Some(_) => {
                return Err(AppError::conflict(format!(
                    "Edit transaction {} was reused during history recovery",
                    expected.transaction_id
                )));
            }
            None => {}
        }
        self.transactions.remove(&expected.transaction_id);
        self.transaction_queues.remove(&expected.transaction_id);
        self.closing_transactions.remove(&expected.transaction_id);
        Ok(())
    }

    async fn validate_consumed_transaction_if_present(
        &self,
        manifest: &WorkspaceOperationManifest,
        expected: &WorkspaceTransactionSnapshot,
        quarantine: &Path,
    ) -> Result<(), AppError> {
        if path_exists(quarantine).await? {
            self.validate_consumed_transaction(manifest, expected, quarantine)
                .await?;
        }
        let original =
            self.backup_directory(&manifest.session_id, Some(&expected.transaction_id))?;
        if path_exists(&original).await? {
            return Err(AppError::conflict(format!(
                "Consumed edit transaction {} reappeared",
                expected.transaction_id
            )));
        }
        if let Some(locator) = self
            .read_transaction_locator_if_present(&expected.transaction_id)
            .await?
        {
            return Err(AppError::conflict(format!(
                "Consumed edit transaction {} still has locator generation {}",
                expected.transaction_id, locator.generation_id
            )));
        }
        Ok(())
    }

    async fn validate_consumed_transaction(
        &self,
        manifest: &WorkspaceOperationManifest,
        expected: &WorkspaceTransactionSnapshot,
        quarantine: &Path,
    ) -> Result<(), AppError> {
        validate_safe_directory(quarantine, "history transaction quarantine").await?;
        let metadata_path = quarantine.join("metadata.json");
        let bytes = read_bounded_regular_file(
            &metadata_path,
            super::MAX_TRANSACTION_METADATA_BYTES as u64,
            "quarantined edit transaction metadata",
        )
        .await?;
        let transaction: TransactionState = serde_json::from_slice(&bytes).map_err(|source| {
            AppError::storage(
                "Quarantined edit transaction metadata is invalid",
                format!("{}: {source}", metadata_path.display()),
                false,
            )
        })?;
        if transaction.session_id != manifest.session_id
            || transaction.id != expected.transaction_id
        {
            return Err(AppError::conflict(
                "Quarantined edit transaction identity changed",
            ));
        }
        validate_transaction_fingerprint(expected, &transaction)?;
        validate_quarantined_transaction_files(quarantine, &transaction).await
    }

    fn history_operation_root(&self) -> PathBuf {
        self.backup_root.join(HISTORY_OPERATION_DIRECTORY)
    }

    fn history_operation_directory(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<PathBuf, AppError> {
        validate_backup_segment(&operation.operation_id, "history operation")?;
        Ok(self.history_operation_root().join(&operation.operation_id))
    }

    fn history_consumed_transaction_path(
        &self,
        manifest: &WorkspaceOperationManifest,
        index: usize,
    ) -> Result<PathBuf, AppError> {
        let operation_directory = self.history_operation_root().join(&manifest.operation_id);
        let name = format!("consumed-{index}");
        validate_backup_segment(&name, "history transaction quarantine")?;
        Ok(operation_directory.join(name))
    }

    async fn prepare_history_operation_root(&self) -> Result<PathBuf, AppError> {
        fs::create_dir_all(&self.backup_root)
            .await
            .map_err(|source| {
                storage_error("create edit backup root", &self.backup_root, source)
            })?;
        inspect_safe_directory(&self.backup_root, "edit backup root").await?;
        let history_root = self.history_operation_root();
        match fs::create_dir(&history_root).await {
            Ok(()) => {}
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {}
            Err(source) => {
                return Err(storage_error(
                    "create history revert operation root",
                    &history_root,
                    source,
                ));
            }
        }
        validate_direct_child_directory(
            &self.backup_root,
            &history_root,
            "history revert operation root",
        )
        .await?;
        Ok(history_root)
    }

    async fn existing_history_operation_root(&self) -> Result<Option<PathBuf>, AppError> {
        let history_root = self.history_operation_root();
        match fs::symlink_metadata(&history_root).await {
            Ok(_) => {
                validate_direct_child_directory(
                    &self.backup_root,
                    &history_root,
                    "history revert operation root",
                )
                .await?;
                Ok(Some(history_root))
            }
            Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(storage_error(
                "inspect history revert operation root",
                &history_root,
                source,
            )),
        }
    }

    async fn prepare_empty_history_operation_directory(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<PathBuf, AppError> {
        let history_root = self.prepare_history_operation_root().await?;
        let operation_directory = self.history_operation_directory(operation)?;
        match fs::create_dir(&operation_directory).await {
            Ok(()) => {}
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                validate_direct_child_directory(
                    &history_root,
                    &operation_directory,
                    "history revert operation directory",
                )
                .await?;
                remove_partial_operation_contents(&operation_directory).await?;
            }
            Err(source) => {
                return Err(storage_error(
                    "create history revert operation directory",
                    &operation_directory,
                    source,
                ));
            }
        }
        validate_direct_child_directory(
            &history_root,
            &operation_directory,
            "history revert operation directory",
        )
        .await?;
        Ok(operation_directory)
    }

    async fn load_workspace_manifest(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<Option<WorkspaceOperationManifest>, AppError> {
        let Some(history_root) = self.existing_history_operation_root().await? else {
            return Ok(None);
        };
        let operation_directory = self.history_operation_directory(operation)?;
        match fs::symlink_metadata(&operation_directory).await {
            Ok(_) => {
                validate_direct_child_directory(
                    &history_root,
                    &operation_directory,
                    "history revert operation directory",
                )
                .await?;
            }
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(storage_error(
                    "inspect history revert operation directory",
                    &operation_directory,
                    source,
                ));
            }
        }
        let manifest_path = operation_directory.join(HISTORY_MANIFEST_FILE);
        match fs::symlink_metadata(&manifest_path).await {
            Ok(_) => self
                .load_workspace_manifest_from_directory(&operation_directory)
                .await
                .map(Some),
            Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(storage_error(
                "inspect history revert workspace manifest",
                &manifest_path,
                source,
            )),
        }
    }

    async fn require_workspace_manifest(
        &self,
        operation: &HistoryRevertOperation,
    ) -> Result<WorkspaceOperationManifest, AppError> {
        let manifest = self
            .load_workspace_manifest(operation)
            .await?
            .ok_or_else(|| {
                AppError::storage(
                    "History revert workspace snapshot is missing",
                    operation.operation_id.clone(),
                    false,
                )
            })?;
        validate_operation_identity(&manifest, operation)?;
        Ok(manifest)
    }

    async fn load_workspace_manifest_from_directory(
        &self,
        operation_directory: &Path,
    ) -> Result<WorkspaceOperationManifest, AppError> {
        let manifest_path = operation_directory.join(HISTORY_MANIFEST_FILE);
        let bytes = read_bounded_regular_file(
            &manifest_path,
            MAX_HISTORY_MANIFEST_BYTES,
            "history revert workspace manifest",
        )
        .await?;
        let manifest: WorkspaceOperationManifest =
            serde_json::from_slice(&bytes).map_err(|source| {
                AppError::storage(
                    "History revert workspace manifest is invalid",
                    format!("{}: {source}", manifest_path.display()),
                    false,
                )
            })?;
        validate_manifest_structure(&manifest, operation_directory)?;
        validate_operation_directory_entries(operation_directory, &manifest).await?;
        if !manifest.cleanup_started {
            for file in &manifest.files {
                validate_snapshot_payload(operation_directory, &file.pre_revert).await?;
                validate_snapshot_payload(operation_directory, &file.target_revert).await?;
            }
        }
        Ok(manifest)
    }

    async fn persist_workspace_manifest(
        &self,
        operation_directory: &Path,
        manifest: &WorkspaceOperationManifest,
    ) -> Result<(), AppError> {
        validate_manifest_structure(manifest, operation_directory)?;
        let bytes = serde_json::to_vec_pretty(manifest).map_err(|source| {
            AppError::internal(format!(
                "Failed to serialize history revert workspace manifest: {source}"
            ))
        })?;
        if bytes.len() as u64 > MAX_HISTORY_MANIFEST_BYTES {
            return Err(AppError::storage(
                "History revert workspace manifest exceeds its safety limit",
                operation_directory.display().to_string(),
                false,
            ));
        }
        atomic_persist_file(
            &operation_directory.join(HISTORY_MANIFEST_FILE),
            &bytes,
            None,
        )
        .await
    }
}

fn validate_operation(operation: &HistoryRevertOperation) -> Result<(), AppError> {
    validate_backup_segment(&operation.operation_id, "history operation")?;
    let expected = HistoryRevertService::operation_id(&operation.request)
        .map_err(|source| AppError::validation(source.to_string()))?;
    if operation.operation_id != expected {
        return Err(AppError::validation(
            "History revert operation ID does not match its request",
        ));
    }
    Ok(())
}

fn validate_operation_identity(
    manifest: &WorkspaceOperationManifest,
    operation: &HistoryRevertOperation,
) -> Result<(), AppError> {
    if manifest.operation_id != operation.operation_id
        || manifest.session_id != operation.request.session_id.as_str()
        || manifest.context_scope_id != operation.request.context_scope_id.as_key()
        || manifest.target_ui_message_id != operation.request.target_ui_message_id
        || manifest.transaction_ids != operation.request.transaction_ids
    {
        return Err(AppError::conflict(
            "History revert workspace snapshot identity does not match its request",
        ));
    }
    Ok(())
}

fn common_workspace_root(transactions: &[TransactionState]) -> Result<Option<PathBuf>, AppError> {
    let Some(first) = transactions.first() else {
        return Ok(None);
    };
    let root = first.workspace_root.clone().ok_or_else(|| {
        AppError::conflict("History revert transaction has no workspace authority")
    })?;
    if transactions.iter().skip(1).any(|transaction| {
        transaction
            .workspace_root
            .as_deref()
            .is_none_or(|candidate| !paths_equal(candidate, &root))
    }) {
        return Err(AppError::conflict(
            "History revert transactions belong to different workspaces",
        ));
    }
    Ok(Some(root))
}

fn fingerprint_transaction(transaction: &TransactionState) -> Result<String, AppError> {
    #[derive(Serialize)]
    struct CanonicalTransaction<'a> {
        id: &'a str,
        session_id: &'a str,
        generation_id: &'a str,
        context_scope_id: Option<&'a str>,
        turn_id: Option<&'a str>,
        workspace_root: Option<&'a Path>,
        files: Vec<(&'a Path, &'a TransactionFileRecord)>,
        created_at: u64,
    }

    let mut files = transaction
        .files
        .iter()
        .map(|(path, record)| (path.as_path(), record))
        .collect::<Vec<_>>();
    files.sort_by_key(|(path, _)| path_sort_key(path));
    let canonical = CanonicalTransaction {
        id: &transaction.id,
        session_id: &transaction.session_id,
        generation_id: &transaction.generation_id,
        context_scope_id: transaction.context_scope_id.as_deref(),
        turn_id: transaction.turn_id.as_deref(),
        workspace_root: transaction.workspace_root.as_deref(),
        files,
        created_at: transaction.created_at,
    };
    serde_json::to_vec(&canonical)
        .map(|bytes| sha256_for(&bytes))
        .map_err(|source| {
            AppError::internal(format!(
                "Failed to fingerprint edit transaction for history revert: {source}"
            ))
        })
}

fn validate_transaction_fingerprint(
    expected: &WorkspaceTransactionSnapshot,
    transaction: &TransactionState,
) -> Result<(), AppError> {
    if transaction.id != expected.transaction_id
        || transaction.generation_id != expected.generation_id
        || fingerprint_transaction(transaction)? != expected.fingerprint
    {
        return Err(AppError::conflict(format!(
            "Edit transaction {} changed during history revert recovery",
            expected.transaction_id
        )));
    }
    Ok(())
}

async fn persist_snapshot_state(
    operation_directory: &Path,
    label: &str,
    index: usize,
    version: EditTransactionFileVersion,
    contents: Option<Vec<u8>>,
) -> Result<WorkspaceSnapshotState, AppError> {
    match version {
        EditTransactionFileVersion::Absent => {
            if contents.is_some() {
                return Err(AppError::internal(
                    "absent history workspace snapshot unexpectedly has contents",
                ));
            }
            Ok(WorkspaceSnapshotState::Absent)
        }
        EditTransactionFileVersion::File { sha256, mode, size } => {
            if size > MAX_HISTORY_SNAPSHOT_FILE_BYTES {
                return Err(AppError::storage(
                    "History revert file exceeds its snapshot safety limit",
                    format!("file size {size}"),
                    false,
                ));
            }
            let contents = contents.ok_or_else(|| {
                AppError::conflict("History workspace file snapshot is missing its contents")
            })?;
            if contents.len() as u64 != size || sha256_for(&contents) != sha256 {
                return Err(AppError::conflict(
                    "History workspace file snapshot does not match its metadata",
                ));
            }
            let payload_file = format!("{label}-{index}.bin");
            validate_backup_segment(&payload_file, "history snapshot payload")?;
            let payload_path = operation_directory.join(&payload_file);
            write_new_file(&payload_path, &contents).await?;
            apply_mode_and_sync(&payload_path, 0o600).await?;
            Ok(WorkspaceSnapshotState::File {
                sha256,
                mode,
                size,
                payload_file,
            })
        }
    }
}

fn ensure_snapshot_size(version: &EditTransactionFileVersion) -> Result<(), AppError> {
    if matches!(version, EditTransactionFileVersion::File { size, .. } if *size > MAX_HISTORY_SNAPSHOT_FILE_BYTES)
    {
        return Err(AppError::storage(
            "History revert file exceeds its snapshot safety limit",
            format!("file size exceeds {MAX_HISTORY_SNAPSHOT_FILE_BYTES} bytes"),
            false,
        ));
    }
    Ok(())
}

async fn apply_snapshot_transition(
    service: &EditTransactionService,
    operation_directory: &Path,
    file: &WorkspaceFileSnapshot,
    expected: &WorkspaceSnapshotState,
    desired: &WorkspaceSnapshotState,
    action: &'static str,
) -> Result<(), AppError> {
    service
        .verify_parent_identity(&file.path, &file.parent_identity)
        .await?;
    let current = read_workspace_file(&file.path).await?.version;
    if current == desired.version() {
        validate_snapshot_payload(operation_directory, desired).await?;
        return Ok(());
    }
    if current != expected.version() {
        return Err(AppError::conflict(format!(
            "History revert conflict for {} while attempting to {action}",
            file.path.display()
        )));
    }

    match desired {
        WorkspaceSnapshotState::Absent => {
            service
                .verify_parent_identity(&file.path, &file.parent_identity)
                .await?;
            if read_workspace_file(&file.path).await?.version != expected.version() {
                return Err(AppError::conflict(format!(
                    "History revert file changed before deletion: {}",
                    file.path.display()
                )));
            }
            fs::remove_file(&file.path).await.map_err(|source| {
                storage_error("remove history revert workspace file", &file.path, source)
            })?;
            let parent = file.path.parent().ok_or_else(|| {
                AppError::validation("History revert workspace file has no parent")
            })?;
            sync_parent_directory(parent, &file.path).await?;
        }
        WorkspaceSnapshotState::File { mode, .. } => {
            let contents = read_snapshot_contents(operation_directory, desired).await?;
            let parent = file.path.parent().ok_or_else(|| {
                AppError::validation("History revert workspace file has no parent")
            })?;
            let temporary = create_synced_temporary_file(
                parent,
                ".codez-history-revert-",
                &contents,
                Some(*mode),
            )
            .await?;
            service
                .verify_parent_identity(&file.path, &file.parent_identity)
                .await?;
            if read_workspace_file(&file.path).await?.version != expected.version() {
                return Err(AppError::conflict(format!(
                    "History revert file changed before replacement: {}",
                    file.path.display()
                )));
            }
            if matches!(expected, WorkspaceSnapshotState::Absent) {
                persist_temporary_file_no_clobber(temporary, &file.path, *mode).await?;
            } else {
                persist_temporary_file(temporary, &file.path, Some(*mode)).await?;
            }
        }
    }
    verify_workspace_state(service, operation_directory, file, desired).await
}

async fn verify_workspace_state(
    service: &EditTransactionService,
    operation_directory: &Path,
    file: &WorkspaceFileSnapshot,
    expected: &WorkspaceSnapshotState,
) -> Result<(), AppError> {
    service
        .verify_parent_identity(&file.path, &file.parent_identity)
        .await?;
    let current = read_workspace_file(&file.path).await?.version;
    if current != expected.version() {
        return Err(AppError::conflict(format!(
            "History revert workspace state changed for {}",
            file.path.display()
        )));
    }
    if !matches!(expected, WorkspaceSnapshotState::Absent) {
        validate_snapshot_payload(operation_directory, expected).await?;
    }
    Ok(())
}

async fn read_snapshot_contents(
    operation_directory: &Path,
    snapshot: &WorkspaceSnapshotState,
) -> Result<Vec<u8>, AppError> {
    let WorkspaceSnapshotState::File {
        sha256,
        size,
        payload_file,
        ..
    } = snapshot
    else {
        return Err(AppError::internal(
            "absent history snapshot has no readable contents",
        ));
    };
    let payload_path = snapshot_payload_path(operation_directory, payload_file)?;
    let contents =
        read_bounded_regular_file(&payload_path, *size, "history revert workspace payload").await?;
    if contents.len() as u64 != *size || sha256_for(&contents) != *sha256 {
        return Err(AppError::conflict(
            "History revert workspace payload changed after preparation",
        ));
    }
    Ok(contents)
}

async fn validate_snapshot_payload(
    operation_directory: &Path,
    snapshot: &WorkspaceSnapshotState,
) -> Result<(), AppError> {
    match snapshot {
        WorkspaceSnapshotState::Absent => Ok(()),
        WorkspaceSnapshotState::File { .. } => {
            read_snapshot_contents(operation_directory, snapshot)
                .await
                .map(|_| ())
        }
    }
}

fn snapshot_payload_path(
    operation_directory: &Path,
    payload_file: &str,
) -> Result<PathBuf, AppError> {
    validate_backup_segment(payload_file, "history snapshot payload")?;
    let path = operation_directory.join(payload_file);
    ensure_direct_child(operation_directory, &path, "history snapshot payload")?;
    Ok(path)
}

async fn remove_snapshot_payload(
    operation_directory: &Path,
    snapshot: &WorkspaceSnapshotState,
) -> Result<(), AppError> {
    let Some(payload_file) = snapshot.payload_file() else {
        return Ok(());
    };
    let path = snapshot_payload_path(operation_directory, payload_file)?;
    remove_safe_regular_file_if_present(&path, "history snapshot payload").await
}

fn validate_manifest_structure(
    manifest: &WorkspaceOperationManifest,
    operation_directory: &Path,
) -> Result<(), AppError> {
    if manifest.schema_version != HISTORY_MANIFEST_SCHEMA_VERSION {
        return Err(AppError::conflict(format!(
            "Unsupported history workspace manifest version {}",
            manifest.schema_version
        )));
    }
    validate_backup_segment(&manifest.operation_id, "history operation")?;
    if operation_directory
        .file_name()
        .and_then(|name| name.to_str())
        != Some(manifest.operation_id.as_str())
    {
        return Err(AppError::conflict(
            "History workspace manifest does not match its directory",
        ));
    }
    let session_id = codez_core::SessionId::parse(manifest.session_id.clone())
        .map_err(|_| AppError::conflict("History workspace manifest has an invalid session ID"))?;
    let context_scope_id = codez_core::context::ContextScopeId::parse(&manifest.context_scope_id)
        .map_err(|_| {
        AppError::conflict("History workspace manifest has an invalid context scope")
    })?;
    let request = crate::history_revert::HistoryRevertRequest {
        session_id,
        context_scope_id,
        target_ui_message_id: manifest.target_ui_message_id.clone(),
        transaction_ids: manifest.transaction_ids.clone(),
    };
    let expected_operation_id = HistoryRevertService::operation_id(&request)
        .map_err(|source| AppError::conflict(source.to_string()))?;
    if manifest.operation_id != expected_operation_id {
        return Err(AppError::conflict(
            "History workspace manifest operation ID is invalid",
        ));
    }
    if manifest.transactions.len() != manifest.transaction_ids.len()
        || manifest
            .transactions
            .iter()
            .zip(&manifest.transaction_ids)
            .any(|(transaction, requested)| transaction.transaction_id != *requested)
    {
        return Err(AppError::conflict(
            "History workspace transaction list is inconsistent",
        ));
    }
    let mut transaction_ids = HashSet::with_capacity(manifest.transactions.len());
    for transaction in &manifest.transactions {
        validate_backup_segment(&transaction.transaction_id, "transaction")?;
        super::validate_generation_id(&transaction.generation_id)?;
        validate_sha256(&transaction.fingerprint, "transaction fingerprint")?;
        if !transaction_ids.insert(transaction.transaction_id.as_str()) {
            return Err(AppError::conflict(
                "History workspace manifest contains duplicate transactions",
            ));
        }
    }

    let authority = manifest
        .workspace_root
        .as_ref()
        .map(|root| WorkspaceRoot::from_canonical(root.clone()))
        .transpose()
        .map_err(|_| AppError::conflict("History workspace authority is invalid"))?;
    if !manifest.files.is_empty() && authority.is_none() {
        return Err(AppError::conflict(
            "History workspace files have no workspace authority",
        ));
    }
    let mut paths = Vec::<&Path>::with_capacity(manifest.files.len());
    for file in &manifest.files {
        if paths.iter().any(|stored| paths_equal(stored, &file.path)) {
            return Err(AppError::conflict(
                "History workspace manifest contains duplicate file paths",
            ));
        }
        paths.push(&file.path);
        if let Some(authority) = authority.as_ref() {
            SafeWorkspacePath::from_canonical(authority, &file.path).map_err(|_| {
                AppError::conflict("History workspace file escapes its workspace authority")
            })?;
        }
        match &file.parent_identity {
            PersistedDirectoryIdentity::Stable(StableDirectoryIdentity { path, file_id })
                if path.is_absolute()
                    && !file_id.is_empty()
                    && path_starts_with(&file.path, path) => {}
            _ => {
                return Err(AppError::conflict(
                    "History workspace file has an invalid parent identity",
                ));
            }
        }
        validate_snapshot_state(&file.pre_revert)?;
        validate_snapshot_state(&file.target_revert)?;
    }

    if manifest.cleanup_complete
        && (!manifest.cleanup_started || manifest.phase != WorkspaceOperationPhase::Finalized)
    {
        return Err(AppError::conflict(
            "Completed history workspace cleanup has an invalid phase",
        ));
    }
    if manifest.cleanup_started
        && !matches!(
            manifest.phase,
            WorkspaceOperationPhase::FinalizingCommitted
                | WorkspaceOperationPhase::FinalizingRolledBack
                | WorkspaceOperationPhase::Finalized
        )
    {
        return Err(AppError::conflict(
            "History workspace cleanup started before finalization",
        ));
    }
    match manifest.phase {
        WorkspaceOperationPhase::Prepared
        | WorkspaceOperationPhase::Applied
        | WorkspaceOperationPhase::RolledBack => {
            if manifest.finalized_outcome.is_some()
                || manifest.cleanup_started
                || manifest.transactions.iter().any(|entry| entry.consumed)
            {
                return Err(AppError::conflict(
                    "Pre-final history workspace manifest contains terminal state",
                ));
            }
        }
        WorkspaceOperationPhase::FinalizingCommitted => {
            if !matches!(
                manifest.finalized_outcome,
                Some(PersistedWorkspaceOutcome::Committed { .. })
            ) || manifest
                .files
                .iter()
                .any(|file| file.phase != WorkspaceFilePhase::Applied)
            {
                return Err(AppError::conflict(
                    "Committed history workspace finalization is inconsistent",
                ));
            }
        }
        WorkspaceOperationPhase::FinalizingRolledBack => {
            if !matches!(
                manifest.finalized_outcome,
                Some(PersistedWorkspaceOutcome::RolledBackStale { .. })
            ) || manifest
                .files
                .iter()
                .any(|file| file.phase != WorkspaceFilePhase::RolledBack)
                || manifest.transactions.iter().any(|entry| entry.consumed)
            {
                return Err(AppError::conflict(
                    "Rolled-back history workspace finalization is inconsistent",
                ));
            }
        }
        WorkspaceOperationPhase::Finalized => {
            if manifest.finalized_outcome.is_none() || !manifest.cleanup_complete {
                return Err(AppError::conflict(
                    "Finalized history workspace manifest is incomplete",
                ));
            }
            match manifest.finalized_outcome {
                Some(PersistedWorkspaceOutcome::Committed { .. })
                    if manifest.transactions.iter().all(|entry| entry.consumed) => {}
                Some(PersistedWorkspaceOutcome::RolledBackStale { .. })
                    if manifest.transactions.iter().all(|entry| !entry.consumed) => {}
                _ => {
                    return Err(AppError::conflict(
                        "Finalized history workspace transaction state is inconsistent",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_snapshot_state(snapshot: &WorkspaceSnapshotState) -> Result<(), AppError> {
    if let WorkspaceSnapshotState::File {
        sha256,
        size,
        payload_file,
        ..
    } = snapshot
    {
        validate_sha256(sha256, "workspace snapshot digest")?;
        if *size > MAX_HISTORY_SNAPSHOT_FILE_BYTES {
            return Err(AppError::conflict(
                "History workspace snapshot exceeds its file limit",
            ));
        }
        validate_backup_segment(payload_file, "history snapshot payload")?;
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<(), AppError> {
    if value.len() != 64 || !value.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(AppError::conflict(format!(
            "History workspace {label} is invalid"
        )));
    }
    Ok(())
}

async fn validate_operation_directory_entries(
    operation_directory: &Path,
    manifest: &WorkspaceOperationManifest,
) -> Result<(), AppError> {
    let mut expected_payloads = HashSet::<String>::new();
    for file in &manifest.files {
        if let Some(payload) = file.pre_revert.payload_file() {
            expected_payloads.insert(payload.to_string());
        }
        if let Some(payload) = file.target_revert.payload_file() {
            expected_payloads.insert(payload.to_string());
        }
    }
    let mut entries = fs::read_dir(operation_directory).await.map_err(|source| {
        storage_error(
            "read history revert operation directory",
            operation_directory,
            source,
        )
    })?;
    while let Some(entry) = entries.next_entry().await.map_err(|source| {
        storage_error(
            "read history revert operation entry",
            operation_directory,
            source,
        )
    })? {
        let path = entry.path();
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| AppError::conflict("History revert operation entry name is not UTF-8"))?;
        let metadata = fs::symlink_metadata(&path).await.map_err(|source| {
            storage_error("inspect history revert operation entry", &path, source)
        })?;
        if name == HISTORY_MANIFEST_FILE || expected_payloads.contains(&name) {
            if !is_safe_regular_file(&metadata) {
                return Err(AppError::conflict(
                    "History revert operation contains an unsafe file",
                ));
            }
            if manifest.cleanup_complete && name != HISTORY_MANIFEST_FILE {
                return Err(AppError::conflict(
                    "Completed history revert operation retained snapshot payloads",
                ));
            }
            continue;
        }
        let Some(index) = name
            .strip_prefix("consumed-")
            .and_then(|value| value.parse::<usize>().ok())
        else {
            return Err(AppError::conflict(
                "History revert operation contains an unexpected entry",
            ));
        };
        if index >= manifest.transactions.len()
            || !metadata.file_type().is_dir()
            || metadata_is_link_or_reparse(&metadata)
            || !matches!(
                manifest.finalized_outcome,
                Some(PersistedWorkspaceOutcome::Committed { .. })
            )
        {
            return Err(AppError::conflict(
                "History revert transaction quarantine is invalid",
            ));
        }
    }
    Ok(())
}

async fn validate_quarantined_transaction_files(
    quarantine: &Path,
    transaction: &TransactionState,
) -> Result<(), AppError> {
    let mut expected = HashSet::<String>::from(["metadata.json".to_string()]);
    for record in transaction.files.values() {
        if let Some(backup_path) = record.backup_path.as_ref() {
            let name = backup_path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| AppError::conflict("Edit backup file name is invalid"))?;
            validate_backup_segment(name, "quarantined edit backup")?;
            expected.insert(name.to_string());
            let quarantined = quarantine.join(name);
            let contents = read_bounded_regular_file(
                &quarantined,
                MAX_HISTORY_SNAPSHOT_FILE_BYTES,
                "quarantined edit backup",
            )
            .await?;
            let EditTransactionFileVersion::File { sha256, size, .. } = &record.original else {
                return Err(AppError::conflict(
                    "Absent edit transaction original unexpectedly has a backup",
                ));
            };
            if contents.len() as u64 != *size || sha256_for(&contents) != *sha256 {
                return Err(AppError::conflict(
                    "Quarantined edit backup does not match transaction metadata",
                ));
            }
        }
    }
    let mut entries = fs::read_dir(quarantine)
        .await
        .map_err(|source| storage_error("read quarantined edit transaction", quarantine, source))?;
    while let Some(entry) = entries.next_entry().await.map_err(|source| {
        storage_error(
            "read quarantined edit transaction entry",
            quarantine,
            source,
        )
    })? {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| AppError::conflict("Quarantined edit transaction entry is not UTF-8"))?;
        let metadata = fs::symlink_metadata(entry.path()).await.map_err(|source| {
            storage_error(
                "inspect quarantined edit transaction entry",
                &entry.path(),
                source,
            )
        })?;
        if !expected.remove(&name) || !is_safe_regular_file(&metadata) {
            return Err(AppError::conflict(
                "Quarantined edit transaction contains an unexpected entry",
            ));
        }
    }
    if !expected.is_empty() {
        return Err(AppError::conflict(
            "Quarantined edit transaction is incomplete",
        ));
    }
    Ok(())
}

async fn persist_temporary_file_no_clobber(
    temporary: tempfile::NamedTempFile,
    target: &Path,
    mode: u32,
) -> Result<(), AppError> {
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let parent = target
            .parent()
            .ok_or_else(|| AppError::validation("History revert workspace path has no parent"))?;
        let persisted = temporary.persist_noclobber(&target).map_err(|source| {
            storage_error(
                "create restored history workspace file",
                &target,
                source.error,
            )
        })?;
        apply_mode_to_file(&persisted, &target, mode)?;
        persisted.sync_all().map_err(|source| {
            storage_error("sync restored history workspace file", &target, source)
        })?;
        sync_directory_blocking(parent, &target)
    })
    .await
    .map_err(|source| {
        AppError::internal(format!(
            "History revert no-clobber persist task failed: {source}"
        ))
    })?
}

async fn validate_direct_child_directory(
    parent: &Path,
    child: &Path,
    label: &str,
) -> Result<(), AppError> {
    ensure_direct_child(parent, child, label)?;
    inspect_safe_directory(parent, &format!("{label} parent")).await?;
    inspect_safe_directory(child, label).await?;
    let canonical_parent = canonicalize_safe_path(parent, &format!("{label} parent")).await?;
    let canonical_child = canonicalize_safe_path(child, label).await?;
    if !canonical_child
        .parent()
        .is_some_and(|candidate| paths_equal(candidate, &canonical_parent))
    {
        return Err(AppError::conflict(format!(
            "The {label} escapes its expected parent"
        )));
    }
    Ok(())
}

async fn validate_safe_directory(path: &Path, label: &str) -> Result<(), AppError> {
    inspect_safe_directory(path, label).await?;
    canonicalize_safe_path(path, label).await.map(|_| ())
}

fn ensure_direct_child(parent: &Path, child: &Path, label: &str) -> Result<(), AppError> {
    if child.parent() != Some(parent) {
        return Err(AppError::conflict(format!(
            "The {label} is not a direct child of its expected parent"
        )));
    }
    Ok(())
}

async fn discover_operation_directories(history_root: &Path) -> Result<Vec<PathBuf>, AppError> {
    validate_safe_directory(history_root, "history revert operation root").await?;
    let mut entries = fs::read_dir(history_root).await.map_err(|source| {
        storage_error("read history revert operation root", history_root, source)
    })?;
    let mut directories = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|source| {
        storage_error(
            "read history revert operation root entry",
            history_root,
            source,
        )
    })? {
        let path = entry.path();
        let name = entry.file_name().into_string().map_err(|_| {
            AppError::conflict("History revert operation directory name is not UTF-8")
        })?;
        validate_backup_segment(&name, "history operation")?;
        validate_direct_child_directory(history_root, &path, "history revert operation directory")
            .await?;
        directories.push(path);
    }
    directories.sort();
    Ok(directories)
}

async fn remove_partial_operation_contents(operation_directory: &Path) -> Result<(), AppError> {
    validate_safe_directory(operation_directory, "partial history operation directory").await?;
    let mut entries = fs::read_dir(operation_directory).await.map_err(|source| {
        storage_error(
            "read partial history operation directory",
            operation_directory,
            source,
        )
    })?;
    while let Some(entry) = entries.next_entry().await.map_err(|source| {
        storage_error(
            "read partial history operation entry",
            operation_directory,
            source,
        )
    })? {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).await.map_err(|source| {
            storage_error("inspect partial history operation entry", &path, source)
        })?;
        if !is_safe_regular_file(&metadata) {
            return Err(AppError::conflict(
                "Partial history operation contains an unsafe entry",
            ));
        }
        fs::remove_file(&path).await.map_err(|source| {
            storage_error("remove partial history operation entry", &path, source)
        })?;
    }
    sync_parent_directory(operation_directory, operation_directory).await
}

async fn remove_safe_regular_file_if_present(path: &Path, label: &str) -> Result<(), AppError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if is_safe_regular_file(&metadata) => {
            fs::remove_file(path)
                .await
                .map_err(|source| storage_error(&format!("remove {label}"), path, source))?;
            let parent = path.parent().ok_or_else(|| {
                AppError::validation(format!("The {label} has no parent directory"))
            })?;
            sync_parent_directory(parent, path).await
        }
        Ok(_) => Err(AppError::conflict(format!(
            "The {label} is not a safe regular file"
        ))),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(storage_error(&format!("inspect {label}"), path, source)),
    }
}

async fn remove_consumed_transaction_if_present(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path).await {
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(storage_error(
                "inspect consumed edit transaction",
                path,
                source,
            ));
        }
        Ok(metadata)
            if !metadata.file_type().is_dir() || metadata_is_link_or_reparse(&metadata) =>
        {
            return Err(AppError::conflict(
                "Consumed edit transaction quarantine is unsafe",
            ));
        }
        Ok(_) => {}
    }
    let mut entries = fs::read_dir(path)
        .await
        .map_err(|source| storage_error("read consumed edit transaction", path, source))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|source| storage_error("read consumed edit transaction entry", path, source))?
    {
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path).await.map_err(|source| {
            storage_error(
                "inspect consumed edit transaction entry",
                &entry_path,
                source,
            )
        })?;
        if !is_safe_regular_file(&metadata) {
            return Err(AppError::conflict(
                "Consumed edit transaction contains an unsafe entry",
            ));
        }
        fs::remove_file(&entry_path).await.map_err(|source| {
            storage_error(
                "remove consumed edit transaction entry",
                &entry_path,
                source,
            )
        })?;
    }
    drop(entries);
    fs::remove_dir(path)
        .await
        .map_err(|source| storage_error("remove consumed edit transaction", path, source))?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::validation("Consumed edit transaction has no operation parent"))?;
    sync_parent_directory(parent, path).await
}

async fn remove_completed_operation_directory(path: &Path) -> Result<(), AppError> {
    validate_safe_directory(path, "completed history operation directory").await?;
    let mut entries = fs::read_dir(path)
        .await
        .map_err(|source| storage_error("read completed history operation", path, source))?;
    let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|source| storage_error("read completed history operation entry", path, source))?
    else {
        return Err(AppError::conflict(
            "Completed history operation lost its manifest",
        ));
    };
    if entry.file_name() != HISTORY_MANIFEST_FILE
        || entries
            .next_entry()
            .await
            .map_err(|source| {
                storage_error("read completed history operation entry", path, source)
            })?
            .is_some()
    {
        return Err(AppError::conflict(
            "Completed history operation contains unexpected entries",
        ));
    }
    drop(entries);
    remove_safe_regular_file_if_present(&entry.path(), "completed history operation manifest")
        .await?;
    fs::remove_dir(path)
        .await
        .map_err(|source| storage_error("remove completed history operation", path, source))?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::validation("Completed history operation has no operation root"))?;
    sync_parent_directory(parent, path).await
}

async fn remove_empty_directory_if_present(path: &Path, label: &str) -> Result<(), AppError> {
    match fs::remove_dir(path).await {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                sync_parent_directory(parent, path).await?;
            }
            Ok(())
        }
        Err(source)
            if matches!(
                source.kind(),
                io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::NotFound
            ) =>
        {
            Ok(())
        }
        Err(source) => Err(storage_error(&format!("remove {label}"), path, source)),
    }
}

async fn path_exists(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(storage_error("inspect history revert path", path, source)),
    }
}

fn path_sort_key(path: &Path) -> String {
    #[cfg(windows)]
    {
        path.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use tokio::fs;
    use uuid::Uuid;

    use codez_core::{
        AppErrorKind, AppPaths, SessionId, StreamId, WorkspaceRoot, context::ContextScopeId,
    };

    use crate::{
        edit_transaction::{EditTransactionContentVersion, EditTransactionRegistration},
        history_revert::{
            HistoryRevertOperation, HistoryRevertRequest, HistoryRevertService,
            HistoryRevertWorkspace, HistoryRevertWorkspaceOutcome,
        },
    };

    use super::{
        EditTransactionService, HISTORY_MANIFEST_FILE, HISTORY_OPERATION_DIRECTORY, sha256_for,
    };

    struct Fixture {
        _temp: tempfile::TempDir,
        data_root: std::path::PathBuf,
        workspace: std::path::PathBuf,
    }

    impl Fixture {
        async fn new() -> Self {
            let temp = tempfile::tempdir().expect("temporary fixture directory must be created");
            let data_root = temp.path().join("data");
            let workspace = temp.path().join("workspace");
            fs::create_dir_all(&data_root)
                .await
                .expect("fixture data root must be created");
            fs::create_dir_all(&workspace)
                .await
                .expect("fixture workspace must be created");
            Self {
                _temp: temp,
                data_root,
                workspace,
            }
        }

        fn service(&self) -> Arc<EditTransactionService> {
            Arc::new(EditTransactionService::new(app_paths(&self.data_root)))
        }

        fn operation(&self, transaction_ids: Vec<String>) -> HistoryRevertOperation {
            let request = HistoryRevertRequest {
                session_id: session_id(),
                context_scope_id: ContextScopeId::Main,
                target_ui_message_id: "ui-history-target".to_string(),
                transaction_ids,
            };
            let operation_id = HistoryRevertService::operation_id(&request)
                .expect("fixture request must produce an operation ID");
            HistoryRevertOperation {
                operation_id,
                request,
            }
        }

        fn operation_directory(&self, operation: &HistoryRevertOperation) -> std::path::PathBuf {
            self.data_root
                .join("edit-backups")
                .join(HISTORY_OPERATION_DIRECTORY)
                .join(&operation.operation_id)
        }
    }

    #[tokio::test]
    async fn committed_revert_restores_existing_deletes_new_and_consumes_transaction() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let existing = fixture.workspace.join("existing.txt");
        let created = fixture.workspace.join("created.txt");
        stage_existing(
            &service,
            &transaction_id,
            &existing,
            b"original",
            b"mutation",
        )
        .await;
        stage_created(&service, &transaction_id, &created, b"created mutation").await;
        let operation = fixture.operation(vec![transaction_id.clone()]);

        service
            .prepare_backup(&operation)
            .await
            .expect("workspace snapshot must prepare");
        service
            .apply_revert(&operation)
            .await
            .expect("workspace revert must apply");

        assert_eq!(
            fs::read(&existing)
                .await
                .expect("restored existing file must be readable"),
            b"original"
        );
        assert!(
            !fs::try_exists(&created)
                .await
                .expect("created-file existence must be readable")
        );

        service
            .finalize_backup(
                &operation,
                HistoryRevertWorkspaceOutcome::Committed { history_version: 3 },
            )
            .await
            .expect("committed workspace snapshot must finalize");
        service
            .finalize_backup(
                &operation,
                HistoryRevertWorkspaceOutcome::Committed { history_version: 3 },
            )
            .await
            .expect("committed finalization retry must be idempotent");
        let missing = service
            .lookup_transaction_provenance(&transaction_id)
            .await
            .expect_err("committed transaction must be consumed");
        assert_eq!(missing.kind(), AppErrorKind::NotFound);

        service
            .cleanup_session_history_reverts(session_id().as_str())
            .await
            .expect("completed session snapshots must clean up");
        assert!(
            !fs::try_exists(fixture.operation_directory(&operation))
                .await
                .expect("operation-directory existence must be readable")
        );
    }

    #[tokio::test]
    async fn overlapping_transactions_apply_the_oldest_original_without_sequential_revert() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let path = fixture.workspace.join("overlap.txt");
        let created = fixture.workspace.join("overlap-created.txt");
        let older = register_transaction(&service, &fixture.workspace).await;
        stage_existing(&service, &older, &path, b"version-0", b"version-1").await;
        stage_created(&service, &older, &created, b"created-version-1").await;
        let newer = register_transaction(&service, &fixture.workspace).await;
        stage_existing(&service, &newer, &path, b"version-1", b"version-2").await;
        let operation = fixture.operation(vec![newer.clone(), older.clone()]);

        service
            .prepare_backup(&operation)
            .await
            .expect("overlapping snapshot must prepare");
        service
            .apply_revert(&operation)
            .await
            .expect("overlapping revert must apply directly");

        assert_eq!(
            fs::read(&path)
                .await
                .expect("overlapping target must be readable"),
            b"version-0"
        );
        assert!(
            !fs::try_exists(&created)
                .await
                .expect("overlapping created-file existence must be readable")
        );

        service
            .rollback_revert(&operation)
            .await
            .expect("stale overlapping revert must roll back");
        service
            .finalize_backup(
                &operation,
                HistoryRevertWorkspaceOutcome::RolledBackStale {
                    expected_history_version: 2,
                    actual_history_version: 3,
                },
            )
            .await
            .expect("rolled-back snapshot must finalize");

        assert_eq!(
            fs::read(&path)
                .await
                .expect("rolled-back pre-state must be readable"),
            b"version-2"
        );
        assert_eq!(
            fs::read(&created)
                .await
                .expect("rolled-back created file must be readable"),
            b"created-version-1"
        );
        service
            .lookup_transaction_provenance(&newer)
            .await
            .expect("stale finalization must retain newer transaction");
        service
            .lookup_transaction_provenance(&older)
            .await
            .expect("stale finalization must retain older transaction");
    }

    #[tokio::test]
    async fn restart_recovers_a_file_applied_before_its_phase_was_persisted() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let first = fixture.workspace.join("first.txt");
        let second = fixture.workspace.join("second.txt");
        stage_existing(&service, &transaction_id, &first, b"first-0", b"first-1").await;
        stage_existing(&service, &transaction_id, &second, b"second-0", b"second-1").await;
        let operation = fixture.operation(vec![transaction_id]);
        service
            .prepare_backup(&operation)
            .await
            .expect("partial-apply snapshot must prepare");
        fs::write(&first, b"first-0")
            .await
            .expect("simulated first-file effect must be written");
        drop(service);

        let restarted = fixture.service();
        restarted
            .apply_revert(&operation)
            .await
            .expect("restart must recognize and persist the first-file effect");

        assert_eq!(
            (
                fs::read(&first).await.expect("first file must be readable"),
                fs::read(&second)
                    .await
                    .expect("second file must be readable"),
            ),
            (b"first-0".to_vec(), b"second-0".to_vec())
        );
    }

    #[tokio::test]
    async fn rollback_conflict_retains_snapshot_until_external_change_is_resolved() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let path = fixture.workspace.join("rollback-conflict.txt");
        stage_existing(&service, &transaction_id, &path, b"original", b"mutation").await;
        let operation = fixture.operation(vec![transaction_id]);
        service
            .prepare_backup(&operation)
            .await
            .expect("rollback-conflict snapshot must prepare");
        service
            .apply_revert(&operation)
            .await
            .expect("rollback-conflict revert must apply");
        fs::write(&path, b"external")
            .await
            .expect("external conflict must be written");

        let error = service
            .rollback_revert(&operation)
            .await
            .expect_err("external change must block rollback");
        assert_eq!(error.kind(), AppErrorKind::Conflict);
        assert!(
            fs::try_exists(fixture.operation_directory(&operation))
                .await
                .expect("recovery snapshot existence must be readable")
        );

        fs::write(&path, b"original")
            .await
            .expect("verified target state must be restored");
        service
            .rollback_revert(&operation)
            .await
            .expect("rollback retry must restore the pre-revert state");
        assert_eq!(
            fs::read(&path)
                .await
                .expect("rolled-back mutation must be readable"),
            b"mutation"
        );
    }

    #[tokio::test]
    async fn committed_finalization_recovers_a_transaction_renamed_before_progress_persisted() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let first_transaction = register_transaction(&service, &fixture.workspace).await;
        let second_transaction = register_transaction(&service, &fixture.workspace).await;
        let first = fixture.workspace.join("consume-first.txt");
        let second = fixture.workspace.join("consume-second.txt");
        stage_existing(
            &service,
            &first_transaction,
            &first,
            b"first-original",
            b"first-mutation",
        )
        .await;
        stage_existing(
            &service,
            &second_transaction,
            &second,
            b"second-original",
            b"second-mutation",
        )
        .await;
        let operation =
            fixture.operation(vec![first_transaction.clone(), second_transaction.clone()]);
        service
            .prepare_backup(&operation)
            .await
            .expect("consume-recovery snapshot must prepare");
        service
            .apply_revert(&operation)
            .await
            .expect("consume-recovery revert must apply");
        let operation_directory = fixture.operation_directory(&operation);
        let mut manifest = service
            .require_workspace_manifest(&operation)
            .await
            .expect("consume-recovery manifest must load");
        manifest.phase = super::WorkspaceOperationPhase::FinalizingCommitted;
        manifest.finalized_outcome =
            Some(super::PersistedWorkspaceOutcome::Committed { history_version: 3 });
        service
            .persist_workspace_manifest(&operation_directory, &manifest)
            .await
            .expect("committed decision must persist before transaction rename");
        let transaction_directory = fixture
            .data_root
            .join("edit-backups")
            .join(session_id().as_str())
            .join(&first_transaction);
        fs::rename(
            &transaction_directory,
            operation_directory.join("consumed-0"),
        )
        .await
        .expect("simulated transaction quarantine must be renamed");
        drop(service);

        let restarted = fixture.service();
        restarted
            .finalize_backup(
                &operation,
                HistoryRevertWorkspaceOutcome::Committed { history_version: 3 },
            )
            .await
            .expect("committed transaction quarantine must recover");

        for transaction_id in [&first_transaction, &second_transaction] {
            let error = restarted
                .lookup_transaction_provenance(transaction_id)
                .await
                .expect_err("recovered committed transaction must be consumed");
            assert_eq!(error.kind(), AppErrorKind::NotFound);
        }
    }

    #[tokio::test]
    async fn committed_finalization_refuses_changed_workspace_before_consuming_transaction() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let path = fixture.workspace.join("commit-conflict.txt");
        stage_existing(&service, &transaction_id, &path, b"original", b"mutation").await;
        let operation = fixture.operation(vec![transaction_id.clone()]);
        service
            .prepare_backup(&operation)
            .await
            .expect("commit-conflict snapshot must prepare");
        service
            .apply_revert(&operation)
            .await
            .expect("commit-conflict revert must apply");
        fs::write(&path, b"external")
            .await
            .expect("external commit conflict must be written");

        let error = service
            .finalize_backup(
                &operation,
                HistoryRevertWorkspaceOutcome::Committed { history_version: 3 },
            )
            .await
            .expect_err("changed workspace must block transaction consumption");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        service
            .lookup_transaction_provenance(&transaction_id)
            .await
            .expect("blocked committed finalization must retain transaction");
    }

    #[tokio::test]
    async fn cleanup_rejects_an_unfinished_session_snapshot() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let path = fixture.workspace.join("pending-cleanup.txt");
        stage_existing(&service, &transaction_id, &path, b"original", b"mutation").await;
        let operation = fixture.operation(vec![transaction_id]);
        service
            .prepare_backup(&operation)
            .await
            .expect("pending cleanup snapshot must prepare");

        let error = service
            .cleanup_session_history_reverts(session_id().as_str())
            .await
            .expect_err("pending recovery evidence must not be deleted");

        assert_eq!(error.kind(), AppErrorKind::RunActive);
        assert!(
            fs::try_exists(fixture.operation_directory(&operation))
                .await
                .expect("pending operation existence must be readable")
        );
    }

    #[tokio::test]
    async fn manifest_path_escape_is_rejected_before_workspace_mutation() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let path = fixture.workspace.join("path-escape.txt");
        stage_existing(&service, &transaction_id, &path, b"original", b"mutation").await;
        let operation = fixture.operation(vec![transaction_id]);
        service
            .prepare_backup(&operation)
            .await
            .expect("path-escape snapshot must prepare");
        let manifest_path = fixture
            .operation_directory(&operation)
            .join(HISTORY_MANIFEST_FILE);
        let mut manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(&manifest_path)
                .await
                .expect("workspace manifest must be readable"),
        )
        .expect("workspace manifest must parse");
        manifest["files"][0]["path"] =
            serde_json::Value::String(fixture.data_root.join("outside.txt").display().to_string());
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).expect("tampered manifest must serialize"),
        )
        .await
        .expect("tampered manifest must be written");

        let error = fixture
            .service()
            .apply_revert(&operation)
            .await
            .expect_err("escaping manifest path must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
        assert_eq!(
            fs::read(&path)
                .await
                .expect("workspace mutation must remain readable"),
            b"mutation"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_snapshot_payload_is_rejected() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let path = fixture.workspace.join("symlink-payload.txt");
        stage_existing(&service, &transaction_id, &path, b"original", b"mutation").await;
        let operation = fixture.operation(vec![transaction_id]);
        service
            .prepare_backup(&operation)
            .await
            .expect("symlink snapshot must prepare");
        let operation_directory = fixture.operation_directory(&operation);
        let target_payload = operation_directory.join("target-0.bin");
        let external = fixture.data_root.join("external-payload.bin");
        fs::write(&external, b"original")
            .await
            .expect("external payload must be written");
        fs::remove_file(&target_payload)
            .await
            .expect("real target payload must be removed");
        symlink(&external, &target_payload).expect("payload symlink must be created");

        let error = fixture
            .service()
            .apply_revert(&operation)
            .await
            .expect_err("symlink snapshot payload must be rejected");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn apply_and_rollback_restore_recorded_file_modes() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let transaction_id = register_transaction(&service, &fixture.workspace).await;
        let path = fixture.workspace.join("mode.txt");
        fs::write(&path, b"original")
            .await
            .expect("mode fixture must be written");
        set_readonly(&path, true);
        service
            .backup_file(&transaction_id, &path, Some("original".to_string()))
            .await
            .expect("readonly original must be backed up");
        let intended = content_version(b"mutation");
        service
            .prepare_mutation(&transaction_id, &path, intended.clone())
            .await
            .expect("mode mutation must prepare");
        set_readonly(&path, false);
        fs::write(&path, b"mutation")
            .await
            .expect("mode mutation must be written");
        service
            .record_verified_mutation(&transaction_id, path.clone(), &intended)
            .await
            .expect("mode mutation must be recorded");
        let operation = fixture.operation(vec![transaction_id]);

        service
            .prepare_backup(&operation)
            .await
            .expect("mode snapshot must prepare");
        service
            .apply_revert(&operation)
            .await
            .expect("mode revert must apply");
        assert!(
            std::fs::metadata(&path)
                .expect("restored mode metadata must be readable")
                .permissions()
                .readonly()
        );

        service
            .rollback_revert(&operation)
            .await
            .expect("mode rollback must apply");
        assert!(
            !std::fs::metadata(&path)
                .expect("rolled-back mode metadata must be readable")
                .permissions()
                .readonly()
        );
    }

    fn app_paths(data_root: &Path) -> Arc<AppPaths> {
        Arc::new(
            AppPaths::new(
                data_root.to_path_buf(),
                data_root.to_path_buf(),
                data_root.to_path_buf(),
                data_root.to_path_buf(),
                data_root.to_path_buf(),
                data_root.to_path_buf(),
            )
            .expect("fixture application paths must be absolute"),
        )
    }

    fn session_id() -> SessionId {
        SessionId::parse("session-history-workspace")
            .expect("fixture session identifier must be valid")
    }

    async fn register_transaction(service: &EditTransactionService, workspace: &Path) -> String {
        let transaction_id = Uuid::new_v4().to_string();
        let workspace_root = WorkspaceRoot::from_canonical(
            dunce::canonicalize(workspace).expect("fixture workspace must canonicalize"),
        )
        .expect("fixture workspace root must be valid");
        service
            .register_chat_transaction(
                &transaction_id,
                EditTransactionRegistration {
                    session_id: session_id(),
                    context_scope_id: ContextScopeId::Main,
                    turn_id: StreamId::parse(format!("turn-{transaction_id}"))
                        .expect("fixture turn identifier must be valid"),
                    workspace_root,
                },
            )
            .await
            .expect("fixture transaction must register");
        transaction_id
    }

    async fn stage_existing(
        service: &EditTransactionService,
        transaction_id: &str,
        path: &Path,
        original: &[u8],
        mutation: &[u8],
    ) {
        fs::write(path, original)
            .await
            .expect("fixture original must be written");
        service
            .backup_file(
                transaction_id,
                path,
                Some(String::from_utf8(original.to_vec()).expect("fixture must be UTF-8")),
            )
            .await
            .expect("fixture original must be backed up");
        let intended = content_version(mutation);
        service
            .prepare_mutation(transaction_id, path, intended.clone())
            .await
            .expect("fixture mutation must prepare");
        fs::write(path, mutation)
            .await
            .expect("fixture mutation must be written");
        service
            .record_verified_mutation(transaction_id, path.to_path_buf(), &intended)
            .await
            .expect("fixture mutation must be recorded");
    }

    async fn stage_created(
        service: &EditTransactionService,
        transaction_id: &str,
        path: &Path,
        mutation: &[u8],
    ) {
        service
            .backup_file(transaction_id, path, None)
            .await
            .expect("fixture absent original must be staged");
        let intended = content_version(mutation);
        service
            .prepare_mutation(transaction_id, path, intended.clone())
            .await
            .expect("fixture created-file mutation must prepare");
        fs::write(path, mutation)
            .await
            .expect("fixture created file must be written");
        service
            .record_verified_mutation(transaction_id, path.to_path_buf(), &intended)
            .await
            .expect("fixture created-file mutation must be recorded");
    }

    fn content_version(bytes: &[u8]) -> EditTransactionContentVersion {
        EditTransactionContentVersion {
            sha256: sha256_for(bytes),
            size: bytes.len() as u64,
        }
    }

    #[cfg(windows)]
    fn set_readonly(path: &Path, readonly: bool) {
        let mut permissions = std::fs::metadata(path)
            .expect("fixture mode metadata must be readable")
            .permissions();
        permissions.set_readonly(readonly);
        std::fs::set_permissions(path, permissions).expect("fixture readonly mode must be set");
    }

    #[cfg(unix)]
    fn set_readonly(path: &Path, readonly: bool) {
        use std::os::unix::fs::PermissionsExt;

        let mode = if readonly { 0o444 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .expect("fixture mode must be set");
    }
}
