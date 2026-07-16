use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Startup state exposed while legacy credential migration is blocked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum MigrationRecoveryPhase {
    /// Secure credential values must be explicitly entered before activation.
    AwaitingCredentials,
    /// Activation completed and the desktop process must restart into normal mode.
    ReadyToRestart,
}

/// One legacy credential family that can require user re-entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum MigrationCredentialDataSet {
    Providers,
    McpSecrets,
    McpOAuth,
}

/// Redacted reason that a legacy credential could not be transferred directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum MigrationCredentialReason {
    MissingCredential,
    InsecureLegacyEncoding,
    InvalidLegacyDocument,
    InvalidIdentifier,
    UnsupportedPlatform,
    LocalStateUnavailable,
    InvalidLocalState,
    KeyUnavailable,
    InvalidEncoding,
    UnsupportedEnvelope,
    AuthenticationFailed,
    InvalidPlaintext,
}

/// One redacted credential requirement presented by the limited recovery UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MigrationCredentialRequirement {
    pub data_set: MigrationCredentialDataSet,
    pub source_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<MigrationCredentialReason>,
    /// `false` means the legacy record has no safe target identity and cannot
    /// be activated automatically.
    pub can_reenter: bool,
}

/// Complete safe-to-display status for a blocked migration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MigrationRecoveryStatus {
    pub phase: MigrationRecoveryPhase,
    pub requirements: Vec<MigrationCredentialRequirement>,
}

/// One secret-bearing input accepted only by the migration resume command.
///
/// This type is deserialized from the command payload but deliberately is not
/// serializable or `Debug`, so a supplied secret cannot be returned or logged.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct MigrationCredentialInput {
    pub credential_id: String,
    pub secret: String,
}
