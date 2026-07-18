use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::Value;

use super::{
    LegacyCredentialReadError, LegacyCredentialReader, LegacyMigrationService, LegacyRoots,
    MigrationError, MigrationPhase, MigrationRunId,
};
use crate::{
    AtomicFileStore, AtomicWriteFaultInjector, AtomicWriteStage, CredentialError, CredentialId,
    CredentialStore, InjectedWriteFault, SecretValue, StorageError,
};

fn source_fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/migration/legacy-data-v0")
        .canonicalize()
        .expect("legacy fixture root must exist")
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).expect("fixture target directory must be created");
    for entry in fs::read_dir(source).expect("fixture source directory must be readable") {
        let entry = entry.expect("fixture source entry must be readable");
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry
            .file_type()
            .expect("fixture source type must be readable")
            .is_dir()
        {
            copy_tree(&source_path, &target_path);
        } else {
            fs::copy(&source_path, &target_path).expect("fixture source file must be copied");
        }
    }
}

struct MigrationFixture {
    _directory: tempfile::TempDir,
    roots: LegacyRoots,
    backup_root: PathBuf,
    target_root: PathBuf,
}

impl MigrationFixture {
    fn from_reviewed_fixture() -> Self {
        let directory = tempfile::tempdir().expect("fixture directory must be available");
        let root = directory.path().join("legacy-data-v0");
        copy_tree(&source_fixture_root(), &root);
        replace_in_file(
            &root.join("user-data/providers.json"),
            "provider-missing",
            "provider-legacy",
        );
        replace_in_file(
            &root.join("user-data/settings.json"),
            "provider-missing",
            "provider-legacy",
        );
        replace_in_file(
            &root.join("user-data/sessions.json"),
            "attachment-missing",
            "attachment-present",
        );
        replace_in_file(
            &root.join("user-data/sessions.json"),
            "sessions/session-legacy/missing",
            "sessions/session-legacy/attachment-present",
        );
        fs::write(
            root.join("user-data/permission-audit.jsonl"),
            concat!(
                "{\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"sessionId\":\"session-legacy\",\"decision\":\"allow\",\"permission\":\"read\"}\n",
                "{\"timestamp\":\"2025-01-01T00:00:01.000Z\",\"sessionId\":\"session-legacy\",\"decision\":\"deny\",\"permission\":\"write\"}\n"
            ),
        )
        .expect("permission audit fixture must be repaired");
        Self::from_root(directory, root)
    }

    fn with_files(files: impl IntoIterator<Item = (&'static str, &'static str)>) -> Self {
        let directory = tempfile::tempdir().expect("fixture directory must be available");
        let root = directory.path().join("legacy-data-v0");
        let user_data = root.join("user-data");
        fs::create_dir_all(&user_data).expect("fixture user data must be created");
        fs::create_dir_all(root.join("home")).expect("fixture home must be created");
        fs::create_dir_all(root.join("workspace")).expect("fixture workspace must be created");
        for (name, contents) in files {
            let path = user_data.join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("fixture file parent must be created");
            }
            fs::write(path, contents).expect("fixture source file must be written");
        }
        Self::from_root(directory, root)
    }

    fn with_reserved_codez_layout() -> Self {
        let directory = tempfile::tempdir().expect("fixture directory must be available");
        let root = directory.path().join("legacy-data-v0");
        let user_data = root.join("electron-user-data");
        let user_home = root.join("home");
        let workspace = root.join("workspace");
        let codez_root = user_home.join(".codez");
        fs::create_dir_all(&user_data).expect("fixture user data must be created");
        fs::create_dir_all(codez_root.join("projects"))
            .expect("fixture projects directory must be created");
        fs::create_dir_all(codez_root.join("rules"))
            .expect("fixture rules directory must be created");
        fs::create_dir_all(codez_root.join("memory"))
            .expect("fixture memory directory must be created");
        fs::create_dir_all(codez_root.join("migrations/previous"))
            .expect("fixture migration artifact directory must be created");
        fs::create_dir_all(&workspace).expect("fixture workspace must be created");
        fs::write(user_data.join("settings.json"), r#"{"theme":"system"}"#)
            .expect("fixture Electron settings must be written");
        fs::write(codez_root.join("projects/plan.md"), "# retained plan\n")
            .expect("fixture plan must be written");
        fs::write(codez_root.join("rules/user.md"), "Use UTF-8.\n")
            .expect("fixture rule must be written");
        fs::write(
            codez_root.join("memory/user.md"),
            "Remember migration state.\n",
        )
        .expect("fixture memory must be written");
        fs::write(
            codez_root.join("skills-config.json"),
            r#"{"enabledSkills":["rust-best-practices"]}"#,
        )
        .expect("fixture skill config must be written");
        fs::write(
            codez_root.join("migrations/previous/migration-manifest.json"),
            r#"{"artifact":true}"#,
        )
        .expect("fixture migration artifact must be written");
        let roots = LegacyRoots::new(user_data, user_home, vec![workspace])
            .expect("fixture roots must be valid");
        let backup_root = codez_root.join("migrations/backups");
        let target_root = codez_root.join("migrations/staging");
        Self {
            _directory: directory,
            roots,
            backup_root,
            target_root,
        }
    }

    fn from_root(directory: tempfile::TempDir, root: PathBuf) -> Self {
        let roots = LegacyRoots::new(
            root.join("user-data"),
            root.join("home"),
            vec![root.join("workspace")],
        )
        .expect("fixture roots must be valid");
        let backup_root = directory.path().join("backups");
        let target_root = directory.path().join("target");
        Self {
            _directory: directory,
            roots,
            backup_root,
            target_root,
        }
    }
}

fn reserved_layout_source_paths(fixture: &MigrationFixture) -> Vec<PathBuf> {
    vec![
        fixture.roots.user_data().join("settings.json"),
        fixture.roots.user_home().join(".codez/projects/plan.md"),
        fixture.roots.user_home().join(".codez/rules/user.md"),
        fixture.roots.user_home().join(".codez/memory/user.md"),
        fixture.roots.user_home().join(".codez/skills-config.json"),
    ]
}

fn source_hashes(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| {
            let bytes = fs::read(path).expect("fixture source must remain readable");
            super::filesystem::sha256_bytes(&bytes)
        })
        .collect()
}

#[cfg(unix)]
fn create_directory_redirect(source: &Path, target: &Path) {
    std::os::unix::fs::symlink(source, target).expect("fixture directory symlink must be created");
}

#[cfg(windows)]
fn create_directory_redirect(source: &Path, target: &Path) {
    std::os::windows::fs::symlink_dir(source, target)
        .expect("fixture directory reparse point must be created");
}

fn replace_in_file(path: &Path, from: &str, to: &str) {
    let contents = fs::read_to_string(path).expect("fixture file must be readable");
    fs::write(path, contents.replace(from, to)).expect("fixture file must be repaired");
}

struct FixtureCredentialReader;

impl LegacyCredentialReader for FixtureCredentialReader {
    fn decrypt(&self, encoded: &str) -> Result<SecretValue, LegacyCredentialReadError> {
        let plaintext = match encoded {
            "[REDACTED_LEGACY_CIPHERTEXT]" => "provider-secret-fixture",
            "[REDACTED_SAFE_STORAGE_ENVELOPE]" => r#"{"FIXTURE_TOKEN":"mcp-secret-fixture"}"#,
            _ => return Err(LegacyCredentialReadError::AuthenticationFailed),
        };
        SecretValue::new(plaintext).map_err(|_| LegacyCredentialReadError::InvalidPlaintext)
    }
}

struct UnreadableCredentialReader;

impl LegacyCredentialReader for UnreadableCredentialReader {
    fn decrypt(&self, _encoded: &str) -> Result<SecretValue, LegacyCredentialReadError> {
        Err(LegacyCredentialReadError::AuthenticationFailed)
    }
}

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
                operation: "read a fixture credential",
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
                operation: "write a fixture credential",
            })?
            .insert(id.clone(), value.expose_secret().to_string());
        Ok(())
    }

    fn delete(&self, id: &CredentialId) -> Result<(), CredentialError> {
        self.values
            .lock()
            .map_err(|_| CredentialError::Unavailable {
                operation: "delete a fixture credential",
            })?
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| CredentialError::NotFound { id: id.clone() })
    }
}

async fn discover_and_backup(
    service: &LegacyMigrationService,
    fixture: &MigrationFixture,
    run_id: &str,
) -> (super::MigrationManifest, super::BackupReport) {
    let manifest = service
        .discover(
            &fixture.roots,
            MigrationRunId::parse(run_id).expect("fixture run ID must be valid"),
        )
        .await
        .expect("fixture discovery must succeed");
    let backup = service
        .backup(&fixture.roots, &manifest, &fixture.backup_root)
        .await
        .expect("fixture backup must succeed");
    (manifest, backup)
}

#[tokio::test]
async fn transform_is_idempotent_versions_all_files_and_excludes_secret_envelopes() {
    let fixture = MigrationFixture::from_reviewed_fixture();
    let service = LegacyMigrationService::default();
    let source_provider = fs::read(fixture.roots.user_data().join("providers.json"))
        .expect("provider source must be readable");
    let (manifest, backup) = discover_and_backup(&service, &fixture, "transform-reviewed").await;

    let first = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("reviewed fixture must transform");
    let second = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("repeated transformation must reuse immutable files");
    let repository = fixture.target_root.join(&first.repository_relative_path);
    let provider_bytes = fs::read(repository.join("user-data/providers.json"))
        .expect("transformed providers must be readable");
    let provider: Value =
        serde_json::from_slice(&provider_bytes).expect("transformed provider must be JSON");
    let settings: Value = serde_json::from_slice(
        &fs::read(repository.join("user-data/settings.json"))
            .expect("transformed settings must be readable"),
    )
    .expect("transformed settings must be JSON");

    assert_eq!(first, second);
    assert_eq!((first.files.len(), first.skipped_secret_files), (11, 1));
    assert_eq!(provider["schema"], "providers");
    assert_eq!(
        provider["providers"][0]["credentialId"],
        "provider-api-key:provider-legacy"
    );
    assert_eq!(
        provider["providers"][0]["models"][0]["name"],
        "legacy-model"
    );
    assert_eq!(
        provider["providers"][0]["models"][0]["maxContextTokens"],
        8192
    );
    assert_eq!(settings["appTheme"], "system");
    assert!(
        provider["providers"][0].get("apiKeyRef").is_none()
            && provider["providers"][0].get("encryption").is_none()
            && !repository.join("user-data/mcp-secrets.secure").exists()
    );
    assert_eq!(
        fs::read(fixture.roots.user_data().join("providers.json"))
            .expect("legacy provider source must remain readable"),
        source_provider
    );
}

#[tokio::test]
async fn transform_report_is_immutable_after_verification() {
    let fixture = MigrationFixture::with_files([("settings.json", r#"{"theme":"system"}"#)]);
    let service = LegacyMigrationService::default();
    let (manifest, backup) =
        discover_and_backup(&service, &fixture, "immutable-transform-report").await;
    service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("initial transform must persist its completion report");
    let report_path = fixture
        .target_root
        .join("migration-repositories/immutable-transform-report/transform-complete.json");
    fs::write(&report_path, b"{}")
        .expect("test must be able to simulate a conflicting completion report");

    let error = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect_err("a conflicting completion report must never be replaced");

    assert!(matches!(
        error,
        MigrationError::Storage(StorageError::ImmutableConflict(_))
    ));
    assert_eq!(
        fs::read(report_path).expect("conflicting report must remain available for diagnosis"),
        b"{}"
    );
}

#[tokio::test]
async fn transform_matches_legacy_provider_normalization() {
    const PROVIDERS: &str = r#"{
      "providers": [{
        "id":"provider-1",
        "models":[{"id":"model-1","name":"Model 1","maxContextTokens":16384.75}],
        "thinking":{"enabled":true,"mode":"openai","effort":"high","unknown":"drop"}
      }]
    }"#;
    let fixture = MigrationFixture::with_files([("providers.json", PROVIDERS)]);
    let service = LegacyMigrationService::default();
    let (manifest, backup) = discover_and_backup(&service, &fixture, "legacy-normalization").await;
    let report = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("legacy-compatible values must normalize");
    let repository = fixture.target_root.join(report.repository_relative_path);
    let provider: Value = serde_json::from_slice(
        &fs::read(repository.join("user-data/providers.json"))
            .expect("transformed Provider document must be readable"),
    )
    .expect("transformed Provider document must be JSON");
    assert_eq!(
        provider["providers"][0]["models"][0]["maxContextTokens"],
        16384
    );
    assert_eq!(provider["providers"][0]["thinking"]["mode"], "auto");
    assert!(
        provider["providers"][0]["thinking"]
            .get("unknown")
            .is_none()
    );
}

#[tokio::test]
async fn semantic_validation_rejects_a_missing_attachment_without_completion_evidence() {
    const SESSIONS: &str = r#"{
      "sessions": [{
        "id": "session-1",
        "messages": [{
          "id": "message-1",
          "attachments": [{"id":"missing","storageKey":"sessions/session-1/missing"}]
        }]
      }]
    }"#;
    let fixture = MigrationFixture::with_files([("sessions.json", SESSIONS)]);
    let service = LegacyMigrationService::default();
    let (manifest, backup) = discover_and_backup(&service, &fixture, "missing-attachment").await;

    let error = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect_err("missing attachment metadata must block transform verification");

    assert!(matches!(
        error,
        MigrationError::MissingReference {
            relation: "attachment",
            ..
        }
    ));
    assert!(
        !fixture
            .target_root
            .join("migration-repositories/missing-attachment/transform-complete.json")
            .exists()
            && service
                .committed_migration(&fixture.target_root)
                .await
                .expect("absent marker must be readable")
                .is_none()
    );
}

#[tokio::test]
async fn credentials_requiring_reentry_cannot_authorize_commit() {
    const PROVIDERS: &str = r#"{
      "activeProviderId": "provider-1",
      "providers": [{
        "id":"provider-1",
        "name":"Provider fixture",
        "apiKeyRef":"unreadable-envelope",
        "encryption":"safeStorage",
        "models":[],
        "thinking":{"enabled":true,"mode":"auto"}
      }]
    }"#;
    let fixture = MigrationFixture::with_files([("providers.json", PROVIDERS)]);
    let service = LegacyMigrationService::default();
    let (manifest, backup) = discover_and_backup(&service, &fixture, "credential-reentry").await;
    let transform = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("non-secret Provider config must transform");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let credential_report = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            Arc::new(UnreadableCredentialReader),
            Arc::clone(&credentials),
        )
        .await
        .expect("unreadable credentials must become explicit re-entry decisions");

    let error = service
        .commit(
            &manifest,
            &backup,
            &transform,
            &credential_report,
            &fixture.target_root,
            credentials,
        )
        .await
        .expect_err("a re-entry decision must keep the repository non-authoritative");

    assert!(matches!(error, MigrationError::CredentialReportMismatch));
    assert_eq!(credential_report.phase, MigrationPhase::AwaitingCredentials);
    assert_eq!(
        service
            .inspect_phase(&fixture.backup_root, &fixture.target_root, &manifest.run_id,)
            .await
            .expect("restart inspection must preserve the re-entry phase"),
        MigrationPhase::AwaitingCredentials
    );
    assert!(
        service
            .committed_migration(&fixture.target_root)
            .await
            .expect("absent marker must be readable")
            .is_none()
    );
}

#[tokio::test]
async fn commit_revalidates_transformed_bytes_before_creating_authority_marker() {
    let fixture = MigrationFixture::with_files([("settings.json", r#"{"theme":"system"}"#)]);
    let service = LegacyMigrationService::default();
    let (manifest, backup) = discover_and_backup(&service, &fixture, "tampered-target").await;
    let transform = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("settings fixture must transform");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let credential_report = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            Arc::new(FixtureCredentialReader),
            Arc::clone(&credentials),
        )
        .await
        .expect("absent credentials must produce verified decisions");
    fs::write(
        fixture
            .target_root
            .join(&transform.repository_relative_path)
            .join("user-data/settings.json"),
        b"{\"schema\":\"settings\",\"schemaVersion\":1,\"theme\":\"dark\"}",
    )
    .expect("transformed target must be tampered");

    let error = service
        .commit(
            &manifest,
            &backup,
            &transform,
            &credential_report,
            &fixture.target_root,
            credentials,
        )
        .await
        .expect_err("changed transformed bytes must block commit");

    assert!(matches!(error, MigrationError::TransformConflict(_)));
    assert!(
        service
            .committed_migration(&fixture.target_root)
            .await
            .expect("absent marker must be readable")
            .is_none()
    );
}

struct MarkerCommitFault;

impl AtomicWriteFaultInjector for MarkerCommitFault {
    fn check(&self, stage: AtomicWriteStage, target: &Path) -> Result<(), InjectedWriteFault> {
        if stage == AtomicWriteStage::BeforeCommit
            && target.file_name().and_then(|name| name.to_str()) == Some("migration-commit.json")
        {
            Err(InjectedWriteFault::at(stage))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn pre_commit_fault_keeps_staged_repository_non_authoritative_and_retryable() {
    let fixture = MigrationFixture::from_reviewed_fixture();
    let service = LegacyMigrationService::default();
    let (manifest, backup) = discover_and_backup(&service, &fixture, "commit-fault").await;
    let transform = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("reviewed fixture must transform");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let credential_report = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            Arc::new(FixtureCredentialReader),
            Arc::clone(&credentials),
        )
        .await
        .expect("fixture credentials must migrate");
    let faulting = LegacyMigrationService::new(
        AtomicFileStore::with_fault_injector(64 * 1024 * 1024, Arc::new(MarkerCommitFault))
            .expect("faulting store limit must be valid"),
        super::DiscoveryLimits::default(),
    );

    let error = faulting
        .commit(
            &manifest,
            &backup,
            &transform,
            &credential_report,
            &fixture.target_root,
            Arc::clone(&credentials),
        )
        .await
        .expect_err("fault before marker commit must be visible");
    assert!(matches!(
        error,
        MigrationError::Storage(StorageError::Injected { .. })
    ));
    assert!(
        service
            .committed_migration(&fixture.target_root)
            .await
            .expect("absent marker must be readable")
            .is_none()
    );
    assert_eq!(
        service
            .inspect_phase(&fixture.backup_root, &fixture.target_root, &manifest.run_id,)
            .await
            .expect("restart inspection must find the verified retry point"),
        MigrationPhase::Verified
    );

    let first = service
        .commit(
            &manifest,
            &backup,
            &transform,
            &credential_report,
            &fixture.target_root,
            Arc::clone(&credentials),
        )
        .await
        .expect("retry must atomically commit the verified run");
    let second = service
        .commit(
            &manifest,
            &backup,
            &transform,
            &credential_report,
            &fixture.target_root,
            credentials,
        )
        .await
        .expect("repeated commit must reuse the same immutable marker");
    let loaded = service
        .committed_migration(&fixture.target_root)
        .await
        .expect("committed marker must be readable")
        .expect("committed marker must exist");

    assert_eq!((first, second.clone()), (second.clone(), second));
    assert_eq!(loaded.phase, MigrationPhase::Committed);
    assert_eq!(
        service
            .inspect_phase(&fixture.backup_root, &fixture.target_root, &manifest.run_id,)
            .await
            .expect("restart inspection must find committed authority"),
        MigrationPhase::Committed
    );
}

#[tokio::test]
async fn committed_repository_is_reverified_before_restart_activation() {
    let fixture = MigrationFixture::with_files([("settings.json", r#"{"theme":"system"}"#)]);
    let service = LegacyMigrationService::default();
    let (manifest, backup) =
        discover_and_backup(&service, &fixture, "restart-reverification").await;
    let transform = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("fixture must transform");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let credential_report = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            Arc::new(FixtureCredentialReader),
            Arc::clone(&credentials),
        )
        .await
        .expect("empty credential set must verify");
    service
        .commit(
            &manifest,
            &backup,
            &transform,
            &credential_report,
            &fixture.target_root,
            credentials,
        )
        .await
        .expect("fixture migration must commit");
    let settings_path = fixture
        .target_root
        .join(&transform.repository_relative_path)
        .join("user-data/settings.json");
    fs::write(
        settings_path,
        br#"{"schema":"settings","schemaVersion":1,"appTheme":"dark"}"#,
    )
    .expect("fixture repository must be tampered after commit");

    let error = service
        .committed_migration(&fixture.target_root)
        .await
        .expect_err("changed repository bytes must block restart activation");

    assert!(matches!(error, MigrationError::TransformConflict(_)));
}

#[tokio::test]
async fn reserved_codez_migration_layout_completes_without_mutating_or_rediscovering_sources() {
    let fixture = MigrationFixture::with_reserved_codez_layout();
    let service = LegacyMigrationService::default();
    let source_paths = reserved_layout_source_paths(&fixture);
    let hashes_before = source_hashes(&source_paths);
    let run_id =
        MigrationRunId::parse("reserved-codez-layout").expect("fixture migration ID must be valid");
    let manifest = service
        .discover(&fixture.roots, run_id)
        .await
        .expect("Electron and existing CodeZ sources must be discovered");
    assert_eq!(manifest.entries.len(), source_paths.len());
    assert!(manifest.entries.iter().all(|entry| {
        !entry
            .relative_path
            .starts_with(Path::new(".codez/migrations"))
    }));

    let first_backup = service
        .backup(&fixture.roots, &manifest, &fixture.backup_root)
        .await
        .expect("reserved backup subtree must be accepted");
    let retried_backup = service
        .backup(&fixture.roots, &manifest, &fixture.backup_root)
        .await
        .expect("reserved backup retry must reuse immutable copies");
    let first_transform = service
        .transform(
            &fixture.roots,
            &manifest,
            &first_backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("reserved staging subtree must be accepted");
    let retried_transform = service
        .transform(
            &fixture.roots,
            &manifest,
            &retried_backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect("reserved staging retry must reuse immutable outputs");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let first_credentials = service
        .migrate_credentials(
            &manifest,
            &first_backup,
            &fixture.backup_root,
            Arc::new(FixtureCredentialReader),
            Arc::clone(&credentials),
        )
        .await
        .expect("absent legacy credentials must produce verified decisions");
    let retried_credentials = service
        .migrate_credentials(
            &manifest,
            &retried_backup,
            &fixture.backup_root,
            Arc::new(FixtureCredentialReader),
            Arc::clone(&credentials),
        )
        .await
        .expect("credential decision retry must be idempotent");
    assert!(
        service
            .committed_migration(&fixture.target_root)
            .await
            .expect("pre-commit authority state must be readable")
            .is_none()
    );

    let first_commit = service
        .commit(
            &manifest,
            &first_backup,
            &first_transform,
            &first_credentials,
            &fixture.target_root,
            Arc::clone(&credentials),
        )
        .await
        .expect("verified migration must commit atomically");
    let retried_commit = service
        .commit(
            &manifest,
            &retried_backup,
            &retried_transform,
            &retried_credentials,
            &fixture.target_root,
            credentials,
        )
        .await
        .expect("commit retry must reuse the authority marker");
    let rediscovered = service
        .discover(
            &fixture.roots,
            MigrationRunId::parse("reserved-codez-rediscovery")
                .expect("fixture migration ID must be valid"),
        )
        .await
        .expect("migration artifacts must not contaminate rediscovery");

    assert_eq!(source_hashes(&source_paths), hashes_before);
    assert_eq!(first_transform, retried_transform);
    assert_eq!(first_credentials, retried_credentials);
    assert_eq!(first_commit, retried_commit);
    assert_eq!(rediscovered.entries, manifest.entries);
    assert_eq!(retried_backup.reused_files, manifest.entries.len());
    assert_eq!(
        service
            .inspect_phase(&fixture.backup_root, &fixture.target_root, &manifest.run_id)
            .await
            .expect("committed reserved layout must be inspectable"),
        MigrationPhase::Committed
    );
}

#[tokio::test]
async fn backup_rejects_a_location_inside_a_catalog_recursive_source() {
    let fixture = MigrationFixture::with_reserved_codez_layout();
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &fixture.roots,
            MigrationRunId::parse("backup-source-overlap")
                .expect("fixture migration ID must be valid"),
        )
        .await
        .expect("fixture discovery must succeed");
    let unsafe_backup = fixture
        .roots
        .user_home()
        .join(".codez/rules/migration-backup");

    let error = service
        .backup(&fixture.roots, &manifest, &unsafe_backup)
        .await
        .expect_err("a backup below a recursive source must be rejected");

    assert!(matches!(error, MigrationError::OverlappingBackupRoot(path) if path == unsafe_backup));
}

#[tokio::test]
async fn transform_rejects_electron_catalog_and_backup_target_overlaps() {
    let fixture = MigrationFixture::with_reserved_codez_layout();
    let service = LegacyMigrationService::default();
    let (manifest, backup) = discover_and_backup(&service, &fixture, "target-source-overlap").await;
    let unsafe_targets = [
        fixture.roots.user_data().join("migration-target"),
        fixture.roots.user_home().join(".codez/rules/staging"),
        fixture.roots.user_home().join(".codez/projects/staging"),
        fixture.backup_root.join("nested-target"),
    ];

    for unsafe_target in unsafe_targets {
        let error = service
            .transform(
                &fixture.roots,
                &manifest,
                &backup,
                &fixture.backup_root,
                &unsafe_target,
            )
            .await
            .expect_err("overlapping target must be rejected before transformation");
        assert!(
            matches!(error, MigrationError::OverlappingTargetRoot(path) if path == unsafe_target)
        );
    }
}

#[tokio::test]
async fn transform_rejects_a_symlink_or_reparse_point_in_the_staging_path() {
    let fixture = MigrationFixture::with_reserved_codez_layout();
    let service = LegacyMigrationService::default();
    let (manifest, backup) = discover_and_backup(&service, &fixture, "redirected-staging").await;
    let redirected_directory = fixture
        ._directory
        .path()
        .join("redirected-staging-outside-codez");
    fs::create_dir_all(&redirected_directory)
        .expect("fixture redirect destination must be created");
    create_directory_redirect(&redirected_directory, &fixture.target_root);

    let error = service
        .transform(
            &fixture.roots,
            &manifest,
            &backup,
            &fixture.backup_root,
            &fixture.target_root,
        )
        .await
        .expect_err("filesystem redirection must not escape migration staging");

    assert!(matches!(error, MigrationError::SymbolicLink(path) if path == fixture.target_root));
}
