//! Crash-recoverable coordination of workspace and context-history reverts.

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;

use codez_core::{
    AppError, AtomicCreateOutcome, AtomicPersistence, SessionId,
    context::{ContextScopeId, HistoryRevertedPayload, LedgerAppendRequest, LedgerEventType},
};

use crate::context::ledger::{LedgerError, ModelLedgerStore};

const JOURNAL_DIRECTORY: &str = "history-reverts";
const JOURNAL_SCHEMA_VERSION: u16 = 1;
const OPERATION_ID_PREFIX: &str = "history-revert-";
const MAX_JOURNAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_TARGET_ID_BYTES: usize = 1024;
const MAX_TRANSACTION_ID_BYTES: usize = 512;
const MAX_TRANSACTION_COUNT: usize = 4096;

/// Stable boundary codes emitted by [`HistoryRevertService`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryRevertErrorCode {
    Validation,
    HistoryRevertStale,
    RecoveryRequired,
}

impl HistoryRevertErrorCode {
    /// Returns the wire spelling expected by desktop adapters.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Validation => "VALIDATION",
            Self::HistoryRevertStale => "HISTORY_REVERT_STALE",
            Self::RecoveryRequired => "RECOVERY_REQUIRED",
        }
    }
}

/// Durable phases of a successful history revert operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRevertPhase {
    Prepared,
    WorkspaceApplied,
    LedgerCommitted,
    Finalized,
}

impl HistoryRevertPhase {
    const fn label(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::WorkspaceApplied => "workspace_applied",
            Self::LedgerCommitted => "ledger_committed",
            Self::Finalized => "finalized",
        }
    }
}

/// Typed failures retained through the desktop boundary.
#[derive(Debug, Error)]
pub enum HistoryRevertError {
    #[error("invalid history revert request: {message}")]
    InvalidRequest { message: String },
    #[error("history revert could not be planned")]
    Planning {
        #[source]
        source: AppError,
    },
    #[error(
        "history revert {operation_id} is stale: expected history version {expected}, found {actual}"
    )]
    Stale {
        operation_id: String,
        expected: u32,
        actual: u32,
    },
    #[error("history revert {operation_id} requires recovery after {action} in phase {phase:?}")]
    RecoveryRequired {
        operation_id: String,
        session_id: String,
        phase: HistoryRevertPhase,
        action: &'static str,
        #[source]
        source: AppError,
    },
    #[error("history revert recovery catalog requires repair while attempting to {action}")]
    RecoveryCatalog {
        action: &'static str,
        #[source]
        source: AppError,
    },
}

impl HistoryRevertError {
    /// Returns the stable code an adapter should serialize.
    #[must_use]
    pub const fn code(&self) -> HistoryRevertErrorCode {
        match self {
            Self::InvalidRequest { .. } | Self::Planning { .. } => {
                HistoryRevertErrorCode::Validation
            }
            Self::Stale { .. } => HistoryRevertErrorCode::HistoryRevertStale,
            Self::RecoveryRequired { .. } | Self::RecoveryCatalog { .. } => {
                HistoryRevertErrorCode::RecoveryRequired
            }
        }
    }

    /// Returns the affected session when it can be trusted from a validated journal.
    #[must_use]
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::RecoveryRequired { session_id, .. } => Some(session_id),
            _ => None,
        }
    }
}

impl From<HistoryRevertError> for AppError {
    fn from(error: HistoryRevertError) -> Self {
        match error {
            HistoryRevertError::InvalidRequest { message } => AppError::validation(message),
            HistoryRevertError::Planning { source } => source,
            HistoryRevertError::Stale {
                operation_id,
                expected,
                actual,
            } => AppError::conflict(format!(
                "History revert {operation_id} is stale: expected version {expected}, found {actual}"
            )),
            HistoryRevertError::RecoveryRequired {
                operation_id,
                phase,
                action,
                source,
                ..
            } => AppError::run_active(format!(
                "History revert {operation_id} requires recovery after {action} in phase {}: {}",
                phase.label(),
                source.public_message()
            )),
            HistoryRevertError::RecoveryCatalog { action, source } => AppError::storage(
                "History revert recovery data requires repair",
                format!("{action}: {source}"),
                false,
            ),
        }
    }
}

/// Immutable request used to derive a stable history-revert operation identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRevertRequest {
    pub session_id: SessionId,
    pub context_scope_id: ContextScopeId,
    pub target_ui_message_id: String,
    pub transaction_ids: Vec<String>,
}

/// Identity supplied to the workspace adapter for every idempotent phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRevertOperation {
    pub operation_id: String,
    pub request: HistoryRevertRequest,
}

/// Successful result retained by the finalized journal for idempotent retries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRevertResult {
    pub operation_id: String,
    pub history_version: u32,
}

/// One durable operation that startup recovery must finish before the session is released.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingHistoryRevert {
    pub operation_id: String,
    pub session_id: SessionId,
    pub phase: HistoryRevertPhase,
}

/// Terminal decision the workspace adapter must finalize without inspecting mutable files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryRevertWorkspaceOutcome {
    /// The ledger accepted the revert; operation backups and consumed edit records may be removed.
    Committed { history_version: u32 },
    /// The ledger rejected a stale plan; only the operation backup may be removed.
    RolledBackStale {
        expected_history_version: u32,
        actual_history_version: u32,
    },
}

/// Workspace-side transaction contract used by the recovery state machine.
///
/// Every method must be idempotent for one `operation_id`. `prepare_backup` must durably preserve
/// the exact pre-revert workspace state. `apply_revert` must never delete that backup.
/// `rollback_revert` restores it after a stale ledger decision. `finalize_backup` may remove the
/// operation payload only after the service has durably recorded a terminal decision, and must
/// succeed when cleanup was already completed before a crash. A committed outcome also consumes
/// the original edit-transaction records; a stale outcome must retain those records.
#[async_trait]
pub trait HistoryRevertWorkspace: Send + Sync {
    async fn prepare_backup(&self, operation: &HistoryRevertOperation) -> Result<(), AppError>;
    async fn apply_revert(&self, operation: &HistoryRevertOperation) -> Result<(), AppError>;
    async fn rollback_revert(&self, operation: &HistoryRevertOperation) -> Result<(), AppError>;
    async fn finalize_backup(
        &self,
        operation: &HistoryRevertOperation,
        outcome: HistoryRevertWorkspaceOutcome,
    ) -> Result<(), AppError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
enum FinalizedOutcome {
    Reverted { history_version: u32 },
    Stale { actual_history_version: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PersistedRequest {
    session_id: String,
    context_scope_id: ContextScopeId,
    target_ui_message_id: String,
    transaction_ids: Vec<String>,
}

impl From<&HistoryRevertRequest> for PersistedRequest {
    fn from(request: &HistoryRevertRequest) -> Self {
        Self {
            session_id: request.session_id.as_str().to_string(),
            context_scope_id: request.context_scope_id.clone(),
            target_ui_message_id: request.target_ui_message_id.clone(),
            transaction_ids: request.transaction_ids.clone(),
        }
    }
}

impl TryFrom<&PersistedRequest> for HistoryRevertRequest {
    type Error = HistoryRevertError;

    fn try_from(request: &PersistedRequest) -> Result<Self, Self::Error> {
        let session_id = SessionId::parse(request.session_id.clone()).map_err(|source| {
            HistoryRevertError::InvalidRequest {
                message: format!("persisted session identifier is invalid: {source}"),
            }
        })?;
        let request = Self {
            session_id,
            context_scope_id: request.context_scope_id.clone(),
            target_ui_message_id: request.target_ui_message_id.clone(),
            transaction_ids: request.transaction_ids.clone(),
        };
        validate_request(&request)?;
        Ok(request)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct HistoryRevertJournal {
    schema_version: u16,
    operation_id: String,
    request: PersistedRequest,
    expected_history_version: u32,
    payload: HistoryRevertedPayload,
    phase: HistoryRevertPhase,
    finalized_outcome: Option<FinalizedOutcome>,
    cleanup_complete: bool,
    created_at: String,
    updated_at: String,
}

impl HistoryRevertJournal {
    fn operation(&self) -> Result<HistoryRevertOperation, HistoryRevertError> {
        Ok(HistoryRevertOperation {
            operation_id: self.operation_id.clone(),
            request: HistoryRevertRequest::try_from(&self.request)?,
        })
    }
}

enum ResumeOutcome {
    Reverted(HistoryRevertResult),
    Stale { expected: u32, actual: u32 },
}

/// Coordinates a revert across workspace files and the append-only model ledger.
pub struct HistoryRevertService {
    journal_directory: PathBuf,
    data_directory: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    ledger: Arc<ModelLedgerStore>,
    workspace: Arc<dyn HistoryRevertWorkspace>,
    operation_locks: DashMap<String, Arc<Mutex<()>>>,
}

impl HistoryRevertService {
    /// Creates a service rooted at `<data-directory>/history-reverts`.
    #[must_use]
    pub fn new(
        data_directory: impl AsRef<Path>,
        persistence: Arc<dyn AtomicPersistence>,
        ledger: Arc<ModelLedgerStore>,
        workspace: Arc<dyn HistoryRevertWorkspace>,
    ) -> Self {
        let data_directory = data_directory.as_ref().to_path_buf();
        Self {
            journal_directory: data_directory.join(JOURNAL_DIRECTORY),
            data_directory,
            persistence,
            ledger,
            workspace,
            operation_locks: DashMap::new(),
        }
    }

    /// Derives the same operation identity for every retry of an identical request.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryRevertError::InvalidRequest`] when an identifier is empty or oversized,
    /// transaction identities are duplicated, or the request is unreasonably large.
    pub fn operation_id(request: &HistoryRevertRequest) -> Result<String, HistoryRevertError> {
        validate_request(request)?;
        let mut digest = Sha256::new();
        update_digest_field(&mut digest, b"codez-history-revert-v1");
        update_digest_field(&mut digest, request.session_id.as_str().as_bytes());
        let scope = request.context_scope_id.as_key();
        update_digest_field(&mut digest, scope.as_bytes());
        update_digest_field(&mut digest, request.target_ui_message_id.as_bytes());
        for transaction_id in &request.transaction_ids {
            update_digest_field(&mut digest, transaction_id.as_bytes());
        }
        Ok(format!(
            "{OPERATION_ID_PREFIX}{}",
            hex::encode(digest.finalize())
        ))
    }

    /// Executes or resumes one history revert.
    ///
    /// The caller must hold the session maintenance lease until this future resolves. A
    /// [`HistoryRevertError::RecoveryRequired`] means the lease must be converted into a durable
    /// recovery block before being released.
    ///
    /// # Errors
    ///
    /// Returns a typed validation/planning error before mutation, `HISTORY_REVERT_STALE` after a
    /// successful workspace rollback, or `RECOVERY_REQUIRED` while durable repair remains pending.
    pub async fn execute(
        &self,
        request: HistoryRevertRequest,
    ) -> Result<HistoryRevertResult, HistoryRevertError> {
        let operation_id = Self::operation_id(&request)?;
        let operation_lock = self
            .operation_locks
            .entry(operation_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _operation_guard = operation_lock.lock().await;
        let journal = match self.load_journal(&operation_id).await? {
            Some(journal) => journal,
            None => self.prepare_journal(operation_id.clone(), &request).await?,
        };
        if journal.request != PersistedRequest::from(&request) {
            return Err(self.recovery_error(
                &journal,
                "validate operation request",
                journal_integrity_error(
                    self.journal_path(&operation_id),
                    "operation identity was reused for a different request",
                ),
            ));
        }

        match self.resume_journal(journal).await? {
            ResumeOutcome::Reverted(result) => Ok(result),
            ResumeOutcome::Stale { expected, actual } => Err(HistoryRevertError::Stale {
                operation_id,
                expected,
                actual,
            }),
        }
    }

    /// Lists operations that must hold a persistent session recovery block.
    ///
    /// # Errors
    ///
    /// Returns `RECOVERY_REQUIRED` when the journal directory or any entry is unsafe or corrupt.
    pub async fn pending_recoveries(
        &self,
    ) -> Result<Vec<PendingHistoryRevert>, HistoryRevertError> {
        let mut pending = Vec::new();
        for path in self.discover_journal_paths().await? {
            let journal = self.load_journal_path(&path).await?;
            if journal.phase == HistoryRevertPhase::Finalized && journal.cleanup_complete {
                continue;
            }
            let operation = journal.operation().map_err(|error| {
                self.catalog_error(
                    "validate pending operation",
                    journal_integrity_error(path.clone(), error.to_string()),
                )
            })?;
            pending.push(PendingHistoryRevert {
                operation_id: operation.operation_id,
                session_id: operation.request.session_id,
                phase: journal.phase,
            });
        }
        pending.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
        Ok(pending)
    }

    /// Recovers every unfinished journal entry.
    ///
    /// The application must establish persistent recovery blocks for
    /// [`Self::pending_recoveries`] before invoking this method. Stale operations are considered
    /// successfully recovered after their workspace rollback and cleanup finish.
    ///
    /// # Errors
    ///
    /// Returns `RECOVERY_REQUIRED` while any operation cannot reach a terminal clean state.
    pub async fn recover_pending(&self) -> Result<Vec<HistoryRevertResult>, HistoryRevertError> {
        let pending = self.pending_recoveries().await?;
        let mut recovered = Vec::new();
        for item in pending {
            let operation_lock = self
                .operation_locks
                .entry(item.operation_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone();
            let _operation_guard = operation_lock.lock().await;
            let journal = self
                .load_journal(&item.operation_id)
                .await?
                .ok_or_else(|| {
                    self.catalog_error(
                        "reload pending operation",
                        journal_integrity_error(
                            self.journal_path(&item.operation_id),
                            "journal disappeared during recovery",
                        ),
                    )
                })?;
            if let ResumeOutcome::Reverted(result) = self.resume_journal(journal).await? {
                recovered.push(result);
            }
        }
        Ok(recovered)
    }

    /// Removes completed journals for one deleted session without touching other sessions.
    ///
    /// The caller must hold the session deletion maintenance lease. Every journal is validated
    /// before the first removal, so pending or corrupt recovery evidence is retained intact.
    ///
    /// # Errors
    ///
    /// Returns `RECOVERY_REQUIRED` when a matching operation is unfinished or any journal entry
    /// is unsafe or corrupt, and when durable removal cannot be confirmed.
    pub async fn cleanup_session(&self, session_id: &SessionId) -> Result<(), HistoryRevertError> {
        let mut completed = Vec::new();
        for path in self.discover_journal_paths().await? {
            let journal = self.load_journal_path(&path).await?;
            if journal.request.session_id != session_id.as_str() {
                continue;
            }
            if journal.phase != HistoryRevertPhase::Finalized || !journal.cleanup_complete {
                return Err(self.recovery_error(
                    &journal,
                    "delete session history journal",
                    AppError::run_active("History revert recovery is still pending"),
                ));
            }
            completed.push((path, journal));
        }

        for (path, journal) in completed {
            let operation_lock = self
                .operation_locks
                .entry(journal.operation_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone();
            let _operation_guard = operation_lock.lock().await;
            let current = self.load_journal_path(&path).await?;
            if current != journal {
                return Err(self.recovery_error(
                    &current,
                    "revalidate session history journal",
                    journal_integrity_error(
                        path,
                        "journal changed while session cleanup was waiting",
                    ),
                ));
            }
            let removed = self.persistence.remove(&path).await.map_err(|source| {
                self.recovery_error(&journal, "remove session history journal", source)
            })?;
            if !removed {
                return Err(self.recovery_error(
                    &journal,
                    "confirm session history journal removal",
                    journal_integrity_error(path, "journal disappeared before durable removal"),
                ));
            }
        }
        self.remove_empty_journal_directory().await
    }

    async fn prepare_journal(
        &self,
        operation_id: String,
        request: &HistoryRevertRequest,
    ) -> Result<HistoryRevertJournal, HistoryRevertError> {
        let plan = self
            .ledger
            .plan_history_revert(
                &request.session_id,
                &request.context_scope_id,
                &request.target_ui_message_id,
            )
            .await
            .map_err(|source| HistoryRevertError::Planning { source })?;
        let now = now_timestamp();
        let journal = HistoryRevertJournal {
            schema_version: JOURNAL_SCHEMA_VERSION,
            operation_id: operation_id.clone(),
            request: PersistedRequest::from(request),
            expected_history_version: plan.expected_history_version,
            payload: plan.payload,
            phase: HistoryRevertPhase::Prepared,
            finalized_outcome: None,
            cleanup_complete: false,
            created_at: now.clone(),
            updated_at: now,
        };
        validate_journal(&journal).map_err(|message| {
            self.catalog_error(
                "validate prepared operation",
                journal_integrity_error(self.journal_path(&operation_id), message),
            )
        })?;
        let bytes = serialize_journal(&self.journal_path(&operation_id), &journal)
            .map_err(|source| self.catalog_error("serialize prepared operation", source))?;
        let path = self.journal_path(&operation_id);
        match self.persistence.create_no_clobber(&path, &bytes).await {
            Ok(AtomicCreateOutcome::Created | AtomicCreateOutcome::Reused) => {}
            Err(source) => {
                return Err(self.catalog_error("persist prepared operation", source));
            }
        }
        self.load_journal(&operation_id).await?.ok_or_else(|| {
            self.catalog_error(
                "confirm prepared operation",
                journal_integrity_error(path, "journal was not readable after durable creation"),
            )
        })
    }

    async fn resume_journal(
        &self,
        mut journal: HistoryRevertJournal,
    ) -> Result<ResumeOutcome, HistoryRevertError> {
        let operation = journal
            .operation()
            .map_err(|source| self.recovery_error_from_message(&journal, "load request", source))?;
        loop {
            match journal.phase {
                HistoryRevertPhase::Prepared => {
                    self.workspace
                        .prepare_backup(&operation)
                        .await
                        .map_err(|source| {
                            self.recovery_error(&journal, "prepare workspace backup", source)
                        })?;
                    self.workspace
                        .apply_revert(&operation)
                        .await
                        .map_err(|source| {
                            self.recovery_error(&journal, "apply workspace revert", source)
                        })?;
                    self.transition(&mut journal, HistoryRevertPhase::WorkspaceApplied)
                        .await?;
                }
                HistoryRevertPhase::WorkspaceApplied => {
                    match self.commit_ledger(&journal, &operation).await {
                        Ok(history_version) => {
                            journal.finalized_outcome = None;
                            journal.cleanup_complete = false;
                            self.transition_with_history_version(
                                &mut journal,
                                HistoryRevertPhase::LedgerCommitted,
                                history_version,
                            )
                            .await?;
                        }
                        Err(LedgerCommitFailure::Stale { actual }) => {
                            self.workspace
                                .rollback_revert(&operation)
                                .await
                                .map_err(|source| {
                                    self.recovery_error(
                                        &journal,
                                        "rollback stale workspace revert",
                                        source,
                                    )
                                })?;
                            let expected = journal.expected_history_version;
                            journal.phase = HistoryRevertPhase::Finalized;
                            journal.finalized_outcome = Some(FinalizedOutcome::Stale {
                                actual_history_version: actual,
                            });
                            journal.cleanup_complete = false;
                            journal.updated_at = now_timestamp();
                            self.persist_existing(&journal, HistoryRevertPhase::WorkspaceApplied)
                                .await?;
                            self.finish_cleanup(&mut journal, &operation).await?;
                            return Ok(ResumeOutcome::Stale { expected, actual });
                        }
                        Err(LedgerCommitFailure::Failed(source)) => {
                            return Err(self.recovery_error(
                                &journal,
                                "commit history ledger",
                                AppError::from(source),
                            ));
                        }
                    }
                }
                HistoryRevertPhase::LedgerCommitted => {
                    let history_version = journal_history_version(&journal).map_err(|message| {
                        self.recovery_error(
                            &journal,
                            "validate committed result",
                            journal_integrity_error(
                                self.journal_path(&journal.operation_id),
                                message,
                            ),
                        )
                    })?;
                    journal.phase = HistoryRevertPhase::Finalized;
                    journal.finalized_outcome =
                        Some(FinalizedOutcome::Reverted { history_version });
                    journal.cleanup_complete = false;
                    journal.updated_at = now_timestamp();
                    self.persist_existing(&journal, HistoryRevertPhase::LedgerCommitted)
                        .await?;
                }
                HistoryRevertPhase::Finalized => {
                    if !journal.cleanup_complete {
                        self.finish_cleanup(&mut journal, &operation).await?;
                    }
                    return finalized_result(&journal);
                }
            }
        }
    }

    async fn commit_ledger(
        &self,
        journal: &HistoryRevertJournal,
        operation: &HistoryRevertOperation,
    ) -> Result<u32, LedgerCommitFailure> {
        let payload = serde_json::to_value(&journal.payload).map_err(|source| {
            LedgerCommitFailure::Failed(LedgerError::Persistence(AppError::internal(format!(
                "serialize history revert payload: {source}"
            ))))
        })?;
        let request = LedgerAppendRequest {
            event_id: operation.operation_id.clone(),
            session_id: operation.request.session_id.as_str().to_string(),
            context_scope_id: operation.request.context_scope_id.clone(),
            turn_id: None,
            created_at: journal.created_at.clone(),
            r#type: LedgerEventType::HistoryReverted,
            payload,
        };
        match self
            .ledger
            .append_event_if_history_version(
                &operation.request.session_id,
                journal.expected_history_version,
                request,
            )
            .await
        {
            Ok(event) => Ok(event.history_version),
            Err(LedgerError::HistoryVersionConflict { actual, .. }) => {
                Err(LedgerCommitFailure::Stale { actual })
            }
            Err(source) => Err(LedgerCommitFailure::Failed(source)),
        }
    }

    async fn finish_cleanup(
        &self,
        journal: &mut HistoryRevertJournal,
        operation: &HistoryRevertOperation,
    ) -> Result<(), HistoryRevertError> {
        let outcome = workspace_outcome(journal).map_err(|message| {
            self.recovery_error(
                journal,
                "validate workspace finalization outcome",
                journal_integrity_error(self.journal_path(&journal.operation_id), message),
            )
        })?;
        self.workspace
            .finalize_backup(operation, outcome)
            .await
            .map_err(|source| self.recovery_error(journal, "finalize workspace backup", source))?;
        journal.cleanup_complete = true;
        journal.updated_at = now_timestamp();
        self.persist_existing(journal, HistoryRevertPhase::Finalized)
            .await
    }

    async fn transition(
        &self,
        journal: &mut HistoryRevertJournal,
        phase: HistoryRevertPhase,
    ) -> Result<(), HistoryRevertError> {
        let previous = journal.phase;
        journal.phase = phase;
        journal.updated_at = now_timestamp();
        self.persist_existing(journal, previous).await
    }

    async fn transition_with_history_version(
        &self,
        journal: &mut HistoryRevertJournal,
        phase: HistoryRevertPhase,
        history_version: u32,
    ) -> Result<(), HistoryRevertError> {
        journal.phase = phase;
        journal.finalized_outcome = Some(FinalizedOutcome::Reverted { history_version });
        journal.updated_at = now_timestamp();
        self.persist_existing(journal, HistoryRevertPhase::WorkspaceApplied)
            .await
    }

    async fn persist_existing(
        &self,
        journal: &HistoryRevertJournal,
        durable_phase: HistoryRevertPhase,
    ) -> Result<(), HistoryRevertError> {
        validate_journal(journal).map_err(|message| {
            self.recovery_error(
                journal,
                "validate journal transition",
                journal_integrity_error(self.journal_path(&journal.operation_id), message),
            )
        })?;
        let path = self.journal_path(&journal.operation_id);
        let bytes = serialize_journal(&path, journal).map_err(|source| {
            self.recovery_error(journal, "serialize journal transition", source)
        })?;
        self.persistence
            .replace(&path, &bytes)
            .await
            .map_err(|source| HistoryRevertError::RecoveryRequired {
                operation_id: journal.operation_id.clone(),
                session_id: journal.request.session_id.clone(),
                phase: durable_phase,
                action: "persist journal transition",
                source,
            })
    }

    async fn load_journal(
        &self,
        operation_id: &str,
    ) -> Result<Option<HistoryRevertJournal>, HistoryRevertError> {
        validate_operation_id(operation_id)
            .map_err(|message| HistoryRevertError::InvalidRequest { message })?;
        let path = self.journal_path(operation_id);
        let Some(bytes) = self
            .persistence
            .read(&path)
            .await
            .map_err(|source| self.catalog_error("read operation journal", source))?
        else {
            return Ok(None);
        };
        self.parse_journal(&path, &bytes).map(Some)
    }

    async fn load_journal_path(
        &self,
        path: &Path,
    ) -> Result<HistoryRevertJournal, HistoryRevertError> {
        let bytes = self
            .persistence
            .read(path)
            .await
            .map_err(|source| self.catalog_error("read recovery journal", source))?
            .ok_or_else(|| {
                self.catalog_error(
                    "read recovery journal",
                    journal_integrity_error(path.to_path_buf(), "journal disappeared"),
                )
            })?;
        self.parse_journal(path, &bytes)
    }

    fn parse_journal(
        &self,
        path: &Path,
        bytes: &[u8],
    ) -> Result<HistoryRevertJournal, HistoryRevertError> {
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(self.catalog_error(
                "bound recovery journal",
                journal_integrity_error(path.to_path_buf(), "journal exceeds the size limit"),
            ));
        }
        let journal: HistoryRevertJournal = serde_json::from_slice(bytes).map_err(|source| {
            self.catalog_error(
                "parse recovery journal",
                journal_integrity_error(path.to_path_buf(), source.to_string()),
            )
        })?;
        let expected_file_name = format!("{}.json", journal.operation_id);
        if path.file_name().and_then(|name| name.to_str()) != Some(expected_file_name.as_str()) {
            return Err(self.catalog_error(
                "validate recovery journal identity",
                journal_integrity_error(
                    path.to_path_buf(),
                    "journal operation ID does not match its file name",
                ),
            ));
        }
        validate_journal(&journal).map_err(|message| {
            self.catalog_error(
                "validate recovery journal",
                journal_integrity_error(path.to_path_buf(), message),
            )
        })?;
        Ok(journal)
    }

    async fn discover_journal_paths(&self) -> Result<Vec<PathBuf>, HistoryRevertError> {
        let data_directory = self.data_directory.clone();
        let journal_directory = self.journal_directory.clone();
        tokio::task::spawn_blocking(move || {
            discover_journal_paths_blocking(&data_directory, &journal_directory)
        })
        .await
        .map_err(|source| {
            self.catalog_error(
                "join recovery discovery",
                AppError::internal(format!("history revert discovery task failed: {source}")),
            )
        })?
        .map_err(|source| self.catalog_error("discover pending operations", source))
    }

    async fn remove_empty_journal_directory(&self) -> Result<(), HistoryRevertError> {
        let data_directory = self.data_directory.clone();
        let journal_directory = self.journal_directory.clone();
        tokio::task::spawn_blocking(move || {
            remove_empty_journal_directory_blocking(&data_directory, &journal_directory)
        })
        .await
        .map_err(|source| {
            self.catalog_error(
                "join recovery journal cleanup",
                AppError::internal(format!(
                    "history revert journal cleanup task failed: {source}"
                )),
            )
        })?
        .map_err(|source| self.catalog_error("remove empty recovery journal", source))
    }

    fn journal_path(&self, operation_id: &str) -> PathBuf {
        self.journal_directory.join(format!("{operation_id}.json"))
    }

    fn recovery_error(
        &self,
        journal: &HistoryRevertJournal,
        action: &'static str,
        source: AppError,
    ) -> HistoryRevertError {
        HistoryRevertError::RecoveryRequired {
            operation_id: journal.operation_id.clone(),
            session_id: journal.request.session_id.clone(),
            phase: journal.phase,
            action,
            source,
        }
    }

    fn recovery_error_from_message(
        &self,
        journal: &HistoryRevertJournal,
        action: &'static str,
        source: HistoryRevertError,
    ) -> HistoryRevertError {
        self.recovery_error(
            journal,
            action,
            journal_integrity_error(self.journal_path(&journal.operation_id), source.to_string()),
        )
    }

    fn catalog_error(&self, action: &'static str, source: AppError) -> HistoryRevertError {
        HistoryRevertError::RecoveryCatalog { action, source }
    }
}

enum LedgerCommitFailure {
    Stale { actual: u32 },
    Failed(LedgerError),
}

fn validate_request(request: &HistoryRevertRequest) -> Result<(), HistoryRevertError> {
    validate_bounded_identifier(
        &request.target_ui_message_id,
        "target UI message",
        MAX_TARGET_ID_BYTES,
    )?;
    if request.transaction_ids.len() > MAX_TRANSACTION_COUNT {
        return Err(HistoryRevertError::InvalidRequest {
            message: format!(
                "history revert has more than {MAX_TRANSACTION_COUNT} edit transactions"
            ),
        });
    }
    let mut unique = HashSet::with_capacity(request.transaction_ids.len());
    for transaction_id in &request.transaction_ids {
        validate_bounded_identifier(transaction_id, "edit transaction", MAX_TRANSACTION_ID_BYTES)?;
        if !unique.insert(transaction_id) {
            return Err(HistoryRevertError::InvalidRequest {
                message: format!("duplicate edit transaction ID: {transaction_id}"),
            });
        }
    }
    Ok(())
}

fn validate_bounded_identifier(
    value: &str,
    label: &str,
    maximum_bytes: usize,
) -> Result<(), HistoryRevertError> {
    if value.trim().is_empty() {
        return Err(HistoryRevertError::InvalidRequest {
            message: format!("{label} identifier is empty"),
        });
    }
    if value.len() > maximum_bytes {
        return Err(HistoryRevertError::InvalidRequest {
            message: format!("{label} identifier exceeds {maximum_bytes} bytes"),
        });
    }
    Ok(())
}

fn validate_journal(journal: &HistoryRevertJournal) -> Result<(), String> {
    if journal.schema_version != JOURNAL_SCHEMA_VERSION {
        return Err(format!(
            "unsupported journal schema version {}",
            journal.schema_version
        ));
    }
    validate_operation_id(&journal.operation_id)?;
    let request =
        HistoryRevertRequest::try_from(&journal.request).map_err(|error| error.to_string())?;
    let expected_operation_id =
        HistoryRevertService::operation_id(&request).map_err(|error| error.to_string())?;
    if journal.operation_id != expected_operation_id {
        return Err("journal operation ID does not match its request".to_string());
    }
    if journal.created_at.trim().is_empty() || journal.updated_at.trim().is_empty() {
        return Err("journal timestamps cannot be empty".to_string());
    }
    if journal.payload.source_history_version != journal.expected_history_version {
        return Err("journal plan history version is inconsistent".to_string());
    }
    if journal.payload.target_ui_message_id != journal.request.target_ui_message_id {
        return Err("journal target UI message is inconsistent".to_string());
    }
    if journal.cleanup_complete && journal.phase != HistoryRevertPhase::Finalized {
        return Err("only finalized journals may complete backup cleanup".to_string());
    }
    match journal.phase {
        HistoryRevertPhase::Prepared | HistoryRevertPhase::WorkspaceApplied => {
            if journal.finalized_outcome.is_some() || journal.cleanup_complete {
                return Err("pre-commit journal contains a terminal outcome".to_string());
            }
        }
        HistoryRevertPhase::LedgerCommitted => match journal.finalized_outcome {
            Some(FinalizedOutcome::Reverted { history_version })
                if history_version > journal.expected_history_version => {}
            _ => return Err("committed journal is missing its history version".to_string()),
        },
        HistoryRevertPhase::Finalized => match journal.finalized_outcome {
            Some(FinalizedOutcome::Reverted { history_version })
                if history_version > journal.expected_history_version => {}
            Some(FinalizedOutcome::Stale { .. }) => {}
            _ => return Err("finalized journal is missing a valid outcome".to_string()),
        },
    }
    Ok(())
}

fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    let Some(digest) = operation_id.strip_prefix(OPERATION_ID_PREFIX) else {
        return Err("history revert operation ID has an invalid prefix".to_string());
    };
    if digest.len() != 64
        || !digest
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err("history revert operation ID has an invalid digest".to_string());
    }
    Ok(())
}

fn journal_history_version(journal: &HistoryRevertJournal) -> Result<u32, String> {
    match journal.finalized_outcome {
        Some(FinalizedOutcome::Reverted { history_version }) => Ok(history_version),
        _ => Err("ledger-committed journal is missing a revert result".to_string()),
    }
}

fn workspace_outcome(
    journal: &HistoryRevertJournal,
) -> Result<HistoryRevertWorkspaceOutcome, String> {
    match journal.finalized_outcome {
        Some(FinalizedOutcome::Reverted { history_version }) => {
            Ok(HistoryRevertWorkspaceOutcome::Committed { history_version })
        }
        Some(FinalizedOutcome::Stale {
            actual_history_version,
        }) => Ok(HistoryRevertWorkspaceOutcome::RolledBackStale {
            expected_history_version: journal.expected_history_version,
            actual_history_version,
        }),
        None => Err("finalized journal has no workspace outcome".to_string()),
    }
}

fn finalized_result(journal: &HistoryRevertJournal) -> Result<ResumeOutcome, HistoryRevertError> {
    match journal.finalized_outcome {
        Some(FinalizedOutcome::Reverted { history_version }) => {
            Ok(ResumeOutcome::Reverted(HistoryRevertResult {
                operation_id: journal.operation_id.clone(),
                history_version,
            }))
        }
        Some(FinalizedOutcome::Stale {
            actual_history_version,
        }) => Ok(ResumeOutcome::Stale {
            expected: journal.expected_history_version,
            actual: actual_history_version,
        }),
        None => Err(HistoryRevertError::RecoveryRequired {
            operation_id: journal.operation_id.clone(),
            session_id: journal.request.session_id.clone(),
            phase: journal.phase,
            action: "read finalized outcome",
            source: journal_integrity_error(
                PathBuf::from(&journal.operation_id),
                "finalized journal has no outcome",
            ),
        }),
    }
}

fn update_digest_field(digest: &mut Sha256, field: &[u8]) {
    digest.update((field.len() as u64).to_le_bytes());
    digest.update(field);
}

fn serialize_journal(path: &Path, journal: &HistoryRevertJournal) -> Result<Vec<u8>, AppError> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(|source| {
        journal_integrity_error(path.to_path_buf(), format!("serialize journal: {source}"))
    })?;
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err(journal_integrity_error(
            path.to_path_buf(),
            "serialized journal exceeds the size limit",
        ));
    }
    Ok(bytes)
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn journal_integrity_error(path: PathBuf, reason: impl Into<String>) -> AppError {
    AppError::storage(
        "History revert recovery data is unsafe or corrupt",
        format!("{}: {}", path.display(), reason.into()),
        false,
    )
}

fn discover_journal_paths_blocking(
    data_directory: &Path,
    journal_directory: &Path,
) -> Result<Vec<PathBuf>, AppError> {
    let data_metadata = match fs::symlink_metadata(data_directory) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(journal_io_error(
                "inspect application data directory",
                data_directory,
                source,
            ));
        }
    };
    if !is_safe_directory(&data_metadata) {
        return Err(journal_integrity_error(
            data_directory.to_path_buf(),
            "application data path is not a stable directory",
        ));
    }
    let canonical_data = dunce::canonicalize(data_directory).map_err(|source| {
        journal_io_error(
            "canonicalize application data directory",
            data_directory,
            source,
        )
    })?;
    if journal_directory.parent() != Some(data_directory) {
        return Err(journal_integrity_error(
            journal_directory.to_path_buf(),
            "journal is not a direct child of the application data directory",
        ));
    }
    let journal_metadata = match fs::symlink_metadata(journal_directory) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(journal_io_error(
                "inspect history revert journal directory",
                journal_directory,
                source,
            ));
        }
    };
    if !is_safe_directory(&journal_metadata) {
        return Err(journal_integrity_error(
            journal_directory.to_path_buf(),
            "journal path is not a stable directory",
        ));
    }
    let canonical_journal = dunce::canonicalize(journal_directory).map_err(|source| {
        journal_io_error(
            "canonicalize history revert journal directory",
            journal_directory,
            source,
        )
    })?;
    if canonical_journal.parent() != Some(canonical_data.as_path()) {
        return Err(journal_integrity_error(
            journal_directory.to_path_buf(),
            "journal resolves outside the application data directory",
        ));
    }

    let mut paths = Vec::new();
    for entry in fs::read_dir(journal_directory).map_err(|source| {
        journal_io_error(
            "enumerate history revert journal directory",
            journal_directory,
            source,
        )
    })? {
        let entry = entry.map_err(|source| {
            journal_io_error(
                "read history revert journal entry",
                journal_directory,
                source,
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|source| {
            journal_io_error("inspect history revert journal entry", &path, source)
        })?;
        if !is_safe_regular_file(&metadata) {
            return Err(journal_integrity_error(
                path,
                "journal entry is not a stable regular file",
            ));
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            return Err(journal_integrity_error(
                path,
                "journal entry name is not UTF-8",
            ));
        };
        let Some(operation_id) = file_name.strip_suffix(".json") else {
            return Err(journal_integrity_error(
                path,
                "journal entry does not use the .json suffix",
            ));
        };
        validate_operation_id(operation_id)
            .map_err(|reason| journal_integrity_error(path.clone(), reason))?;
        let canonical_entry = dunce::canonicalize(&path).map_err(|source| {
            journal_io_error("canonicalize history revert journal entry", &path, source)
        })?;
        if canonical_entry.parent() != Some(canonical_journal.as_path()) {
            return Err(journal_integrity_error(
                path,
                "journal entry resolves outside the journal directory",
            ));
        }
        paths.push(canonical_entry);
    }
    paths.sort();
    Ok(paths)
}

fn remove_empty_journal_directory_blocking(
    data_directory: &Path,
    journal_directory: &Path,
) -> Result<(), AppError> {
    if !discover_journal_paths_blocking(data_directory, journal_directory)?.is_empty() {
        return Ok(());
    }
    match fs::remove_dir(journal_directory) {
        Ok(()) => Ok(()),
        Err(source)
            if matches!(
                source.kind(),
                io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::NotFound
            ) =>
        {
            Ok(())
        }
        Err(source) => Err(journal_io_error(
            "remove empty history revert journal directory",
            journal_directory,
            source,
        )),
    }
}

fn journal_io_error(operation: &'static str, path: &Path, source: io::Error) -> AppError {
    AppError::storage(
        "History revert recovery data could not be accessed safely",
        format!("{operation} at {}: {source}", path.display()),
        false,
    )
}

fn is_safe_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && !metadata.file_type().is_symlink() && !is_reparse_point(metadata)
}

fn is_safe_regular_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file() && !metadata.file_type().is_symlink() && !is_reparse_point(metadata)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        path::{Path, PathBuf},
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use async_trait::async_trait;
    use tokio::{fs, io::AsyncWriteExt};

    use codez_core::{
        AppError, AtomicCreateOutcome, AtomicPersistence, PortFuture, SessionId,
        context::{
            ContextScopeId, LedgerAppendRequest, LedgerEventType, NormalizedModelMessage,
            UserMessagePayload,
        },
    };

    use super::{
        FinalizedOutcome, HistoryRevertErrorCode, HistoryRevertJournal, HistoryRevertOperation,
        HistoryRevertPhase, HistoryRevertRequest, HistoryRevertService, HistoryRevertWorkspace,
        HistoryRevertWorkspaceOutcome, ModelLedgerStore,
    };

    #[derive(Default)]
    struct TestFailures {
        journal_phase: Option<HistoryRevertPhase>,
    }

    #[derive(Default)]
    struct TestPersistence {
        trace: Arc<StdMutex<Vec<String>>>,
        failures: StdMutex<TestFailures>,
        fail_history_append_after_write: AtomicBool,
    }

    impl TestPersistence {
        fn fail_next_journal_phase(&self, phase: HistoryRevertPhase) {
            self.failures
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .journal_phase = Some(phase);
        }

        fn fail_next_history_append_after_write(&self) {
            self.fail_history_append_after_write
                .store(true, Ordering::Release);
        }

        fn trace(&self, value: impl Into<String>) {
            self.trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(value.into());
        }

        fn clear_trace(&self) {
            self.trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
        }

        fn trace_snapshot(&self) -> Vec<String> {
            self.trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }

        fn should_fail_phase(&self, bytes: &[u8]) -> bool {
            let Ok(journal) = serde_json::from_slice::<HistoryRevertJournal>(bytes) else {
                return false;
            };
            let mut failures = self
                .failures
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if failures.journal_phase == Some(journal.phase) {
                failures.journal_phase = None;
                true
            } else {
                false
            }
        }

        fn trace_journal(&self, bytes: &[u8]) {
            if let Ok(journal) = serde_json::from_slice::<HistoryRevertJournal>(bytes) {
                self.trace(format!("journal:{}", journal.phase.label()));
            }
        }
    }

    impl AtomicPersistence for TestPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move {
                match fs::read(path).await {
                    Ok(bytes) => Ok(Some(bytes)),
                    Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
                    Err(source) => Err(test_storage_error("read", path, source)),
                }
            })
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                if self.should_fail_phase(bytes) {
                    return Err(AppError::storage(
                        "injected journal replacement failure",
                        path.display().to_string(),
                        true,
                    ));
                }
                create_parent(path).await?;
                fs::write(path, bytes)
                    .await
                    .map_err(|source| test_storage_error("replace", path, source))?;
                self.trace_journal(bytes);
                Ok(())
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                create_parent(path).await?;
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .await
                {
                    Ok(mut file) => {
                        file.write_all(bytes).await.map_err(|source| {
                            test_storage_error("write no-clobber file", path, source)
                        })?;
                        file.sync_all().await.map_err(|source| {
                            test_storage_error("sync no-clobber file", path, source)
                        })?;
                        self.trace_journal(bytes);
                        Ok(AtomicCreateOutcome::Created)
                    }
                    Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                        let existing = fs::read(path).await.map_err(|source| {
                            test_storage_error("read reused no-clobber file", path, source)
                        })?;
                        if existing == bytes {
                            Ok(AtomicCreateOutcome::Reused)
                        } else {
                            Err(AppError::conflict("no-clobber test resource differs"))
                        }
                    }
                    Err(source) => Err(test_storage_error("create no-clobber file", path, source)),
                }
            })
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                create_parent(path).await?;
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .await
                    .map_err(|source| test_storage_error("open append file", path, source))?;
                file.write_all(bytes)
                    .await
                    .map_err(|source| test_storage_error("append", path, source))?;
                file.sync_all()
                    .await
                    .map_err(|source| test_storage_error("sync append", path, source))?;
                let history_revert = bytes
                    .windows(b"history_reverted".len())
                    .any(|window| window == b"history_reverted");
                if history_revert {
                    self.trace("ledger:history_reverted");
                }
                if history_revert
                    && self
                        .fail_history_append_after_write
                        .swap(false, Ordering::AcqRel)
                {
                    return Err(AppError::storage(
                        "injected uncertain ledger append",
                        path.display().to_string(),
                        true,
                    ));
                }
                Ok(())
            })
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move {
                match fs::remove_file(path).await {
                    Ok(()) => Ok(true),
                    Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
                    Err(source) => Err(test_storage_error("remove", path, source)),
                }
            })
        }
    }

    struct TestWorkspace {
        root: PathBuf,
        trace: Arc<StdMutex<Vec<String>>>,
        apply_calls: AtomicUsize,
        rollback_calls: AtomicUsize,
        finalize_calls: AtomicUsize,
        finalize_outcomes: StdMutex<Vec<HistoryRevertWorkspaceOutcome>>,
        fail_apply_after_effect: AtomicBool,
        fail_finalize_before_effect: AtomicBool,
    }

    impl TestWorkspace {
        fn new(root: PathBuf, trace: Arc<StdMutex<Vec<String>>>) -> Self {
            Self {
                root,
                trace,
                apply_calls: AtomicUsize::new(0),
                rollback_calls: AtomicUsize::new(0),
                finalize_calls: AtomicUsize::new(0),
                finalize_outcomes: StdMutex::new(Vec::new()),
                fail_apply_after_effect: AtomicBool::new(false),
                fail_finalize_before_effect: AtomicBool::new(false),
            }
        }

        fn operation_directory(&self, operation: &HistoryRevertOperation) -> PathBuf {
            self.root.join(&operation.operation_id)
        }

        fn backup_path(&self, operation: &HistoryRevertOperation) -> PathBuf {
            self.operation_directory(operation).join("workspace.backup")
        }

        fn applied_path(&self, operation: &HistoryRevertOperation) -> PathBuf {
            self.operation_directory(operation)
                .join("workspace.applied")
        }

        fn fail_next_apply_after_effect(&self) {
            self.fail_apply_after_effect.store(true, Ordering::Release);
        }

        fn fail_next_finalize_before_effect(&self) {
            self.fail_finalize_before_effect
                .store(true, Ordering::Release);
        }

        fn trace(&self, value: &str) {
            self.trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(value.to_string());
        }
    }

    #[async_trait]
    impl HistoryRevertWorkspace for TestWorkspace {
        async fn prepare_backup(&self, operation: &HistoryRevertOperation) -> Result<(), AppError> {
            let directory = self.operation_directory(operation);
            fs::create_dir_all(&directory).await.map_err(|source| {
                test_storage_error("create workspace backup", &directory, source)
            })?;
            let backup = self.backup_path(operation);
            if fs::try_exists(&backup)
                .await
                .map_err(|source| test_storage_error("inspect workspace backup", &backup, source))?
            {
                return Ok(());
            }
            fs::write(&backup, b"pre-revert workspace")
                .await
                .map_err(|source| test_storage_error("write workspace backup", &backup, source))?;
            self.trace("workspace:backup");
            Ok(())
        }

        async fn apply_revert(&self, operation: &HistoryRevertOperation) -> Result<(), AppError> {
            self.apply_calls.fetch_add(1, Ordering::AcqRel);
            let backup = self.backup_path(operation);
            if !fs::try_exists(&backup)
                .await
                .map_err(|source| test_storage_error("inspect workspace backup", &backup, source))?
            {
                return Err(AppError::storage(
                    "workspace backup is missing",
                    backup.display().to_string(),
                    false,
                ));
            }
            let applied = self.applied_path(operation);
            fs::write(&applied, b"reverted workspace")
                .await
                .map_err(|source| test_storage_error("apply workspace revert", &applied, source))?;
            self.trace("workspace:apply");
            if self.fail_apply_after_effect.swap(false, Ordering::AcqRel) {
                return Err(AppError::storage(
                    "injected uncertain workspace apply",
                    applied.display().to_string(),
                    true,
                ));
            }
            Ok(())
        }

        async fn rollback_revert(
            &self,
            operation: &HistoryRevertOperation,
        ) -> Result<(), AppError> {
            self.rollback_calls.fetch_add(1, Ordering::AcqRel);
            let backup = self.backup_path(operation);
            if !fs::try_exists(&backup)
                .await
                .map_err(|source| test_storage_error("inspect rollback backup", &backup, source))?
            {
                return Err(AppError::storage(
                    "rollback backup is missing",
                    backup.display().to_string(),
                    false,
                ));
            }
            let applied = self.applied_path(operation);
            match fs::remove_file(&applied).await {
                Ok(()) => {}
                Err(source) if source.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(test_storage_error(
                        "rollback workspace revert",
                        &applied,
                        source,
                    ));
                }
            }
            self.trace("workspace:rollback");
            Ok(())
        }

        async fn finalize_backup(
            &self,
            operation: &HistoryRevertOperation,
            outcome: HistoryRevertWorkspaceOutcome,
        ) -> Result<(), AppError> {
            self.finalize_calls.fetch_add(1, Ordering::AcqRel);
            self.finalize_outcomes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(outcome);
            let directory = self.operation_directory(operation);
            if self
                .fail_finalize_before_effect
                .swap(false, Ordering::AcqRel)
            {
                return Err(AppError::storage(
                    "injected workspace finalization failure",
                    directory.display().to_string(),
                    true,
                ));
            }
            match fs::remove_dir_all(&directory).await {
                Ok(()) => {}
                Err(source) if source.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(test_storage_error(
                        "finalize workspace backup",
                        &directory,
                        source,
                    ));
                }
            }
            match outcome {
                HistoryRevertWorkspaceOutcome::Committed { .. } => {
                    self.trace("workspace:finalize_committed");
                }
                HistoryRevertWorkspaceOutcome::RolledBackStale { .. } => {
                    self.trace("workspace:finalize_rolled_back");
                }
            }
            Ok(())
        }
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        data_root: PathBuf,
        persistence: Arc<TestPersistence>,
        ledger: Arc<ModelLedgerStore>,
        workspace: Arc<TestWorkspace>,
    }

    impl Fixture {
        async fn new() -> Self {
            let temp = tempfile::tempdir().expect("temporary fixture directory must be created");
            let data_root = temp.path().to_path_buf();
            let persistence = Arc::new(TestPersistence::default());
            let ledger = Arc::new(ModelLedgerStore::new(
                data_root.join("session-runtime"),
                persistence.clone(),
            ));
            let workspace = Arc::new(TestWorkspace::new(
                data_root.join("workspace-backups"),
                Arc::clone(&persistence.trace),
            ));
            let fixture = Self {
                _temp: temp,
                data_root,
                persistence,
                ledger,
                workspace,
            };
            fixture.seed_history().await;
            fixture.persistence.clear_trace();
            fixture
        }

        fn service(&self) -> HistoryRevertService {
            HistoryRevertService::new(
                &self.data_root,
                self.persistence.clone(),
                Arc::clone(&self.ledger),
                self.workspace.clone(),
            )
        }

        fn request(&self) -> HistoryRevertRequest {
            HistoryRevertRequest {
                session_id: test_session_id(),
                context_scope_id: ContextScopeId::Main,
                target_ui_message_id: "ui-second".to_string(),
                transaction_ids: vec!["tx-newer".to_string(), "tx-older".to_string()],
            }
        }

        async fn seed_history(&self) {
            append_user_message(&self.ledger, "event-first", "message-first", "ui-first").await;
            append_user_message(&self.ledger, "event-second", "message-second", "ui-second").await;
        }
    }

    #[test]
    fn identical_requests_keep_a_stable_operation_id() {
        let request = HistoryRevertRequest {
            session_id: test_session_id(),
            context_scope_id: ContextScopeId::Main,
            target_ui_message_id: "ui-target".to_string(),
            transaction_ids: vec!["tx-newer".to_string(), "tx-older".to_string()],
        };
        let mut reordered = request.clone();
        reordered.transaction_ids.reverse();

        let first = HistoryRevertService::operation_id(&request)
            .expect("valid request must produce an operation ID");
        let retry = HistoryRevertService::operation_id(&request)
            .expect("identical retry must produce an operation ID");
        let changed = HistoryRevertService::operation_id(&reordered)
            .expect("valid reordered request must produce an operation ID");

        assert_eq!(first, retry);
        assert_ne!(first, changed);
    }

    #[tokio::test]
    async fn success_keeps_backup_until_ledger_commit_and_is_idempotent() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let request = fixture.request();

        let first = service
            .execute(request.clone())
            .await
            .expect("history revert must complete");
        let trace = fixture.persistence.trace_snapshot();
        let ledger_index = trace
            .iter()
            .position(|entry| entry == "ledger:history_reverted")
            .expect("history ledger append must be traced");
        let finalize_index = trace
            .iter()
            .position(|entry| entry == "workspace:finalize_committed")
            .expect("workspace backup cleanup must be traced");
        assert!(ledger_index < finalize_index);
        assert!(trace[..ledger_index].contains(&"workspace:backup".to_string()));
        assert_eq!(first.history_version, 3);
        assert_eq!(
            fixture
                .workspace
                .finalize_outcomes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            &[HistoryRevertWorkspaceOutcome::Committed { history_version: 3 }]
        );

        let calls_before_retry = (
            fixture.workspace.apply_calls.load(Ordering::Acquire),
            fixture.workspace.finalize_calls.load(Ordering::Acquire),
        );
        let retry = service
            .execute(request)
            .await
            .expect("finalized operation must be idempotent");

        assert_eq!(retry, first);
        assert_eq!(
            (
                fixture.workspace.apply_calls.load(Ordering::Acquire),
                fixture.workspace.finalize_calls.load(Ordering::Acquire),
            ),
            calls_before_retry
        );
    }

    #[tokio::test]
    async fn failed_workspace_phase_persistence_recovers_from_prepared() {
        let fixture = Fixture::new().await;
        fixture
            .persistence
            .fail_next_journal_phase(HistoryRevertPhase::WorkspaceApplied);
        let service = fixture.service();
        let request = fixture.request();
        let operation_id = HistoryRevertService::operation_id(&request)
            .expect("fixture request must produce an operation ID");
        let operation = HistoryRevertOperation {
            operation_id,
            request: request.clone(),
        };

        let error = service
            .execute(request)
            .await
            .expect_err("injected journal failure must require recovery");

        assert_eq!(error.code(), HistoryRevertErrorCode::RecoveryRequired);
        assert!(
            fs::try_exists(fixture.workspace.backup_path(&operation))
                .await
                .expect("backup existence must be readable")
        );
        let pending = service
            .pending_recoveries()
            .await
            .expect("prepared operation must remain discoverable");
        assert_eq!(pending[0].phase, HistoryRevertPhase::Prepared);

        let restarted = fixture.service();
        let recovered = restarted
            .recover_pending()
            .await
            .expect("prepared operation must recover idempotently");

        assert_eq!(recovered[0].history_version, 3);
        assert!(
            !fs::try_exists(fixture.workspace.backup_path(&operation))
                .await
                .expect("finalized backup existence must be readable")
        );
        assert_eq!(fixture.workspace.apply_calls.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn uncertain_ledger_append_replays_the_stable_event_without_losing_backup() {
        let fixture = Fixture::new().await;
        fixture.persistence.fail_next_history_append_after_write();
        let service = fixture.service();
        let request = fixture.request();
        let operation_id = HistoryRevertService::operation_id(&request)
            .expect("fixture request must produce an operation ID");
        let operation = HistoryRevertOperation {
            operation_id,
            request,
        };

        let error = service
            .execute(operation.request.clone())
            .await
            .expect_err("uncertain ledger append must require recovery");

        assert_eq!(error.code(), HistoryRevertErrorCode::RecoveryRequired);
        assert!(
            fs::try_exists(fixture.workspace.backup_path(&operation))
                .await
                .expect("backup existence must be readable")
        );

        let recovered = fixture
            .service()
            .recover_pending()
            .await
            .expect("stable event replay must recover the operation");

        assert_eq!(recovered[0].history_version, 3);
        let snapshot = fixture
            .ledger
            .get_snapshot(&test_session_id())
            .await
            .expect("recovered ledger must load")
            .expect("recovered ledger snapshot must exist");
        assert_eq!(
            snapshot
                .scopes
                .get("main")
                .expect("main scope must exist")
                .history_version,
            3
        );
    }

    #[tokio::test]
    async fn stale_ledger_version_rolls_back_workspace_and_finalizes_the_decision() {
        let fixture = Fixture::new().await;
        fixture
            .persistence
            .fail_next_journal_phase(HistoryRevertPhase::WorkspaceApplied);
        let service = fixture.service();
        let request = fixture.request();

        let first = service
            .execute(request.clone())
            .await
            .expect_err("phase failure must pause before ledger commit");
        assert_eq!(first.code(), HistoryRevertErrorCode::RecoveryRequired);
        append_user_message(
            &fixture.ledger,
            "event-concurrent",
            "message-concurrent",
            "ui-concurrent",
        )
        .await;

        let stale = service
            .execute(request.clone())
            .await
            .expect_err("changed history must make the prepared operation stale");
        assert_eq!(stale.code(), HistoryRevertErrorCode::HistoryRevertStale);
        assert_eq!(fixture.workspace.rollback_calls.load(Ordering::Acquire), 1);
        assert_eq!(
            fixture
                .workspace
                .finalize_outcomes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            &[HistoryRevertWorkspaceOutcome::RolledBackStale {
                expected_history_version: 2,
                actual_history_version: 3,
            }]
        );
        assert!(
            service
                .pending_recoveries()
                .await
                .expect("terminal stale operation must be readable")
                .is_empty()
        );

        let retry = service
            .execute(request)
            .await
            .expect_err("terminal stale retry must return the same decision");
        assert_eq!(retry.code(), HistoryRevertErrorCode::HistoryRevertStale);
        assert_eq!(fixture.workspace.rollback_calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn uncertain_workspace_apply_retries_with_the_same_backup() {
        let fixture = Fixture::new().await;
        fixture.workspace.fail_next_apply_after_effect();
        let service = fixture.service();
        let request = fixture.request();

        let error = service
            .execute(request)
            .await
            .expect_err("uncertain workspace apply must require recovery");
        assert_eq!(error.code(), HistoryRevertErrorCode::RecoveryRequired);

        let recovered = fixture
            .service()
            .recover_pending()
            .await
            .expect("idempotent workspace apply must recover");

        assert_eq!(recovered[0].history_version, 3);
        assert_eq!(fixture.workspace.apply_calls.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn finalized_cleanup_failure_recovers_with_the_committed_outcome() {
        let fixture = Fixture::new().await;
        fixture.workspace.fail_next_finalize_before_effect();
        let service = fixture.service();
        let request = fixture.request();
        let operation_id = HistoryRevertService::operation_id(&request)
            .expect("fixture request must produce an operation ID");
        let operation = HistoryRevertOperation {
            operation_id,
            request,
        };

        let error = service
            .execute(operation.request.clone())
            .await
            .expect_err("failed terminal cleanup must require recovery");
        assert_eq!(error.code(), HistoryRevertErrorCode::RecoveryRequired);
        let pending = service
            .pending_recoveries()
            .await
            .expect("incomplete terminal cleanup must remain discoverable");
        assert_eq!(pending[0].phase, HistoryRevertPhase::Finalized);
        assert!(
            fs::try_exists(fixture.workspace.backup_path(&operation))
                .await
                .expect("retained terminal backup must be readable")
        );

        let recovered = fixture
            .service()
            .recover_pending()
            .await
            .expect("terminal cleanup must recover idempotently");
        let outcomes = fixture
            .workspace
            .finalize_outcomes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();

        assert_eq!(recovered[0].history_version, 3);
        assert_eq!(
            outcomes,
            vec![
                HistoryRevertWorkspaceOutcome::Committed { history_version: 3 },
                HistoryRevertWorkspaceOutcome::Committed { history_version: 3 },
            ]
        );
    }

    #[tokio::test]
    async fn unsafe_recovery_entry_blocks_startup_recovery() {
        let fixture = Fixture::new().await;
        let journal_directory = fixture.data_root.join("history-reverts");
        fs::create_dir_all(&journal_directory)
            .await
            .expect("fixture journal directory must be created");
        fs::write(journal_directory.join("untrusted.json"), b"{}")
            .await
            .expect("untrusted journal fixture must be written");

        let error = fixture
            .service()
            .pending_recoveries()
            .await
            .expect_err("untrusted journal entry must block recovery");

        assert_eq!(error.code(), HistoryRevertErrorCode::RecoveryRequired);
        assert_eq!(fixture.workspace.apply_calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn session_cleanup_removes_only_completed_journals_for_the_requested_session() {
        let fixture = Fixture::new().await;
        let service = fixture.service();
        let request = fixture.request();
        let completed = service
            .execute(request)
            .await
            .expect("fixture history revert must complete");
        let other_session = SessionId::parse("session-history-revert-other")
            .expect("other fixture session must be valid");
        append_user_message_for(
            &fixture.ledger,
            &other_session,
            "other-event-first",
            "other-message-first",
            "other-ui-first",
        )
        .await;
        append_user_message_for(
            &fixture.ledger,
            &other_session,
            "other-event-second",
            "other-message-second",
            "other-ui-second",
        )
        .await;
        let other_request = HistoryRevertRequest {
            session_id: other_session.clone(),
            context_scope_id: ContextScopeId::Main,
            target_ui_message_id: "other-ui-second".to_string(),
            transaction_ids: vec!["other-transaction".to_string()],
        };
        let other = service
            .execute(other_request)
            .await
            .expect("other fixture history revert must complete");

        service
            .cleanup_session(&test_session_id())
            .await
            .expect("completed session journal cleanup must succeed");

        assert!(
            fixture
                .persistence
                .read(&service.journal_path(&completed.operation_id))
                .await
                .expect("removed journal state must be readable")
                .is_none()
        );
        assert!(
            fixture
                .persistence
                .read(&service.journal_path(&other.operation_id))
                .await
                .expect("other journal state must be readable")
                .is_some()
        );
    }

    #[tokio::test]
    async fn session_cleanup_retains_pending_recovery_evidence() {
        let fixture = Fixture::new().await;
        fixture
            .persistence
            .fail_next_journal_phase(HistoryRevertPhase::WorkspaceApplied);
        let service = fixture.service();
        let request = fixture.request();
        let operation_id = HistoryRevertService::operation_id(&request)
            .expect("fixture request must produce an operation ID");
        service
            .execute(request)
            .await
            .expect_err("injected journal failure must leave pending recovery");

        let error = service
            .cleanup_session(&test_session_id())
            .await
            .expect_err("pending recovery must block session journal cleanup");

        assert_eq!(error.code(), HistoryRevertErrorCode::RecoveryRequired);
        assert!(
            fixture
                .persistence
                .read(&service.journal_path(&operation_id))
                .await
                .expect("pending journal state must be readable")
                .is_some()
        );
    }

    #[test]
    fn finalized_journal_requires_a_terminal_outcome() {
        let request = HistoryRevertRequest {
            session_id: test_session_id(),
            context_scope_id: ContextScopeId::Main,
            target_ui_message_id: "ui-target".to_string(),
            transaction_ids: Vec::new(),
        };
        let operation_id = HistoryRevertService::operation_id(&request)
            .expect("fixture request must produce an operation ID");
        let mut journal = HistoryRevertJournal {
            schema_version: super::JOURNAL_SCHEMA_VERSION,
            operation_id,
            request: (&request).into(),
            expected_history_version: 1,
            payload: codez_core::context::HistoryRevertedPayload {
                source_history_version: 1,
                target_ui_message_id: "ui-target".to_string(),
                target_message_id: "message-target".to_string(),
                active_messages: Vec::new(),
                skill_states: Some(Vec::new()),
            },
            phase: HistoryRevertPhase::Finalized,
            finalized_outcome: None,
            cleanup_complete: false,
            created_at: "2026-07-17T00:00:00.000Z".to_string(),
            updated_at: "2026-07-17T00:00:00.000Z".to_string(),
        };

        assert!(super::validate_journal(&journal).is_err());
        journal.finalized_outcome = Some(FinalizedOutcome::Reverted { history_version: 2 });
        assert!(super::validate_journal(&journal).is_ok());
    }

    async fn append_user_message(
        ledger: &ModelLedgerStore,
        event_id: &str,
        message_id: &str,
        ui_message_id: &str,
    ) {
        let session_id = test_session_id();
        append_user_message_for(ledger, &session_id, event_id, message_id, ui_message_id).await;
    }

    async fn append_user_message_for(
        ledger: &ModelLedgerStore,
        session_id: &SessionId,
        event_id: &str,
        message_id: &str,
        ui_message_id: &str,
    ) {
        let payload = UserMessagePayload {
            message: NormalizedModelMessage {
                id: message_id.to_string(),
                client_message_id: Some(ui_message_id.to_string()),
                turn_id: format!("turn-{message_id}"),
                role: "user".to_string(),
                content: format!("content for {message_id}"),
                tool_calls: None,
                tool_call_id: None,
                name: None,
                status: "complete".to_string(),
                created_at: "2026-07-17T00:00:00.000Z".to_string(),
                source_sequence: None,
                attachments: None,
                file_references: None,
            },
            provider_id: None,
            model: None,
            command_metadata: None,
        };
        ledger
            .append_event_for(
                session_id,
                LedgerAppendRequest {
                    event_id: event_id.to_string(),
                    session_id: session_id.as_str().to_string(),
                    context_scope_id: ContextScopeId::Main,
                    turn_id: Some(format!("turn-{message_id}")),
                    created_at: "2026-07-17T00:00:00.000Z".to_string(),
                    r#type: LedgerEventType::UserMessage,
                    payload: serde_json::to_value(payload)
                        .expect("fixture user payload must serialize"),
                },
            )
            .await
            .expect("fixture user message must append");
    }

    fn test_session_id() -> SessionId {
        SessionId::parse("session-history-revert")
            .expect("fixture session identifier must be valid")
    }

    async fn create_parent(path: &Path) -> Result<(), AppError> {
        let parent = path
            .parent()
            .ok_or_else(|| AppError::validation("test path has no parent"))?;
        fs::create_dir_all(parent)
            .await
            .map_err(|source| test_storage_error("create parent", parent, source))
    }

    fn test_storage_error(operation: &str, path: &Path, source: io::Error) -> AppError {
        AppError::storage(
            "test persistence failed",
            format!("{operation} at {}: {source}", path.display()),
            true,
        )
    }
}
