use std::{
    collections::HashMap,
    error::Error as StdError,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};

use codez_core::AppError;
use serde::{Serialize, de::DeserializeOwned};
use tempfile::Builder;
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;

const DEFAULT_MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_QUARANTINE_COLLISIONS: usize = 10_000;

type ResourceLock = AsyncMutex<()>;

/// An injectable checkpoint before an atomic file operation changes durable state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicWriteStage {
    /// Before a temporary file or append handle is created.
    BeforeTemporaryFile,
    /// After temporary data is synced but before the target is replaced or appended.
    BeforeCommit,
}

/// Outcome of atomically creating an immutable JSON document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicCreateOutcome {
    /// No target existed and the new document was committed.
    Created,
    /// An existing regular file contained the same serialized bytes.
    Reused,
}

/// Deterministic failure used to verify crash-safe storage behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("storage fault injected at {stage:?}")]
pub struct InjectedWriteFault {
    /// Checkpoint at which the operation was interrupted.
    pub stage: AtomicWriteStage,
}

impl InjectedWriteFault {
    /// Creates a deterministic fault for the requested checkpoint.
    #[must_use]
    pub const fn at(stage: AtomicWriteStage) -> Self {
        Self { stage }
    }
}

/// Test or diagnostic boundary for injecting failures before storage commits.
pub trait AtomicWriteFaultInjector: Send + Sync {
    /// Returns an injected failure for a selected operation checkpoint.
    ///
    /// # Errors
    ///
    /// Returns [`InjectedWriteFault`] when the caller should abort the write.
    fn check(&self, stage: AtomicWriteStage, target: &Path) -> Result<(), InjectedWriteFault>;
}

#[derive(Debug)]
struct NoFaults;

impl AtomicWriteFaultInjector for NoFaults {
    fn check(&self, _stage: AtomicWriteStage, _target: &Path) -> Result<(), InjectedWriteFault> {
        Ok(())
    }
}

/// Valid JSONL records recovered from one active file.
#[derive(Debug)]
pub struct JsonLinesRead<T> {
    /// Records parsed before end-of-file or the first malformed line.
    pub records: Vec<T>,
    /// Preserved source file when a malformed suffix was isolated.
    pub quarantine_path: Option<PathBuf>,
}

/// Typed failures produced by atomic file and recovery operations.
#[derive(Debug, Error)]
pub enum StorageError {
    /// The configured document limit cannot protect reads and writes.
    #[error("maximum document size must be greater than zero")]
    InvalidDocumentLimit,
    /// A file exceeds the configured allocation and persistence limit.
    #[error("storage document exceeds {max_bytes} bytes: {path}")]
    DocumentTooLarge { path: PathBuf, max_bytes: u64 },
    /// A target is a symlink or another unsupported filesystem object.
    #[error("storage target is not a regular file: {0}")]
    UnsafeFileType(PathBuf),
    /// An immutable target already exists with different bytes.
    #[error("immutable storage target already contains different data: {0}")]
    ImmutableConflict(PathBuf),
    /// A path cannot identify a file within a parent directory.
    #[error("storage target does not have a usable parent and file name: {0}")]
    InvalidPath(PathBuf),
    /// A filesystem operation failed.
    #[error("storage I/O failed while attempting to {operation}: {path}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// JSON serialization failed before the target was changed.
    #[error("failed to serialize JSON for storage target: {path}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    /// Corrupt JSON was moved away from the active repository path.
    #[error("corrupt JSON was isolated from {path} at {quarantine_path}")]
    CorruptJson {
        path: PathBuf,
        quarantine_path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    /// Corrupt JSON could not be moved away from the active path.
    #[error("corrupt JSON could not be isolated from {path}: {parse_error}")]
    CorruptJsonIsolation {
        path: PathBuf,
        parse_error: String,
        #[source]
        source: io::Error,
    },
    /// A malformed JSONL source was preserved, but its valid prefix could not be restored.
    #[error("valid JSONL prefix could not be restored to {path}; source is at {quarantine_path}")]
    JsonLinesRecovery {
        path: PathBuf,
        quarantine_path: PathBuf,
        #[source]
        source: Box<StorageError>,
    },
    /// A malformed JSONL source could not be quarantined.
    #[error("malformed JSONL line {line} could not be isolated from {path}: {parse_error}")]
    JsonLinesIsolation {
        path: PathBuf,
        line: usize,
        parse_error: String,
        #[source]
        source: io::Error,
    },
    /// A deterministic fault interrupted the write before commit.
    #[error("storage write to {path} was interrupted before commit")]
    Injected {
        path: PathBuf,
        #[source]
        source: InjectedWriteFault,
    },
    /// A blocking storage task could not be joined.
    #[error("storage worker failed for {path}")]
    TaskJoin {
        path: PathBuf,
        #[source]
        source: tokio::task::JoinError,
    },
}

impl From<StorageError> for AppError {
    fn from(error: StorageError) -> Self {
        let public_message = match &error {
            StorageError::CorruptJson { .. } => "Some local data was corrupt and was isolated",
            StorageError::JsonLinesRecovery { .. } => {
                "Some local data was isolated and requires recovery"
            }
            StorageError::CorruptJsonIsolation { .. } | StorageError::JsonLinesIsolation { .. } => {
                "Some local data is corrupt and could not be isolated safely"
            }
            StorageError::DocumentTooLarge { .. } => "A local data file is too large",
            StorageError::InvalidDocumentLimit
            | StorageError::UnsafeFileType(_)
            | StorageError::ImmutableConflict(_)
            | StorageError::InvalidPath(_)
            | StorageError::Io { .. }
            | StorageError::Serialize { .. }
            | StorageError::Injected { .. }
            | StorageError::TaskJoin { .. } => "The local data operation failed",
        };
        let diagnostic = error_diagnostic(&error);
        AppError::storage(public_message, diagnostic, false)
    }
}

/// Per-resource atomic JSON and recoverable JSONL persistence.
#[derive(Clone)]
pub struct AtomicFileStore {
    resource_locks: Arc<Mutex<HashMap<PathBuf, Weak<ResourceLock>>>>,
    fault_injector: Arc<dyn AtomicWriteFaultInjector>,
    max_document_bytes: u64,
}

impl std::fmt::Debug for AtomicFileStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AtomicFileStore")
            .field("max_document_bytes", &self.max_document_bytes)
            .finish_non_exhaustive()
    }
}

impl Default for AtomicFileStore {
    fn default() -> Self {
        Self::from_parts(DEFAULT_MAX_DOCUMENT_BYTES, Arc::new(NoFaults))
    }
}

impl AtomicFileStore {
    /// Returns the maximum JSON or JSONL document size accepted by this store.
    #[must_use]
    pub const fn max_document_bytes(&self) -> u64 {
        self.max_document_bytes
    }

    /// Creates a store with an explicit maximum JSON/JSONL file size.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::InvalidDocumentLimit`] when `max_document_bytes`
    /// is zero.
    pub fn with_max_document_bytes(max_document_bytes: u64) -> Result<Self, StorageError> {
        if max_document_bytes == 0 {
            return Err(StorageError::InvalidDocumentLimit);
        }
        Ok(Self::from_parts(max_document_bytes, Arc::new(NoFaults)))
    }

    /// Creates a bounded store with deterministic pre-commit fault injection.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::InvalidDocumentLimit`] when `max_document_bytes`
    /// is zero.
    pub fn with_fault_injector(
        max_document_bytes: u64,
        fault_injector: Arc<dyn AtomicWriteFaultInjector>,
    ) -> Result<Self, StorageError> {
        if max_document_bytes == 0 {
            return Err(StorageError::InvalidDocumentLimit);
        }
        Ok(Self::from_parts(max_document_bytes, fault_injector))
    }

    /// Reads and deserializes one JSON document without observing temporary files.
    ///
    /// Corrupt input is moved to a unique sibling path and reported as
    /// [`StorageError::CorruptJson`].
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for unsafe file types, excessive input, I/O,
    /// deserialization, quarantine, or worker failures.
    pub async fn read_json<T>(&self, path: &Path) -> Result<Option<T>, StorageError>
    where
        T: DeserializeOwned + Send + 'static,
    {
        let resource_lock = self.resource_lock(path);
        let _guard = resource_lock.lock().await;
        let task_path = path.to_path_buf();
        let error_path = task_path.clone();
        let max_document_bytes = self.max_document_bytes;
        tokio::task::spawn_blocking(move || read_json_blocking(&task_path, max_document_bytes))
            .await
            .map_err(|source| StorageError::TaskJoin {
                path: error_path,
                source,
            })?
    }

    /// Serializes and atomically replaces one JSON document.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when serialization, validation, temporary-file
    /// synchronization, fault injection, or atomic replacement fails.
    pub async fn write_json<T>(&self, path: &Path, value: &T) -> Result<(), StorageError>
    where
        T: Serialize + ?Sized,
    {
        let bytes = serde_json::to_vec_pretty(value).map_err(|source| StorageError::Serialize {
            path: path.to_path_buf(),
            source,
        })?;
        self.replace_bytes(path, bytes).await
    }

    /// Creates one immutable JSON document without replacing an existing value.
    ///
    /// Existing identical bytes are reused, making retries idempotent. A
    /// different existing document returns [`StorageError::ImmutableConflict`].
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when serialization, size validation, secure
    /// temporary persistence, or no-clobber comparison fails.
    pub async fn create_json<T>(
        &self,
        path: &Path,
        value: &T,
    ) -> Result<AtomicCreateOutcome, StorageError>
    where
        T: Serialize + ?Sized,
    {
        let bytes = serde_json::to_vec_pretty(value).map_err(|source| StorageError::Serialize {
            path: path.to_path_buf(),
            source,
        })?;
        self.create_bytes(path, bytes).await
    }

    /// Reads JSONL records and repairs a malformed suffix from the valid prefix.
    ///
    /// The complete malformed source is retained at `quarantine_path`; the active
    /// path is atomically restored to only the valid prefix.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for unsafe file types, excessive input, I/O,
    /// quarantine, prefix recovery, or worker failures.
    pub async fn read_json_lines<T>(
        &self,
        path: &Path,
    ) -> Result<Option<JsonLinesRead<T>>, StorageError>
    where
        T: DeserializeOwned + Send + 'static,
    {
        let resource_lock = self.resource_lock(path);
        let _guard = resource_lock.lock().await;
        let task_path = path.to_path_buf();
        let error_path = task_path.clone();
        let max_document_bytes = self.max_document_bytes;
        let fault_injector = Arc::clone(&self.fault_injector);
        tokio::task::spawn_blocking(move || {
            read_json_lines_blocking(&task_path, max_document_bytes, fault_injector.as_ref())
        })
        .await
        .map_err(|source| StorageError::TaskJoin {
            path: error_path,
            source,
        })?
    }

    /// Serializes records as compact JSONL and atomically replaces the file.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when serialization, size validation, or atomic
    /// persistence fails.
    pub async fn write_json_lines<T>(&self, path: &Path, records: &[T]) -> Result<(), StorageError>
    where
        T: Serialize,
    {
        let mut bytes = Vec::new();
        for record in records {
            serde_json::to_writer(&mut bytes, record).map_err(|source| {
                StorageError::Serialize {
                    path: path.to_path_buf(),
                    source,
                }
            })?;
            bytes.push(b'\n');
            ensure_size(path, bytes.len(), self.max_document_bytes)?;
        }
        self.replace_bytes(path, bytes).await
    }

    /// Appends one synced JSONL record under the target's single-writer lock.
    ///
    /// A process crash can truncate the final append; [`Self::read_json_lines`]
    /// detects and isolates that suffix without replaying later records.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when serialization, size validation, fault
    /// injection, append, or synchronization fails.
    pub async fn append_json_line<T>(&self, path: &Path, record: &T) -> Result<(), StorageError>
    where
        T: Serialize + ?Sized,
    {
        let mut bytes = serde_json::to_vec(record).map_err(|source| StorageError::Serialize {
            path: path.to_path_buf(),
            source,
        })?;
        bytes.push(b'\n');
        ensure_size(path, bytes.len(), self.max_document_bytes)?;

        let resource_lock = self.resource_lock(path);
        let _guard = resource_lock.lock().await;
        let task_path = path.to_path_buf();
        let error_path = task_path.clone();
        let max_document_bytes = self.max_document_bytes;
        let fault_injector = Arc::clone(&self.fault_injector);
        tokio::task::spawn_blocking(move || {
            append_bytes_blocking(
                &task_path,
                &bytes,
                max_document_bytes,
                fault_injector.as_ref(),
            )
        })
        .await
        .map_err(|source| StorageError::TaskJoin {
            path: error_path,
            source,
        })?
    }

    fn from_parts(
        max_document_bytes: u64,
        fault_injector: Arc<dyn AtomicWriteFaultInjector>,
    ) -> Self {
        Self {
            resource_locks: Arc::new(Mutex::new(HashMap::new())),
            fault_injector,
            max_document_bytes,
        }
    }

    fn resource_lock(&self, path: &Path) -> Arc<ResourceLock> {
        let mut locks = self
            .resource_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(ResourceLock::new(()));
        locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
        lock
    }

    async fn replace_bytes(&self, path: &Path, bytes: Vec<u8>) -> Result<(), StorageError> {
        ensure_size(path, bytes.len(), self.max_document_bytes)?;
        let resource_lock = self.resource_lock(path);
        let _guard = resource_lock.lock().await;
        let task_path = path.to_path_buf();
        let error_path = task_path.clone();
        let fault_injector = Arc::clone(&self.fault_injector);
        tokio::task::spawn_blocking(move || {
            atomic_replace_bytes_blocking(&task_path, &bytes, fault_injector.as_ref())
        })
        .await
        .map_err(|source| StorageError::TaskJoin {
            path: error_path,
            source,
        })?
    }

    async fn create_bytes(
        &self,
        path: &Path,
        bytes: Vec<u8>,
    ) -> Result<AtomicCreateOutcome, StorageError> {
        ensure_size(path, bytes.len(), self.max_document_bytes)?;
        let resource_lock = self.resource_lock(path);
        let _guard = resource_lock.lock().await;
        let task_path = path.to_path_buf();
        let error_path = task_path.clone();
        let fault_injector = Arc::clone(&self.fault_injector);
        tokio::task::spawn_blocking(move || {
            atomic_create_bytes_blocking(&task_path, &bytes, fault_injector.as_ref())
        })
        .await
        .map_err(|source| StorageError::TaskJoin {
            path: error_path,
            source,
        })?
    }
}

fn read_json_blocking<T>(path: &Path, max_bytes: u64) -> Result<Option<T>, StorageError>
where
    T: DeserializeOwned,
{
    let Some(bytes) = read_bounded(path, max_bytes)? else {
        return Ok(None);
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(source) => {
            let parse_error = source.to_string();
            match quarantine_file(path) {
                Ok(quarantine_path) => Err(StorageError::CorruptJson {
                    path: path.to_path_buf(),
                    quarantine_path,
                    source,
                }),
                Err(isolation_error) => Err(StorageError::CorruptJsonIsolation {
                    path: path.to_path_buf(),
                    parse_error,
                    source: isolation_error,
                }),
            }
        }
    }
}

fn read_json_lines_blocking<T>(
    path: &Path,
    max_bytes: u64,
    fault_injector: &dyn AtomicWriteFaultInjector,
) -> Result<Option<JsonLinesRead<T>>, StorageError>
where
    T: DeserializeOwned,
{
    let Some(bytes) = read_bounded(path, max_bytes)? else {
        return Ok(None);
    };
    let mut records = Vec::new();
    let mut cursor = 0;
    let mut valid_prefix_end = 0;
    let mut line_number = 0;

    while cursor < bytes.len() {
        line_number += 1;
        let line_end = bytes[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |relative| cursor + relative + 1);
        let mut record_bytes = &bytes[cursor..line_end];
        if record_bytes.last() == Some(&b'\n') {
            record_bytes = &record_bytes[..record_bytes.len() - 1];
        }
        if record_bytes.iter().all(u8::is_ascii_whitespace) {
            valid_prefix_end = line_end;
            cursor = line_end;
            continue;
        }

        match serde_json::from_slice(record_bytes) {
            Ok(record) => records.push(record),
            Err(source) => {
                let parse_error = source.to_string();
                let quarantine_path = quarantine_file(path).map_err(|isolation_error| {
                    StorageError::JsonLinesIsolation {
                        path: path.to_path_buf(),
                        line: line_number,
                        parse_error,
                        source: isolation_error,
                    }
                })?;
                atomic_replace_bytes_blocking(path, &bytes[..valid_prefix_end], fault_injector)
                    .map_err(|source| StorageError::JsonLinesRecovery {
                        path: path.to_path_buf(),
                        quarantine_path: quarantine_path.clone(),
                        source: Box::new(source),
                    })?;
                return Ok(Some(JsonLinesRead {
                    records,
                    quarantine_path: Some(quarantine_path),
                }));
            }
        }
        valid_prefix_end = line_end;
        cursor = line_end;
    }

    Ok(Some(JsonLinesRead {
        records,
        quarantine_path: None,
    }))
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, StorageError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("inspect", path, source)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StorageError::UnsafeFileType(path.to_path_buf()));
    }
    if metadata.len() > max_bytes {
        return Err(StorageError::DocumentTooLarge {
            path: path.to_path_buf(),
            max_bytes,
        });
    }
    let bytes = fs::read(path).map_err(|source| io_error("read", path, source))?;
    ensure_size(path, bytes.len(), max_bytes)?;
    Ok(Some(bytes))
}

fn atomic_replace_bytes_blocking(
    path: &Path,
    bytes: &[u8],
    fault_injector: &dyn AtomicWriteFaultInjector,
) -> Result<(), StorageError> {
    let parent = storage_parent(path)?;
    create_secure_directory(parent)?;
    reject_symlink_target(path)?;
    check_fault(fault_injector, AtomicWriteStage::BeforeTemporaryFile, path)?;

    let prefix = path
        .file_name()
        .and_then(|name| name.to_str())
        .map_or(".codez-storage-", |name| name);
    let mut temporary = Builder::new()
        .prefix(prefix)
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|source| io_error("create temporary file", path, source))?;
    set_secure_file_permissions(temporary.as_file(), path)?;
    temporary
        .write_all(bytes)
        .map_err(|source| io_error("write temporary file", path, source))?;
    temporary
        .flush()
        .map_err(|source| io_error("flush temporary file", path, source))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|source| io_error("sync temporary file", path, source))?;
    check_fault(fault_injector, AtomicWriteStage::BeforeCommit, path)?;

    let persisted = temporary
        .persist(path)
        .map_err(|error| io_error("atomically replace target", path, error.error))?;
    persisted
        .sync_all()
        .map_err(|source| io_error("sync replaced target", path, source))?;
    sync_parent_directory(parent, path)
}

fn atomic_create_bytes_blocking(
    path: &Path,
    bytes: &[u8],
    fault_injector: &dyn AtomicWriteFaultInjector,
) -> Result<AtomicCreateOutcome, StorageError> {
    let parent = storage_parent(path)?;
    create_secure_directory(parent)?;
    if let Some(outcome) = immutable_existing_outcome(path, bytes)? {
        return Ok(outcome);
    }
    check_fault(fault_injector, AtomicWriteStage::BeforeTemporaryFile, path)?;

    let prefix = path
        .file_name()
        .and_then(|name| name.to_str())
        .map_or(".codez-storage-", |name| name);
    let mut temporary = Builder::new()
        .prefix(prefix)
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|source| io_error("create immutable temporary file", path, source))?;
    set_secure_file_permissions(temporary.as_file(), path)?;
    temporary
        .write_all(bytes)
        .map_err(|source| io_error("write immutable temporary file", path, source))?;
    temporary
        .flush()
        .map_err(|source| io_error("flush immutable temporary file", path, source))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|source| io_error("sync immutable temporary file", path, source))?;
    check_fault(fault_injector, AtomicWriteStage::BeforeCommit, path)?;

    match temporary.persist_noclobber(path) {
        Ok(persisted) => {
            persisted
                .sync_all()
                .map_err(|source| io_error("sync immutable target", path, source))?;
            sync_parent_directory(parent, path)?;
            Ok(AtomicCreateOutcome::Created)
        }
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            immutable_existing_outcome(path, bytes)?.ok_or_else(|| StorageError::Io {
                operation: "inspect raced immutable target",
                path: path.to_path_buf(),
                source: io::Error::new(
                    io::ErrorKind::NotFound,
                    "immutable target disappeared after creation conflict",
                ),
            })
        }
        Err(error) => Err(io_error(
            "persist immutable target without clobbering",
            path,
            error.error,
        )),
    }
}

fn immutable_existing_outcome(
    path: &Path,
    expected: &[u8],
) -> Result<Option<AtomicCreateOutcome>, StorageError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("inspect immutable target", path, source)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StorageError::UnsafeFileType(path.to_path_buf()));
    }
    if metadata.len() != u64::try_from(expected.len()).unwrap_or(u64::MAX) {
        return Err(StorageError::ImmutableConflict(path.to_path_buf()));
    }
    let existing =
        fs::read(path).map_err(|source| io_error("read immutable target", path, source))?;
    if existing == expected {
        Ok(Some(AtomicCreateOutcome::Reused))
    } else {
        Err(StorageError::ImmutableConflict(path.to_path_buf()))
    }
}

fn append_bytes_blocking(
    path: &Path,
    bytes: &[u8],
    max_bytes: u64,
    fault_injector: &dyn AtomicWriteFaultInjector,
) -> Result<(), StorageError> {
    let parent = storage_parent(path)?;
    create_secure_directory(parent)?;
    reject_symlink_target(path)?;
    let existing_bytes = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(source) if source.kind() == io::ErrorKind::NotFound => 0,
        Err(source) => return Err(io_error("inspect append target", path, source)),
    };
    let appended_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if existing_bytes.saturating_add(appended_bytes) > max_bytes {
        return Err(StorageError::DocumentTooLarge {
            path: path.to_path_buf(),
            max_bytes,
        });
    }
    check_fault(fault_injector, AtomicWriteStage::BeforeTemporaryFile, path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|source| io_error("open append target", path, source))?;
    set_secure_file_permissions(&file, path)?;
    check_fault(fault_injector, AtomicWriteStage::BeforeCommit, path)?;
    file.write_all(bytes)
        .map_err(|source| io_error("append JSONL record", path, source))?;
    file.flush()
        .map_err(|source| io_error("flush JSONL append", path, source))?;
    file.sync_all()
        .map_err(|source| io_error("sync JSONL append", path, source))?;
    sync_parent_directory(parent, path)
}

fn quarantine_file(path: &Path) -> io::Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid storage file name"))?;

    for index in 0..MAX_QUARANTINE_COLLISIONS {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(".{index}")
        };
        let quarantine_path = parent.join(format!("{file_name}.corrupt{suffix}"));
        match preserve_corrupt_source(path, &quarantine_path) {
            Ok(()) => {
                sync_parent_directory_io(parent)?;
                return Ok(quarantine_path);
            }
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(source),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "too many corrupt-file quarantine collisions",
    ))
}

fn preserve_corrupt_source(source_path: &Path, quarantine_path: &Path) -> io::Result<()> {
    match fs::hard_link(source_path, quarantine_path) {
        Ok(()) => {
            let quarantine_file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(quarantine_path)?;
            set_secure_file_permissions_io(&quarantine_file)?;
            quarantine_file.sync_all()?;
            remove_source_after_backup(source_path, quarantine_path)
        }
        Err(source) if source.kind() == io::ErrorKind::AlreadyExists => Err(source),
        Err(_) => copy_corrupt_source(source_path, quarantine_path),
    }
}

fn copy_corrupt_source(source_path: &Path, quarantine_path: &Path) -> io::Result<()> {
    let mut source = File::open(source_path)?;
    let mut quarantine = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(quarantine_path)?;
    set_secure_file_permissions_io(&quarantine)?;
    io::copy(&mut source, &mut quarantine)?;
    quarantine.flush()?;
    quarantine.sync_all()?;
    remove_source_after_backup(source_path, quarantine_path)
}

fn remove_source_after_backup(source_path: &Path, quarantine_path: &Path) -> io::Result<()> {
    if let Err(source) = fs::remove_file(source_path) {
        let _ = fs::remove_file(quarantine_path);
        return Err(source);
    }
    Ok(())
}

fn storage_parent(path: &Path) -> Result<&Path, StorageError> {
    if path.file_name().is_none() {
        return Err(StorageError::InvalidPath(path.to_path_buf()));
    }
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| StorageError::InvalidPath(path.to_path_buf()))
}

fn reject_symlink_target(path: &Path) -> Result<(), StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(StorageError::UnsafeFileType(path.to_path_buf()))
        }
        Ok(_) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(io_error("inspect target", path, source)),
    }
}

fn check_fault(
    fault_injector: &dyn AtomicWriteFaultInjector,
    stage: AtomicWriteStage,
    path: &Path,
) -> Result<(), StorageError> {
    fault_injector
        .check(stage, path)
        .map_err(|source| StorageError::Injected {
            path: path.to_path_buf(),
            source,
        })
}

fn ensure_size(path: &Path, byte_count: usize, max_bytes: u64) -> Result<(), StorageError> {
    if u64::try_from(byte_count).unwrap_or(u64::MAX) > max_bytes {
        Err(StorageError::DocumentTooLarge {
            path: path.to_path_buf(),
            max_bytes,
        })
    } else {
        Ok(())
    }
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> StorageError {
    StorageError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

fn error_diagnostic(error: &StorageError) -> String {
    let mut diagnostic = error.to_string();
    let mut source = error.source();
    while let Some(current) = source {
        diagnostic.push_str(": ");
        diagnostic.push_str(&current.to_string());
        source = current.source();
    }
    diagnostic
}

#[cfg(unix)]
fn create_secure_directory(path: &Path) -> Result<(), StorageError> {
    use std::os::unix::fs::PermissionsExt;

    fs::create_dir_all(path).map_err(|source| io_error("create parent directory", path, source))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|source| io_error("set parent directory permissions", path, source))
}

#[cfg(not(unix))]
fn create_secure_directory(path: &Path) -> Result<(), StorageError> {
    fs::create_dir_all(path).map_err(|source| io_error("create parent directory", path, source))
}

#[cfg(unix)]
fn set_secure_file_permissions(file: &File, path: &Path) -> Result<(), StorageError> {
    set_secure_file_permissions_io(file)
        .map_err(|source| io_error("set file permissions", path, source))
}

#[cfg(not(unix))]
fn set_secure_file_permissions(_file: &File, _path: &Path) -> Result<(), StorageError> {
    Ok(())
}

#[cfg(unix)]
fn set_secure_file_permissions_io(file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_secure_file_permissions_io(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path, target: &Path) -> Result<(), StorageError> {
    sync_parent_directory_io(parent)
        .map_err(|source| io_error("sync parent directory", target, source))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path, _target: &Path) -> Result<(), StorageError> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory_io(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory_io(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use serde::{Deserialize, Serialize};

    use super::{
        AtomicCreateOutcome, AtomicFileStore, AtomicWriteFaultInjector, AtomicWriteStage,
        InjectedWriteFault, StorageError,
    };

    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    struct FixtureRecord {
        value: u32,
    }

    struct FailBeforeCommit;

    impl AtomicWriteFaultInjector for FailBeforeCommit {
        fn check(&self, stage: AtomicWriteStage, _target: &Path) -> Result<(), InjectedWriteFault> {
            if stage == AtomicWriteStage::BeforeCommit {
                Err(InjectedWriteFault::at(stage))
            } else {
                Ok(())
            }
        }
    }

    struct ConcurrencyProbe {
        active: AtomicUsize,
        maximum: AtomicUsize,
    }

    impl ConcurrencyProbe {
        fn new() -> Self {
            Self {
                active: AtomicUsize::new(0),
                maximum: AtomicUsize::new(0),
            }
        }
    }

    impl AtomicWriteFaultInjector for ConcurrencyProbe {
        fn check(&self, stage: AtomicWriteStage, _target: &Path) -> Result<(), InjectedWriteFault> {
            if stage == AtomicWriteStage::BeforeCommit {
                let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
                self.maximum.fetch_max(active, Ordering::AcqRel);
                std::thread::sleep(Duration::from_millis(20));
                self.active.fetch_sub(1, Ordering::AcqRel);
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn pre_commit_failure_preserves_the_previous_document() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let path = directory.path().join("settings.json");
        let store = AtomicFileStore::default();
        store
            .write_json(&path, &FixtureRecord { value: 1 })
            .await
            .expect("initial fixture write must succeed");
        let failing_store = AtomicFileStore::with_fault_injector(1024, Arc::new(FailBeforeCommit))
            .expect("fixture limit is valid");

        let error = failing_store
            .write_json(&path, &FixtureRecord { value: 2 })
            .await
            .expect_err("injected write must fail");
        let persisted = store
            .read_json::<FixtureRecord>(&path)
            .await
            .expect("previous JSON must remain readable");

        assert!(
            matches!(error, StorageError::Injected { .. })
                && persisted == Some(FixtureRecord { value: 1 })
        );
    }

    #[tokio::test]
    async fn immutable_json_creation_reuses_identical_bytes_and_rejects_different_data() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let path = directory.path().join("migration-commit.json");
        let store = AtomicFileStore::default();

        let created = store
            .create_json(&path, &FixtureRecord { value: 1 })
            .await
            .expect("first immutable create must succeed");
        let reused = store
            .create_json(&path, &FixtureRecord { value: 1 })
            .await
            .expect("identical immutable create must be reused");
        let conflict = store
            .create_json(&path, &FixtureRecord { value: 2 })
            .await
            .expect_err("different immutable data must never replace the target");
        let persisted = store
            .read_json::<FixtureRecord>(&path)
            .await
            .expect("immutable JSON must remain readable");

        assert_eq!(
            (created, reused, persisted),
            (
                AtomicCreateOutcome::Created,
                AtomicCreateOutcome::Reused,
                Some(FixtureRecord { value: 1 })
            )
        );
        assert!(matches!(conflict, StorageError::ImmutableConflict(_)));
    }

    #[tokio::test]
    async fn corrupt_json_is_preserved_outside_the_active_path() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let path = directory.path().join("settings.json");
        let previous_quarantine = directory.path().join("settings.json.corrupt");
        fs::write(&previous_quarantine, b"older-corruption")
            .expect("previous quarantine fixture must be written");
        fs::write(&path, b"{not-json").expect("fixture corruption must be written");
        let store = AtomicFileStore::default();

        let error = store
            .read_json::<FixtureRecord>(&path)
            .await
            .expect_err("corrupt JSON must be isolated");
        let StorageError::CorruptJson {
            quarantine_path, ..
        } = error
        else {
            panic!("expected isolated corrupt JSON");
        };

        assert_eq!(
            (
                path.exists(),
                fs::read(previous_quarantine).expect("previous quarantine must not be overwritten"),
                fs::read(quarantine_path).expect("quarantined source must remain readable")
            ),
            (false, b"older-corruption".to_vec(), b"{not-json".to_vec())
        );
    }

    #[tokio::test]
    async fn malformed_jsonl_restores_only_the_valid_prefix() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let path = directory.path().join("audit.jsonl");
        let valid_line = serde_json::to_string(&FixtureRecord { value: 1 })
            .expect("fixture record must serialize");
        fs::write(&path, format!("{valid_line}\nnot-json\n{{\"value\":2}}\n"))
            .expect("fixture JSONL must be written");
        let store = AtomicFileStore::default();

        let recovered = store
            .read_json_lines::<FixtureRecord>(&path)
            .await
            .expect("JSONL recovery must succeed")
            .expect("fixture file must exist");

        assert_eq!(
            (
                recovered.records,
                recovered.quarantine_path.is_some(),
                fs::read_to_string(path).expect("valid prefix must remain active")
            ),
            (
                vec![FixtureRecord { value: 1 }],
                true,
                format!("{valid_line}\n")
            )
        );
    }

    #[tokio::test]
    async fn writes_to_the_same_resource_do_not_commit_concurrently() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let path = directory.path().join("sessions.json");
        let probe = Arc::new(ConcurrencyProbe::new());
        let store = AtomicFileStore::with_fault_injector(
            1024,
            Arc::clone(&probe) as Arc<dyn AtomicWriteFaultInjector>,
        )
        .expect("fixture limit is valid");
        let first = FixtureRecord { value: 1 };
        let second = FixtureRecord { value: 2 };

        let (first_result, second_result) = tokio::join!(
            store.write_json(&path, &first),
            store.write_json(&path, &second)
        );

        assert!(
            first_result.is_ok()
                && second_result.is_ok()
                && probe.maximum.load(Ordering::Acquire) == 1
        );
    }

    #[tokio::test]
    async fn jsonl_replace_append_and_read_preserve_record_order() {
        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let path = directory.path().join("journal.jsonl");
        let store = AtomicFileStore::default();
        store
            .write_json_lines(&path, &[FixtureRecord { value: 1 }])
            .await
            .expect("initial JSONL write must succeed");
        store
            .append_json_line(&path, &FixtureRecord { value: 2 })
            .await
            .expect("JSONL append must succeed");

        let records = store
            .read_json_lines::<FixtureRecord>(&path)
            .await
            .expect("JSONL read must succeed")
            .expect("fixture file must exist")
            .records;

        assert_eq!(
            records,
            vec![FixtureRecord { value: 1 }, FixtureRecord { value: 2 }]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn persisted_files_use_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory must be available");
        let path = directory.path().join("providers.json");
        AtomicFileStore::default()
            .write_json(&path, &FixtureRecord { value: 1 })
            .await
            .expect("fixture write must succeed");

        let mode = fs::metadata(path)
            .expect("persisted file metadata must be available")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(mode, 0o600);
    }
}
