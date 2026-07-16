use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

use codez_core::AppError;

use crate::{
    edit_transaction::EditTransactionService, fingerprint::ReadFingerprintStore,
    mutation_coordinator::FileMutationCoordinator,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct WriteArgs {
    pub file_path: String,
    pub content: String,
}

pub struct WriteToolContext<'a> {
    pub workspace_root: &'a Path,
    pub session_id: Option<&'a str>,
    pub context_scope_id: &'a str,
    pub transaction_id: Option<&'a str>,
    pub mutation_coordinator: Arc<FileMutationCoordinator>,
    pub fingerprint_store: Arc<ReadFingerprintStore>,
    pub edit_transaction_service: Option<Arc<EditTransactionService>>,
}

pub async fn execute_write(args: WriteArgs, context: &WriteToolContext<'_>) -> Result<String, AppError> {
    if args.file_path.is_empty() {
        return Err(AppError::validation("file_path is required"));
    }

    let requested_path = PathBuf::from(&args.file_path);
    let absolute_path = if requested_path.is_absolute() {
        requested_path
    } else {
        context.workspace_root.join(&requested_path)
    };

    if let Some(parent) = absolute_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let absolute_path = dunce::canonicalize(&absolute_path).unwrap_or(absolute_path);

    if !absolute_path.starts_with(context.workspace_root) || absolute_path == context.workspace_root {
        return Err(AppError::permission_denied(
            "Access denied. Cannot modify file outside of workspace.",
        ));
    }

    let _lock = context.mutation_coordinator.acquire(&absolute_path).await;

    let exists = tokio::fs::try_exists(&absolute_path).await.unwrap_or(false);
    let mut original_content: Option<String> = None;

    if exists {
        let content = tokio::fs::read_to_string(&absolute_path)
            .await
            .map_err(|e| AppError::storage(format!("Failed to read existing file: {}", e), e.to_string(), false))?;
        
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        let expected_sha = hex::encode(hasher.finalize());
        original_content = Some(content);

        if let Some(session_id) = context.session_id {
            if !context.fingerprint_store.has_delivery(
                session_id,
                context.context_scope_id,
                &absolute_path,
                &expected_sha,
            ) {
                return Err(AppError::validation(
                    "You must Read this file in this conversation before overwriting it. Use Edit for partial changes.",
                ));
            }
        } else {
            return Err(AppError::validation("Session ID is required for Write tool to overwrite a file."));
        }
    }

    let mut staged_backup = false;
    if let (Some(tx_service), Some(tx_id)) = (&context.edit_transaction_service, context.transaction_id) {
        staged_backup = tx_service
            .backup_file(tx_id, &absolute_path, original_content)
            .await
            .map_err(|e| AppError::external(format!("Failed to backup file before writing: {}", e), e.to_string(), false))?;
    }

    tokio::fs::write(&absolute_path, args.content.as_bytes())
        .await
        .map_err(|e| AppError::storage(format!("Failed to write file: {}", e), e.to_string(), false))?;

    let mut hasher = Sha256::new();
    hasher.update(args.content.as_bytes());
    let new_sha = hex::encode(hasher.finalize());

    if let Some(session_id) = context.session_id {
        context.fingerprint_store.record_delivery(
            session_id,
            context.context_scope_id,
            &absolute_path,
            &new_sha,
        );
    }

    if let (Some(tx_service), Some(tx_id)) = (&context.edit_transaction_service, context.transaction_id) {
        tx_service
            .record_mutation(tx_id, absolute_path.clone(), staged_backup)
            .await
            .map_err(|e| AppError::external(format!("Failed to record transaction mutation: {}", e), e.to_string(), false))?;
    }

    Ok(format!("Successfully wrote to {}", absolute_path.display()))
}
