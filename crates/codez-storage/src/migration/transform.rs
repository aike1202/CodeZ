use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    BACKUP_REPORT_SCHEMA_VERSION, BackupReport, CredentialMigrationReport,
    CredentialMigrationStatus, LegacyDataSet, LegacyFormat, LegacyRoots, LegacyValidation,
    ManifestScope, MigrationError, MigrationManifest, MigrationManifestEntry, MigrationPhase,
    MigrationRunId, credentials, filesystem, layout,
};
use crate::{CredentialId, CredentialKind, CredentialStore, SchemaFamily, SchemaFormat};

const TRANSFORM_REPORT_SCHEMA_VERSION: u32 = 1;
const COMMIT_MARKER_SCHEMA_VERSION: u32 = 1;
const REPOSITORY_LAYOUT_VERSION: u32 = 1;
const REPOSITORIES_DIRECTORY: &str = "migration-repositories";
const REPOSITORY_DIRECTORY: &str = "repository";
const TRANSFORM_REPORT_FILE: &str = "transform-complete.json";
const COMMIT_MARKER_FILE: &str = "migration-commit.json";

/// One immutable file produced from a verified legacy backup entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformedFile {
    /// Legacy data family that owns the target.
    pub data_set: LegacyDataSet,
    /// Root scope retained without serializing an absolute path.
    pub scope: ManifestScope,
    /// Repository-relative path below the retained scope.
    pub relative_path: PathBuf,
    /// Versioned schema family for structured data.
    pub schema: Option<SchemaFamily>,
    /// Hash of the exact verified backup input.
    pub source_sha256: String,
    /// Hash of the immutable transformed output.
    pub target_sha256: String,
    /// Exact transformed byte length.
    pub target_byte_length: u64,
    /// Structured records before transformation, absent for opaque data.
    pub source_records: Option<usize>,
    /// Structured records after transformation, absent for opaque data.
    pub target_records: Option<usize>,
}

/// Deterministic proof that all non-secret legacy files were transformed and verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformReport {
    /// Report serialization version.
    pub schema_version: u32,
    /// Migration run associated with the verified backup.
    pub run_id: MigrationRunId,
    /// Fingerprint of the source manifest.
    pub manifest_fingerprint: String,
    /// Fixed relative location selected by a future repository adapter.
    pub repository_relative_path: PathBuf,
    /// Deterministically ordered transformed files.
    pub files: Vec<TransformedFile>,
    /// Source secret-envelope files intentionally omitted from disk targets.
    pub skipped_secret_files: usize,
    /// Aggregate transformed bytes.
    pub total_target_bytes: u64,
    /// Always [`MigrationPhase::Verified`] after semantic validation succeeds.
    pub phase: MigrationPhase,
    /// SHA-256 over the report content excluding this field.
    pub fingerprint: String,
}

/// Single authority record that selects one verified immutable repository run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCommitMarker {
    /// Marker serialization version.
    pub schema_version: u32,
    /// Immutable repository layout version.
    pub repository_layout_version: u32,
    /// Committed migration run.
    pub run_id: MigrationRunId,
    /// Fingerprint of the source manifest.
    pub manifest_fingerprint: String,
    /// Fingerprint of the verified transformed repository.
    pub transform_fingerprint: String,
    /// Fingerprint of the redacted credential decision report.
    pub credential_report_fingerprint: String,
    /// Relative immutable repository root selected by this marker.
    pub repository_relative_path: PathBuf,
    /// Number of immutable repository files.
    pub transformed_files: usize,
    /// Always [`MigrationPhase::Committed`] for an authoritative marker.
    pub phase: MigrationPhase,
    /// SHA-256 over the marker content excluding this field.
    pub fingerprint: String,
}

pub(super) fn transform_report_path(target_root: &Path, run_id: &MigrationRunId) -> PathBuf {
    target_root
        .join(REPOSITORIES_DIRECTORY)
        .join(run_id.as_str())
        .join(TRANSFORM_REPORT_FILE)
}

pub(super) fn commit_marker_path(target_root: &Path) -> PathBuf {
    target_root.join(COMMIT_MARKER_FILE)
}

pub(super) fn transform_blocking(
    roots: &LegacyRoots,
    manifest: &MigrationManifest,
    backup_report: &BackupReport,
    backup_root: &Path,
    target_root: &Path,
) -> Result<TransformReport, MigrationError> {
    validate_backup_prerequisite(manifest, backup_report)?;
    let repository_relative_path = repository_relative_path(&manifest.run_id);
    let repository_root = target_root.join(&repository_relative_path);
    layout::validate_transform_layout(roots, manifest, backup_root, target_root)?;

    let mut files = Vec::with_capacity(manifest.entries.len());
    let mut skipped_secret_files = 0_usize;
    let mut total_target_bytes = 0_u64;
    for entry in &manifest.entries {
        if entry.format == LegacyFormat::SecretEnvelope {
            skipped_secret_files = skipped_secret_files.saturating_add(1);
            continue;
        }
        if blocks_data_transformation(&entry.validation) {
            return Err(MigrationError::TransformationBlocked {
                data_set: entry.data_set,
                relative_path: entry.relative_path.clone(),
            });
        }

        let source = filesystem::read_verified_backup_entry(manifest, backup_root, entry)?;
        let transformed = transform_entry(entry, source)?;
        let target = repository_root
            .join(entry.scope.backup_directory_name())
            .join(&entry.relative_path);
        filesystem::write_immutable_target(&target, &transformed.bytes)?;
        let target_byte_length = u64::try_from(transformed.bytes.len()).unwrap_or(u64::MAX);
        total_target_bytes = total_target_bytes.saturating_add(target_byte_length);
        files.push(TransformedFile {
            data_set: entry.data_set,
            scope: entry.scope,
            relative_path: entry.relative_path.clone(),
            schema: entry.schema,
            source_sha256: entry.sha256.clone(),
            target_sha256: filesystem::sha256_bytes(&transformed.bytes),
            target_byte_length,
            source_records: transformed.source_records,
            target_records: transformed.target_records,
        });
    }

    let mut report = TransformReport {
        schema_version: TRANSFORM_REPORT_SCHEMA_VERSION,
        run_id: manifest.run_id.clone(),
        manifest_fingerprint: manifest.fingerprint.clone(),
        repository_relative_path,
        files,
        skipped_secret_files,
        total_target_bytes,
        phase: MigrationPhase::Verified,
        fingerprint: String::new(),
    };
    report.fingerprint = transform_report_fingerprint(&report)?;
    verify_repository(target_root, &report)?;
    Ok(report)
}

pub(super) fn prepare_commit_blocking<S>(
    manifest: &MigrationManifest,
    backup_report: &BackupReport,
    transform_report: &TransformReport,
    credential_report: &CredentialMigrationReport,
    target_root: &Path,
    credential_store: &S,
) -> Result<MigrationCommitMarker, MigrationError>
where
    S: CredentialStore,
{
    layout::reject_filesystem_redirects(target_root)?;
    validate_backup_prerequisite(manifest, backup_report)?;
    validate_transform_against_manifest(manifest, transform_report)?;
    let summary = verify_repository(target_root, transform_report)?;
    validate_credential_report(transform_report, credential_report, credential_store)?;
    for credential_id in summary.required_credentials {
        let _secret = credential_store.get(&credential_id).map_err(|source| {
            MigrationError::CredentialUnavailable {
                id: credential_id,
                source,
            }
        })?;
    }

    let credential_report_fingerprint = credential_report_fingerprint(credential_report)?;
    let mut marker = MigrationCommitMarker {
        schema_version: COMMIT_MARKER_SCHEMA_VERSION,
        repository_layout_version: REPOSITORY_LAYOUT_VERSION,
        run_id: transform_report.run_id.clone(),
        manifest_fingerprint: transform_report.manifest_fingerprint.clone(),
        transform_fingerprint: transform_report.fingerprint.clone(),
        credential_report_fingerprint,
        repository_relative_path: transform_report.repository_relative_path.clone(),
        transformed_files: transform_report.files.len(),
        phase: MigrationPhase::Committed,
        fingerprint: String::new(),
    };
    marker.fingerprint = commit_marker_fingerprint(&marker)?;
    Ok(marker)
}

pub(super) fn validate_commit_marker(marker: &MigrationCommitMarker) -> Result<(), MigrationError> {
    let expected_repository = repository_relative_path(&marker.run_id);
    let expected_fingerprint = commit_marker_fingerprint(marker)?;
    if marker.schema_version != COMMIT_MARKER_SCHEMA_VERSION
        || marker.repository_layout_version != REPOSITORY_LAYOUT_VERSION
        || marker.phase != MigrationPhase::Committed
        || marker.repository_relative_path != expected_repository
        || marker.fingerprint != expected_fingerprint
    {
        return Err(MigrationError::CompletionMarkerMismatch);
    }
    Ok(())
}

pub(super) fn validate_marker_report(
    marker: &MigrationCommitMarker,
    report: &TransformReport,
) -> Result<(), MigrationError> {
    validate_commit_marker(marker)?;
    validate_transform_report(report)?;
    if marker.run_id != report.run_id
        || marker.manifest_fingerprint != report.manifest_fingerprint
        || marker.transform_fingerprint != report.fingerprint
        || marker.repository_relative_path != report.repository_relative_path
        || marker.transformed_files != report.files.len()
    {
        return Err(MigrationError::CompletionMarkerMismatch);
    }
    Ok(())
}

pub(super) fn validate_backup_prerequisite(
    manifest: &MigrationManifest,
    backup_report: &BackupReport,
) -> Result<(), MigrationError> {
    filesystem::verify_manifest_fingerprint(manifest)?;
    if backup_report.schema_version != BACKUP_REPORT_SCHEMA_VERSION
        || backup_report.phase != MigrationPhase::BackedUp
        || backup_report.run_id != manifest.run_id
        || backup_report.manifest_fingerprint != manifest.fingerprint
        || backup_report
            .copied_files
            .saturating_add(backup_report.reused_files)
            != manifest.entries.len()
        || backup_report.total_bytes != manifest.total_bytes
    {
        return Err(MigrationError::TransformBackupMismatch);
    }
    Ok(())
}

fn validate_transform_against_manifest(
    manifest: &MigrationManifest,
    report: &TransformReport,
) -> Result<(), MigrationError> {
    validate_transform_report(report)?;
    if report.run_id != manifest.run_id || report.manifest_fingerprint != manifest.fingerprint {
        return Err(MigrationError::TransformReportMismatch);
    }

    let expected_secret_files = manifest
        .entries
        .iter()
        .filter(|entry| entry.format == LegacyFormat::SecretEnvelope)
        .count();
    if report.skipped_secret_files != expected_secret_files {
        return Err(MigrationError::TransformReportMismatch);
    }
    let mut actual_files = report.files.iter();
    for expected in manifest
        .entries
        .iter()
        .filter(|entry| entry.format != LegacyFormat::SecretEnvelope)
    {
        let Some(actual) = actual_files.next() else {
            return Err(MigrationError::TransformReportMismatch);
        };
        if actual.data_set != expected.data_set
            || actual.scope != expected.scope
            || actual.relative_path != expected.relative_path
            || actual.schema != expected.schema
            || actual.source_sha256 != expected.sha256
        {
            return Err(MigrationError::TransformReportMismatch);
        }
    }
    if actual_files.next().is_some() {
        return Err(MigrationError::TransformReportMismatch);
    }
    Ok(())
}

const fn blocks_data_transformation(validation: &LegacyValidation) -> bool {
    matches!(
        validation,
        LegacyValidation::InvalidJson { .. }
            | LegacyValidation::InvalidJsonRoot
            | LegacyValidation::PartialJsonLines { .. }
    )
}

struct TransformedBytes {
    bytes: Vec<u8>,
    source_records: Option<usize>,
    target_records: Option<usize>,
}

fn transform_entry(
    entry: &MigrationManifestEntry,
    source: Vec<u8>,
) -> Result<TransformedBytes, MigrationError> {
    match (entry.format, entry.schema) {
        (LegacyFormat::Json, Some(schema)) if schema.format() == SchemaFormat::Json => {
            let mut value = parse_object(entry, &source)?;
            transform_domain_fields(entry, &mut value)?;
            add_version_header(entry, schema, &mut value)?;
            let bytes = serde_json::to_vec(&Value::Object(value))
                .map_err(MigrationError::TransformSerialization)?;
            Ok(TransformedBytes {
                bytes,
                source_records: Some(1),
                target_records: Some(1),
            })
        }
        (LegacyFormat::JsonLines, Some(schema)) if schema.format() == SchemaFormat::JsonLines => {
            let mut bytes = Vec::new();
            let mut record_count = 0_usize;
            for line in source.split(|byte| *byte == b'\n') {
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let mut value = parse_object(entry, line)?;
                add_version_header(entry, schema, &mut value)?;
                serde_json::to_writer(&mut bytes, &Value::Object(value))
                    .map_err(MigrationError::TransformSerialization)?;
                bytes.push(b'\n');
                record_count = record_count.saturating_add(1);
            }
            Ok(TransformedBytes {
                bytes,
                source_records: Some(record_count),
                target_records: Some(record_count),
            })
        }
        (LegacyFormat::Opaque, None) => Ok(TransformedBytes {
            bytes: source,
            source_records: None,
            target_records: None,
        }),
        (LegacyFormat::SecretEnvelope, None) => Err(invalid_document(entry)),
        (LegacyFormat::Mixed, _) | (LegacyFormat::Json, _) | (LegacyFormat::JsonLines, _) => {
            Err(MigrationError::SchemaFormatMismatch {
                data_set: entry.data_set,
                relative_path: entry.relative_path.clone(),
            })
        }
        (LegacyFormat::Opaque, Some(_)) | (LegacyFormat::SecretEnvelope, Some(_)) => {
            Err(MigrationError::SchemaFormatMismatch {
                data_set: entry.data_set,
                relative_path: entry.relative_path.clone(),
            })
        }
    }
}

fn parse_object(
    entry: &MigrationManifestEntry,
    bytes: &[u8],
) -> Result<Map<String, Value>, MigrationError> {
    match serde_json::from_slice(bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) | Err(_) => Err(invalid_document(entry)),
    }
}

fn transform_domain_fields(
    entry: &MigrationManifestEntry,
    object: &mut Map<String, Value>,
) -> Result<(), MigrationError> {
    match entry.data_set {
        LegacyDataSet::Providers => transform_providers(entry, object),
        LegacyDataSet::Settings => {
            transform_settings(object);
            Ok(())
        }
        _ => Ok(()),
    }
}

fn transform_providers(
    entry: &MigrationManifestEntry,
    object: &mut Map<String, Value>,
) -> Result<(), MigrationError> {
    let providers = object
        .get_mut("providers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid_document(entry))?;
    for provider in providers {
        let provider = provider
            .as_object_mut()
            .ok_or_else(|| invalid_document(entry))?;
        let provider_id = provider
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_document(entry))?;
        let has_configured_credential = ["apiKeyRef", "apiKey", "api_key", "api-key"]
            .iter()
            .filter_map(|key| provider.get(*key).and_then(Value::as_str))
            .any(|value| !value.is_empty());
        let credential_id = has_configured_credential
            .then(|| CredentialId::new(CredentialKind::ProviderApiKey, provider_id))
            .transpose()
            .map_err(|_| invalid_document(entry))?;
        provider.remove("credentialId");
        provider.remove("apiKeyRef");
        provider.remove("encryption");
        provider.remove("apiKey");
        provider.remove("api_key");
        provider.remove("api-key");
        if let Some(credential_id) = credential_id {
            provider.insert(
                "credentialId".to_string(),
                Value::String(credential_id.account_name()),
            );
        }
        normalize_provider_models(entry, provider)?;
        normalize_provider_thinking(provider);
    }
    Ok(())
}

fn normalize_provider_models(
    entry: &MigrationManifestEntry,
    provider: &mut Map<String, Value>,
) -> Result<(), MigrationError> {
    let default_model = provider.remove("defaultModel");
    if !provider.get("models").is_some_and(Value::is_array) {
        let models = default_model
            .as_ref()
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map_or_else(Vec::new, |model| {
                vec![Value::Object(Map::from_iter([
                    ("id".to_string(), Value::String(model.to_string())),
                    ("name".to_string(), Value::String(model.to_string())),
                    ("maxContextTokens".to_string(), Value::from(8192_u64)),
                ]))]
            });
        provider.insert("models".to_string(), Value::Array(models));
    }
    let models = provider
        .get_mut("models")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid_document(entry))?;
    for model in models {
        let model = model
            .as_object_mut()
            .ok_or_else(|| invalid_document(entry))?;
        let max_context_tokens = model
            .get("maxContextTokens")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(f64::floor)
            .map(|value| {
                if value <= u64::MAX as f64 {
                    Value::from(value as u64)
                } else {
                    serde_json::Number::from_f64(value)
                        .map_or_else(|| Value::from(8192_u64), Value::Number)
                }
            })
            .unwrap_or_else(|| Value::from(8192_u64));
        model.insert("maxContextTokens".to_string(), max_context_tokens);
    }
    Ok(())
}

fn normalize_provider_thinking(provider: &mut Map<String, Value>) {
    let legacy = provider
        .remove("thinking")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let enabled = legacy.get("enabled").and_then(Value::as_bool) != Some(false);
    let mode = match legacy.get("mode").and_then(Value::as_str) {
        Some("openai") | None | Some("") => "auto".to_string(),
        Some(mode) => mode.to_string(),
    };
    let mut thinking = Map::new();
    thinking.insert("enabled".to_string(), Value::Bool(enabled));
    thinking.insert("mode".to_string(), Value::String(mode));
    for key in ["effort", "budgetTokens"] {
        if let Some(value) = legacy.get(key) {
            thinking.insert(key.to_string(), value.clone());
        }
    }
    provider.insert("thinking".to_string(), Value::Object(thinking));
}

fn transform_settings(object: &mut Map<String, Value>) {
    if !object.contains_key("appTheme")
        && let Some(theme) = object.remove("theme")
    {
        object.insert("appTheme".to_string(), theme);
    }
    let Some(selections) = object.get_mut("subAgentModels") else {
        return;
    };
    let Some(selections) = selections.as_object_mut() else {
        object.insert("subAgentModels".to_string(), Value::Object(Map::new()));
        return;
    };
    let mut normalized = Map::new();
    for (agent_type, raw) in selections.iter() {
        let candidates = raw
            .as_array()
            .map_or_else(|| vec![raw], |values| values.iter().collect());
        let valid = candidates
            .into_iter()
            .filter(|candidate| {
                candidate.get("providerId").is_some_and(Value::is_string)
                    && candidate.get("model").is_some_and(Value::is_string)
            })
            .cloned()
            .collect::<Vec<_>>();
        if !valid.is_empty() {
            normalized.insert(agent_type.clone(), Value::Array(valid));
        }
    }
    *selections = normalized;
}

fn add_version_header(
    entry: &MigrationManifestEntry,
    schema: SchemaFamily,
    object: &mut Map<String, Value>,
) -> Result<(), MigrationError> {
    let expected_schema = Value::String(schema.id().to_string());
    let expected_version = Value::from(schema.current_version());
    if object
        .get("schema")
        .is_some_and(|actual| actual != &expected_schema)
        || object
            .get("schemaVersion")
            .is_some_and(|actual| actual != &expected_version)
    {
        return Err(MigrationError::UnsupportedLegacySchema {
            data_set: entry.data_set,
            relative_path: entry.relative_path.clone(),
        });
    }
    object.insert("schema".to_string(), expected_schema);
    object.insert("schemaVersion".to_string(), expected_version);
    Ok(())
}

fn repository_relative_path(run_id: &MigrationRunId) -> PathBuf {
    Path::new(REPOSITORIES_DIRECTORY)
        .join(run_id.as_str())
        .join(REPOSITORY_DIRECTORY)
}

fn transform_report_fingerprint(report: &TransformReport) -> Result<String, MigrationError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintInput<'a> {
        schema_version: u32,
        run_id: &'a MigrationRunId,
        manifest_fingerprint: &'a str,
        repository_relative_path: &'a Path,
        files: &'a [TransformedFile],
        skipped_secret_files: usize,
        total_target_bytes: u64,
        phase: MigrationPhase,
    }

    let bytes = serde_json::to_vec(&FingerprintInput {
        schema_version: report.schema_version,
        run_id: &report.run_id,
        manifest_fingerprint: &report.manifest_fingerprint,
        repository_relative_path: &report.repository_relative_path,
        files: &report.files,
        skipped_secret_files: report.skipped_secret_files,
        total_target_bytes: report.total_target_bytes,
        phase: report.phase,
    })
    .map_err(MigrationError::TransformSerialization)?;
    Ok(filesystem::sha256_bytes(&bytes))
}

fn credential_report_fingerprint(
    report: &CredentialMigrationReport,
) -> Result<String, MigrationError> {
    let bytes = serde_json::to_vec(report).map_err(MigrationError::TransformSerialization)?;
    Ok(filesystem::sha256_bytes(&bytes))
}

fn commit_marker_fingerprint(marker: &MigrationCommitMarker) -> Result<String, MigrationError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintInput<'a> {
        schema_version: u32,
        repository_layout_version: u32,
        run_id: &'a MigrationRunId,
        manifest_fingerprint: &'a str,
        transform_fingerprint: &'a str,
        credential_report_fingerprint: &'a str,
        repository_relative_path: &'a Path,
        transformed_files: usize,
        phase: MigrationPhase,
    }

    let bytes = serde_json::to_vec(&FingerprintInput {
        schema_version: marker.schema_version,
        repository_layout_version: marker.repository_layout_version,
        run_id: &marker.run_id,
        manifest_fingerprint: &marker.manifest_fingerprint,
        transform_fingerprint: &marker.transform_fingerprint,
        credential_report_fingerprint: &marker.credential_report_fingerprint,
        repository_relative_path: &marker.repository_relative_path,
        transformed_files: marker.transformed_files,
        phase: marker.phase,
    })
    .map_err(MigrationError::TransformSerialization)?;
    Ok(filesystem::sha256_bytes(&bytes))
}

struct SemanticSummary {
    required_credentials: Vec<CredentialId>,
}

#[derive(Default)]
struct SemanticFacts {
    provider_ids: HashSet<String>,
    session_ids: HashSet<String>,
    attachment_keys: HashSet<String>,
    ledger_paths: HashSet<PathBuf>,
    message_ids: HashMap<String, HashSet<String>>,
    provider_references: Vec<String>,
    session_references: Vec<String>,
    attachment_references: Vec<String>,
    ledger_references: Vec<PathBuf>,
    message_references: Vec<(String, String)>,
    required_credentials: HashMap<String, CredentialId>,
}

fn verify_repository(
    target_root: &Path,
    report: &TransformReport,
) -> Result<SemanticSummary, MigrationError> {
    validate_transform_report(report)?;

    let repository_root = target_root.join(&report.repository_relative_path);
    let mut facts = SemanticFacts::default();
    for file in &report.files {
        let target = repository_root
            .join(file.scope.backup_directory_name())
            .join(&file.relative_path);
        let bytes = filesystem::read_verified_target(
            &target,
            file.target_byte_length,
            &file.target_sha256,
        )?;
        let values = parse_transformed_values(file, &bytes)?;
        collect_semantic_facts(file, &values, &mut facts)?;
    }
    validate_semantic_facts(facts)
}

pub(super) fn verify_repository_integrity(
    target_root: &Path,
    report: &TransformReport,
) -> Result<(), MigrationError> {
    verify_repository(target_root, report).map(|_| ())
}

pub(super) fn validate_transform_report(report: &TransformReport) -> Result<(), MigrationError> {
    if report.schema_version != TRANSFORM_REPORT_SCHEMA_VERSION
        || report.phase != MigrationPhase::Verified
        || report.repository_relative_path != repository_relative_path(&report.run_id)
        || report.fingerprint != transform_report_fingerprint(report)?
        || report.total_target_bytes
            != report
                .files
                .iter()
                .map(|entry| entry.target_byte_length)
                .fold(0_u64, u64::saturating_add)
    {
        return Err(MigrationError::TransformReportMismatch);
    }
    Ok(())
}

fn parse_transformed_values(
    file: &TransformedFile,
    bytes: &[u8],
) -> Result<Vec<Value>, MigrationError> {
    let Some(schema) = file.schema else {
        if file.source_records.is_none() && file.target_records.is_none() {
            return Ok(Vec::new());
        }
        return Err(invalid_transformed_file(file));
    };
    let values = match schema.format() {
        SchemaFormat::Json => {
            vec![serde_json::from_slice(bytes).map_err(|_| invalid_transformed_file(file))?]
        }
        SchemaFormat::JsonLines => {
            let mut records: Vec<Value> = Vec::new();
            for line in bytes.split(|byte| *byte == b'\n') {
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                records.push(
                    serde_json::from_slice(line).map_err(|_| invalid_transformed_file(file))?,
                );
            }
            records
        }
    };
    if file.source_records != Some(values.len()) || file.target_records != Some(values.len()) {
        return Err(invalid_transformed_file(file));
    }
    for value in &values {
        let object = value
            .as_object()
            .ok_or_else(|| invalid_transformed_file(file))?;
        if object.get("schema").and_then(Value::as_str) != Some(schema.id())
            || object.get("schemaVersion").and_then(Value::as_u64)
                != Some(u64::from(schema.current_version()))
        {
            return Err(invalid_transformed_file(file));
        }
    }
    Ok(values)
}

fn collect_semantic_facts(
    file: &TransformedFile,
    values: &[Value],
    facts: &mut SemanticFacts,
) -> Result<(), MigrationError> {
    match file.data_set {
        LegacyDataSet::Providers => collect_provider_facts(file, values, facts),
        LegacyDataSet::Sessions => collect_session_facts(file, values, facts),
        LegacyDataSet::Settings => collect_settings_facts(file, values, facts),
        LegacyDataSet::PermissionAudit => {
            for value in values {
                if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
                    facts.session_references.push(session_id.to_string());
                }
            }
            Ok(())
        }
        LegacyDataSet::McpUserConfig => {
            for value in values {
                collect_mcp_secret_references(value, facts)?;
            }
            Ok(())
        }
        LegacyDataSet::Attachments => collect_attachment_facts(file, values, facts),
        LegacyDataSet::ContextLedger => collect_ledger_facts(file, values, facts),
        LegacyDataSet::ParallelExecutions => {
            for value in values {
                let session_id = required_string(value, "sessionId", file)?;
                facts.session_references.push(session_id.to_string());
            }
            Ok(())
        }
        LegacyDataSet::RecentProjects
        | LegacyDataSet::PermissionRules
        | LegacyDataSet::WorkspacePermissions
        | LegacyDataSet::McpProjectTrust
        | LegacyDataSet::McpSecrets
        | LegacyDataSet::McpOAuth
        | LegacyDataSet::McpContent
        | LegacyDataSet::ContextSnapshot
        | LegacyDataSet::EditBackups
        | LegacyDataSet::ToolJournal
        | LegacyDataSet::LargeToolResults
        | LegacyDataSet::Plans
        | LegacyDataSet::SkillsConfig
        | LegacyDataSet::ProjectAnalysisCache
        | LegacyDataSet::WorkspaceRulesMemory => Ok(()),
    }
}

fn collect_provider_facts(
    file: &TransformedFile,
    values: &[Value],
    facts: &mut SemanticFacts,
) -> Result<(), MigrationError> {
    let document = single_document(file, values)?;
    let providers = document
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_transformed_file(file))?;
    for provider in providers {
        let provider_id = required_string(provider, "id", file)?;
        if !facts.provider_ids.insert(provider_id.to_string()) {
            return Err(MigrationError::DuplicateIdentifier {
                kind: "provider",
                value: provider_id.to_string(),
            });
        }
        if ["apiKeyRef", "encryption", "apiKey", "api_key", "api-key"]
            .iter()
            .any(|key| provider.get(*key).is_some())
        {
            return Err(MigrationError::SecretFieldPersisted {
                data_set: file.data_set,
                relative_path: file.relative_path.clone(),
            });
        }
        let Some(credential) = provider.get("credentialId") else {
            continue;
        };
        let credential = credential
            .as_str()
            .ok_or_else(|| invalid_transformed_file(file))?;
        let credential_id =
            CredentialId::parse(credential).map_err(|_| invalid_transformed_file(file))?;
        if credential_id.kind() != CredentialKind::ProviderApiKey
            || credential_id.key() != provider_id
        {
            return Err(invalid_transformed_file(file));
        }
        facts
            .required_credentials
            .insert(credential.to_string(), credential_id);
    }
    if let Some(active) = document.get("activeProviderId") {
        match active {
            Value::Null => {}
            Value::String(value) => facts.provider_references.push(value.clone()),
            _ => return Err(invalid_transformed_file(file)),
        }
    }
    Ok(())
}

fn collect_session_facts(
    file: &TransformedFile,
    values: &[Value],
    facts: &mut SemanticFacts,
) -> Result<(), MigrationError> {
    let document = single_document(file, values)?;
    let sessions = document
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_transformed_file(file))?;
    for session in sessions {
        let session_id = required_string(session, "id", file)?.to_string();
        if !facts.session_ids.insert(session_id.clone()) {
            return Err(MigrationError::DuplicateIdentifier {
                kind: "session",
                value: session_id,
            });
        }
        let mut messages = HashSet::new();
        if let Some(message_values) = session.get("messages").and_then(Value::as_array) {
            for message in message_values {
                let message_id = required_string(message, "id", file)?;
                if !messages.insert(message_id.to_string()) {
                    return Err(MigrationError::DuplicateIdentifier {
                        kind: "message",
                        value: message_id.to_string(),
                    });
                }
                if let Some(attachments) = message.get("attachments").and_then(Value::as_array) {
                    for attachment in attachments {
                        let storage_key = required_string(attachment, "storageKey", file)?;
                        if attachment_session_id(Path::new(storage_key))
                            != Some(session_id.as_str())
                        {
                            return Err(invalid_transformed_file(file));
                        }
                        facts.attachment_references.push(storage_key.to_string());
                    }
                }
            }
        }
        facts.message_ids.insert(session_id.clone(), messages);
        if let Some(runtime) = session.get("runtime") {
            if let Some(ledger_path) = runtime.get("ledgerRelativePath").and_then(Value::as_str) {
                let path = safe_relative_path(ledger_path)
                    .ok_or_else(|| invalid_transformed_file(file))?;
                if ledger_session_id(&path) != Some(session_id.as_str()) {
                    return Err(invalid_transformed_file(file));
                }
                facts.ledger_references.push(path);
            }
        }
    }
    Ok(())
}

fn collect_settings_facts(
    file: &TransformedFile,
    values: &[Value],
    facts: &mut SemanticFacts,
) -> Result<(), MigrationError> {
    let document = single_document(file, values)?;
    let Some(selections) = document.get("subAgentModels").and_then(Value::as_object) else {
        return Ok(());
    };
    for selection in selections.values() {
        let candidates = selection
            .as_array()
            .ok_or_else(|| invalid_transformed_file(file))?;
        for candidate in candidates {
            let provider_id = required_string(candidate, "providerId", file)?;
            required_string(candidate, "model", file)?;
            facts.provider_references.push(provider_id.to_string());
        }
    }
    Ok(())
}

fn collect_attachment_facts(
    file: &TransformedFile,
    values: &[Value],
    facts: &mut SemanticFacts,
) -> Result<(), MigrationError> {
    if file.schema != Some(SchemaFamily::AttachmentMetadata) {
        return Ok(());
    }
    let document = single_document(file, values)?;
    let attachment = document
        .get("attachment")
        .ok_or_else(|| invalid_transformed_file(file))?;
    let attachment_id = required_string(attachment, "id", file)?;
    let storage_key = required_string(attachment, "storageKey", file)?;
    let storage_path =
        safe_relative_path(storage_key).ok_or_else(|| invalid_transformed_file(file))?;
    if storage_path.file_name().and_then(|value| value.to_str()) != Some(attachment_id)
        || file.relative_path
            != Path::new("attachments")
                .join(&storage_path)
                .join("meta.json")
    {
        return Err(invalid_transformed_file(file));
    }
    if !facts.attachment_keys.insert(storage_key.to_string()) {
        return Err(MigrationError::DuplicateIdentifier {
            kind: "attachment-storage-key",
            value: storage_key.to_string(),
        });
    }
    let session_id =
        attachment_session_id(&storage_path).ok_or_else(|| invalid_transformed_file(file))?;
    facts.session_references.push(session_id.to_string());
    Ok(())
}

fn collect_ledger_facts(
    file: &TransformedFile,
    values: &[Value],
    facts: &mut SemanticFacts,
) -> Result<(), MigrationError> {
    let session_id = ledger_session_id(&file.relative_path)
        .ok_or_else(|| invalid_transformed_file(file))?
        .to_string();
    facts.session_references.push(session_id.clone());
    facts.ledger_paths.insert(file.relative_path.clone());
    for value in values {
        if value.get("kind").and_then(Value::as_str) == Some("message") {
            let message_id = required_string(value, "messageId", file)?;
            facts
                .message_references
                .push((session_id.clone(), message_id.to_string()));
        }
    }
    Ok(())
}

fn collect_mcp_secret_references(
    value: &Value,
    facts: &mut SemanticFacts,
) -> Result<(), MigrationError> {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_mcp_secret_references(value, facts)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_mcp_secret_references(value, facts)?;
            }
        }
        Value::String(value) => {
            let mut remaining = value.as_str();
            while let Some(start) = remaining.find("${secret:") {
                remaining = &remaining[start + "${secret:".len()..];
                let Some(end) = remaining.find('}') else {
                    return Err(MigrationError::InvalidSecretReference);
                };
                let key = &remaining[..end];
                let credential_id = CredentialId::new(CredentialKind::McpSecret, key)
                    .map_err(|_| MigrationError::InvalidSecretReference)?;
                facts
                    .required_credentials
                    .insert(credential_id.account_name(), credential_id);
                remaining = &remaining[end + 1..];
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn validate_semantic_facts(facts: SemanticFacts) -> Result<SemanticSummary, MigrationError> {
    for provider_id in facts.provider_references {
        if !facts.provider_ids.contains(&provider_id) {
            return Err(MigrationError::MissingReference {
                relation: "provider",
                value: provider_id,
            });
        }
    }
    for session_id in facts.session_references {
        if !facts.session_ids.contains(&session_id) {
            return Err(MigrationError::MissingReference {
                relation: "session",
                value: session_id,
            });
        }
    }
    for attachment in facts.attachment_references {
        if !facts.attachment_keys.contains(&attachment) {
            return Err(MigrationError::MissingReference {
                relation: "attachment",
                value: attachment,
            });
        }
    }
    for ledger in facts.ledger_references {
        if !facts.ledger_paths.contains(&ledger) {
            return Err(MigrationError::MissingReference {
                relation: "session-runtime-ledger",
                value: ledger.to_string_lossy().into_owned(),
            });
        }
    }
    for (session_id, message_id) in facts.message_references {
        if !facts
            .message_ids
            .get(&session_id)
            .is_some_and(|messages| messages.contains(&message_id))
        {
            return Err(MigrationError::MissingReference {
                relation: "ledger-message",
                value: format!("{session_id}:{message_id}"),
            });
        }
    }
    let mut required_credentials = facts.required_credentials.into_values().collect::<Vec<_>>();
    required_credentials.sort_by_key(CredentialId::account_name);
    Ok(SemanticSummary {
        required_credentials,
    })
}

fn validate_credential_report<S>(
    transform_report: &TransformReport,
    report: &CredentialMigrationReport,
    credential_store: &S,
) -> Result<(), MigrationError>
where
    S: CredentialStore,
{
    validate_credential_report_metadata(transform_report, report)?;
    if report.phase != MigrationPhase::Verified || report.requires_reentry != 0 {
        return Err(MigrationError::CredentialReportMismatch);
    }
    for entry in &report.entries {
        if !matches!(
            entry.status,
            CredentialMigrationStatus::Migrated | CredentialMigrationStatus::Reentered
        ) {
            continue;
        }
        let credential_id = entry
            .credential_id
            .as_ref()
            .ok_or(MigrationError::CredentialReportMismatch)?;
        let _secret = credential_store.get(credential_id).map_err(|source| {
            MigrationError::CredentialUnavailable {
                id: credential_id.clone(),
                source,
            }
        })?;
    }
    Ok(())
}

pub(super) fn validate_credential_report_metadata(
    transform_report: &TransformReport,
    report: &CredentialMigrationReport,
) -> Result<(), MigrationError> {
    credentials::validate_credential_report_structure(report)?;
    if report.run_id != transform_report.run_id
        || report.manifest_fingerprint != transform_report.manifest_fingerprint
        || !matches!(
            report.phase,
            MigrationPhase::Verified | MigrationPhase::AwaitingCredentials
        )
    {
        return Err(MigrationError::CredentialReportMismatch);
    }
    Ok(())
}

fn single_document<'a>(
    file: &TransformedFile,
    values: &'a [Value],
) -> Result<&'a Value, MigrationError> {
    let [value] = values else {
        return Err(invalid_transformed_file(file));
    };
    Ok(value)
}

fn required_string<'a>(
    value: &'a Value,
    key: &str,
    file: &TransformedFile,
) -> Result<&'a str, MigrationError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_transformed_file(file))
}

fn safe_relative_path(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    (!path.as_os_str().is_empty()
        && !path.is_absolute()
        && path.components().all(|component| {
            !matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }))
    .then_some(path)
}

fn ledger_session_id(path: &Path) -> Option<&str> {
    let components = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    match components.as_slice() {
        ["session-runtime", session_id, "ledger.jsonl"] if !session_id.is_empty() => {
            Some(session_id)
        }
        _ => None,
    }
}

fn attachment_session_id(path: &Path) -> Option<&str> {
    let components = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    match components.as_slice() {
        ["sessions", session_id, attachment_id]
            if !session_id.is_empty() && !attachment_id.is_empty() =>
        {
            Some(session_id)
        }
        _ => None,
    }
}

fn invalid_document(entry: &MigrationManifestEntry) -> MigrationError {
    MigrationError::InvalidTransformedDocument {
        data_set: entry.data_set,
        relative_path: entry.relative_path.clone(),
    }
}

fn invalid_transformed_file(file: &TransformedFile) -> MigrationError {
    MigrationError::InvalidTransformedDocument {
        data_set: file.data_set,
        relative_path: file.relative_path.clone(),
    }
}
