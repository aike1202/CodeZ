#![forbid(unsafe_code)]

//! Versioned repositories, atomic files, credentials, and legacy-data migration.

mod atomic_file;
mod credentials;
mod migration;
mod repositories;
mod schema;

pub use atomic_file::{
    AtomicCreateOutcome, AtomicFileStore, AtomicWriteFaultInjector, AtomicWriteStage,
    InjectedWriteFault, JsonLinesRead, StorageError,
};
pub use credentials::{
    CODEZ_CREDENTIAL_SERVICE, CredentialError, CredentialId, CredentialKind, CredentialStore,
    OsCredentialStore, SecretValue,
};
pub use migration::{
    BackupReport, CredentialMigrationEntry, CredentialMigrationReason, CredentialMigrationReport,
    CredentialMigrationStatus, DataSensitivity, DiscoveryLimits, DiscoveryRule,
    ElectronSafeStorageReader, LEGACY_DATA_CATALOG, LegacyCredentialReadError,
    LegacyCredentialReader, LegacyDataSet, LegacyDataSpec, LegacyFormat, LegacyMigrationService,
    LegacyRoots, LegacyValidation, ManifestScope, MigrationCommitMarker, MigrationError,
    MigrationManifest, MigrationManifestEntry, MigrationPhase, MigrationRunId, RootScope,
    SchemaSelector, TransformReport, TransformedFile, TreeSelector,
};
pub use repositories::RecentProjectsStore;
pub use schema::{SchemaError, SchemaFamily, SchemaFormat, VersionedDocument, VersionedRecord};
