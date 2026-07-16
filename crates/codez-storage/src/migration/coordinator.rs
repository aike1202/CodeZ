use std::{path::PathBuf, sync::Arc};

use super::{
    BackupReport, CredentialMigrationReport, CredentialReentry, LegacyCredentialReader,
    LegacyMigrationService, LegacyRoots, MigrationActivationMarker, MigrationActivationService,
    MigrationCommitMarker, MigrationError, MigrationManifest, MigrationPhase, MigrationRunId,
    TransformReport, filesystem, transform,
};
use crate::CredentialStore;

/// Stable result of one startup migration attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupMigrationOutcome {
    /// The committed repository was fully materialized into active paths.
    Activated {
        /// Atomic authority marker selecting the immutable migration run.
        commit: MigrationCommitMarker,
        /// Proof that every committed file is active.
        activation: MigrationActivationMarker,
    },
    /// Secret migration requires explicit user re-entry before commit.
    AwaitingCredentials {
        /// Redacted per-credential migration decisions.
        report: CredentialMigrationReport,
    },
}

/// Runs the complete legacy migration state machine before repositories start.
pub struct LegacyMigrationCoordinator<R, S> {
    migration: LegacyMigrationService,
    activation: MigrationActivationService,
    roots: LegacyRoots,
    application_data_root: PathBuf,
    backup_root: PathBuf,
    staging_root: PathBuf,
    run_id: MigrationRunId,
    reader: Arc<R>,
    credentials: Arc<S>,
}

impl<R, S> std::fmt::Debug for LegacyMigrationCoordinator<R, S> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LegacyMigrationCoordinator")
            .field("application_data_root", &self.application_data_root)
            .field("backup_root", &self.backup_root)
            .field("staging_root", &self.staging_root)
            .field("run_id", &self.run_id)
            .finish_non_exhaustive()
    }
}

impl<R, S> LegacyMigrationCoordinator<R, S>
where
    R: LegacyCredentialReader + 'static,
    S: CredentialStore + 'static,
{
    /// Creates a coordinator with explicit roots, stores, and stable run ID.
    #[must_use]
    #[expect(
        clippy::too_many_arguments,
        reason = "startup authority inputs remain explicit"
    )]
    pub fn new(
        migration: LegacyMigrationService,
        activation: MigrationActivationService,
        roots: LegacyRoots,
        application_data_root: PathBuf,
        backup_root: PathBuf,
        staging_root: PathBuf,
        run_id: MigrationRunId,
        reader: Arc<R>,
        credentials: Arc<S>,
    ) -> Self {
        Self {
            migration,
            activation,
            roots,
            application_data_root,
            backup_root,
            staging_root,
            run_id,
            reader,
            credentials,
        }
    }

    /// Resumes or executes migration through activation.
    ///
    /// A completed backup is reused even if the frozen legacy source later
    /// changes. A partial backup is revalidated against its saved manifest.
    /// No active repository should be constructed until this returns
    /// [`StartupMigrationOutcome::Activated`].
    ///
    /// # Errors
    ///
    /// Returns [`MigrationError`] when any persisted phase is corrupt,
    /// inconsistent, unsafe, or cannot advance without data loss.
    pub async fn run(&self) -> Result<StartupMigrationOutcome, MigrationError> {
        if let Some(commit) = self
            .migration
            .committed_migration(&self.staging_root)
            .await?
        {
            let report = self.load_committed_report(&commit).await?;
            let activation = self
                .activation
                .activate(
                    &self.roots,
                    &self.application_data_root,
                    &self.staging_root,
                    &commit,
                    &report,
                )
                .await?;
            return Ok(StartupMigrationOutcome::Activated { commit, activation });
        }

        let (manifest, backup) = self.load_or_create_backup().await?;
        let credentials = match self
            .migration
            .credential_migration_report(&manifest, &self.backup_root)
            .await?
        {
            Some(report) => report,
            None => {
                self.migration
                    .migrate_credentials(
                        &manifest,
                        &backup,
                        &self.backup_root,
                        Arc::clone(&self.reader),
                        Arc::clone(&self.credentials),
                    )
                    .await?
            }
        };
        let report = self
            .migration
            .transform(
                &self.roots,
                &manifest,
                &backup,
                &self.backup_root,
                &self.staging_root,
            )
            .await?;
        let credentials = if credentials.phase == MigrationPhase::AwaitingCredentials {
            let Some(completed) = self
                .migration
                .completed_credential_reentry(&manifest, &self.backup_root, &credentials)
                .await?
            else {
                return Ok(StartupMigrationOutcome::AwaitingCredentials {
                    report: credentials,
                });
            };
            completed
        } else {
            credentials
        };
        if credentials.phase != MigrationPhase::Verified {
            return Err(MigrationError::CredentialReportMismatch);
        }

        let commit = self
            .migration
            .commit(
                &manifest,
                &backup,
                &report,
                &credentials,
                &self.staging_root,
                Arc::clone(&self.credentials),
            )
            .await?;
        let activation = self
            .activation
            .activate(
                &self.roots,
                &self.application_data_root,
                &self.staging_root,
                &commit,
                &report,
            )
            .await?;
        Ok(StartupMigrationOutcome::Activated { commit, activation })
    }

    /// Completes an explicitly blocked credential migration and activates the
    /// already verified repository only after secure-storage validation passes.
    ///
    /// # Errors
    ///
    /// Returns [`MigrationError`] when the persisted report is not awaiting
    /// credentials, supplied identities are incomplete, or commit/activation
    /// verification fails.
    pub async fn resume_with_credentials(
        &self,
        entries: Vec<CredentialReentry>,
    ) -> Result<StartupMigrationOutcome, MigrationError> {
        if let Some(commit) = self
            .migration
            .committed_migration(&self.staging_root)
            .await?
        {
            let report = self.load_committed_report(&commit).await?;
            let activation = self
                .activation
                .activate(
                    &self.roots,
                    &self.application_data_root,
                    &self.staging_root,
                    &commit,
                    &report,
                )
                .await?;
            return Ok(StartupMigrationOutcome::Activated { commit, activation });
        }

        let (manifest, backup) = self.load_or_create_backup().await?;
        let credentials = self
            .migration
            .complete_credential_reentry(
                &manifest,
                &backup,
                &self.backup_root,
                entries,
                Arc::clone(&self.credentials),
            )
            .await?;
        let report = self
            .migration
            .transform(
                &self.roots,
                &manifest,
                &backup,
                &self.backup_root,
                &self.staging_root,
            )
            .await?;
        let commit = self
            .migration
            .commit(
                &manifest,
                &backup,
                &report,
                &credentials,
                &self.staging_root,
                Arc::clone(&self.credentials),
            )
            .await?;
        let activation = self
            .activation
            .activate(
                &self.roots,
                &self.application_data_root,
                &self.staging_root,
                &commit,
                &report,
            )
            .await?;
        Ok(StartupMigrationOutcome::Activated { commit, activation })
    }

    async fn load_or_create_backup(
        &self,
    ) -> Result<(MigrationManifest, BackupReport), MigrationError> {
        let run_directory = self.backup_root.join(self.run_id.as_str());
        let manifest_path = run_directory.join("migration-manifest.json");
        let report_path = run_directory.join("backup-complete.json");
        let manifest = self
            .migration
            .store
            .read_json::<MigrationManifest>(&manifest_path)
            .await?;
        let backup = self
            .migration
            .store
            .read_json::<BackupReport>(&report_path)
            .await?;
        match (manifest, backup) {
            (Some(manifest), Some(backup)) => {
                if manifest.run_id != self.run_id {
                    return Err(MigrationError::TransformBackupMismatch);
                }
                filesystem::verify_manifest_fingerprint(&manifest)?;
                transform::validate_backup_prerequisite(&manifest, &backup)?;
                Ok((manifest, backup))
            }
            (Some(manifest), None) => {
                if manifest.run_id != self.run_id {
                    return Err(MigrationError::TransformBackupMismatch);
                }
                filesystem::verify_manifest_fingerprint(&manifest)?;
                let backup = self
                    .migration
                    .backup(&self.roots, &manifest, &self.backup_root)
                    .await?;
                Ok((manifest, backup))
            }
            (None, Some(_)) => Err(MigrationError::TransformBackupMismatch),
            (None, None) => {
                let manifest = self
                    .migration
                    .discover(&self.roots, self.run_id.clone())
                    .await?;
                let backup = self
                    .migration
                    .backup(&self.roots, &manifest, &self.backup_root)
                    .await?;
                Ok((manifest, backup))
            }
        }
    }

    async fn load_committed_report(
        &self,
        marker: &MigrationCommitMarker,
    ) -> Result<TransformReport, MigrationError> {
        let path = transform::transform_report_path(&self.staging_root, &marker.run_id);
        let report = self
            .migration
            .store
            .read_json::<TransformReport>(&path)
            .await?
            .ok_or(MigrationError::CompletionMarkerMismatch)?;
        transform::validate_marker_report(marker, &report)?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Mutex},
    };

    use crate::{
        AtomicFileStore, CredentialError, CredentialId, CredentialKind, CredentialReentry,
        CredentialStore, SecretValue,
    };

    use super::{LegacyMigrationCoordinator, StartupMigrationOutcome};
    use crate::migration::{
        LegacyCredentialReadError, LegacyCredentialReader, LegacyMigrationService, LegacyRoots,
        MigrationActivationService, MigrationRunId,
    };

    #[derive(Default)]
    struct MemoryCredentialStore {
        values: Mutex<HashMap<CredentialId, String>>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, id: &CredentialId) -> Result<SecretValue, CredentialError> {
            let value = self
                .values
                .lock()
                .map_err(|_| CredentialError::Unavailable {
                    operation: "read coordinator fixture credential",
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
                    operation: "write coordinator fixture credential",
                })?
                .insert(id.clone(), value.expose_secret().to_string());
            Ok(())
        }

        fn delete(&self, id: &CredentialId) -> Result<(), CredentialError> {
            self.values
                .lock()
                .map_err(|_| CredentialError::Unavailable {
                    operation: "delete coordinator fixture credential",
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
        legacy_user_data: std::path::PathBuf,
        data_root: std::path::PathBuf,
        roots: LegacyRoots,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("fixture directory must be available");
            let legacy_user_data = directory.path().join("electron-user-data");
            let user_home = directory.path().join("home");
            let data_root = user_home.join(".codez");
            fs::create_dir_all(&legacy_user_data).expect("legacy user data must be created");
            fs::create_dir_all(&data_root).expect("application data root must be created");
            fs::write(
                legacy_user_data.join("settings.json"),
                r#"{"theme":"system"}"#,
            )
            .expect("legacy settings must be written");
            let roots = LegacyRoots::new(legacy_user_data.clone(), user_home, Vec::new())
                .expect("fixture roots must be valid");
            Self {
                _directory: directory,
                legacy_user_data,
                data_root,
                roots,
            }
        }

        fn coordinator(
            &self,
        ) -> LegacyMigrationCoordinator<UnusedCredentialReader, MemoryCredentialStore> {
            self.coordinator_with_credentials(Arc::new(MemoryCredentialStore::default()))
        }

        fn coordinator_with_credentials(
            &self,
            credentials: Arc<MemoryCredentialStore>,
        ) -> LegacyMigrationCoordinator<UnusedCredentialReader, MemoryCredentialStore> {
            let files = AtomicFileStore::with_max_document_bytes(256 * 1024 * 1024)
                .expect("fixture document limit must be valid");
            LegacyMigrationCoordinator::new(
                LegacyMigrationService::new(
                    files.clone(),
                    super::super::DiscoveryLimits::default(),
                ),
                MigrationActivationService::new(files),
                self.roots.clone(),
                self.data_root.clone(),
                self.data_root.join("migrations/backups"),
                self.data_root.join("migrations/staging"),
                MigrationRunId::parse("startup-global-v1").expect("fixture run ID must be valid"),
                Arc::new(UnusedCredentialReader),
                credentials,
            )
        }
    }

    #[tokio::test]
    async fn startup_coordinator_reuses_committed_authority_and_activation() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();

        let first = coordinator
            .run()
            .await
            .expect("first startup must migrate and activate");
        let second = coordinator
            .run()
            .await
            .expect("restart must reuse committed authority");

        assert!(matches!(first, StartupMigrationOutcome::Activated { .. }));
        assert_eq!(first, second);
        assert!(fixture.data_root.join("settings.json").is_file());
    }

    #[tokio::test]
    async fn completed_backup_remains_authoritative_when_the_frozen_source_later_changes() {
        let fixture = Fixture::new();
        let coordinator = fixture.coordinator();
        let (_manifest, _backup) = coordinator
            .load_or_create_backup()
            .await
            .expect("fixture backup must complete");
        fs::write(
            fixture.legacy_user_data.join("settings.json"),
            r#"{"theme":"changed-after-backup"}"#,
        )
        .expect("legacy source mutation must be simulated");

        coordinator
            .run()
            .await
            .expect("completed immutable backup must remain resumable");
        let active: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.data_root.join("settings.json")).expect("active settings must exist"),
        )
        .expect("active settings must remain JSON");

        assert_eq!(active["appTheme"], "system");
    }

    #[tokio::test]
    async fn startup_coordinator_activates_only_after_explicit_credential_reentry() {
        let fixture = Fixture::new();
        fs::write(
            fixture.legacy_user_data.join("providers.json"),
            r#"{
              "activeProviderId":"provider-reentry",
              "providers":[{
                "id":"provider-reentry",
                "name":"Reentry Provider",
                "baseUrl":"https://provider.invalid/v1",
                "apiFormat":"openai",
                "apiKeyRef":"unreadable-envelope",
                "encryption":"safeStorage",
                "models":[],
                "thinking":{"enabled":true,"mode":"auto"},
                "enabled":true,
                "createdAt":"2026-01-01T00:00:00Z",
                "updatedAt":"2026-01-01T00:00:00Z"
              }]
            }"#,
        )
        .expect("legacy Provider fixture must be written");
        let credentials = Arc::new(MemoryCredentialStore::default());
        let coordinator = fixture.coordinator_with_credentials(Arc::clone(&credentials));
        let credential_id = CredentialId::new(CredentialKind::ProviderApiKey, "provider-reentry")
            .expect("fixture credential ID must be valid");

        let awaiting = coordinator
            .run()
            .await
            .expect("migration must stop safely for unreadable credentials");
        assert!(matches!(
            awaiting,
            StartupMigrationOutcome::AwaitingCredentials { .. }
        ));
        assert!(!fixture.data_root.join("providers.json").exists());

        let activated = coordinator
            .resume_with_credentials(vec![CredentialReentry::new(
                credential_id.clone(),
                SecretValue::new("explicit-fixture-secret").expect("fixture secret must be valid"),
            )])
            .await
            .expect("explicit credential re-entry must allow activation");
        let restarted = coordinator
            .run()
            .await
            .expect("restart must reuse the activated authority");

        assert!(matches!(
            activated,
            StartupMigrationOutcome::Activated { .. }
        ));
        assert_eq!(activated, restarted);
        assert!(fixture.data_root.join("providers.json").is_file());
        assert!(credentials.get(&credential_id).is_ok());
    }
}
