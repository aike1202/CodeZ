mod catalog;
mod filesystem;

#[cfg(test)]
mod tests;

use std::{
    error::Error as StdError,
    path::{Component, Path, PathBuf},
};

use codez_core::AppError;
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use thiserror::Error;

use crate::{AtomicFileStore, SchemaFamily, StorageError};

pub use catalog::{
    DataSensitivity, DiscoveryRule, LEGACY_DATA_CATALOG, LegacyDataSet, LegacyDataSpec,
    LegacyFormat, RootScope, SchemaSelector, TreeSelector,
};

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const BACKUP_REPORT_SCHEMA_VERSION: u32 = 1;

/// Caller-supplied, filesystem-safe identity for one repeatable migration run.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct MigrationRunId(String);

impl MigrationRunId {
    /// Validates a stable run identifier before it is used as a directory name.
    ///
    /// # Errors
    ///
    /// Returns [`MigrationError::InvalidRunId`] when the value is empty, longer
    /// than 64 bytes, or contains characters other than ASCII letters, digits,
    /// `-`, and `_`.
    pub fn parse(value: impl Into<String>) -> Result<Self, MigrationError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(MigrationError::InvalidRunId);
        }
        Ok(Self(value))
    }

    /// Returns the validated directory-safe run identity.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for MigrationRunId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(D::Error::custom)
    }
}

/// Validated source roots explicitly authorized for legacy discovery.
#[derive(Debug, Clone)]
pub struct LegacyRoots {
    user_data: PathBuf,
    user_home: PathBuf,
    workspaces: Vec<PathBuf>,
}

impl LegacyRoots {
    /// Creates a bounded set of absolute legacy source roots.
    ///
    /// # Errors
    ///
    /// Returns [`MigrationError::InvalidRoot`] when a root is relative or has
    /// unresolved parent traversal.
    pub fn new(
        user_data: PathBuf,
        user_home: PathBuf,
        workspaces: Vec<PathBuf>,
    ) -> Result<Self, MigrationError> {
        validate_root("legacy user data", &user_data)?;
        validate_root("legacy user home", &user_home)?;
        for workspace in &workspaces {
            validate_root("legacy workspace", workspace)?;
        }
        Ok(Self {
            user_data,
            user_home,
            workspaces,
        })
    }

    /// Returns the authorized Electron `userData` root.
    #[must_use]
    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    /// Returns the authorized user home root.
    #[must_use]
    pub fn user_home(&self) -> &Path {
        &self.user_home
    }

    /// Returns explicitly authorized workspace roots.
    #[must_use]
    pub fn workspaces(&self) -> &[PathBuf] {
        &self.workspaces
    }

    fn resolve_scope(&self, scope: ManifestScope) -> Result<&Path, MigrationError> {
        match scope {
            ManifestScope::UserData => Ok(&self.user_data),
            ManifestScope::UserHome => Ok(&self.user_home),
            ManifestScope::Workspace { index } => self
                .workspaces
                .get(index)
                .map(PathBuf::as_path)
                .ok_or(MigrationError::UnknownWorkspaceScope { index }),
        }
    }
}

/// Resource ceilings applied before legacy files are allocated or copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscoveryLimits {
    /// Maximum filesystem entries inspected across catalog scans.
    pub max_entries: usize,
    /// Maximum aggregate bytes across the manifest.
    pub max_total_bytes: u64,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_total_bytes: 4 * 1024 * 1024 * 1024,
        }
    }
}

/// Relative root identity serialized without exposing absolute user paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ManifestScope {
    /// File relative to the Electron `userData` root.
    UserData,
    /// File relative to the current user home root.
    UserHome,
    /// File relative to one explicitly supplied workspace root.
    Workspace { index: usize },
}

impl ManifestScope {
    fn backup_directory_name(self) -> String {
        match self {
            Self::UserData => "user-data".to_string(),
            Self::UserHome => "user-home".to_string(),
            Self::Workspace { index } => format!("workspace-{index}"),
        }
    }
}

/// Content validation performed without recording source values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum LegacyValidation {
    /// A JSON object parsed successfully.
    ValidJson,
    /// Every non-empty JSONL record parsed successfully.
    ValidJsonLines { record_count: usize },
    /// JSON parsing failed; only location metadata is retained.
    InvalidJson { line: usize, column: usize },
    /// A JSON value parsed but was not an object.
    InvalidJsonRoot,
    /// JSONL is valid only through the reported prefix.
    PartialJsonLines {
        valid_records: usize,
        first_invalid_line: usize,
    },
    /// Credential content was intentionally not parsed by discovery.
    PendingCredentialMigration,
    /// Binary or user-authored content is copied without parsing.
    Opaque,
}

impl LegacyValidation {
    /// Reports whether transformation must stop for this entry.
    #[must_use]
    pub const fn blocks_transformation(&self) -> bool {
        matches!(
            self,
            Self::InvalidJson { .. }
                | Self::InvalidJsonRoot
                | Self::PartialJsonLines { .. }
                | Self::PendingCredentialMigration
        )
    }
}

/// One discovered file described only by scope-relative metadata and checksum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationManifestEntry {
    /// Inventory data set that owns this source file.
    pub data_set: LegacyDataSet,
    /// Authorized root scope without an absolute path.
    pub scope: ManifestScope,
    /// Relative source path below `scope`.
    pub relative_path: PathBuf,
    /// Physical legacy format of this file.
    pub format: LegacyFormat,
    /// Pre-content sensitivity classification.
    pub sensitivity: DataSensitivity,
    /// Target schema family when this entry carries structured metadata.
    pub schema: Option<SchemaFamily>,
    /// Exact source byte length.
    pub byte_length: u64,
    /// Lowercase SHA-256 of the complete source bytes.
    pub sha256: String,
    /// Structure-only validation result.
    pub validation: LegacyValidation,
}

/// Stable, content-redacted inventory produced by read-only discovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationManifest {
    /// Manifest serialization version.
    pub schema_version: u32,
    /// Caller-supplied migration run identity.
    pub run_id: MigrationRunId,
    /// Deterministically sorted discovered files.
    pub entries: Vec<MigrationManifestEntry>,
    /// Catalog data sets absent from every authorized root.
    pub absent_data_sets: Vec<LegacyDataSet>,
    /// Aggregate source bytes.
    pub total_bytes: u64,
    /// SHA-256 over the redacted manifest content, excluding this field.
    pub fingerprint: String,
}

impl MigrationManifest {
    /// Reports whether corruption or pending credential work blocks transformation.
    #[must_use]
    pub fn has_blocking_entries(&self) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.validation.blocks_transformation())
    }
}

/// Durable migration phases shared by backup and future transform/commit work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationPhase {
    /// No source has been inspected.
    NotStarted,
    /// A read-only manifest exists.
    Discovered,
    /// Every manifest entry has an exact verified backup.
    BackedUp,
    /// Versioned target transformation is in progress.
    Transforming,
    /// Transformed records and references have been verified.
    Verified,
    /// Secret migration or explicit re-entry decisions remain pending.
    AwaitingCredentials,
    /// An atomic completion marker made the new repository authoritative.
    Committed,
    /// The run stopped safely and may be retried.
    Failed,
}

/// Idempotent backup completion record written only after all checksums match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    /// Backup report serialization version.
    pub schema_version: u32,
    /// Migration run identity.
    pub run_id: MigrationRunId,
    /// Fingerprint of the manifest this backup satisfies.
    pub manifest_fingerprint: String,
    /// Files copied during this invocation.
    pub copied_files: usize,
    /// Existing matching files reused during this invocation.
    pub reused_files: usize,
    /// Aggregate verified source bytes.
    pub total_bytes: u64,
    /// Always [`MigrationPhase::BackedUp`] for a completed report.
    pub phase: MigrationPhase,
}

/// Read-only discovery and exact no-clobber backup service.
#[derive(Debug, Clone)]
pub struct LegacyMigrationService {
    store: AtomicFileStore,
    limits: DiscoveryLimits,
}

impl Default for LegacyMigrationService {
    fn default() -> Self {
        Self::new(AtomicFileStore::default(), DiscoveryLimits::default())
    }
}

impl LegacyMigrationService {
    /// Creates a migration service with explicit persistence and discovery limits.
    #[must_use]
    pub const fn new(store: AtomicFileStore, limits: DiscoveryLimits) -> Self {
        Self { store, limits }
    }

    /// Discovers known legacy files without modifying any source root.
    ///
    /// # Errors
    ///
    /// Returns [`MigrationError`] for symlinks, unsupported file types, resource
    /// limits, I/O, catalog collisions, or blocking-worker failures.
    pub async fn discover(
        &self,
        roots: &LegacyRoots,
        run_id: MigrationRunId,
    ) -> Result<MigrationManifest, MigrationError> {
        let roots = roots.clone();
        let limits = self.limits;
        tokio::task::spawn_blocking(move || filesystem::discover_blocking(&roots, run_id, limits))
            .await
            .map_err(MigrationError::DiscoveryTaskJoin)?
    }

    /// Creates or reuses exact, owner-restricted backups for one manifest.
    ///
    /// The source is re-hashed before each copy. Existing backup files are reused
    /// only when their checksum matches, and are never overwritten.
    ///
    /// # Errors
    ///
    /// Returns [`MigrationError`] when roots overlap, a source changed after
    /// discovery, an existing backup conflicts, copying fails, or completion
    /// records cannot be written atomically.
    pub async fn backup(
        &self,
        roots: &LegacyRoots,
        manifest: &MigrationManifest,
        backup_root: &Path,
    ) -> Result<BackupReport, MigrationError> {
        validate_root("migration backup", backup_root)?;
        let run_directory = backup_root.join(manifest.run_id.as_str());
        let roots = roots.clone();
        let manifest_for_worker = manifest.clone();
        let worker_backup_root = backup_root.to_path_buf();
        let report = tokio::task::spawn_blocking(move || {
            filesystem::backup_blocking(&roots, &manifest_for_worker, &worker_backup_root)
        })
        .await
        .map_err(MigrationError::BackupTaskJoin)??;

        self.store
            .write_json(&run_directory.join("migration-manifest.json"), manifest)
            .await?;
        self.store
            .write_json(&run_directory.join("backup-complete.json"), &report)
            .await?;
        Ok(report)
    }
}

/// Failures that preserve legacy source data and prevent migration commit.
#[derive(Debug, Error)]
pub enum MigrationError {
    /// A run ID cannot be used as a bounded directory component.
    #[error("migration run id is invalid")]
    InvalidRunId,
    /// An authorized root is relative or contains unresolved traversal.
    #[error("{kind} root is invalid: {path}")]
    InvalidRoot { kind: &'static str, path: PathBuf },
    /// A serialized workspace scope no longer has an authorized root.
    #[error("migration manifest references unknown workspace index {index}")]
    UnknownWorkspaceScope { index: usize },
    /// A source or backup path contains a symlink.
    #[error("migration refuses to follow symbolic link: {0}")]
    SymbolicLink(PathBuf),
    /// A catalog path resolved to an unsupported filesystem object.
    #[error("migration source is not a regular file or directory: {0}")]
    UnsupportedFileType(PathBuf),
    /// A manifest relative path could escape its authorized root.
    #[error("migration manifest contains unsafe relative path: {0}")]
    UnsafeRelativePath(PathBuf),
    /// Two catalog rules selected the same source file.
    #[error("multiple migration catalog entries selected {scope:?}/{relative_path}")]
    CatalogCollision {
        scope: ManifestScope,
        relative_path: PathBuf,
    },
    /// The redacted manifest could not be serialized deterministically.
    #[error("migration manifest could not be serialized")]
    ManifestSerialization(#[source] serde_json::Error),
    /// A manifest was modified after its fingerprint was generated.
    #[error("migration manifest fingerprint does not match its content")]
    ManifestFingerprintMismatch,
    /// The configured file-count ceiling was exceeded.
    #[error("legacy migration exceeds the {max_entries} entry limit")]
    EntryLimitExceeded { max_entries: usize },
    /// The configured aggregate byte ceiling was exceeded.
    #[error("legacy migration exceeds the {max_bytes} byte limit")]
    TotalByteLimitExceeded { max_bytes: u64 },
    /// One file exceeds its reviewed per-data-set limit.
    #[error("legacy file exceeds the {max_bytes} byte limit: {path}")]
    FileByteLimitExceeded { path: PathBuf, max_bytes: u64 },
    /// A source changed after discovery and before backup.
    #[error("legacy source changed after discovery: {0}")]
    SourceChanged(PathBuf),
    /// An existing no-clobber backup has different bytes.
    #[error("existing migration backup conflicts with the manifest: {0}")]
    BackupConflict(PathBuf),
    /// A backup directory overlaps a source root.
    #[error("migration backup root overlaps legacy source root: {0}")]
    OverlappingBackupRoot(PathBuf),
    /// A filesystem operation failed.
    #[error("migration I/O failed while attempting to {operation}: {path}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The read-only discovery worker could not be joined.
    #[error("legacy discovery worker failed")]
    DiscoveryTaskJoin(#[source] tokio::task::JoinError),
    /// The backup worker could not be joined.
    #[error("legacy backup worker failed")]
    BackupTaskJoin(#[source] tokio::task::JoinError),
    /// Atomic report persistence failed.
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl From<MigrationError> for AppError {
    fn from(error: MigrationError) -> Self {
        let mut diagnostic = error.to_string();
        let mut source = error.source();
        while let Some(current) = source {
            diagnostic.push_str(": ");
            diagnostic.push_str(&current.to_string());
            source = current.source();
        }
        AppError::storage(
            "The legacy data migration could not continue safely",
            diagnostic,
            false,
        )
    }
}

fn validate_root(kind: &'static str, path: &Path) -> Result<(), MigrationError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err(MigrationError::InvalidRoot {
            kind,
            path: path.to_path_buf(),
        });
    }
    Ok(())
}
