use codez_contracts::migration as wire;
use codez_core::AppError;
use codez_storage::{CredentialMigrationReason, CredentialMigrationStatus, LegacyDataSet};

use crate::state::MigrationRecoverySnapshot;

pub(crate) fn recovery_snapshot_to_wire(
    snapshot: MigrationRecoverySnapshot,
) -> Result<wire::MigrationRecoveryStatus, AppError> {
    match snapshot {
        MigrationRecoverySnapshot::ReadyToRestart => Ok(wire::MigrationRecoveryStatus {
            phase: wire::MigrationRecoveryPhase::ReadyToRestart,
            requirements: Vec::new(),
        }),
        MigrationRecoverySnapshot::AwaitingCredentials(report) => {
            let requirements = report
                .entries
                .into_iter()
                .filter(|entry| entry.status == CredentialMigrationStatus::RequiresReentry)
                .map(|entry| {
                    let can_reenter = entry.credential_id.is_some();
                    Ok(wire::MigrationCredentialRequirement {
                        data_set: data_set_to_wire(entry.data_set)?,
                        source_index: entry.source_index,
                        credential_id: entry.credential_id.map(|id| id.account_name()),
                        reason: entry.reason.map(reason_to_wire),
                        can_reenter,
                    })
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            Ok(wire::MigrationRecoveryStatus {
                phase: wire::MigrationRecoveryPhase::AwaitingCredentials,
                requirements,
            })
        }
    }
}

fn data_set_to_wire(value: LegacyDataSet) -> Result<wire::MigrationCredentialDataSet, AppError> {
    match value {
        LegacyDataSet::Providers => Ok(wire::MigrationCredentialDataSet::Providers),
        LegacyDataSet::McpSecrets => Ok(wire::MigrationCredentialDataSet::McpSecrets),
        LegacyDataSet::McpOAuth => Ok(wire::MigrationCredentialDataSet::McpOAuth),
        _ => Err(AppError::internal(
            "credential migration returned an unsupported secret data set",
        )),
    }
}

fn reason_to_wire(value: CredentialMigrationReason) -> wire::MigrationCredentialReason {
    match value {
        CredentialMigrationReason::MissingCredential => {
            wire::MigrationCredentialReason::MissingCredential
        }
        CredentialMigrationReason::InsecureLegacyEncoding => {
            wire::MigrationCredentialReason::InsecureLegacyEncoding
        }
        CredentialMigrationReason::InvalidLegacyDocument => {
            wire::MigrationCredentialReason::InvalidLegacyDocument
        }
        CredentialMigrationReason::InvalidIdentifier => {
            wire::MigrationCredentialReason::InvalidIdentifier
        }
        CredentialMigrationReason::UnsupportedPlatform => {
            wire::MigrationCredentialReason::UnsupportedPlatform
        }
        CredentialMigrationReason::LocalStateUnavailable => {
            wire::MigrationCredentialReason::LocalStateUnavailable
        }
        CredentialMigrationReason::InvalidLocalState => {
            wire::MigrationCredentialReason::InvalidLocalState
        }
        CredentialMigrationReason::KeyUnavailable => {
            wire::MigrationCredentialReason::KeyUnavailable
        }
        CredentialMigrationReason::InvalidEncoding => {
            wire::MigrationCredentialReason::InvalidEncoding
        }
        CredentialMigrationReason::UnsupportedEnvelope => {
            wire::MigrationCredentialReason::UnsupportedEnvelope
        }
        CredentialMigrationReason::AuthenticationFailed => {
            wire::MigrationCredentialReason::AuthenticationFailed
        }
        CredentialMigrationReason::InvalidPlaintext => {
            wire::MigrationCredentialReason::InvalidPlaintext
        }
    }
}
