use std::{
    collections::HashMap,
    fs,
    sync::{Arc, Mutex},
};

use codez_contracts::{ErrorCode, provider as wire};
use codez_core::{
    AppErrorKind,
    provider::{ApiFormat, ProviderRepository, ThinkingEffort, ThinkingMode},
};
use codez_providers::service::ProviderService;
use codez_storage::{
    AtomicFileStore, CredentialError, CredentialId, CredentialKind, CredentialMigrationStatus,
    CredentialStore, LegacyCredentialReadError, LegacyCredentialReader, LegacyDataSet,
    LegacyMigrationService, LegacyRoots, MigrationActivationService, MigrationPhase,
    MigrationRunId, SecretValue,
};

use crate::error::{ErrorReporter, command_result};

use super::{
    StorageProviderCredentials, StorageProviderRepository, provider_form_from_wire,
    provider_info_to_wire,
};

#[derive(Default)]
struct MemoryCredentialStore {
    values: Mutex<HashMap<CredentialId, String>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn get(&self, id: &CredentialId) -> Result<SecretValue, CredentialError> {
        let secret = self
            .values
            .lock()
            .map_err(|_| CredentialError::Unavailable {
                operation: "read a Provider migration test credential",
            })?
            .get(id)
            .cloned()
            .ok_or_else(|| CredentialError::NotFound { id: id.clone() })?;
        SecretValue::new(secret)
    }

    fn set(&self, id: &CredentialId, value: &SecretValue) -> Result<(), CredentialError> {
        self.values
            .lock()
            .map_err(|_| CredentialError::Unavailable {
                operation: "write a Provider migration test credential",
            })?
            .insert(id.clone(), value.expose_secret().to_string());
        Ok(())
    }

    fn delete(&self, id: &CredentialId) -> Result<(), CredentialError> {
        self.values
            .lock()
            .map_err(|_| CredentialError::Unavailable {
                operation: "delete a Provider migration test credential",
            })?
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| CredentialError::NotFound { id: id.clone() })
    }
}

struct NoCredentialReader;

impl LegacyCredentialReader for NoCredentialReader {
    fn decrypt(&self, _encoded: &str) -> Result<SecretValue, LegacyCredentialReadError> {
        Err(LegacyCredentialReadError::UnsupportedPlatform)
    }
}

#[tokio::test]
async fn provider_repository_should_reject_unmigrated_legacy_secret_fields() {
    let directory = tempfile::tempdir().expect("Provider repository fixture must exist");
    let path = directory.path().join("providers.json");
    fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema": "providers",
            "schemaVersion": 1,
            "providers": [{
                "id": "provider-legacy",
                "name": "Legacy Provider",
                "baseUrl": "https://provider.invalid/v1",
                "apiKeyRef": "legacy-secret-envelope",
                "encryption": "safeStorage",
                "models": [],
                "thinking": { "enabled": true, "mode": "auto" },
                "enabled": true,
                "createdAt": "2025-01-01T00:00:00Z",
                "updatedAt": "2025-01-01T00:00:00Z"
            }]
        }))
        .expect("legacy Provider fixture must serialize"),
    )
    .expect("legacy Provider fixture must be written");
    let repository = StorageProviderRepository::new(Arc::new(AtomicFileStore::default()), path);

    let result = repository.load().await;

    assert!(result.is_err());
}

#[tokio::test]
async fn transformed_provider_should_resolve_through_the_composed_storage_adapters() {
    const SECRET: &str = "sk-migrated-provider-secret";
    let directory = tempfile::tempdir().expect("migration fixture directory must exist");
    let user_data = directory.path().join("electron-user-data");
    let user_home = directory.path().join("home");
    let backup_root = user_home.join(".codez/migrations/backups");
    let staging_root = user_home.join(".codez/migrations/staging");
    fs::create_dir_all(&user_data).expect("Electron fixture directory must exist");
    fs::create_dir_all(&user_home).expect("home fixture directory must exist");
    write_legacy_provider(&user_data, "legacy-safe-storage-envelope", "safeStorage");

    let roots =
        LegacyRoots::new(user_data, user_home, Vec::new()).expect("migration roots must be valid");
    let migration = LegacyMigrationService::default();
    let manifest = migration
        .discover(
            &roots,
            MigrationRunId::parse("provider-contract-e2e").expect("migration run ID must be valid"),
        )
        .await
        .expect("legacy Provider must be discovered");
    let backup = migration
        .backup(&roots, &manifest, &backup_root)
        .await
        .expect("legacy Provider must be backed up");
    let transform = migration
        .transform(&roots, &manifest, &backup, &backup_root, &staging_root)
        .await
        .expect("legacy Provider must transform into the Rust contract");
    let providers_path = staging_root
        .join(&transform.repository_relative_path)
        .join("user-data/providers.json");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let credential_id = CredentialId::new(CredentialKind::ProviderApiKey, "provider-legacy")
        .expect("fixture credential identity must be valid");
    credentials
        .set(
            &credential_id,
            &SecretValue::new(SECRET).expect("fixture secret must be valid"),
        )
        .expect("migrated credential must be available");
    let service = provider_service(providers_path, credentials)
        .await
        .expect("Provider service must load transformed metadata");

    let resolved = service
        .resolve_chat_config(None, Some("legacy-model"))
        .await
        .expect("migrated Provider and credential must resolve for chat");

    assert_eq!(
        (
            resolved.provider_id.as_str(),
            resolved.api_format,
            resolved.model.max_output_tokens,
            resolved.thinking.mode,
            resolved.thinking.effort,
            resolved.api_key.expose_secret(),
        ),
        (
            "provider-legacy",
            ApiFormat::Anthropic,
            Some(4096),
            ThinkingMode::Anthropic,
            Some(ThinkingEffort::High),
            SECRET,
        )
    );
}

#[tokio::test]
async fn provider_without_api_key_should_commit_activate_and_remain_unconfigured() {
    let directory = tempfile::tempdir().expect("migration fixture directory must exist");
    let user_data = directory.path().join("electron-user-data");
    let user_home = directory.path().join("home");
    let application_data_root = user_home.join(".codez");
    let backup_root = application_data_root.join("migrations/backups");
    let staging_root = application_data_root.join("migrations/staging");
    fs::create_dir_all(&user_data).expect("Electron fixture directory must exist");
    fs::create_dir_all(&application_data_root).expect("application data root must exist");
    write_legacy_provider(&user_data, "", "none");

    let roots =
        LegacyRoots::new(user_data, user_home, Vec::new()).expect("migration roots must be valid");
    let migration = LegacyMigrationService::default();
    let run_id =
        MigrationRunId::parse("provider-without-key-e2e").expect("migration run ID must be valid");
    let manifest = migration
        .discover(&roots, run_id)
        .await
        .expect("legacy Provider must be discovered");
    let backup = migration
        .backup(&roots, &manifest, &backup_root)
        .await
        .expect("legacy Provider must be backed up");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let credential_report = migration
        .migrate_credentials(
            &manifest,
            &backup,
            &backup_root,
            Arc::new(NoCredentialReader),
            Arc::clone(&credentials),
        )
        .await
        .expect("an empty legacy credential must be a verified absence");
    let transform = migration
        .transform(&roots, &manifest, &backup, &backup_root, &staging_root)
        .await
        .expect("unconfigured legacy Provider must transform");
    let commit = migration
        .commit(
            &manifest,
            &backup,
            &transform,
            &credential_report,
            &staging_root,
            Arc::clone(&credentials),
        )
        .await
        .expect("unconfigured legacy Provider must not block commit");
    MigrationActivationService::new(AtomicFileStore::default())
        .activate(
            &roots,
            &application_data_root,
            &staging_root,
            &commit,
            &transform,
        )
        .await
        .expect("committed Provider must activate");
    let service = provider_service(
        application_data_root.join("providers.json"),
        Arc::clone(&credentials),
    )
    .await
    .expect("Provider service must load activated metadata");
    let info = service
        .get_all()
        .await
        .expect("activated Provider must be listable")
        .into_iter()
        .next()
        .expect("activated Provider must exist");
    let resolve_error = service
        .resolve_chat_config(Some(&info.id), Some("legacy-model"))
        .await
        .err()
        .expect("chat resolution must fail without inventing a key");
    let persisted: serde_json::Value = serde_json::from_slice(
        &fs::read(application_data_root.join("providers.json"))
            .expect("activated Provider document must exist"),
    )
    .expect("activated Provider document must remain valid JSON");

    assert!(
        credential_report.phase == MigrationPhase::Verified
            && credential_report.entries.iter().any(|entry| {
                entry.data_set == LegacyDataSet::Providers
                    && entry.status == CredentialMigrationStatus::NotPresent
            })
            && persisted["providers"][0].get("credentialId").is_none()
            && !info.api_key_configured
            && resolve_error.kind() == AppErrorKind::Conflict
    );
}

#[tokio::test]
async fn provider_boundary_crud_should_keep_api_keys_out_of_metadata_and_wire_responses() {
    const SECRET: &str = "sk-boundary-secret-that-must-not-cross-ipc";
    let directory = tempfile::tempdir().expect("Provider boundary fixture directory must exist");
    let providers_path = directory.path().join("providers.json");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let service = provider_service(providers_path.clone(), Arc::clone(&credentials))
        .await
        .expect("Provider boundary service must initialize");

    let created = service
        .create(
            provider_form_from_wire(wire_provider_form(SECRET))
                .expect("valid wire Provider data must convert"),
        )
        .await
        .expect("wire Provider creation must succeed");
    let created_wire = provider_info_to_wire(created);
    let created_payload =
        serde_json::to_string(&created_wire).expect("Provider wire response must serialize");
    let persisted_metadata =
        fs::read_to_string(&providers_path).expect("Provider metadata must persist after creation");

    let listed = service
        .get_all()
        .await
        .expect("Provider listing must succeed")
        .into_iter()
        .map(provider_info_to_wire)
        .collect::<Vec<_>>();
    let listed_payload =
        serde_json::to_string(&listed).expect("Provider list wire response must serialize");

    let mut update = wire_provider_form("");
    update.name = "Updated Boundary Provider".to_string();
    let updated = service
        .update(
            &created_wire.id,
            provider_form_from_wire(update).expect("valid wire Provider update must convert"),
        )
        .await
        .map(provider_info_to_wire)
        .expect("wire Provider update must succeed");

    service
        .delete(&created_wire.id)
        .await
        .expect("Provider deletion must succeed");

    assert!(
        created_wire.api_key_configured
            && updated.api_key_configured
            && !created_payload.contains(SECRET)
            && !listed_payload.contains(SECRET)
            && !persisted_metadata.contains(SECRET)
            && service
                .get_all()
                .await
                .expect("Provider listing must remain available after deletion")
                .is_empty()
            && credentials
                .values
                .lock()
                .expect("credential fixture lock must remain available")
                .is_empty(),
        "Provider API keys must remain in the credential adapter and be removed on deletion"
    );
}

#[tokio::test]
async fn provider_boundary_should_map_invalid_wire_input_to_a_redacted_validation_error() {
    const SECRET: &str = "sk-submitted-secret-that-must-not-appear-in-command-errors";
    let directory = tempfile::tempdir().expect("Provider boundary fixture directory must exist");
    let credentials = Arc::new(MemoryCredentialStore::default());
    let service = provider_service(directory.path().join("providers.json"), credentials)
        .await
        .expect("Provider boundary service must initialize");
    let reporter = ErrorReporter::default();
    let mut data = wire_provider_form(SECRET);
    data.name = "   ".to_string();

    let result = async {
        let data = provider_form_from_wire(data)?;
        service.create(data).await.map(provider_info_to_wire)
    }
    .await;
    let error = command_result(&reporter, result)
        .expect_err("invalid Provider data must produce a command error");
    let error_payload =
        serde_json::to_string(&error).expect("Provider command error must serialize");

    assert!(
        error.code == ErrorCode::Validation
            && !error.message.contains(SECRET)
            && !error_payload.contains(SECRET),
        "Provider command errors must not disclose submitted API keys"
    );
}

async fn provider_service(
    providers_path: std::path::PathBuf,
    credentials: Arc<MemoryCredentialStore>,
) -> Result<ProviderService, codez_core::AppError> {
    let repository = Arc::new(StorageProviderRepository::new(
        Arc::new(AtomicFileStore::default()),
        providers_path,
    ));
    let credential_adapter = Arc::new(StorageProviderCredentials::new(credentials));
    ProviderService::new(repository, credential_adapter).await
}

fn wire_provider_form(api_key: &str) -> wire::ProviderFormData {
    wire::ProviderFormData {
        name: "Boundary Provider".to_string(),
        base_url: "https://provider.invalid/v1".to_string(),
        api_format: Some(wire::ApiFormat::Openai),
        api_key: api_key.to_string(),
        models: vec![wire::ModelConfig {
            id: "boundary-model".to_string(),
            name: "boundary-model".to_string(),
            max_context_tokens: 8_192,
            max_input_tokens: None,
            max_output_tokens: Some(2_048),
            reasoning_counts_against_context: None,
            supports_vision: None,
            api_format: None,
            thinking_mode: None,
            thinking_effort: None,
            thinking_budget_tokens: None,
        }],
        thinking: wire::ThinkingConfig {
            enabled: true,
            mode: wire::ThinkingMode::Auto,
            effort: None,
            budget_tokens: None,
        },
    }
}

fn write_legacy_provider(user_data: &std::path::Path, api_key_ref: &str, encryption: &str) {
    fs::write(
        user_data.join("providers.json"),
        serde_json::to_vec(&serde_json::json!({
            "activeProviderId": "provider-legacy",
            "providers": [{
                "id": "provider-legacy",
                "name": "Migrated Provider",
                "baseUrl": "https://provider.invalid/v1",
                "apiFormat": "openai",
                "apiKeyRef": api_key_ref,
                "encryption": encryption,
                "models": [{
                    "id": "legacy-model-id",
                    "name": "legacy-model",
                    "maxContextTokens": 32768,
                    "maxOutputTokens": 4096,
                    "apiFormat": "anthropic",
                    "thinkingMode": "anthropic",
                    "thinkingEffort": "high"
                }],
                "thinking": { "enabled": true, "mode": "auto" },
                "enabled": true,
                "createdAt": "2025-01-01T00:00:00Z",
                "updatedAt": "2025-01-01T00:00:00Z"
            }]
        }))
        .expect("legacy Provider fixture must serialize"),
    )
    .expect("legacy Provider fixture must be written");
}
