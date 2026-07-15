use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use super::{
    CredentialMigrationReason, CredentialMigrationStatus, LegacyCredentialReadError,
    LegacyCredentialReader, LegacyMigrationService, LegacyRoots, MigrationError, MigrationPhase,
    MigrationRunId,
};
use crate::{CredentialError, CredentialId, CredentialKind, CredentialStore, SecretValue};

struct FakeLegacyReader {
    values: HashMap<String, String>,
}

impl FakeLegacyReader {
    fn new(values: impl IntoIterator<Item = (&'static str, &'static str)>) -> Self {
        Self {
            values: values
                .into_iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        }
    }
}

impl LegacyCredentialReader for FakeLegacyReader {
    fn decrypt(&self, encoded: &str) -> Result<SecretValue, LegacyCredentialReadError> {
        self.values
            .get(encoded)
            .cloned()
            .ok_or(LegacyCredentialReadError::AuthenticationFailed)
            .and_then(|value| {
                SecretValue::new(value).map_err(|_| LegacyCredentialReadError::InvalidPlaintext)
            })
    }
}

#[derive(Default)]
struct MemoryCredentialStore {
    values: Mutex<HashMap<CredentialId, String>>,
}

impl MemoryCredentialStore {
    fn snapshot(&self) -> HashMap<CredentialId, String> {
        self.values
            .lock()
            .expect("fixture credential lock must be available")
            .clone()
    }
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

struct CredentialFixture {
    _directory: tempfile::TempDir,
    roots: LegacyRoots,
    backup_root: PathBuf,
}

impl CredentialFixture {
    fn new(files: impl IntoIterator<Item = (&'static str, &'static str)>) -> Self {
        let directory = tempfile::tempdir().expect("fixture directory must be available");
        let user_data = directory.path().join("user-data");
        let home = directory.path().join("home");
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(&user_data).expect("fixture user data must be created");
        fs::create_dir_all(&home).expect("fixture home must be created");
        fs::create_dir_all(&workspace).expect("fixture workspace must be created");
        for (name, contents) in files {
            fs::write(user_data.join(name), contents).expect("fixture source must be written");
        }
        let roots = LegacyRoots::new(user_data, home, vec![workspace])
            .expect("fixture roots must be valid");
        let backup_root = directory.path().join("backups");
        Self {
            _directory: directory,
            roots,
            backup_root,
        }
    }
}

#[tokio::test]
async fn credential_migration_is_redacted_and_idempotent_across_all_three_families() {
    const PROVIDERS: &str = r#"{
      "providers": [
        {"id":"provider-safe","apiKeyRef":"provider-envelope","encryption":"safeStorage"},
        {"id":"provider-base64","apiKeyRef":"cGxhaW50ZXh0","encryption":"base64"},
        {"id":"provider-none","apiKeyRef":"plaintext-provider-value","encryption":"none"}
      ]
    }"#;
    let fixture = CredentialFixture::new([
        ("providers.json", PROVIDERS),
        ("mcp-secrets.secure", "mcp-secret-envelope"),
        ("mcp-oauth.secure", "mcp-oauth-envelope"),
    ]);
    let provider_source_before = fs::read(fixture.roots.user_data().join("providers.json"))
        .expect("provider source must be readable");
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &fixture.roots,
            MigrationRunId::parse("credential-success")
                .expect("fixture migration ID must be valid"),
        )
        .await
        .expect("credential fixture discovery must succeed");
    let backup = service
        .backup(&fixture.roots, &manifest, &fixture.backup_root)
        .await
        .expect("credential fixture backup must succeed");
    let reader = Arc::new(FakeLegacyReader::new([
        ("provider-envelope", "provider-plaintext-fixture"),
        (
            "mcp-secret-envelope",
            r#"{"TOKEN":"mcp-plaintext-fixture"}"#,
        ),
        (
            "mcp-oauth-envelope",
            r#"{"oauth-server-1":{"tokens":{"access_token":"oauth-plaintext-fixture"}}}"#,
        ),
    ]));
    let credential_store = Arc::new(MemoryCredentialStore::default());

    let first = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            Arc::clone(&reader),
            Arc::clone(&credential_store),
        )
        .await
        .expect("first credential migration must succeed");
    let second = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            reader,
            Arc::clone(&credential_store),
        )
        .await
        .expect("repeated credential migration must succeed");
    let report_path = fixture
        .backup_root
        .join("credential-success/credential-migration.json");
    let serialized_report =
        fs::read_to_string(report_path).expect("redacted credential report must be persisted");
    let stored = credential_store.snapshot();

    assert_eq!(first, second);
    assert_eq!(first.phase, MigrationPhase::AwaitingCredentials);
    assert_eq!(
        (first.migrated, first.requires_reentry, first.not_present),
        (3, 2, 0)
    );
    assert_eq!(stored.len(), 3);
    assert_eq!(
        stored.get(
            &CredentialId::new(CredentialKind::ProviderApiKey, "provider-safe")
                .expect("fixture provider ID must be valid")
        ),
        Some(&"provider-plaintext-fixture".to_string())
    );
    assert!(first.entries.iter().any(|entry| {
        entry.status == CredentialMigrationStatus::RequiresReentry
            && entry.reason == Some(CredentialMigrationReason::InsecureLegacyEncoding)
    }));
    assert!(
        !serialized_report.contains("plaintext-fixture")
            && !serialized_report.contains("provider-envelope")
            && !serialized_report.contains("cGxhaW50ZXh0")
            && !serialized_report.contains("plaintext-provider-value")
    );
    assert_eq!(
        fs::read(fixture.roots.user_data().join("providers.json"))
            .expect("legacy provider source must remain readable"),
        provider_source_before
    );
}

#[tokio::test]
async fn malformed_aggregate_plaintext_requires_reentry_without_writing_credentials() {
    let fixture = CredentialFixture::new([
        ("mcp-secrets.secure", "bad-secret-envelope"),
        ("mcp-oauth.secure", "bad-oauth-envelope"),
    ]);
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &fixture.roots,
            MigrationRunId::parse("credential-malformed")
                .expect("fixture migration ID must be valid"),
        )
        .await
        .expect("credential fixture discovery must succeed");
    let backup = service
        .backup(&fixture.roots, &manifest, &fixture.backup_root)
        .await
        .expect("credential fixture backup must succeed");
    let reader = Arc::new(FakeLegacyReader::new([
        ("bad-secret-envelope", "[]"),
        ("bad-oauth-envelope", r#"{"server":"not-an-object"}"#),
    ]));
    let credential_store = Arc::new(MemoryCredentialStore::default());

    let report = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            reader,
            Arc::clone(&credential_store),
        )
        .await
        .expect("malformed plaintext must become a redacted decision");

    assert_eq!(
        (report.migrated, report.requires_reentry, report.not_present),
        (0, 2, 1)
    );
    assert_eq!(report.phase, MigrationPhase::AwaitingCredentials);
    assert!(credential_store.snapshot().is_empty());
    assert_eq!(
        report
            .entries
            .iter()
            .filter(|entry| {
                entry.reason == Some(CredentialMigrationReason::InvalidLegacyDocument)
            })
            .count(),
        2
    );
}

#[tokio::test]
async fn failed_envelope_authentication_is_an_explicit_reentry_decision() {
    const PROVIDERS: &str = r#"{
      "providers": [
        {"id":"provider-auth-failure","apiKeyRef":"unknown-envelope","encryption":"safeStorage"}
      ]
    }"#;
    let fixture = CredentialFixture::new([("providers.json", PROVIDERS)]);
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &fixture.roots,
            MigrationRunId::parse("credential-auth-failure")
                .expect("fixture migration ID must be valid"),
        )
        .await
        .expect("credential fixture discovery must succeed");
    let backup = service
        .backup(&fixture.roots, &manifest, &fixture.backup_root)
        .await
        .expect("credential fixture backup must succeed");

    let report = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            Arc::new(FakeLegacyReader::new([])),
            Arc::new(MemoryCredentialStore::default()),
        )
        .await
        .expect("authentication failure must become a redacted decision");

    assert!(report.entries.iter().any(|entry| {
        entry.reason == Some(CredentialMigrationReason::AuthenticationFailed)
            && entry.status == CredentialMigrationStatus::RequiresReentry
    }));
}

#[tokio::test]
async fn credential_migration_rejects_a_backup_changed_after_verification() {
    const PROVIDERS: &str = r#"{
      "providers": [
        {"id":"provider-tamper","apiKeyRef":"provider-envelope","encryption":"safeStorage"}
      ]
    }"#;
    let fixture = CredentialFixture::new([("providers.json", PROVIDERS)]);
    let service = LegacyMigrationService::default();
    let manifest = service
        .discover(
            &fixture.roots,
            MigrationRunId::parse("credential-tamper").expect("fixture migration ID must be valid"),
        )
        .await
        .expect("credential fixture discovery must succeed");
    let backup = service
        .backup(&fixture.roots, &manifest, &fixture.backup_root)
        .await
        .expect("credential fixture backup must succeed");
    let backup_path = fixture
        .backup_root
        .join("credential-tamper/user-data/providers.json");
    let tampered = PROVIDERS.replace("provider-envelope", "provider-Envelope");
    fs::write(&backup_path, tampered).expect("fixture backup must be changed");
    let credential_store = Arc::new(MemoryCredentialStore::default());

    let error = service
        .migrate_credentials(
            &manifest,
            &backup,
            &fixture.backup_root,
            Arc::new(FakeLegacyReader::new([(
                "provider-envelope",
                "provider-plaintext-fixture",
            )])),
            Arc::clone(&credential_store),
        )
        .await
        .expect_err("changed backup must block credential migration");

    assert!(matches!(error, MigrationError::BackupConflict(_)));
    assert!(credential_store.snapshot().is_empty());
}
