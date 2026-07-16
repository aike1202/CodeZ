use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::value::RawValue;
use zeroize::Zeroizing;

use super::{
    BACKUP_REPORT_SCHEMA_VERSION, BackupReport, LegacyDataSet, MigrationError, MigrationManifest,
    MigrationPhase, MigrationRunId, filesystem, layout,
    legacy_safe_storage::{LegacyCredentialReadError, LegacyCredentialReader},
};
use crate::{CredentialId, CredentialKind, CredentialStore, SecretValue};

pub(super) const CREDENTIAL_REPORT_SCHEMA_VERSION: u32 = 2;
const LEGACY_CREDENTIAL_REPORT_SCHEMA_VERSION: u32 = 1;
const CREDENTIAL_REENTRY_RECEIPT_SCHEMA_VERSION: u32 = 1;

/// Outcome of migrating one credential identity or one whole encrypted source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialMigrationStatus {
    /// Plaintext was transferred directly into secure operating-system storage.
    Migrated,
    /// The user explicitly re-entered the credential into secure operating-system storage.
    Reentered,
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
    /// Number of credentials explicitly re-entered into secure storage.
    #[serde(default)]
    pub reentered: usize,
    /// Number of records or encrypted sources requiring user input.
    pub requires_reentry: usize,
    /// Number of absent credential families.
    pub not_present: usize,
}

/// One user-supplied credential value that may complete a blocked migration.
///
/// The secret is deliberately not serializable or printable. It is consumed by
/// the narrow operating-system credential-store adapter during resume.
pub struct CredentialReentry {
    credential_id: CredentialId,
    secret: SecretValue,
}

impl CredentialReentry {
    /// Creates one explicit credential re-entry request.
    #[must_use]
    pub fn new(credential_id: CredentialId, secret: SecretValue) -> Self {
        Self {
            credential_id,
            secret,
        }
    }

    /// Returns the non-secret target identity for this input.
    #[must_use]
    pub fn credential_id(&self) -> &CredentialId {
        &self.credential_id
    }
}

/// Immutable redacted evidence that a blocked credential report was completed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CredentialReentryReceipt {
    schema_version: u32,
    awaiting_report_fingerprint: String,
    completed_report: CredentialMigrationReport,
    fingerprint: String,
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
    layout::reject_filesystem_redirects(backup_root)?;
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
        reentered: 0,
        requires_reentry,
        not_present,
    })
}

pub(super) fn complete_credential_reentry_blocking<S>(
    awaiting_report: CredentialMigrationReport,
    values: Vec<CredentialReentry>,
    credential_store: &S,
) -> Result<CredentialMigrationReport, MigrationError>
where
    S: CredentialStore,
{
    validate_credential_report_structure(&awaiting_report)?;
    if awaiting_report.phase != MigrationPhase::AwaitingCredentials {
        return Err(MigrationError::CredentialReportMismatch);
    }

    let required = required_reentry_ids(&awaiting_report)?;
    let mut supplied = HashMap::with_capacity(values.len());
    for value in values {
        let credential_id = value.credential_id.clone();
        if supplied
            .insert(credential_id.clone(), value.secret)
            .is_some()
        {
            return Err(MigrationError::CredentialReentryDuplicate { id: credential_id });
        }
    }
    if let Some(credential_id) = supplied
        .keys()
        .find(|credential_id| !required.contains(*credential_id))
        .cloned()
    {
        return Err(MigrationError::CredentialReentryUnexpected { id: credential_id });
    }
    if let Some(credential_id) = required
        .iter()
        .find(|credential_id| !supplied.contains_key(*credential_id))
        .cloned()
    {
        return Err(MigrationError::CredentialReentryMissing { id: credential_id });
    }

    for credential_id in &required {
        let secret = supplied.get(credential_id).ok_or_else(|| {
            MigrationError::CredentialReentryMissing {
                id: credential_id.clone(),
            }
        })?;
        credential_store
            .set(credential_id, secret)
            .map_err(MigrationError::CredentialStore)?;
    }

    let mut completed_report = awaiting_report;
    for entry in &mut completed_report.entries {
        if entry.status == CredentialMigrationStatus::RequiresReentry {
            entry.status = CredentialMigrationStatus::Reentered;
            entry.reason = None;
        }
    }
    completed_report.phase = MigrationPhase::Verified;
    completed_report.reentered = completed_report.reentered.saturating_add(required.len());
    completed_report.requires_reentry = 0;
    validate_credential_report_structure(&completed_report)?;
    Ok(completed_report)
}

pub(super) fn new_credential_reentry_receipt(
    awaiting_report: &CredentialMigrationReport,
    completed_report: CredentialMigrationReport,
) -> Result<CredentialReentryReceipt, MigrationError> {
    validate_reentry_completion(awaiting_report, &completed_report)?;
    let mut receipt = CredentialReentryReceipt {
        schema_version: CREDENTIAL_REENTRY_RECEIPT_SCHEMA_VERSION,
        awaiting_report_fingerprint: credential_report_fingerprint(awaiting_report)?,
        completed_report,
        fingerprint: String::new(),
    };
    receipt.fingerprint = credential_reentry_receipt_fingerprint(&receipt)?;
    Ok(receipt)
}

pub(super) fn completed_report_from_receipt(
    awaiting_report: &CredentialMigrationReport,
    receipt: CredentialReentryReceipt,
) -> Result<CredentialMigrationReport, MigrationError> {
    if receipt.schema_version != CREDENTIAL_REENTRY_RECEIPT_SCHEMA_VERSION
        || receipt.awaiting_report_fingerprint != credential_report_fingerprint(awaiting_report)?
        || receipt.fingerprint != credential_reentry_receipt_fingerprint(&receipt)?
    {
        return Err(MigrationError::CredentialReportMismatch);
    }
    validate_reentry_completion(awaiting_report, &receipt.completed_report)?;
    Ok(receipt.completed_report)
}

pub(super) fn validate_credential_report_structure(
    report: &CredentialMigrationReport,
) -> Result<(), MigrationError> {
    if !matches!(
        report.schema_version,
        LEGACY_CREDENTIAL_REPORT_SCHEMA_VERSION | CREDENTIAL_REPORT_SCHEMA_VERSION
    ) {
        return Err(MigrationError::CredentialReportMismatch);
    }

    let mut migrated = 0_usize;
    let mut reentered = 0_usize;
    let mut not_present = 0_usize;
    let mut requires_reentry = 0_usize;
    for entry in &report.entries {
        match entry.status {
            CredentialMigrationStatus::Migrated => {
                migrated = migrated.saturating_add(1);
                if entry.reason.is_some() || entry.credential_id.is_none() {
                    return Err(MigrationError::CredentialReportMismatch);
                }
            }
            CredentialMigrationStatus::Reentered => {
                reentered = reentered.saturating_add(1);
                if entry.reason.is_some() || entry.credential_id.is_none() {
                    return Err(MigrationError::CredentialReportMismatch);
                }
            }
            CredentialMigrationStatus::NotPresent => {
                not_present = not_present.saturating_add(1);
                if entry.credential_id.is_some() || entry.reason.is_some() {
                    return Err(MigrationError::CredentialReportMismatch);
                }
            }
            CredentialMigrationStatus::RequiresReentry => {
                requires_reentry = requires_reentry.saturating_add(1);
                if entry.reason.is_none() {
                    return Err(MigrationError::CredentialReportMismatch);
                }
            }
        }
    }
    let expected_phase = if requires_reentry == 0 {
        MigrationPhase::Verified
    } else {
        MigrationPhase::AwaitingCredentials
    };
    if migrated != report.migrated
        || reentered != report.reentered
        || not_present != report.not_present
        || requires_reentry != report.requires_reentry
        || report
            .migrated
            .saturating_add(report.reentered)
            .saturating_add(report.not_present)
            .saturating_add(report.requires_reentry)
            != report.entries.len()
        || report.phase != expected_phase
    {
        return Err(MigrationError::CredentialReportMismatch);
    }
    Ok(())
}

fn required_reentry_ids(
    report: &CredentialMigrationReport,
) -> Result<HashSet<CredentialId>, MigrationError> {
    let mut ids = HashSet::with_capacity(report.requires_reentry);
    for entry in report
        .entries
        .iter()
        .filter(|entry| entry.status == CredentialMigrationStatus::RequiresReentry)
    {
        let credential_id = entry.credential_id.clone().ok_or(
            MigrationError::CredentialReentryIdentifierMissing {
                data_set: entry.data_set,
                source_index: entry.source_index,
            },
        )?;
        if !ids.insert(credential_id.clone()) {
            return Err(MigrationError::CredentialReentryDuplicate { id: credential_id });
        }
    }
    Ok(ids)
}

fn validate_reentry_completion(
    awaiting_report: &CredentialMigrationReport,
    completed_report: &CredentialMigrationReport,
) -> Result<(), MigrationError> {
    validate_credential_report_structure(awaiting_report)?;
    validate_credential_report_structure(completed_report)?;
    if awaiting_report.phase != MigrationPhase::AwaitingCredentials
        || completed_report.phase != MigrationPhase::Verified
        || awaiting_report.run_id != completed_report.run_id
        || awaiting_report.manifest_fingerprint != completed_report.manifest_fingerprint
        || awaiting_report.entries.len() != completed_report.entries.len()
        || completed_report.migrated != awaiting_report.migrated
        || completed_report.not_present != awaiting_report.not_present
        || completed_report.requires_reentry != 0
        || completed_report.reentered
            != awaiting_report
                .reentered
                .saturating_add(awaiting_report.requires_reentry)
    {
        return Err(MigrationError::CredentialReportMismatch);
    }

    for (awaiting, completed) in awaiting_report
        .entries
        .iter()
        .zip(&completed_report.entries)
    {
        if awaiting.data_set != completed.data_set
            || awaiting.source_index != completed.source_index
            || awaiting.credential_id != completed.credential_id
        {
            return Err(MigrationError::CredentialReportMismatch);
        }
        let expected_status = match awaiting.status {
            CredentialMigrationStatus::Migrated => CredentialMigrationStatus::Migrated,
            CredentialMigrationStatus::Reentered => CredentialMigrationStatus::Reentered,
            CredentialMigrationStatus::NotPresent => CredentialMigrationStatus::NotPresent,
            CredentialMigrationStatus::RequiresReentry => CredentialMigrationStatus::Reentered,
        };
        if completed.status != expected_status || completed.reason.is_some() {
            return Err(MigrationError::CredentialReportMismatch);
        }
    }
    Ok(())
}

fn credential_report_fingerprint(
    report: &CredentialMigrationReport,
) -> Result<String, MigrationError> {
    let bytes =
        serde_json::to_vec(report).map_err(MigrationError::CredentialReentrySerialization)?;
    Ok(filesystem::sha256_bytes(&bytes))
}

fn credential_reentry_receipt_fingerprint(
    receipt: &CredentialReentryReceipt,
) -> Result<String, MigrationError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintInput<'a> {
        schema_version: u32,
        awaiting_report_fingerprint: &'a str,
        completed_report: &'a CredentialMigrationReport,
    }

    let bytes = serde_json::to_vec(&FingerprintInput {
        schema_version: receipt.schema_version,
        awaiting_report_fingerprint: &receipt.awaiting_report_fingerprint,
        completed_report: &receipt.completed_report,
    })
    .map_err(MigrationError::CredentialReentrySerialization)?;
    Ok(filesystem::sha256_bytes(&bytes))
}

pub(super) fn validate_backup_prerequisite(
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
            entries.push(not_present_entry_at(LegacyDataSet::Providers, source_index));
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
    not_present_entry_at(data_set, 0)
}

fn not_present_entry_at(data_set: LegacyDataSet, source_index: usize) -> CredentialMigrationEntry {
    CredentialMigrationEntry {
        data_set,
        source_index,
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
