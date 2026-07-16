use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use codez_core::SessionId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use super::{
    LegacyDataSet, LegacyRoots, ManifestScope, MigrationCommitMarker, MigrationError,
    MigrationPhase, TransformReport, TransformedFile, filesystem, layout, transform,
};
use crate::AtomicFileStore;

const ACTIVATION_SCHEMA_VERSION: u32 = 1;
const ACTIVATION_MARKER_FILE: &str = "activation.json";
const MAX_MIGRATED_SESSIONS: usize = 10_000;

/// Active path namespace selected for one materialized migration output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ActivationScope {
    /// Path below the new `~/.codez` application data root.
    ApplicationData,
    /// Path below the current user's home directory.
    UserHome,
    /// Path below one explicitly authorized workspace.
    Workspace { index: usize },
}

/// One active file proven to match a committed immutable migration output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivatedFile {
    /// Active root namespace without serializing an absolute path.
    pub scope: ActivationScope,
    /// Relative path below the active root.
    pub relative_path: PathBuf,
    /// Exact active byte length.
    pub byte_length: u64,
    /// SHA-256 of the complete active bytes.
    pub sha256: String,
}

/// Durable proof that every committed migration output is active.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationActivationMarker {
    /// Activation marker serialization version.
    pub schema_version: u32,
    /// Fingerprint of the authority marker used for activation.
    pub commit_fingerprint: String,
    /// Deterministically ordered active outputs.
    pub files: Vec<ActivatedFile>,
    /// Always [`MigrationPhase::Committed`] for a complete activation.
    pub phase: MigrationPhase,
    /// SHA-256 over this marker excluding the fingerprint field.
    pub fingerprint: String,
}

/// Materializes one committed immutable repository into active data paths.
#[derive(Clone)]
pub struct MigrationActivationService {
    files: AtomicFileStore,
    mutation: Arc<Mutex<()>>,
}

impl std::fmt::Debug for MigrationActivationService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MigrationActivationService")
            .field("max_document_bytes", &self.files.max_document_bytes())
            .finish_non_exhaustive()
    }
}

impl MigrationActivationService {
    /// Creates an activation service using the supplied bounded atomic store.
    #[must_use]
    pub fn new(files: AtomicFileStore) -> Self {
        Self {
            files,
            mutation: Arc::new(Mutex::new(())),
        }
    }

    /// Activates every committed file and writes a final durable marker.
    ///
    /// Existing targets are replaced only when they still match the backed-up
    /// legacy bytes or already match the committed target. A different target
    /// fails closed without being overwritten.
    ///
    /// # Errors
    ///
    /// Returns [`MigrationError`] when the authority proof, repository bytes,
    /// path mapping, session index, existing targets, or atomic writes are not
    /// safe and internally consistent.
    pub async fn activate(
        &self,
        roots: &LegacyRoots,
        application_data_root: &Path,
        staging_root: &Path,
        marker: &MigrationCommitMarker,
        report: &TransformReport,
    ) -> Result<MigrationActivationMarker, MigrationError> {
        let _guard = self.mutation.lock().await;
        verify_activation_authority(application_data_root, staging_root, marker, report).await?;
        let marker_path = application_data_root
            .join("migrations")
            .join(ACTIVATION_MARKER_FILE);
        let existing_activation = self
            .files
            .read_json::<MigrationActivationMarker>(&marker_path)
            .await?;
        if let Some(existing) = &existing_activation {
            validate_activation_marker(existing, marker)?;
        }
        let may_materialize = existing_activation.is_none();

        let mut activated = Vec::new();
        let mut target_identities = HashSet::new();
        for transformed in &report.files {
            let source = repository_file(staging_root, report, transformed);
            let bytes = read_repository_bytes(
                source,
                transformed.target_byte_length,
                transformed.target_sha256.clone(),
            )
            .await?;
            if transformed.data_set == LegacyDataSet::Sessions {
                let sessions = parse_migrated_sessions(bytes).await?;
                for (session_id, session_bytes, session_hash) in sessions {
                    let relative_path =
                        Path::new("sessions").join(format!("{}.json", session_id.as_str()));
                    let target = application_data_root.join(&relative_path);
                    register_target(&mut target_identities, &target)?;
                    self.activate_bytes(
                        &target,
                        &session_bytes,
                        &session_hash,
                        None,
                        may_materialize,
                    )
                    .await?;
                    activated.push(ActivatedFile {
                        scope: ActivationScope::ApplicationData,
                        relative_path,
                        byte_length: u64::try_from(session_bytes.len()).unwrap_or(u64::MAX),
                        sha256: session_hash,
                    });
                }
                continue;
            }

            let (scope, target) = active_target(roots, application_data_root, transformed)?;
            register_target(&mut target_identities, &target)?;
            self.activate_bytes(
                &target,
                &bytes,
                &transformed.target_sha256,
                Some(&transformed.source_sha256),
                may_materialize,
            )
            .await?;
            activated.push(ActivatedFile {
                scope,
                relative_path: transformed.relative_path.clone(),
                byte_length: transformed.target_byte_length,
                sha256: transformed.target_sha256.clone(),
            });
        }
        activated.sort_unstable_by(|left, right| {
            activated_sort_key(left).cmp(&activated_sort_key(right))
        });

        let mut activation = MigrationActivationMarker {
            schema_version: ACTIVATION_SCHEMA_VERSION,
            commit_fingerprint: marker.fingerprint.clone(),
            files: activated,
            phase: MigrationPhase::Committed,
            fingerprint: String::new(),
        };
        activation.fingerprint = activation_fingerprint(&activation)?;
        if let Some(existing) = existing_activation {
            if existing != activation {
                return Err(MigrationError::ActivationMarkerMismatch);
            }
            return Ok(existing);
        }
        self.files.create_json(&marker_path, &activation).await?;
        Ok(activation)
    }

    async fn activate_bytes(
        &self,
        target: &Path,
        expected: &[u8],
        expected_sha256: &str,
        legacy_sha256: Option<&str>,
        may_materialize: bool,
    ) -> Result<(), MigrationError> {
        match self.files.read_bytes(target).await? {
            Some(existing) => {
                let existing_hash = hash_bytes(target.to_path_buf(), existing).await?;
                if existing_hash == expected_sha256 {
                    return Ok(());
                }
                if !may_materialize || legacy_sha256 != Some(existing_hash.as_str()) {
                    return Err(MigrationError::ActivationConflict(target.to_path_buf()));
                }
            }
            None if !may_materialize => {
                return Err(MigrationError::ActivationConflict(target.to_path_buf()));
            }
            None => {}
        }
        self.files.write_bytes(target, expected).await?;
        let active = self
            .files
            .read_bytes(target)
            .await?
            .ok_or_else(|| MigrationError::ActivationConflict(target.to_path_buf()))?;
        if hash_bytes(target.to_path_buf(), active).await? != expected_sha256 {
            return Err(MigrationError::ActivationConflict(target.to_path_buf()));
        }
        Ok(())
    }
}

fn repository_file(
    staging_root: &Path,
    report: &TransformReport,
    transformed: &TransformedFile,
) -> PathBuf {
    staging_root
        .join(&report.repository_relative_path)
        .join(transformed.scope.backup_directory_name())
        .join(&transformed.relative_path)
}

fn active_target(
    roots: &LegacyRoots,
    application_data_root: &Path,
    transformed: &TransformedFile,
) -> Result<(ActivationScope, PathBuf), MigrationError> {
    match transformed.scope {
        ManifestScope::UserData => Ok((
            ActivationScope::ApplicationData,
            application_data_root.join(&transformed.relative_path),
        )),
        ManifestScope::UserHome => Ok((
            ActivationScope::UserHome,
            roots.user_home().join(&transformed.relative_path),
        )),
        ManifestScope::Workspace { index } => {
            let workspace = roots
                .workspaces()
                .get(index)
                .ok_or(MigrationError::UnknownWorkspaceScope { index })?;
            Ok((
                ActivationScope::Workspace { index },
                workspace.join(&transformed.relative_path),
            ))
        }
    }
}

fn migrated_sessions(bytes: &[u8]) -> Result<Vec<(SessionId, Vec<u8>, String)>, MigrationError> {
    let document: Value =
        serde_json::from_slice(bytes).map_err(|_| MigrationError::InvalidSessionDocument)?;
    if document.get("schema").and_then(Value::as_str) != Some("sessions")
        || document.get("schemaVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err(MigrationError::InvalidSessionDocument);
    }
    let sessions = document
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or(MigrationError::InvalidSessionDocument)?;
    if sessions.len() > MAX_MIGRATED_SESSIONS {
        return Err(MigrationError::InvalidSessionDocument);
    }
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(sessions.len());
    for session in sessions {
        let id = session
            .get("id")
            .and_then(Value::as_str)
            .ok_or(MigrationError::InvalidSessionDocument)
            .and_then(|value| {
                SessionId::parse(value).map_err(|_| MigrationError::InvalidSessionDocument)
            })?;
        if !seen.insert(id.clone()) {
            return Err(MigrationError::InvalidSessionDocument);
        }
        let bytes =
            serde_json::to_vec_pretty(session).map_err(MigrationError::TransformSerialization)?;
        let sha256 = filesystem::sha256_bytes(&bytes);
        result.push((id, bytes, sha256));
    }
    result.sort_unstable_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
    Ok(result)
}

fn register_target(
    identities: &mut HashSet<Vec<OsString>>,
    target: &Path,
) -> Result<(), MigrationError> {
    let identity = comparison_components(target);
    if identities.insert(identity) {
        Ok(())
    } else {
        Err(MigrationError::DuplicateActivationTarget(
            target.to_path_buf(),
        ))
    }
}

async fn verify_activation_authority(
    application_data_root: &Path,
    staging_root: &Path,
    marker: &MigrationCommitMarker,
    report: &TransformReport,
) -> Result<(), MigrationError> {
    let application_data_root = application_data_root.to_path_buf();
    let staging_root = staging_root.to_path_buf();
    let marker = marker.clone();
    let report = report.clone();
    let error_path = staging_root.clone();
    tokio::task::spawn_blocking(move || {
        super::validate_root("application data activation", &application_data_root)?;
        super::validate_root("migration staging", &staging_root)?;
        layout::reject_filesystem_redirects(&application_data_root)?;
        layout::reject_filesystem_redirects(&staging_root)?;
        transform::validate_marker_report(&marker, &report)?;
        transform::verify_repository_integrity(&staging_root, &report)
    })
    .await
    .map_err(|source| MigrationError::ActivationTaskJoin {
        path: error_path,
        source,
    })?
}

async fn read_repository_bytes(
    path: PathBuf,
    byte_length: u64,
    sha256: String,
) -> Result<Vec<u8>, MigrationError> {
    let error_path = path.clone();
    tokio::task::spawn_blocking(move || {
        filesystem::read_verified_target(&path, byte_length, &sha256)
    })
    .await
    .map_err(|source| MigrationError::ActivationTaskJoin {
        path: error_path,
        source,
    })?
}

async fn parse_migrated_sessions(
    bytes: Vec<u8>,
) -> Result<Vec<(SessionId, Vec<u8>, String)>, MigrationError> {
    let error_path = PathBuf::from("sessions.json");
    tokio::task::spawn_blocking(move || migrated_sessions(&bytes))
        .await
        .map_err(|source| MigrationError::ActivationTaskJoin {
            path: error_path,
            source,
        })?
}

async fn hash_bytes(path: PathBuf, bytes: Vec<u8>) -> Result<String, MigrationError> {
    let error_path = path.clone();
    tokio::task::spawn_blocking(move || filesystem::sha256_bytes(&bytes))
        .await
        .map_err(|source| MigrationError::ActivationTaskJoin {
            path: error_path,
            source,
        })
}

#[cfg(not(windows))]
fn comparison_components(path: &Path) -> Vec<OsString> {
    path.components()
        .filter(|component| *component != Component::CurDir)
        .map(|component| component.as_os_str().to_os_string())
        .collect()
}

#[cfg(windows)]
fn comparison_components(path: &Path) -> Vec<OsString> {
    path.components()
        .filter(|component| *component != Component::CurDir)
        .map(|component| OsString::from(component.as_os_str().to_string_lossy().to_lowercase()))
        .collect()
}

fn activated_sort_key(file: &ActivatedFile) -> (u8, usize, &Path) {
    match file.scope {
        ActivationScope::ApplicationData => (0, 0, &file.relative_path),
        ActivationScope::UserHome => (1, 0, &file.relative_path),
        ActivationScope::Workspace { index } => (2, index, &file.relative_path),
    }
}

fn activation_fingerprint(marker: &MigrationActivationMarker) -> Result<String, MigrationError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintInput<'a> {
        schema_version: u32,
        commit_fingerprint: &'a str,
        files: &'a [ActivatedFile],
        phase: MigrationPhase,
    }

    let bytes = serde_json::to_vec(&FingerprintInput {
        schema_version: marker.schema_version,
        commit_fingerprint: &marker.commit_fingerprint,
        files: &marker.files,
        phase: marker.phase,
    })
    .map_err(MigrationError::TransformSerialization)?;
    Ok(filesystem::sha256_bytes(&bytes))
}

fn validate_activation_marker(
    activation: &MigrationActivationMarker,
    commit: &MigrationCommitMarker,
) -> Result<(), MigrationError> {
    if activation.schema_version != ACTIVATION_SCHEMA_VERSION
        || activation.phase != MigrationPhase::Committed
        || activation.commit_fingerprint != commit.fingerprint
        || activation.fingerprint != activation_fingerprint(activation)?
    {
        return Err(MigrationError::ActivationMarkerMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Mutex as StdMutex},
    };

    use crate::{AtomicFileStore, CredentialError, CredentialId, CredentialStore, SecretValue};

    use super::{MigrationActivationService, MigrationError};
    use crate::migration::{
        LegacyCredentialReadError, LegacyCredentialReader, LegacyMigrationService, LegacyRoots,
        MigrationRunId,
    };

    #[derive(Default)]
    struct MemoryCredentialStore {
        values: StdMutex<HashMap<CredentialId, String>>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, id: &CredentialId) -> Result<SecretValue, CredentialError> {
            let value = self
                .values
                .lock()
                .map_err(|_| CredentialError::Unavailable {
                    operation: "read activation fixture credential",
                })?
                .get(id)
                .cloned()
                .ok_or_else(|| CredentialError::NotFound { id: id.clone() })?;
            SecretValue::new(value)
        }

        fn set(&self, id: &CredentialId, value: &SecretValue) -> Result<(), CredentialError> {
            self.values
                .lock()
                .map_err(|_| CredentialError::Unavailable {
                    operation: "write activation fixture credential",
                })?
                .insert(id.clone(), value.expose_secret().to_string());
            Ok(())
        }

        fn delete(&self, id: &CredentialId) -> Result<(), CredentialError> {
            self.values
                .lock()
                .map_err(|_| CredentialError::Unavailable {
                    operation: "delete activation fixture credential",
                })?
                .remove(id)
                .map(|_| ())
                .ok_or_else(|| CredentialError::NotFound { id: id.clone() })
        }
    }

    struct UnusedCredentialReader;

    impl LegacyCredentialReader for UnusedCredentialReader {
        fn decrypt(&self, _encoded: &str) -> Result<SecretValue, LegacyCredentialReadError> {
            Err(LegacyCredentialReadError::UnsupportedPlatform)
        }
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        roots: LegacyRoots,
        data_root: std::path::PathBuf,
        backup_root: std::path::PathBuf,
        staging_root: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("fixture directory must be available");
            let user_data = directory.path().join("electron-user-data");
            let user_home = directory.path().join("home");
            let data_root = user_home.join(".codez");
            fs::create_dir_all(&user_data).expect("legacy user data must be created");
            fs::create_dir_all(&data_root).expect("application data root must be created");
            fs::write(user_data.join("settings.json"), r#"{"theme":"system"}"#)
                .expect("legacy settings must be written");
            fs::write(
                user_data.join("sessions.json"),
                r#"{"sessions":[{"id":"session-1","summary":"Retained","messages":[]}]}"#,
            )
            .expect("legacy sessions must be written");
            let roots = LegacyRoots::new(user_data, user_home, Vec::new())
                .expect("fixture roots must be valid");
            let backup_root = data_root.join("migrations/backups");
            let staging_root = data_root.join("migrations/staging");
            Self {
                _directory: directory,
                roots,
                data_root,
                backup_root,
                staging_root,
            }
        }

        async fn commit(
            &self,
        ) -> (
            crate::migration::MigrationCommitMarker,
            crate::migration::TransformReport,
        ) {
            let service = LegacyMigrationService::default();
            let manifest = service
                .discover(
                    &self.roots,
                    MigrationRunId::parse("activation-fixture")
                        .expect("fixture run ID must be valid"),
                )
                .await
                .expect("legacy data must be discovered");
            let backup = service
                .backup(&self.roots, &manifest, &self.backup_root)
                .await
                .expect("legacy data must be backed up");
            let credentials = Arc::new(MemoryCredentialStore::default());
            let credential_report = service
                .migrate_credentials(
                    &manifest,
                    &backup,
                    &self.backup_root,
                    Arc::new(UnusedCredentialReader),
                    Arc::clone(&credentials),
                )
                .await
                .expect("absent credentials must verify");
            let report = service
                .transform(
                    &self.roots,
                    &manifest,
                    &backup,
                    &self.backup_root,
                    &self.staging_root,
                )
                .await
                .expect("legacy data must transform");
            let marker = service
                .commit(
                    &manifest,
                    &backup,
                    &report,
                    &credential_report,
                    &self.staging_root,
                    credentials,
                )
                .await
                .expect("verified migration must commit");
            (marker, report)
        }

        fn activator(&self) -> MigrationActivationService {
            let files = AtomicFileStore::with_max_document_bytes(256 * 1024 * 1024)
                .expect("activation fixture limit must be valid");
            MigrationActivationService::new(files)
        }
    }

    #[tokio::test]
    async fn activation_materializes_global_data_and_splits_the_legacy_session_index() {
        let fixture = Fixture::new();
        let (marker, report) = fixture.commit().await;
        let activator = fixture.activator();

        let first = activator
            .activate(
                &fixture.roots,
                &fixture.data_root,
                &fixture.staging_root,
                &marker,
                &report,
            )
            .await
            .expect("committed repository must activate");
        let second = activator
            .activate(
                &fixture.roots,
                &fixture.data_root,
                &fixture.staging_root,
                &marker,
                &report,
            )
            .await
            .expect("activation retry must be idempotent");
        let settings: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.data_root.join("settings.json")).expect("active settings must exist"),
        )
        .expect("active settings must remain JSON");
        let session: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.data_root.join("sessions/session-1.json"))
                .expect("split session must exist"),
        )
        .expect("split session must remain JSON");

        assert_eq!(first, second);
        assert_eq!(settings["appTheme"], "system");
        assert_eq!(session["summary"], "Retained");
        assert!(!fixture.data_root.join("sessions.json").exists());
        assert!(
            fixture
                .data_root
                .join("migrations/activation.json")
                .is_file()
        );
    }

    #[tokio::test]
    async fn activation_preserves_an_unknown_existing_target_and_fails_closed() {
        let fixture = Fixture::new();
        let (marker, report) = fixture.commit().await;
        let active_settings = fixture.data_root.join("settings.json");
        fs::write(&active_settings, br#"{"appTheme":"newer"}"#)
            .expect("conflicting active settings must be written");

        let error = fixture
            .activator()
            .activate(
                &fixture.roots,
                &fixture.data_root,
                &fixture.staging_root,
                &marker,
                &report,
            )
            .await
            .expect_err("unknown active data must block migration activation");

        assert!(
            matches!(error, MigrationError::ActivationConflict(path) if path == active_settings)
        );
        assert_eq!(
            fs::read(active_settings).expect("conflicting target must remain readable"),
            br#"{"appTheme":"newer"}"#
        );
    }

    #[tokio::test]
    async fn completed_activation_does_not_silently_repair_a_changed_active_file() {
        let fixture = Fixture::new();
        let (marker, report) = fixture.commit().await;
        let activator = fixture.activator();
        activator
            .activate(
                &fixture.roots,
                &fixture.data_root,
                &fixture.staging_root,
                &marker,
                &report,
            )
            .await
            .expect("fixture activation must complete");
        let active_settings = fixture.data_root.join("settings.json");
        fs::write(&active_settings, br#"{"appTheme":"tampered"}"#)
            .expect("active settings tamper must be simulated");

        let error = activator
            .activate(
                &fixture.roots,
                &fixture.data_root,
                &fixture.staging_root,
                &marker,
                &report,
            )
            .await
            .expect_err("changed active data must block restart");

        assert!(
            matches!(error, MigrationError::ActivationConflict(path) if path == active_settings)
        );
        assert_eq!(
            fs::read(active_settings).expect("tampered active file must remain for diagnosis"),
            br#"{"appTheme":"tampered"}"#
        );
    }
}
