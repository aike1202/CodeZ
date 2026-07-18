use std::{fs, path::PathBuf};

use super::{
    DataSensitivity, DiscoveryLimits, LegacyDataSet, LegacyMigrationService, LegacyRoots,
    LegacyValidation, MigrationError, MigrationPhase, MigrationRunId,
};
use crate::AtomicFileStore;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/migration/legacy-data-v0")
        .canonicalize()
        .expect("legacy fixture root must exist")
}

fn fixture_roots() -> LegacyRoots {
    let root = fixture_root();
    LegacyRoots::new(
        root.join("user-data"),
        root.join("home"),
        vec![root.join("workspace")],
    )
    .expect("fixture roots are absolute and traversal-free")
}

fn temporary_settings_roots() -> (tempfile::TempDir, LegacyRoots, PathBuf) {
    let source_parent = tempfile::tempdir().expect("source parent must be available");
    let user_data = source_parent.path().join("user-data");
    let user_home = source_parent.path().join("home");
    let workspace = source_parent.path().join("workspace");
    fs::create_dir_all(&user_data).expect("fixture user data must be created");
    fs::create_dir_all(&user_home).expect("fixture home must be created");
    fs::create_dir_all(&workspace).expect("fixture workspace must be created");
    let settings_path = user_data.join("settings.json");
    fs::write(&settings_path, b"{\"value\":1}").expect("fixture settings must be written");
    let roots = LegacyRoots::new(user_data, user_home, vec![workspace])
        .expect("temporary fixture roots are valid");
    (source_parent, roots, settings_path)
}

#[tokio::test]
async fn discovery_is_deterministic_and_does_not_serialize_source_contents() {
    let service = LegacyMigrationService::default();
    let roots = fixture_roots();
    let first = service
        .discover(
            &roots,
            MigrationRunId::parse("fixture-run-1").expect("fixture run id is valid"),
        )
        .await
        .expect("fixture discovery must succeed");
    let second = service
        .discover(
            &roots,
            MigrationRunId::parse("fixture-run-2").expect("fixture run id is valid"),
        )
        .await
        .expect("repeated fixture discovery must succeed");
    let permission_audit = first
        .entries
        .iter()
        .find(|entry| entry.data_set == LegacyDataSet::PermissionAudit)
        .expect("permission audit fixture must be discovered");
    let provider = first
        .entries
        .iter()
        .find(|entry| entry.data_set == LegacyDataSet::Providers)
        .expect("provider fixture must be discovered");
    let serialized = serde_json::to_string(&first).expect("manifest must serialize");

    assert!(
        first.entries.len() == 13
            && first.fingerprint == second.fingerprint
            && first.entries == second.entries
            && first.has_blocking_entries()
            && matches!(
                permission_audit.validation,
                LegacyValidation::PartialJsonLines {
                    valid_records: 1,
                    first_invalid_line: 2
                }
            )
            && provider.sensitivity == DataSensitivity::Secret
            && !serialized.contains("REDACTED_LEGACY_CIPHERTEXT")
            && !serialized.contains("provider.example")
    );
}

#[tokio::test]
async fn discovery_stops_at_the_configured_entry_limit() {
    let (_source_parent, roots, _) = temporary_settings_roots();
    let service = LegacyMigrationService::new(
        AtomicFileStore::default(),
        DiscoveryLimits {
            max_entries: 0,
            max_total_bytes: u64::MAX,
        },
    );

    let error = service
        .discover(
            &roots,
            MigrationRunId::parse("entry-limit").expect("fixture run id is valid"),
        )
        .await
        .expect_err("configured entry limit must stop discovery");

    assert!(matches!(
        error,
        MigrationError::EntryLimitExceeded { max_entries: 0 }
    ));
}

#[tokio::test]
async fn backup_is_idempotent_and_preserves_the_legacy_source() {
    let service = LegacyMigrationService::default();
    let roots = fixture_roots();
    let run_id = MigrationRunId::parse("fixture-backup").expect("fixture run id is valid");
    let manifest = service
        .discover(&roots, run_id)
        .await
        .expect("fixture discovery must succeed");
    let backup_parent = tempfile::tempdir().expect("backup parent must be available");
    let backup_root = backup_parent.path().join("backups");
    let source_provider = roots.user_data().join("providers.json");
    let source_before = fs::read(&source_provider).expect("source fixture must be readable");

    let first = service
        .backup(&roots, &manifest, &backup_root)
        .await
        .expect("initial backup must succeed");
    let second = service
        .backup(&roots, &manifest, &backup_root)
        .await
        .expect("repeated backup must reuse matching files");
    let backed_up_provider = fs::read(
        backup_root
            .join("fixture-backup")
            .join("user-data/providers.json"),
    )
    .expect("provider backup must be readable");

    assert_eq!(
        (
            first.phase,
            first.copied_files,
            second.reused_files,
            source_before.clone(),
            fs::read(source_provider).expect("legacy source must remain unchanged"),
            backed_up_provider,
            backup_root
                .join("fixture-backup/backup-complete.json")
                .is_file(),
        ),
        (
            MigrationPhase::BackedUp,
            manifest.entries.len(),
            manifest.entries.len(),
            source_before.clone(),
            source_before.clone(),
            source_before,
            true,
        )
    );
}

#[tokio::test]
async fn backup_refuses_a_source_changed_after_discovery() {
    let (source_parent, roots, settings_path) = temporary_settings_roots();
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &roots,
            MigrationRunId::parse("changed-source").expect("fixture run id is valid"),
        )
        .await
        .expect("fixture discovery must succeed");
    fs::write(&settings_path, b"{\"value\":200}").expect("fixture source must be changed");
    let backup_root = source_parent.path().join("backups");

    let error = service
        .backup(&roots, &manifest, &backup_root)
        .await
        .expect_err("changed source must block backup");

    assert!(matches!(error, MigrationError::SourceChanged(path) if path == settings_path));
}

#[tokio::test]
async fn backup_reports_a_deleted_source_as_changed() {
    let (source_parent, roots, settings_path) = temporary_settings_roots();
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &roots,
            MigrationRunId::parse("deleted-source").expect("fixture run id is valid"),
        )
        .await
        .expect("fixture discovery must succeed");
    fs::remove_file(&settings_path).expect("fixture source must be removed");

    let error = service
        .backup(&roots, &manifest, &source_parent.path().join("backups"))
        .await
        .expect_err("a deleted source must block backup");

    assert!(matches!(error, MigrationError::SourceChanged(path) if path == settings_path));
}

#[test]
fn migration_run_id_deserialization_rejects_path_traversal() {
    let result = serde_json::from_str::<MigrationRunId>(r#""../escape""#);

    assert!(result.is_err());
}

#[tokio::test]
async fn backup_reports_a_conflict_when_an_existing_copy_is_larger() {
    let (source_parent, roots, _) = temporary_settings_roots();
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &roots,
            MigrationRunId::parse("backup-conflict").expect("fixture run id is valid"),
        )
        .await
        .expect("fixture discovery must succeed");
    let backup_root = source_parent.path().join("backups");
    service
        .backup(&roots, &manifest, &backup_root)
        .await
        .expect("initial backup must succeed");
    let backup_path = backup_root.join("backup-conflict/user-data/settings.json");
    fs::write(&backup_path, b"{\"value\":1000}")
        .expect("conflicting backup fixture must be written");

    let error = service
        .backup(&roots, &manifest, &backup_root)
        .await
        .expect_err("a conflicting backup must never be overwritten");

    assert!(matches!(error, MigrationError::BackupConflict(path) if path == backup_path));
}
