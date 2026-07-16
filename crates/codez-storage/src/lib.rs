#![forbid(unsafe_code)]

//! Versioned repositories, atomic files, credentials, and legacy-data migration.

mod atomic_file;
pub mod credentials;
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
    ActivatedFile, ActivationScope, BackupReport, CredentialMigrationEntry,
    CredentialMigrationReason, CredentialMigrationReport, CredentialMigrationStatus,
    CredentialReentry, DataSensitivity, DiscoveryLimits, DiscoveryRule, ElectronSafeStorageReader,
    LEGACY_DATA_CATALOG, LegacyCredentialReadError, LegacyCredentialReader, LegacyDataSet,
    LegacyDataSpec, LegacyFormat, LegacyMigrationCoordinator, LegacyMigrationService, LegacyRoots,
    LegacyValidation, ManifestScope, MigrationActivationMarker, MigrationActivationService,
    MigrationCommitMarker, MigrationError, MigrationManifest, MigrationManifestEntry,
    MigrationPhase, MigrationRunId, RootScope, SchemaSelector, StartupMigrationOutcome,
    TransformReport, TransformedFile, TreeSelector,
};
pub use repositories::{RecentProjectsStore, SessionStore};
pub use schema::{SchemaError, SchemaFamily, SchemaFormat, VersionedDocument, VersionedRecord};
