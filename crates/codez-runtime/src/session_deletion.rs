use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use codez_core::{AppError, AtomicCreateOutcome, AtomicPersistence, PortFuture, SessionId};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::session_maintenance::{SessionMaintenanceCoordinator, SessionMaintenanceLease};

const JOURNAL_DIRECTORY: &str = "session-deletions";
const TOMBSTONE_SUFFIX: &str = ".json";
const TOMBSTONE_SCHEMA_VERSION: u32 = 1;

/// One idempotent resource cleanup performed for a deleted session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionDeletionStep {
    /// Clears session-scoped permission decisions.
    Permissions,
    /// Removes durable and in-memory edit rollback transactions.
    EditTransactions,
    /// Removes the session task snapshot.
    Todos,
    /// Removes promoted image attachments.
    Attachments,
    /// Removes the model context ledger.
    Ledger,
    /// Clears read fingerprints and delivery tracking.
    Fingerprints,
    /// Removes the user-facing session document last.
    SessionDocument,
}

const DELETION_STEPS: [SessionDeletionStep; 7] = [
    SessionDeletionStep::Permissions,
    SessionDeletionStep::EditTransactions,
    SessionDeletionStep::Todos,
    SessionDeletionStep::Attachments,
    SessionDeletionStep::Ledger,
    SessionDeletionStep::Fingerprints,
    SessionDeletionStep::SessionDocument,
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionDeletionTombstone {
    schema_version: u32,
    session_id: SessionId,
}

impl SessionDeletionTombstone {
    fn new(session_id: SessionId) -> Self {
        Self {
            schema_version: TOMBSTONE_SCHEMA_VERSION,
            session_id,
        }
    }
}

/// Adapter boundary for the resources removed by [`SessionDeletionService`].
pub trait SessionDeletionOperations: Send + Sync {
    /// Executes one idempotent cleanup step for `session_id`.
    fn execute<'a>(
        &'a self,
        step: SessionDeletionStep,
        session_id: &'a SessionId,
    ) -> PortFuture<'a, ()>;
}

/// Coordinates crash-safe, idempotent deletion of every resource owned by one session.
pub struct SessionDeletionService {
    inner: Arc<SessionDeletionInner>,
}

struct SessionDeletionInner {
    data_directory: PathBuf,
    journal_directory: PathBuf,
    persistence: Arc<dyn AtomicPersistence>,
    operations: Arc<dyn SessionDeletionOperations>,
    maintenance: Arc<SessionMaintenanceCoordinator>,
    state: Mutex<SessionDeletionState>,
    workers: Mutex<HashSet<SessionId>>,
}

#[derive(Default)]
struct SessionDeletionState {
    pending: HashSet<SessionId>,
    generation: u128,
}

/// Stable token used to reject a session list that crossed a deletion boundary.
#[derive(Debug, Clone, Copy)]
pub struct SessionListSnapshot {
    generation: u128,
}

impl SessionDeletionService {
    /// Creates a deletion coordinator rooted below the new CodeZ data directory.
    #[must_use]
    pub fn new(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        operations: Arc<dyn SessionDeletionOperations>,
        maintenance: Arc<SessionMaintenanceCoordinator>,
    ) -> Self {
        Self {
            inner: Arc::new(SessionDeletionInner {
                data_directory: data_directory.to_path_buf(),
                journal_directory: data_directory.join(JOURNAL_DIRECTORY),
                persistence,
                operations,
                maintenance,
                state: Mutex::new(SessionDeletionState::default()),
                workers: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// Replays every durable deletion tombstone before application state is exposed.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the journal is unsafe or corrupt, or any cleanup
    /// operation cannot be completed. The affected session remains blocked.
    pub async fn recover_pending(&self) -> Result<(), AppError> {
        let pending = discover_pending_sessions(
            self.inner.data_directory.clone(),
            self.inner.journal_directory.clone(),
        )
        .await?;

        for session_id in &pending {
            self.mark_discovered_recovery(session_id)?;
        }

        for session_id in pending {
            self.start_worker(session_id, WorkerMode::RecoverExisting)?
                .await
                .map_err(|_| worker_response_error())??;
        }
        Ok(())
    }

    /// Rejects reads and writes while a durable deletion is awaiting completion.
    ///
    /// # Errors
    ///
    /// Returns a retryable `RUN_ACTIVE` error for a pending session deletion.
    pub fn ensure_available(&self, session_id: &SessionId) -> Result<(), AppError> {
        if self.inner.is_pending(session_id) {
            Err(AppError::run_active("Session deletion is pending recovery"))
        } else {
            Ok(())
        }
    }

    /// Rejects enumeration while any deletion could expose a partial document.
    ///
    /// # Errors
    ///
    /// Returns a retryable `RUN_ACTIVE` error when a deletion is pending.
    pub fn ensure_list_available(&self) -> Result<(), AppError> {
        self.begin_list_snapshot().map(|_| ())
    }

    /// Captures the deletion generation before loading session documents.
    ///
    /// # Errors
    ///
    /// Returns a retryable `RUN_ACTIVE` error while any deletion is pending.
    pub fn begin_list_snapshot(&self) -> Result<SessionListSnapshot, AppError> {
        let state = self.inner.state();
        if state.pending.is_empty() {
            Ok(SessionListSnapshot {
                generation: state.generation,
            })
        } else {
            Err(AppError::run_active("Session deletion is pending recovery"))
        }
    }

    /// Verifies that no deletion started or completed while a list was loaded.
    ///
    /// # Errors
    ///
    /// Returns a retryable `RUN_ACTIVE` error when the snapshot is stale.
    pub fn ensure_list_unchanged(&self, snapshot: SessionListSnapshot) -> Result<(), AppError> {
        let state = self.inner.state();
        if state.pending.is_empty() && state.generation == snapshot.generation {
            Ok(())
        } else {
            Err(AppError::run_active(
                "Session list crossed a deletion boundary",
            ))
        }
    }

    /// Persists a tombstone, idempotently removes all session resources, then finalizes it.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the tombstone cannot be committed, a cleanup
    /// step fails, or finalization cannot be persisted. A committed tombstone is
    /// retained for a later retry.
    pub async fn delete(&self, session_id: &SessionId) -> Result<(), AppError> {
        self.start_worker(session_id.clone(), WorkerMode::CreateOrRecover)?
            .await
            .map_err(|_| worker_response_error())?
    }

    /// Commits deletion while the caller still owns the maintenance lease used to
    /// inspect the session document.
    ///
    /// The recovery marker is established before the supplied lease is released,
    /// so ordinary activity cannot restore or mutate the session after the caller
    /// has decided to physically delete it.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the lease does not belong to this service's
    /// maintenance coordinator, another deletion is active, the tombstone cannot
    /// be persisted, cleanup fails, or finalization cannot be persisted.
    pub async fn delete_with_maintenance(
        &self,
        maintenance: SessionMaintenanceLease,
    ) -> Result<(), AppError> {
        let session_id = maintenance.session_id().clone();
        self.start_worker_with_reservation(
            session_id,
            WorkerMode::CreateOrRecover,
            Some(maintenance),
        )?
        .await
        .map_err(|_| worker_response_error())?
    }

    fn mark_discovered_recovery(&self, session_id: &SessionId) -> Result<(), AppError> {
        if self.inner.is_pending(session_id) {
            return Ok(());
        }

        let maintenance = self
            .inner
            .maintenance
            .try_begin_maintenance(session_id.clone())
            .map_err(AppError::from)?;
        self.inner
            .maintenance
            .mark_recovery_required(maintenance.session_id())
            .map_err(AppError::from)?;
        self.inner.mark_pending(session_id);
        Ok(())
    }

    fn start_worker(
        &self,
        session_id: SessionId,
        mode: WorkerMode,
    ) -> Result<oneshot::Receiver<Result<(), AppError>>, AppError> {
        self.start_worker_with_reservation(session_id, mode, None)
    }

    fn start_worker_with_reservation(
        &self,
        session_id: SessionId,
        mode: WorkerMode,
        reservation: Option<SessionMaintenanceLease>,
    ) -> Result<oneshot::Receiver<Result<(), AppError>>, AppError> {
        let mut workers = self.inner.workers();
        if workers.contains(&session_id) {
            return Err(AppError::run_active("Session deletion is already running"));
        }

        if reservation.is_some() && self.inner.is_pending(&session_id) {
            return Err(AppError::run_active("Session deletion is pending recovery"));
        }

        if let Some(maintenance) = reservation {
            if maintenance.session_id() != &session_id {
                return Err(AppError::internal(
                    "Session deletion reservation does not match the requested session",
                ));
            }
            self.inner
                .maintenance
                .mark_recovery_required(maintenance.session_id())
                .map_err(AppError::from)?;
            self.inner.mark_pending(&session_id);
            drop(maintenance);
        } else if !self.inner.is_pending(&session_id) {
            let maintenance = self
                .inner
                .maintenance
                .try_begin_maintenance(session_id.clone())
                .map_err(AppError::from)?;
            self.inner
                .maintenance
                .mark_recovery_required(maintenance.session_id())
                .map_err(AppError::from)?;
            self.inner.mark_pending(&session_id);
        }

        let recovery_maintenance = self
            .inner
            .maintenance
            .try_begin_recovery_maintenance(session_id.clone())
            .map_err(AppError::from)?;
        workers.insert(session_id.clone());
        drop(workers);

        let registration = WorkerRegistration {
            inner: Arc::clone(&self.inner),
            session_id: session_id.clone(),
        };
        let inner = Arc::clone(&self.inner);
        let (response, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let _registration = registration;
            let result = inner
                .run_worker(&session_id, mode, &recovery_maintenance)
                .await;
            let _response_ignored = response.send(result);
        });
        Ok(receiver)
    }
}

#[derive(Clone, Copy)]
enum WorkerMode {
    CreateOrRecover,
    RecoverExisting,
}

struct WorkerRegistration {
    inner: Arc<SessionDeletionInner>,
    session_id: SessionId,
}

impl Drop for WorkerRegistration {
    fn drop(&mut self) {
        self.inner.workers().remove(&self.session_id);
    }
}

impl SessionDeletionInner {
    async fn run_worker(
        &self,
        session_id: &SessionId,
        mode: WorkerMode,
        recovery_maintenance: &crate::session_maintenance::SessionMaintenanceLease,
    ) -> Result<(), AppError> {
        let preparation = match mode {
            WorkerMode::CreateOrRecover => self.ensure_tombstone(session_id).await,
            WorkerMode::RecoverExisting => self.require_existing_tombstone(session_id).await,
        };
        if let Err(failure) = preparation {
            if failure.clear_recovery {
                self.finish_recovery(recovery_maintenance)?;
            }
            return Err(failure.error);
        }

        for step in DELETION_STEPS {
            self.operations.execute(step, session_id).await?;
        }
        let path = self.tombstone_path(session_id);
        self.validate_access(&path).await?;
        self.persistence
            .remove(&path)
            .await
            .map_err(|source| journal_persistence_error("finalize tombstone", &path, source))?;
        self.finish_recovery(recovery_maintenance)
    }

    async fn require_existing_tombstone(
        &self,
        session_id: &SessionId,
    ) -> Result<(), PreparationFailure> {
        let path = self.tombstone_path(session_id);
        let tombstone = self
            .load_tombstone(session_id)
            .await
            .map_err(PreparationFailure::retain)?
            .ok_or_else(|| {
                PreparationFailure::retain(journal_integrity_error(
                    "load pending tombstone",
                    &path,
                    "the journal entry disappeared before recovery",
                ))
            })?;
        validate_tombstone(&tombstone, session_id, &path).map_err(PreparationFailure::retain)
    }

    async fn ensure_tombstone(&self, session_id: &SessionId) -> Result<(), PreparationFailure> {
        let path = self.tombstone_path(session_id);
        if let Some(tombstone) = self
            .load_tombstone(session_id)
            .await
            .map_err(PreparationFailure::retain)?
        {
            return validate_tombstone(&tombstone, session_id, &path)
                .map_err(PreparationFailure::retain);
        }

        let bytes = serde_json::to_vec_pretty(&SessionDeletionTombstone::new(session_id.clone()))
            .map_err(|source| {
            PreparationFailure::retain(journal_integrity_error(
                "serialize tombstone",
                &path,
                source,
            ))
        })?;
        self.validate_access(&path)
            .await
            .map_err(PreparationFailure::retain)?;
        match self.persistence.create_no_clobber(&path, &bytes).await {
            Ok(AtomicCreateOutcome::Created | AtomicCreateOutcome::Reused) => {
                self.verify_reused_tombstone(session_id).await
            }
            Err(source) => {
                let create_error = journal_persistence_error("persist tombstone", &path, source);
                match self.load_tombstone(session_id).await {
                    Ok(Some(tombstone)) => validate_tombstone(&tombstone, session_id, &path)
                        .map_err(PreparationFailure::retain),
                    Ok(None) => Err(PreparationFailure::clear(create_error)),
                    Err(confirmation_error) if !confirmation_error.retryable() => {
                        Err(PreparationFailure::retain(confirmation_error))
                    }
                    Err(confirmation_error) => Err(PreparationFailure::retain(journal_io_error(
                        "confirm tombstone after create failure",
                        &path,
                        format!("{create_error}; confirmation failed: {confirmation_error}"),
                    ))),
                }
            }
        }
    }

    async fn verify_reused_tombstone(
        &self,
        session_id: &SessionId,
    ) -> Result<(), PreparationFailure> {
        let path = self.tombstone_path(session_id);
        let tombstone = self
            .load_tombstone(session_id)
            .await
            .map_err(PreparationFailure::retain)?
            .ok_or_else(|| {
                PreparationFailure::retain(journal_integrity_error(
                    "verify reused tombstone",
                    &path,
                    "the reused journal entry disappeared",
                ))
            })?;
        validate_tombstone(&tombstone, session_id, &path).map_err(PreparationFailure::retain)
    }

    async fn load_tombstone(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<SessionDeletionTombstone>, AppError> {
        let path = self.tombstone_path(session_id);
        self.validate_access(&path).await?;
        let Some(bytes) = self
            .persistence
            .read(&path)
            .await
            .map_err(|source| journal_persistence_error("read tombstone", &path, source))?
        else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|source| journal_integrity_error("parse tombstone", &path, source))
    }

    fn finish_recovery(
        &self,
        maintenance: &crate::session_maintenance::SessionMaintenanceLease,
    ) -> Result<(), AppError> {
        self.maintenance
            .clear_recovery_required(maintenance.session_id())
            .map_err(AppError::from)?;
        self.clear_pending(maintenance.session_id());
        Ok(())
    }

    fn tombstone_path(&self, session_id: &SessionId) -> PathBuf {
        self.journal_directory
            .join(format!("{}{TOMBSTONE_SUFFIX}", session_id.as_str()))
    }

    fn mark_pending(&self, session_id: &SessionId) {
        let mut state = self.state();
        if state.pending.insert(session_id.clone()) {
            state.generation = state.generation.wrapping_add(1);
        }
    }

    fn clear_pending(&self, session_id: &SessionId) {
        let mut state = self.state();
        if state.pending.remove(session_id) {
            state.generation = state.generation.wrapping_add(1);
        }
    }

    fn is_pending(&self, session_id: &SessionId) -> bool {
        self.state().pending.contains(session_id)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SessionDeletionState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn workers(&self) -> std::sync::MutexGuard<'_, HashSet<SessionId>> {
        self.workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn validate_access(&self, entry_path: &Path) -> Result<(), AppError> {
        validate_journal_access(
            self.data_directory.clone(),
            self.journal_directory.clone(),
            entry_path.to_path_buf(),
        )
        .await
    }
}

struct PreparationFailure {
    error: AppError,
    clear_recovery: bool,
}

impl PreparationFailure {
    fn retain(error: AppError) -> Self {
        Self {
            error,
            clear_recovery: false,
        }
    }

    fn clear(error: AppError) -> Self {
        Self {
            error,
            clear_recovery: true,
        }
    }
}

fn validate_tombstone(
    tombstone: &SessionDeletionTombstone,
    expected: &SessionId,
    path: &Path,
) -> Result<(), AppError> {
    if tombstone.schema_version != TOMBSTONE_SCHEMA_VERSION {
        return Err(journal_integrity_error(
            "validate tombstone schema",
            path,
            format!("unsupported schema version {}", tombstone.schema_version),
        ));
    }
    if &tombstone.session_id != expected {
        return Err(journal_integrity_error(
            "validate tombstone session",
            path,
            "the document session does not match its file name",
        ));
    }
    Ok(())
}

async fn discover_pending_sessions(
    data_directory: PathBuf,
    journal_directory: PathBuf,
) -> Result<Vec<SessionId>, AppError> {
    tokio::task::spawn_blocking(move || {
        discover_pending_sessions_blocking(&data_directory, &journal_directory)
    })
    .await
    .map_err(|source| AppError::internal(format!("Session deletion discovery failed: {source}")))?
}

fn discover_pending_sessions_blocking(
    data_directory: &Path,
    journal_directory: &Path,
) -> Result<Vec<SessionId>, AppError> {
    let Some(canonical_journal) =
        validate_journal_root_blocking(data_directory, journal_directory)?
    else {
        return Ok(Vec::new());
    };

    let entries = match fs::read_dir(journal_directory) {
        Ok(entries) => entries,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(journal_io_error(
                "enumerate deletion journal",
                journal_directory,
                source,
            ));
        }
    };

    let mut pending = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| {
            journal_io_error("read deletion journal entry", journal_directory, source)
        })?;
        validate_journal_entry_blocking(&canonical_journal, &entry.path())?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            return Err(journal_integrity_error(
                "validate deletion journal entry name",
                &entry.path(),
                "session deletion journal entry name is not UTF-8",
            ));
        };
        let Some(raw_id) = file_name.strip_suffix(TOMBSTONE_SUFFIX) else {
            continue;
        };
        let session_id = SessionId::parse(raw_id).map_err(|source| {
            journal_integrity_error(
                "validate deletion journal entry ID",
                &entry.path(),
                format!("session deletion journal entry has an invalid ID: {source}"),
            )
        })?;
        pending.push(session_id);
    }
    pending.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
    Ok(pending)
}

async fn validate_journal_access(
    data_directory: PathBuf,
    journal_directory: PathBuf,
    entry_path: PathBuf,
) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let canonical_journal =
            validate_journal_root_blocking(&data_directory, &journal_directory)?;
        if entry_path.parent() != Some(journal_directory.as_path()) {
            return Err(journal_integrity_error(
                "validate deletion journal entry location",
                &entry_path,
                "entry is not a direct child of the deletion journal",
            ));
        }
        if let Some(canonical_journal) = canonical_journal {
            validate_journal_entry_if_present_blocking(&canonical_journal, &entry_path)?;
        }
        Ok(())
    })
    .await
    .map_err(|source| {
        AppError::internal(format!("Session deletion path validation failed: {source}"))
    })?
}

fn validate_journal_root_blocking(
    data_directory: &Path,
    journal_directory: &Path,
) -> Result<Option<PathBuf>, AppError> {
    let data_metadata = fs::symlink_metadata(data_directory).map_err(|source| {
        journal_io_error("inspect application data root", data_directory, source)
    })?;
    if !data_metadata.is_dir()
        || data_metadata.file_type().is_symlink()
        || is_reparse_point(&data_metadata)
    {
        return Err(journal_integrity_error(
            "validate application data root",
            data_directory,
            "application data root is not a stable regular directory",
        ));
    }
    let canonical_data = dunce::canonicalize(data_directory).map_err(|source| {
        journal_io_error("canonicalize application data root", data_directory, source)
    })?;
    if journal_directory.parent() != Some(data_directory) {
        return Err(journal_integrity_error(
            "validate deletion journal location",
            journal_directory,
            "journal is not a direct child of the application data root",
        ));
    }

    let journal_metadata = match fs::symlink_metadata(journal_directory) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(journal_io_error(
                "inspect deletion journal",
                journal_directory,
                source,
            ));
        }
    };
    if !journal_metadata.is_dir()
        || journal_metadata.file_type().is_symlink()
        || is_reparse_point(&journal_metadata)
    {
        return Err(journal_integrity_error(
            "validate deletion journal",
            journal_directory,
            "journal is not a stable regular directory",
        ));
    }
    let canonical_journal = dunce::canonicalize(journal_directory).map_err(|source| {
        journal_io_error("canonicalize deletion journal", journal_directory, source)
    })?;
    if canonical_journal.parent() != Some(canonical_data.as_path()) {
        return Err(journal_integrity_error(
            "validate canonical deletion journal location",
            &canonical_journal,
            "journal resolves outside the application data root",
        ));
    }
    Ok(Some(canonical_journal))
}

fn validate_journal_entry_if_present_blocking(
    canonical_journal: &Path,
    entry_path: &Path,
) -> Result<(), AppError> {
    match fs::symlink_metadata(entry_path) {
        Ok(_) => validate_journal_entry_blocking(canonical_journal, entry_path),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(journal_io_error(
            "inspect deletion journal entry",
            entry_path,
            source,
        )),
    }
}

fn validate_journal_entry_blocking(
    canonical_journal: &Path,
    entry_path: &Path,
) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(entry_path)
        .map_err(|source| journal_io_error("inspect deletion journal entry", entry_path, source))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(journal_integrity_error(
            "validate deletion journal entry",
            entry_path,
            "entry is not a stable regular file",
        ));
    }
    let canonical_entry = dunce::canonicalize(entry_path).map_err(|source| {
        journal_io_error("canonicalize deletion journal entry", entry_path, source)
    })?;
    if canonical_entry.parent() != Some(canonical_journal) {
        return Err(journal_integrity_error(
            "validate canonical deletion journal entry location",
            &canonical_entry,
            "entry resolves outside the deletion journal",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn journal_io_error(
    operation: &'static str,
    path: &Path,
    source: impl std::fmt::Display,
) -> AppError {
    AppError::storage(
        "Session deletion could not be completed",
        format!("{operation} at {}: {source}", path.display()),
        true,
    )
}

fn journal_persistence_error(operation: &'static str, path: &Path, source: AppError) -> AppError {
    let retryable = source.retryable();
    AppError::storage(
        "Session deletion could not be completed",
        format!("{operation} at {}: {source}", path.display()),
        retryable,
    )
}

fn journal_integrity_error(
    operation: &'static str,
    path: &Path,
    source: impl std::fmt::Display,
) -> AppError {
    AppError::storage(
        "Session deletion journal is unsafe or corrupt",
        format!("{operation} at {}: {source}", path.display()),
        false,
    )
}

fn worker_response_error() -> AppError {
    AppError::internal("Session deletion worker exited without reporting a result")
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        path::Path,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use crate::session_maintenance::SessionMaintenanceCoordinator;
    use codez_core::{
        AppError, AppErrorKind, AtomicCreateOutcome, AtomicPersistence, PortFuture, SessionId,
    };
    use tokio::sync::Notify;

    use super::{
        DELETION_STEPS, SessionDeletionOperations, SessionDeletionService, SessionDeletionStep,
    };

    #[derive(Default)]
    struct RecordingOperations {
        fail_at: Mutex<Option<SessionDeletionStep>>,
        calls: Mutex<Vec<SessionDeletionStep>>,
    }

    impl RecordingOperations {
        fn failing(step: SessionDeletionStep) -> Self {
            Self {
                fail_at: Mutex::new(Some(step)),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn clear_failure(&self) {
            *self
                .fail_at
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        }

        fn calls(&self) -> Vec<SessionDeletionStep> {
            self.calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl SessionDeletionOperations for RecordingOperations {
        fn execute<'a>(
            &'a self,
            step: SessionDeletionStep,
            _session_id: &'a SessionId,
        ) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(step);
                if *self
                    .fail_at
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    == Some(step)
                {
                    Err(AppError::storage(
                        "Injected session cleanup failure",
                        format!("failed at {step:?}"),
                        true,
                    ))
                } else {
                    Ok(())
                }
            })
        }
    }

    #[derive(Default)]
    struct TestPersistence {
        fail_create: AtomicBool,
    }

    impl TestPersistence {
        fn failing_create() -> Self {
            Self {
                fail_create: AtomicBool::new(true),
            }
        }
    }

    impl AtomicPersistence for TestPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move {
                match fs::read(path) {
                    Ok(bytes) => Ok(Some(bytes)),
                    Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(source) => Err(test_persistence_error("read", path, source)),
                }
            })
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                create_parent(path)?;
                fs::write(path, bytes)
                    .map_err(|source| test_persistence_error("replace", path, source))
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                if self.fail_create.load(Ordering::Acquire) {
                    return Err(test_persistence_error(
                        "create",
                        path,
                        "injected create failure",
                    ));
                }
                create_parent(path)?;
                match OpenOptions::new().write(true).create_new(true).open(path) {
                    Ok(mut file) => {
                        file.write_all(bytes)
                            .and_then(|()| file.sync_all())
                            .map_err(|source| test_persistence_error("create", path, source))?;
                        Ok(AtomicCreateOutcome::Created)
                    }
                    Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                        let existing = fs::read(path)
                            .map_err(|error| test_persistence_error("compare", path, error))?;
                        if existing == bytes {
                            Ok(AtomicCreateOutcome::Reused)
                        } else {
                            Err(test_persistence_error(
                                "compare",
                                path,
                                "immutable resource conflict",
                            ))
                        }
                    }
                    Err(source) => Err(test_persistence_error("create", path, source)),
                }
            })
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                create_parent(path)?;
                let mut file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .map_err(|source| test_persistence_error("append", path, source))?;
                file.write_all(bytes)
                    .and_then(|()| file.sync_all())
                    .map_err(|source| test_persistence_error("append", path, source))
            })
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move {
                match fs::remove_file(path) {
                    Ok(()) => Ok(true),
                    Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
                    Err(source) => Err(test_persistence_error("remove", path, source)),
                }
            })
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum BlockingPersistenceStage {
        Create,
        Remove,
    }

    struct BlockingPersistence {
        stage: BlockingPersistenceStage,
        started: Notify,
        release: Notify,
        delegate: TestPersistence,
    }

    impl BlockingPersistence {
        fn new(stage: BlockingPersistenceStage) -> Self {
            Self {
                stage,
                started: Notify::new(),
                release: Notify::new(),
                delegate: TestPersistence::default(),
            }
        }
    }

    impl AtomicPersistence for BlockingPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            self.delegate.read(path)
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            self.delegate.replace(path, bytes)
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                if self.stage == BlockingPersistenceStage::Create {
                    self.started.notify_one();
                    self.release.notified().await;
                }
                self.delegate.create_no_clobber(path, bytes).await
            })
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            self.delegate.append(path, bytes)
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move {
                let removed = self.delegate.remove(path).await?;
                if self.stage == BlockingPersistenceStage::Remove {
                    self.started.notify_one();
                    self.release.notified().await;
                }
                Ok(removed)
            })
        }
    }

    struct ReusedTombstonePersistence {
        reads: AtomicUsize,
        reused_bytes: Vec<u8>,
    }

    impl AtomicPersistence for ReusedTombstonePersistence {
        fn read<'a>(&'a self, _path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move {
                if self.reads.fetch_add(1, Ordering::AcqRel) == 0 {
                    Ok(None)
                } else {
                    Ok(Some(self.reused_bytes.clone()))
                }
            })
        }

        fn replace<'a>(&'a self, path: &'a Path, _bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                Err(test_persistence_error(
                    "unexpected replace",
                    path,
                    "operation is not used by this fixture",
                ))
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            _path: &'a Path,
            _bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async { Ok(AtomicCreateOutcome::Reused) })
        }

        fn append<'a>(&'a self, path: &'a Path, _bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                Err(test_persistence_error(
                    "unexpected append",
                    path,
                    "operation is not used by this fixture",
                ))
            })
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move {
                Err(test_persistence_error(
                    "unexpected remove",
                    path,
                    "operation is not used by this fixture",
                ))
            })
        }
    }

    struct BlockingOperations {
        started: Notify,
        release: Notify,
    }

    impl BlockingOperations {
        fn new() -> Self {
            Self {
                started: Notify::new(),
                release: Notify::new(),
            }
        }
    }

    impl SessionDeletionOperations for BlockingOperations {
        fn execute<'a>(
            &'a self,
            step: SessionDeletionStep,
            _session_id: &'a SessionId,
        ) -> PortFuture<'a, ()> {
            Box::pin(async move {
                if step == SessionDeletionStep::Permissions {
                    self.started.notify_one();
                    self.release.notified().await;
                }
                Ok(())
            })
        }
    }

    fn session_id() -> SessionId {
        SessionId::parse("session-delete-fixture").expect("fixture session ID must be valid")
    }

    fn service(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        operations: Arc<dyn SessionDeletionOperations>,
    ) -> SessionDeletionService {
        service_with_maintenance(
            data_directory,
            persistence,
            operations,
            Arc::new(SessionMaintenanceCoordinator::new()),
        )
    }

    fn service_with_maintenance(
        data_directory: &Path,
        persistence: Arc<dyn AtomicPersistence>,
        operations: Arc<dyn SessionDeletionOperations>,
        maintenance: Arc<SessionMaintenanceCoordinator>,
    ) -> SessionDeletionService {
        SessionDeletionService::new(data_directory, persistence, operations, maintenance)
    }

    async fn wait_until_available(service: &SessionDeletionService, session_id: &SessionId) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while service.ensure_available(session_id).is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached deletion worker must finish");
    }

    fn create_parent(path: &Path) -> Result<(), AppError> {
        let parent = path
            .parent()
            .ok_or_else(|| test_persistence_error("resolve parent", path, "path has no parent"))?;
        fs::create_dir_all(parent)
            .map_err(|source| test_persistence_error("create parent", path, source))
    }

    fn test_persistence_error(
        operation: &'static str,
        path: &Path,
        source: impl std::fmt::Display,
    ) -> AppError {
        AppError::storage(
            "Test persistence failed",
            format!("{operation} at {}: {source}", path.display()),
            true,
        )
    }

    async fn assert_step_failure_retains_tombstone(step: SessionDeletionStep) {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(RecordingOperations::failing(step));
        let service = service(directory.path(), persistence, operations);
        let session_id = session_id();

        let result = service.delete(&session_id).await;
        let blocked = service
            .ensure_available(&session_id)
            .expect_err("pending deletion must block the session");

        assert!(
            result.is_err()
                && service.inner.tombstone_path(&session_id).is_file()
                && blocked.kind() == AppErrorKind::RunActive
                && blocked.retryable()
        );
    }

    macro_rules! deletion_step_failure_test {
        ($name:ident, $step:expr) => {
            #[tokio::test]
            async fn $name() {
                assert_step_failure_retains_tombstone($step).await;
            }
        };
    }

    deletion_step_failure_test!(
        permission_failure_retains_tombstone,
        SessionDeletionStep::Permissions
    );
    deletion_step_failure_test!(
        edit_transaction_failure_retains_tombstone,
        SessionDeletionStep::EditTransactions
    );
    deletion_step_failure_test!(todo_failure_retains_tombstone, SessionDeletionStep::Todos);
    deletion_step_failure_test!(
        attachment_failure_retains_tombstone,
        SessionDeletionStep::Attachments
    );
    deletion_step_failure_test!(
        ledger_failure_retains_tombstone,
        SessionDeletionStep::Ledger
    );
    deletion_step_failure_test!(
        fingerprint_failure_retains_tombstone,
        SessionDeletionStep::Fingerprints
    );
    deletion_step_failure_test!(
        session_document_failure_retains_tombstone,
        SessionDeletionStep::SessionDocument
    );

    #[tokio::test]
    async fn tombstone_failure_prevents_every_destructive_step() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::failing_create());
        let operations = Arc::new(RecordingOperations::default());
        let service = service(directory.path(), persistence, operations.clone());
        let session_id = session_id();

        let error = service
            .delete(&session_id)
            .await
            .expect_err("injected create failure must be returned");

        assert!(
            error.kind() == AppErrorKind::Storage
                && error.retryable()
                && operations.calls().is_empty()
                && service.ensure_available(&session_id).is_ok()
        );
    }

    #[tokio::test]
    async fn retry_replays_all_steps_and_finalizes_tombstone() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(RecordingOperations::failing(
            SessionDeletionStep::Attachments,
        ));
        let maintenance = Arc::new(SessionMaintenanceCoordinator::new());
        let service = service_with_maintenance(
            directory.path(),
            persistence,
            operations.clone(),
            Arc::clone(&maintenance),
        );
        let session_id = session_id();
        service
            .delete(&session_id)
            .await
            .expect_err("first cleanup must fail");
        let blocked = maintenance
            .try_begin_activity(session_id.clone())
            .map_err(AppError::from)
            .expect_err("failed worker must leave durable recovery block");
        operations.clear_failure();

        service
            .delete(&session_id)
            .await
            .expect("retry must finish the deletion");

        assert!(
            !service.inner.tombstone_path(&session_id).exists()
                && service.ensure_available(&session_id).is_ok()
                && blocked.kind() == AppErrorKind::RunActive
                && operations.calls().ends_with(&DELETION_STEPS)
        );
    }

    #[tokio::test]
    async fn cancelled_caller_does_not_cancel_committed_deletion_worker() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(BlockingOperations::new());
        let service = Arc::new(service(directory.path(), persistence, operations.clone()));
        let session_id = session_id();
        let task_service = Arc::clone(&service);
        let task_session_id = session_id.clone();
        let task = tokio::spawn(async move { task_service.delete(&task_session_id).await });
        operations.started.notified().await;

        task.abort();
        let _cancelled = task.await;
        operations.release.notify_one();
        wait_until_available(&service, &session_id).await;

        assert!(
            !service.inner.tombstone_path(&session_id).exists()
                && service.ensure_available(&session_id).is_ok()
        );
    }

    #[tokio::test]
    async fn cancelled_caller_during_tombstone_create_does_not_cancel_worker() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence = Arc::new(BlockingPersistence::new(BlockingPersistenceStage::Create));
        let operations = Arc::new(RecordingOperations::default());
        let service = Arc::new(service(
            directory.path(),
            persistence.clone(),
            operations.clone(),
        ));
        let session_id = session_id();
        let task_service = Arc::clone(&service);
        let task_session_id = session_id.clone();
        let task = tokio::spawn(async move { task_service.delete(&task_session_id).await });
        persistence.started.notified().await;

        task.abort();
        let _cancelled = task.await;
        assert!(service.ensure_available(&session_id).is_err());
        persistence.release.notify_one();
        wait_until_available(&service, &session_id).await;

        assert!(
            operations.calls() == DELETION_STEPS
                && !service.inner.tombstone_path(&session_id).exists()
        );
    }

    #[tokio::test]
    async fn cancelled_caller_after_remove_keeps_session_blocked_until_finalize() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence = Arc::new(BlockingPersistence::new(BlockingPersistenceStage::Remove));
        let operations = Arc::new(RecordingOperations::default());
        let service = Arc::new(service(directory.path(), persistence.clone(), operations));
        let session_id = session_id();
        let task_service = Arc::clone(&service);
        let task_session_id = session_id.clone();
        let task = tokio::spawn(async move { task_service.delete(&task_session_id).await });
        persistence.started.notified().await;

        assert!(
            !service.inner.tombstone_path(&session_id).exists()
                && service.ensure_available(&session_id).is_err()
        );
        task.abort();
        let _cancelled = task.await;
        persistence.release.notify_one();
        wait_until_available(&service, &session_id).await;

        assert!(service.ensure_available(&session_id).is_ok());
    }

    #[tokio::test]
    async fn concurrent_delete_returns_run_active_without_replaying_cleanup() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(BlockingOperations::new());
        let service = Arc::new(service(directory.path(), persistence, operations.clone()));
        let session_id = session_id();
        let task_service = Arc::clone(&service);
        let task_session_id = session_id.clone();
        let first = tokio::spawn(async move { task_service.delete(&task_session_id).await });
        operations.started.notified().await;

        let duplicate = service
            .delete(&session_id)
            .await
            .expect_err("concurrent deletion must be rejected");
        operations.release.notify_one();
        first
            .await
            .expect("first caller task must finish")
            .expect("first deletion must finish");

        assert!(
            duplicate.kind() == AppErrorKind::RunActive
                && duplicate.retryable()
                && service.ensure_available(&session_id).is_ok()
        );
    }

    #[tokio::test]
    async fn recovery_block_rejects_shared_exclusive_and_ordinary_maintenance() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(BlockingOperations::new());
        let maintenance = Arc::new(SessionMaintenanceCoordinator::new());
        let service = Arc::new(service_with_maintenance(
            directory.path(),
            persistence,
            operations.clone(),
            Arc::clone(&maintenance),
        ));
        let session_id = session_id();
        let task_service = Arc::clone(&service);
        let task_session_id = session_id.clone();
        let deletion = tokio::spawn(async move { task_service.delete(&task_session_id).await });
        operations.started.notified().await;

        let shared = maintenance
            .try_begin_activity(session_id.clone())
            .map_err(AppError::from)
            .expect_err("recovery must block shared activity");
        let exclusive = maintenance
            .try_begin_exclusive_activity(session_id.clone())
            .map_err(AppError::from)
            .expect_err("recovery must block exclusive activity");
        let ordinary_maintenance = maintenance
            .try_begin_maintenance(session_id)
            .map_err(AppError::from)
            .expect_err("recovery must block ordinary maintenance");
        operations.release.notify_one();
        deletion
            .await
            .expect("deletion caller task must finish")
            .expect("deletion must finish");

        assert!(
            [shared, exclusive, ordinary_maintenance]
                .iter()
                .all(|error| error.kind() == AppErrorKind::RunActive && error.retryable())
        );
    }

    #[tokio::test]
    async fn reserved_delete_blocks_restore_before_tombstone_creation() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence = Arc::new(BlockingPersistence::new(BlockingPersistenceStage::Create));
        let operations = Arc::new(RecordingOperations::default());
        let maintenance = Arc::new(SessionMaintenanceCoordinator::new());
        let service = Arc::new(service_with_maintenance(
            directory.path(),
            persistence.clone(),
            operations,
            Arc::clone(&maintenance),
        ));
        let session_id = session_id();
        let decision = maintenance
            .try_begin_maintenance(session_id.clone())
            .expect("delete decision must own session maintenance");
        let task_service = Arc::clone(&service);
        let deletion =
            tokio::spawn(async move { task_service.delete_with_maintenance(decision).await });
        persistence.started.notified().await;

        let restore = maintenance
            .try_begin_activity(session_id.clone())
            .map_err(AppError::from)
            .expect_err("recovery marker must block restore before tombstone creation");
        let availability = service
            .ensure_available(&session_id)
            .expect_err("reserved deletion must be visible while tombstone creation is blocked");
        persistence.release.notify_one();
        deletion
            .await
            .expect("reserved deletion task must finish")
            .expect("reserved deletion must finish after tombstone release");

        assert!(
            restore.kind() == AppErrorKind::RunActive
                && restore.retryable()
                && availability.kind() == AppErrorKind::RunActive
                && service.ensure_available(&session_id).is_ok()
        );
    }

    #[tokio::test]
    async fn reserved_delete_releases_recovery_when_tombstone_is_not_committed() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::failing_create());
        let operations = Arc::new(RecordingOperations::default());
        let maintenance = Arc::new(SessionMaintenanceCoordinator::new());
        let service = service_with_maintenance(
            directory.path(),
            persistence,
            operations.clone(),
            Arc::clone(&maintenance),
        );
        let session_id = session_id();
        let decision = maintenance
            .try_begin_maintenance(session_id.clone())
            .expect("delete decision must own session maintenance");

        let error = service
            .delete_with_maintenance(decision)
            .await
            .expect_err("uncommitted tombstone must fail deletion");
        let restored_activity = maintenance.try_begin_activity(session_id.clone());

        assert!(
            error.kind() == AppErrorKind::Storage
                && error.retryable()
                && operations.calls().is_empty()
                && restored_activity.is_ok()
                && service.ensure_available(&session_id).is_ok()
        );
    }

    #[tokio::test]
    async fn completed_deletion_invalidates_an_in_flight_list_snapshot() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(RecordingOperations::default());
        let service = service(directory.path(), persistence, operations);
        let snapshot = service
            .begin_list_snapshot()
            .expect("initial list snapshot must be available");

        service
            .delete(&session_id())
            .await
            .expect("deletion must complete");
        let error = service
            .ensure_list_unchanged(snapshot)
            .expect_err("snapshot crossing deletion must be rejected");

        assert!(error.kind() == AppErrorKind::RunActive && error.retryable());
    }

    #[tokio::test]
    async fn startup_recovery_replays_tombstone_and_unblocks_session() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let failing = Arc::new(RecordingOperations::failing(
            SessionDeletionStep::Attachments,
        ));
        let first = service(directory.path(), Arc::clone(&persistence), failing);
        let session_id = session_id();
        first
            .delete(&session_id)
            .await
            .expect_err("first process must leave a tombstone");
        let recovered_operations = Arc::new(RecordingOperations::default());
        let recovered = service(directory.path(), persistence, recovered_operations.clone());

        recovered
            .recover_pending()
            .await
            .expect("startup must recover pending deletion");

        assert!(
            recovered_operations.calls() == DELETION_STEPS
                && !recovered.inner.tombstone_path(&session_id).exists()
                && recovered.ensure_available(&session_id).is_ok()
        );
    }

    #[tokio::test]
    async fn corrupt_startup_tombstone_keeps_session_blocked() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(RecordingOperations::default());
        let service = service(directory.path(), Arc::clone(&persistence), operations);
        let session_id = session_id();
        persistence
            .replace(&service.inner.tombstone_path(&session_id), b"{not-json")
            .await
            .expect("corrupt fixture must be persisted");

        let error = service
            .recover_pending()
            .await
            .expect_err("corrupt recovery must fail");
        let blocked = service
            .ensure_available(&session_id)
            .expect_err("corrupt recovery must keep the session blocked");

        assert!(
            error.kind() == AppErrorKind::Storage
                && !error.retryable()
                && blocked.kind() == AppErrorKind::RunActive
                && blocked.retryable()
        );
    }

    #[tokio::test]
    async fn mismatched_tombstone_cannot_be_used_for_another_session() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(RecordingOperations::default());
        let service = service(
            directory.path(),
            Arc::clone(&persistence),
            operations.clone(),
        );
        let requested = session_id();
        let other = SessionId::parse("other-session").expect("fixture session ID must be valid");
        let bytes = serde_json::to_vec_pretty(&super::SessionDeletionTombstone::new(other))
            .expect("fixture tombstone must serialize");
        persistence
            .replace(&service.inner.tombstone_path(&requested), &bytes)
            .await
            .expect("fixture tombstone must persist");

        let error = service
            .delete(&requested)
            .await
            .expect_err("mismatched tombstone must fail");

        assert!(
            error.kind() == AppErrorKind::Storage
                && !error.retryable()
                && operations.calls().is_empty()
                && service.ensure_available(&requested).is_err()
        );
    }

    #[tokio::test]
    async fn unsupported_tombstone_schema_is_non_retryable_and_stays_blocked() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(RecordingOperations::default());
        let service = service(
            directory.path(),
            Arc::clone(&persistence),
            operations.clone(),
        );
        let session_id = session_id();
        let bytes = serde_json::to_vec_pretty(&super::SessionDeletionTombstone {
            schema_version: super::TOMBSTONE_SCHEMA_VERSION + 1,
            session_id: session_id.clone(),
        })
        .expect("fixture tombstone must serialize");
        persistence
            .replace(&service.inner.tombstone_path(&session_id), &bytes)
            .await
            .expect("fixture tombstone must persist");

        let error = service
            .delete(&session_id)
            .await
            .expect_err("unsupported schema must fail");

        assert!(
            error.kind() == AppErrorKind::Storage
                && !error.retryable()
                && operations.calls().is_empty()
                && service.ensure_available(&session_id).is_err()
        );
    }

    #[tokio::test]
    async fn unsafe_tombstone_entry_is_non_retryable_and_stays_blocked() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(TestPersistence::default());
        let operations = Arc::new(RecordingOperations::default());
        let service = service(directory.path(), persistence, operations.clone());
        let session_id = session_id();
        fs::create_dir_all(service.inner.tombstone_path(&session_id))
            .expect("unsafe fixture directory must be created");

        let error = service
            .delete(&session_id)
            .await
            .expect_err("unsafe journal entry must fail");

        assert!(
            error.kind() == AppErrorKind::Storage
                && !error.retryable()
                && operations.calls().is_empty()
                && service.ensure_available(&session_id).is_err()
        );
    }

    #[tokio::test]
    async fn reused_tombstone_is_reloaded_before_cleanup() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let requested = session_id();
        let other = SessionId::parse("other-session").expect("fixture session ID must be valid");
        let reused_bytes = serde_json::to_vec_pretty(&super::SessionDeletionTombstone::new(other))
            .expect("fixture tombstone must serialize");
        let persistence: Arc<dyn AtomicPersistence> = Arc::new(ReusedTombstonePersistence {
            reads: AtomicUsize::new(0),
            reused_bytes,
        });
        let operations = Arc::new(RecordingOperations::default());
        let service = service(directory.path(), persistence, operations.clone());

        let error = service
            .delete(&requested)
            .await
            .expect_err("reused mismatched tombstone must fail");

        assert!(
            error.kind() == AppErrorKind::Storage
                && !error.retryable()
                && operations.calls().is_empty()
                && service.ensure_available(&requested).is_err()
        );
    }
}
