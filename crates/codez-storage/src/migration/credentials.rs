use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::value::RawValue;
use zeroize::Zeroizing;

use super::{
    BACKUP_REPORT_SCHEMA_VERSION, BackupReport, LegacyDataSet, MigrationError, MigrationManifest,
    MigrationPhase, MigrationRunId, filesystem,
    legacy_safe_storage::{LegacyCredentialReadError, LegacyCredentialReader},
};
use crate::{CredentialId, CredentialKind, CredentialStore, SecretValue};

const CREDENTIAL_REPORT_SCHEMA_VERSION: u32 = 1;

/// Outcome of migrating one credential identity or one whole encrypted source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialMigrationStatus {
    /// Plaintext was transferred directly into secure operating-system storage.
    Migrated,
    /// The user must provide the credential again before migration can commit.
    RequiresReentry,
    /// The legacy source contained no configured credential.
    NotPresent,
}

/// Stable, secret-free reason attached to a credential migration decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialMigrationReason {
    /// A configured record omitted its credential value.
    MissingCredential,
    /// The old Provider used plaintext or Base64 instead of `safeStorage`.
    InsecureLegacyEncoding,
    /// The legacy source or decrypted aggregate was not the expected JSON shape.
    InvalidLegacyDocument,
    /// A source identity cannot be represented by the new credential namespace.
    InvalidIdentifier,
    /// No verified reader exists for the current platform.
    UnsupportedPlatform,
    /// Chromium's `Local State` was missing or inaccessible.
    LocalStateUnavailable,
    /// Chromium's `Local State` did not contain a valid supported key record.
    InvalidLocalState,
    /// The current user context could not unwrap Chromium's encryption key.
    KeyUnavailable,
    /// The credential was not valid Base64.
    InvalidEncoding,
    /// The credential envelope version was not recognized.
    UnsupportedEnvelope,
    /// The legacy ciphertext failed authentication.
    AuthenticationFailed,
    /// The authenticated plaintext was empty or not UTF-8.
    InvalidPlaintext,
}

impl From<LegacyCredentialReadError> for CredentialMigrationReason {
    fn from(value: LegacyCredentialReadError) -> Self {
        match value {
            LegacyCredentialReadError::UnsupportedPlatform => Self::UnsupportedPlatform,
            LegacyCredentialReadError::LocalStateUnavailable => Self::LocalStateUnavailable,
            LegacyCredentialReadError::InvalidLocalState => Self::InvalidLocalState,
            LegacyCredentialReadError::KeyUnavailable => Self::KeyUnavailable,
            LegacyCredentialReadError::InvalidEncoding => Self::InvalidEncoding,
            LegacyCredentialReadError::UnsupportedEnvelope => Self::UnsupportedEnvelope,
            LegacyCredentialReadError::AuthenticationFailed => Self::AuthenticationFailed,
            LegacyCredentialReadError::InvalidPlaintext => Self::InvalidPlaintext,
        }
    }
}

/// Redacted decision for one stable credential or one unreadable aggregate file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMigrationEntry {
    /// Legacy data family that owned the credential.
    pub data_set: LegacyDataSet,
    /// Deterministic position within the legacy source, used when its ID is invalid.
    pub source_index: usize,
    /// Valid non-secret target identity, absent for source-wide decisions.
    pub credential_id: Option<CredentialId>,
    /// Migration outcome.
    pub status: CredentialMigrationStatus,
    /// Stable explanation for re-entry; absent for migrated or missing values.
    pub reason: Option<CredentialMigrationReason>,
}

/// Durable redacted report for one backed-up credential migration run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMigrationReport {
    /// Report serialization version.
    pub schema_version: u32,
    /// Migration run associated with the verified backup.
    pub run_id: MigrationRunId,
    /// Fingerprint of the manifest whose backup was read.
    pub manifest_fingerprint: String,
    /// `verified` when no input is needed, otherwise `awaiting_credentials`.
    pub phase: MigrationPhase,
    /// Deterministically ordered decisions for Provider, MCP secret, and OAuth data.
    pub entries: Vec<CredentialMigrationEntry>,
    /// Number of credentials written to secure storage.
    pub migrated: usize,
    /// Number of records or encrypted sources requiring user input.
    pub requires_reentry: usize,
    /// Number of absent credential families.
    pub not_present: usize,
}

pub(super) fn migrate_credentials_blocking<R, S>(
    manifest: &MigrationManifest,
    backup_report: &BackupReport,
    backup_root: &Path,
    reader: &R,
    credential_store: &S,
) -> Result<CredentialMigrationReport, MigrationError>
where
    R: LegacyCredentialReader,
    S: CredentialStore,
{
    validate_backup_prerequisite(manifest, backup_report)?;
    let mut entries = Vec::new();
    migrate_provider_credentials(
        manifest,
        backup_root,
        reader,
        credential_store,
        &mut entries,
    )?;
    migrate_aggregate_credentials::<MigratingSecret, _, _>(
        manifest,
        backup_root,
        LegacyDataSet::McpSecrets,
        CredentialKind::McpSecret,
        reader,
        credential_store,
        &mut entries,
    )?;
    migrate_aggregate_credentials::<MigratingOAuthRecord, _, _>(
        manifest,
        backup_root,
        LegacyDataSet::McpOAuth,
        CredentialKind::McpOAuth,
        reader,
        credential_store,
        &mut entries,
    )?;

    let migrated = count_status(&entries, CredentialMigrationStatus::Migrated);
    let requires_reentry = count_status(&entries, CredentialMigrationStatus::RequiresReentry);
    let not_present = count_status(&entries, CredentialMigrationStatus::NotPresent);
    Ok(CredentialMigrationReport {
        schema_version: CREDENTIAL_REPORT_SCHEMA_VERSION,
        run_id: manifest.run_id.clone(),
        manifest_fingerprint: manifest.fingerprint.clone(),
        phase: if requires_reentry == 0 {
            MigrationPhase::Verified
        } else {
            MigrationPhase::AwaitingCredentials
        },
        entries,
        migrated,
        requires_reentry,
        not_present,
    })
}

fn validate_backup_prerequisite(
    manifest: &MigrationManifest,
    backup_report: &BackupReport,
) -> Result<(), MigrationError> {
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
        return Err(MigrationError::CredentialBackupMismatch);
    }
    Ok(())
}

fn migrate_provider_credentials<R, S>(
    manifest: &MigrationManifest,
    backup_root: &Path,
    reader: &R,
    credential_store: &S,
    entries: &mut Vec<CredentialMigrationEntry>,
) -> Result<(), MigrationError>
where
    R: LegacyCredentialReader,
    S: CredentialStore,
{
    let Some(bytes) =
        filesystem::read_verified_backup(manifest, backup_root, LegacyDataSet::Providers)?
    else {
        entries.push(not_present_entry(LegacyDataSet::Providers));
        return Ok(());
    };
    let bytes = Zeroizing::new(bytes);
    let document = match serde_json::from_slice::<LegacyProviderDocument>(&bytes) {
        Ok(document) => document,
        Err(_) => {
            entries.push(reentry_entry(
                LegacyDataSet::Providers,
                0,
                None,
                CredentialMigrationReason::InvalidLegacyDocument,
            ));
            return Ok(());
        }
    };
    if document.providers.is_empty() {
        entries.push(not_present_entry(LegacyDataSet::Providers));
        return Ok(());
    }

    for (source_index, provider) in document.providers.into_iter().enumerate() {
        let credential_id = match provider.id {
            Some(id) => match CredentialId::new(CredentialKind::ProviderApiKey, id) {
                Ok(id) => id,
                Err(_) => {
                    entries.push(reentry_entry(
                        LegacyDataSet::Providers,
                        source_index,
                        None,
                        CredentialMigrationReason::InvalidIdentifier,
                    ));
                    continue;
                }
            },
            None => {
                entries.push(reentry_entry(
                    LegacyDataSet::Providers,
                    source_index,
                    None,
                    CredentialMigrationReason::InvalidIdentifier,
                ));
                continue;
            }
        };
        let Some(encoded) = provider.api_key_ref else {
            entries.push(reentry_entry(
                LegacyDataSet::Providers,
                source_index,
                Some(credential_id),
                CredentialMigrationReason::MissingCredential,
            ));
            continue;
        };
        if encoded.is_empty() {
            entries.push(reentry_entry(
                LegacyDataSet::Providers,
                source_index,
                Some(credential_id),
                CredentialMigrationReason::MissingCredential,
            ));
            continue;
        }
        if provider.encryption.as_deref() != Some("safeStorage") {
            entries.push(reentry_entry(
                LegacyDataSet::Providers,
                source_index,
                Some(credential_id),
                CredentialMigrationReason::InsecureLegacyEncoding,
            ));
            continue;
        }
        let secret = match reader.decrypt(encoded.as_str()) {
            Ok(secret) => secret,
            Err(error) => {
                entries.push(reentry_entry(
                    LegacyDataSet::Providers,
                    source_index,
                    Some(credential_id),
                    error.into(),
                ));
                continue;
            }
        };
        credential_store
            .set(&credential_id, &secret)
            .map_err(MigrationError::CredentialStore)?;
        entries.push(migrated_entry(
            LegacyDataSet::Providers,
            source_index,
            credential_id,
        ));
    }
    Ok(())
}

fn migrate_aggregate_credentials<V, R, S>(
    manifest: &MigrationManifest,
    backup_root: &Path,
    data_set: LegacyDataSet,
    credential_kind: CredentialKind,
    reader: &R,
    credential_store: &S,
    entries: &mut Vec<CredentialMigrationEntry>,
) -> Result<(), MigrationError>
where
    V: MigratingCredential + for<'de> Deserialize<'de>,
    R: LegacyCredentialReader,
    S: CredentialStore,
{
    let Some(bytes) = filesystem::read_verified_backup(manifest, backup_root, data_set)? else {
        entries.push(not_present_entry(data_set));
        return Ok(());
    };
    let encoded = match std::str::from_utf8(&bytes) {
        Ok(value) if !value.trim().is_empty() => value.trim(),
        Ok(_) | Err(_) => {
            entries.push(reentry_entry(
                data_set,
                0,
                None,
                CredentialMigrationReason::InvalidEncoding,
            ));
            return Ok(());
        }
    };
    let plaintext = match reader.decrypt(encoded) {
        Ok(value) => value,
        Err(error) => {
            entries.push(reentry_entry(data_set, 0, None, error.into()));
            return Ok(());
        }
    };
    let records = match serde_json::from_str::<BTreeMap<String, V>>(plaintext.expose_secret()) {
        Ok(records) => records,
        Err(_) => {
            entries.push(reentry_entry(
                data_set,
                0,
                None,
                CredentialMigrationReason::InvalidLegacyDocument,
            ));
            return Ok(());
        }
    };
    if records.is_empty() {
        entries.push(not_present_entry(data_set));
        return Ok(());
    }

    for (source_index, (key, value)) in records.into_iter().enumerate() {
        let credential_id = match CredentialId::new(credential_kind, key) {
            Ok(id) => id,
            Err(_) => {
                entries.push(reentry_entry(
                    data_set,
                    source_index,
                    None,
                    CredentialMigrationReason::InvalidIdentifier,
                ));
                continue;
            }
        };
        credential_store
            .set(&credential_id, value.secret())
            .map_err(MigrationError::CredentialStore)?;
        entries.push(migrated_entry(data_set, source_index, credential_id));
    }
    Ok(())
}

fn count_status(entries: &[CredentialMigrationEntry], status: CredentialMigrationStatus) -> usize {
    entries
        .iter()
        .filter(|entry| entry.status == status)
        .count()
}

fn migrated_entry(
    data_set: LegacyDataSet,
    source_index: usize,
    credential_id: CredentialId,
) -> CredentialMigrationEntry {
    CredentialMigrationEntry {
        data_set,
        source_index,
        credential_id: Some(credential_id),
        status: CredentialMigrationStatus::Migrated,
        reason: None,
    }
}

fn reentry_entry(
    data_set: LegacyDataSet,
    source_index: usize,
    credential_id: Option<CredentialId>,
    reason: CredentialMigrationReason,
) -> CredentialMigrationEntry {
    CredentialMigrationEntry {
        data_set,
        source_index,
        credential_id,
        status: CredentialMigrationStatus::RequiresReentry,
        reason: Some(reason),
    }
}

fn not_present_entry(data_set: LegacyDataSet) -> CredentialMigrationEntry {
    CredentialMigrationEntry {
        data_set,
        source_index: 0,
        credential_id: None,
        status: CredentialMigrationStatus::NotPresent,
        reason: None,
    }
}

#[derive(Deserialize)]
struct LegacyProviderDocument {
    #[serde(default)]
    providers: Vec<LegacyProviderCredential>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProviderCredential {
    id: Option<String>,
    api_key_ref: Option<LegacySecretText>,
    encryption: Option<String>,
}

struct LegacySecretText(Zeroizing<String>);

impl LegacySecretText {
    fn as_str(&self) -> &str {
        self.0.as_str()
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<'de> Deserialize<'de> for LegacySecretText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(|value| Self(Zeroizing::new(value)))
    }
}

trait MigratingCredential {
    fn secret(&self) -> &SecretValue;
}

struct MigratingSecret(SecretValue);

impl MigratingCredential for MigratingSecret {
    fn secret(&self) -> &SecretValue {
        &self.0
    }
}

impl<'de> Deserialize<'de> for MigratingSecret {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        SecretValue::new(value)
            .map(Self)
            .map_err(|_| D::Error::custom("legacy secret is empty"))
    }
}

struct MigratingOAuthRecord(SecretValue);

impl MigratingCredential for MigratingOAuthRecord {
    fn secret(&self) -> &SecretValue {
        &self.0
    }
}

impl<'de> Deserialize<'de> for MigratingOAuthRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let boxed: Box<str> = raw.into();
        let secret = SecretValue::new(String::from(boxed))
            .map_err(|_| D::Error::custom("legacy OAuth record is empty"))?;
        if !secret.expose_secret().trim_start().starts_with('{') {
            return Err(D::Error::custom("legacy OAuth record must be an object"));
        }
        Ok(Self(secret))
    }
}
