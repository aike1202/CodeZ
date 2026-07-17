use std::path::Path;

use codez_core::{AppError, AppErrorKind, FileKind, SafeWorkspacePath};
use sha2::{Digest, Sha256};

use crate::edit_transaction::{EditMutationPreparation, EditTransactionContentVersion};
use crate::tools::registry::{ToolContext, ToolFileServices};

pub(super) const MAX_MUTATION_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileState {
    pub bytes: Option<Vec<u8>>,
}

impl FileState {
    pub fn sha256(&self) -> Option<String> {
        self.bytes.as_deref().map(sha256)
    }

    pub fn text(&self) -> Result<Option<&str>, AppError> {
        self.bytes
            .as_deref()
            .map(|bytes| {
                std::str::from_utf8(bytes)
                    .map_err(|_| AppError::validation("The file is not valid UTF-8 text"))
            })
            .transpose()
    }

    fn content_version(&self) -> Option<EditTransactionContentVersion> {
        self.bytes
            .as_deref()
            .map(EditTransactionContentVersion::from_bytes)
    }
}

impl EditTransactionContentVersion {
    fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            sha256: sha256(bytes),
            size: bytes.len() as u64,
        }
    }
}

pub(super) fn services(context: &ToolContext) -> Result<&ToolFileServices, AppError> {
    context
        .file_services
        .as_ref()
        .ok_or_else(|| AppError::internal("trusted file services were not composed for a tool"))
}

pub(super) fn transaction_identity(context: &ToolContext) -> Result<(&str, &str), AppError> {
    let session_id = context
        .session_id
        .as_deref()
        .ok_or_else(|| AppError::validation("A session is required for file mutation"))?;
    let transaction_id = context
        .transaction_id
        .as_deref()
        .ok_or_else(|| AppError::validation("An edit transaction is required for file mutation"))?;
    Ok((session_id, transaction_id))
}

pub(super) fn ensure_authorized_path(
    authorized_path: &Path,
    safe_path: &SafeWorkspacePath,
) -> Result<(), AppError> {
    let safe_path = safe_path.absolute_path();
    if path_identity(authorized_path) == path_identity(&safe_path) {
        Ok(())
    } else {
        Err(AppError::conflict(
            "The file path changed after tool authorization",
        ))
    }
}

pub(super) async fn read_state(
    services: &ToolFileServices,
    path: &SafeWorkspacePath,
) -> Result<FileState, AppError> {
    let metadata = match services.file_system.metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == AppErrorKind::NotFound => {
            return Ok(FileState { bytes: None });
        }
        Err(error) => return Err(error),
    };
    if metadata.kind != FileKind::File {
        return Err(AppError::validation(
            "File mutation only accepts regular files",
        ));
    }
    if metadata.byte_length > MAX_MUTATION_BYTES {
        return Err(AppError::validation(
            "The file exceeds the 10 MiB mutation limit",
        ));
    }
    let bytes = services
        .file_system
        .read_bounded(path, MAX_MUTATION_BYTES)
        .await?;
    Ok(FileState { bytes: Some(bytes) })
}

pub(super) fn require_current_delivery(
    services: &ToolFileServices,
    context: &ToolContext,
    session_id: &str,
    path: &Path,
    state: &FileState,
) -> Result<(), AppError> {
    let sha256 = state
        .sha256()
        .ok_or_else(|| AppError::not_found("The file does not exist"))?;
    if services
        .fingerprint_store
        .has_delivery(session_id, &context.context_scope_id, path, &sha256)
    {
        Ok(())
    } else {
        Err(AppError::conflict(
            "Read the current file in this agent context before modifying it",
        ))
    }
}

pub(super) async fn stage_backup(
    services: &ToolFileServices,
    transaction_id: &str,
    path: &Path,
    before: &FileState,
) -> Result<bool, AppError> {
    let content = before.text()?.map(std::borrow::ToOwned::to_owned);
    services
        .edit_transaction_service
        .backup_file(transaction_id, path, content)
        .await
}

pub(super) async fn discard_staged_backup(
    services: &ToolFileServices,
    transaction_id: &str,
    path: &Path,
) -> Result<(), AppError> {
    services
        .edit_transaction_service
        .discard_staged_backup(transaction_id, path)
        .await
        .map(|_| ())
}

pub(super) async fn prepare_mutation(
    services: &ToolFileServices,
    transaction_id: &str,
    path: &Path,
    new_bytes: &[u8],
) -> Result<EditMutationPreparation, AppError> {
    let intended = EditTransactionContentVersion::from_bytes(new_bytes);
    services
        .edit_transaction_service
        .prepare_mutation(transaction_id, path, intended)
        .await
}

pub(super) async fn abort_staged_backup(
    services: &ToolFileServices,
    transaction_id: &str,
    path: &Path,
    staged_backup: bool,
    operation_error: AppError,
) -> AppError {
    if !staged_backup {
        return operation_error;
    }
    match discard_staged_backup(services, transaction_id, path).await {
        Ok(()) => operation_error,
        Err(cleanup_error) => combined_cleanup_error(
            "The file operation failed and its staged backup could not be discarded",
            operation_error,
            cleanup_error,
        ),
    }
}

pub(super) async fn abort_prepared_mutation(
    services: &ToolFileServices,
    transaction_id: &str,
    path: &Path,
    preparation: EditMutationPreparation,
    staged_backup: bool,
    operation_error: AppError,
) -> AppError {
    match services
        .edit_transaction_service
        .abort_prepared_mutation(transaction_id, path, preparation, staged_backup)
        .await
    {
        Ok(()) => operation_error,
        Err(cleanup_error) => combined_cleanup_error(
            "The file operation failed and its prepared mutation could not be aborted",
            operation_error,
            cleanup_error,
        ),
    }
}

pub(super) async fn record_successful_mutation(
    services: &ToolFileServices,
    context: &ToolContext,
    session_id: &str,
    transaction_id: &str,
    path: &Path,
    preparation: &EditMutationPreparation,
) -> Result<String, AppError> {
    let intended = preparation.intended();
    record_verified_mutation(services, transaction_id, path, intended).await?;
    let sha256 = intended.sha256.clone();
    services.fingerprint_store.record(session_id, path, &sha256);
    services.fingerprint_store.record_delivery(
        session_id,
        &context.context_scope_id,
        path,
        &sha256,
    );
    Ok(sha256)
}

pub(super) async fn reconcile_failed_write(
    services: &ToolFileServices,
    transaction_id: &str,
    safe_path: &SafeWorkspacePath,
    before: &FileState,
    write_error: AppError,
    staged_backup: bool,
    preparation: EditMutationPreparation,
) -> AppError {
    let absolute_path = safe_path.absolute_path();
    match read_state(services, safe_path).await {
        Ok(after) if &after == before => {
            abort_prepared_mutation(
                services,
                transaction_id,
                &absolute_path,
                preparation,
                staged_backup,
                write_error,
            )
            .await
        }
        Ok(after) if after.content_version().as_ref() == Some(preparation.intended()) => {
            if let Err(record_error) = record_verified_mutation(
                services,
                transaction_id,
                &absolute_path,
                preparation.intended(),
            )
            .await
            {
                return AppError::storage(
                    "The write changed the file but its rollback state could not be recorded",
                    format!("write error: {write_error}; transaction error: {record_error}"),
                    false,
                );
            }
            AppError::storage(
                "The write reported an error after changing the file; rollback data was retained",
                write_error.to_string(),
                false,
            )
        }
        Ok(_) => AppError::conflict(
            "The write failed after the file changed to unexpected content; rollback data was retained",
        ),
        Err(inspect_error) => AppError::storage(
            "The write failed and its final file state could not be verified; rollback data was retained",
            format!("write error: {write_error}; verification error: {inspect_error}"),
            false,
        ),
    }
}

fn combined_cleanup_error(
    message: &str,
    operation_error: AppError,
    cleanup_error: AppError,
) -> AppError {
    AppError::storage(
        message,
        format!("operation error: {operation_error}; cleanup error: {cleanup_error}"),
        false,
    )
}

async fn record_verified_mutation(
    services: &ToolFileServices,
    transaction_id: &str,
    path: &Path,
    intended: &EditTransactionContentVersion,
) -> Result<(), AppError> {
    if let Err(first_error) = services
        .edit_transaction_service
        .record_verified_mutation(transaction_id, path.to_path_buf(), intended)
        .await
    {
        services
            .edit_transaction_service
            .record_verified_mutation(transaction_id, path.to_path_buf(), intended)
            .await
            .map_err(|retry_error| {
                AppError::storage(
                    "The file changed but its rollback state could not be persisted",
                    format!("first transaction error: {first_error}; retry error: {retry_error}"),
                    false,
                )
            })?;
    }
    Ok(())
}

#[must_use]
pub(super) fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn path_identity(path: &Path) -> String {
    #[cfg(windows)]
    {
        dunce::simplified(path).to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn path_identity_treats_verbatim_and_drive_paths_as_the_same_file() {
        let drive_path = std::path::Path::new(r"C:\workspace\src\file.rs");
        let verbatim_path = std::path::Path::new(r"\\?\C:\workspace\src\file.rs");

        assert_eq!(
            super::path_identity(drive_path),
            super::path_identity(verbatim_path)
        );
    }
}
