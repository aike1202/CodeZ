use codez_contracts::{
    CommandError,
    migration::{MigrationCredentialInput, MigrationRecoveryStatus},
};
use codez_core::AppError;
use codez_storage::{CredentialId, CredentialReentry, SecretValue};
use tauri::{AppHandle, State};

use crate::{
    error::command_result,
    migration_boundary::recovery_snapshot_to_wire,
    state::{MigrationRecoverySnapshot, MigrationRecoveryState},
};

const MAX_CREDENTIAL_REENTRY_SECRET_BYTES: usize = 64 * 1024;

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state))]
pub async fn migration_get_status(
    state: State<'_, MigrationRecoveryState>,
) -> Result<MigrationRecoveryStatus, CommandError> {
    command_result(
        &state.errors,
        recovery_snapshot_to_wire(state.snapshot().await),
    )
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, inputs))]
pub async fn migration_submit_credentials(
    inputs: Vec<MigrationCredentialInput>,
    state: State<'_, MigrationRecoveryState>,
) -> Result<MigrationRecoveryStatus, CommandError> {
    let result = async {
        let entries = inputs
            .into_iter()
            .map(credential_input_to_domain)
            .collect::<Result<Vec<_>, AppError>>()?;
        let snapshot = state.resume(entries).await.map_err(AppError::from)?;
        recovery_snapshot_to_wire(snapshot)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(name = "desktop.command", skip(state, app))]
pub async fn migration_restart(
    app: AppHandle,
    state: State<'_, MigrationRecoveryState>,
) -> Result<(), CommandError> {
    let result = if matches!(
        state.snapshot().await,
        MigrationRecoverySnapshot::ReadyToRestart
    ) {
        app.request_restart();
        Ok(())
    } else {
        Err(AppError::conflict(
            "Credential migration is not ready to restart yet",
        ))
    };
    command_result(&state.errors, result)
}

fn credential_input_to_domain(
    input: MigrationCredentialInput,
) -> Result<CredentialReentry, AppError> {
    let credential_id = CredentialId::parse(&input.credential_id)
        .map_err(|_| AppError::validation("The credential identity is invalid"))?;
    if input.secret.len() > MAX_CREDENTIAL_REENTRY_SECRET_BYTES {
        return Err(AppError::validation("The credential value is too large"));
    }
    let secret = SecretValue::new(input.secret)
        .map_err(|_| AppError::validation("A credential value is required"))?;
    Ok(CredentialReentry::new(credential_id, secret))
}

#[cfg(test)]
mod tests {
    use codez_core::AppErrorKind;

    use super::{
        MAX_CREDENTIAL_REENTRY_SECRET_BYTES, MigrationCredentialInput, credential_input_to_domain,
    };

    #[test]
    fn credential_input_rejects_an_oversized_secret_before_keychain_access() {
        let result = credential_input_to_domain(MigrationCredentialInput {
            credential_id: "provider-api-key:provider-1".to_string(),
            secret: "x".repeat(MAX_CREDENTIAL_REENTRY_SECRET_BYTES + 1),
        });

        assert!(matches!(result, Err(error) if error.kind() == AppErrorKind::Validation));
    }
}
