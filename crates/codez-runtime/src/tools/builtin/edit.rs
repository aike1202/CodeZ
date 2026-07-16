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
pub struct EditOperation {
    pub old_string: String,
    pub new_string: String,
    #[serde(default)]
    pub replace_all: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EditArgs {
    pub file_path: String,
    pub edits: Vec<EditOperation>,
}

pub struct EditToolContext<'a> {
    pub workspace_root: &'a Path,
    pub session_id: Option<&'a str>,
    pub context_scope_id: &'a str,
    pub transaction_id: Option<&'a str>,
    pub mutation_coordinator: Arc<FileMutationCoordinator>,
    pub fingerprint_store: Arc<ReadFingerprintStore>,
    pub edit_transaction_service: Option<Arc<EditTransactionService>>,
}

pub async fn execute_edit(args: EditArgs, context: &EditToolContext<'_>) -> Result<String, AppError> {
    if args.file_path.is_empty() {
        return Err(AppError::validation("file_path is required"));
    }
    if args.edits.is_empty() {
        return Err(AppError::validation("edits must be a non-empty array"));
    }

    for (index, edit) in args.edits.iter().enumerate() {
        if edit.old_string.is_empty() {
            return Err(AppError::validation(format!(
                "Edit {}: old_string must not be empty. Use Write for new files or full rewrites.",
                index + 1
            )));
        }
        if edit.old_string == edit.new_string {
            return Err(AppError::validation(format!(
                "Edit {}: old_string and new_string must be different.",
                index + 1
            )));
        }
    }

    let requested_path = PathBuf::from(&args.file_path);
    let absolute_path = if requested_path.is_absolute() {
        requested_path
    } else {
        context.workspace_root.join(&requested_path)
    };

    let absolute_path = dunce::canonicalize(&absolute_path).map_err(|e| {
        AppError::validation(format!(
            "Failed to resolve path: {}. Ensure the file exists.",
            e
        ))
    })?;

    if !absolute_path.starts_with(context.workspace_root) || absolute_path == context.workspace_root {
        return Err(AppError::permission_denied(
            "Access denied. Cannot modify file outside of workspace.",
        ));
    }

    let _lock = context.mutation_coordinator.acquire(&absolute_path).await;

    let file_content = match tokio::fs::read_to_string(&absolute_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::not_found(
                "File not found. Use Write to create it.",
            ));
        }
        Err(e) => return Err(AppError::external(format!("Failed to read file: {}", e), e.to_string(), false)),
    };

    let mut hasher = Sha256::new();
    hasher.update(file_content.as_bytes());
    let current_sha = hex::encode(hasher.finalize());

    if let Some(session_id) = context.session_id {
        if !context.fingerprint_store.has_delivery(
            session_id,
            context.context_scope_id,
            &absolute_path,
            &current_sha,
        ) {
            return Err(AppError::validation(
                "You must Read the current version of this file in this agent context before editing it.",
            ));
        }
    } else {
        return Err(AppError::validation("Session ID is required for Edit tool."));
    }

    let working = file_content.replace("\r\n", "\n");
    let mut updated = working.clone();
    let mut applied_new_strings: Vec<String> = Vec::new();

    for (index, edit) in args.edits.iter().enumerate() {
        let target = edit.old_string.replace("\r\n", "\n");
        let replacement = edit.new_string.replace("\r\n", "\n");
        let target_without_trailing_newlines = target.trim_end_matches('\n').to_string();

        if !target_without_trailing_newlines.is_empty()
            && applied_new_strings
                .iter()
                .any(|prev| prev.contains(&target_without_trailing_newlines))
        {
            return Err(AppError::validation(format!(
                "Edit {}: old_string is a substring of new_string from a previous edit.",
                index + 1
            )));
        }

        let occurrences = updated.matches(&target).count();
        if occurrences == 0 {
            return Err(AppError::validation(format!(
                "Edit {}: old_string not found. Ensure an exact match without Read line-number prefixes; re-Read the relevant range before retrying.",
                index + 1
            )));
        }
        if occurrences > 1 && !edit.replace_all {
            return Err(AppError::validation(format!(
                "Edit {}: old_string is not unique ({} matches). Use replace_all: true or expand old_string to be unique.",
                index + 1, occurrences
            )));
        }

        if edit.replace_all {
            updated = updated.replace(&target, &replacement);
        } else {
            updated = updated.replacen(&target, &replacement, 1);
        }
        applied_new_strings.push(replacement);
    }

    if updated == working {
        return Err(AppError::validation("The edit batch produces no net change."));
    }

    let mut staged_backup = false;
    if let (Some(tx_service), Some(tx_id)) = (&context.edit_transaction_service, context.transaction_id) {
        staged_backup = tx_service
            .backup_file(tx_id, &absolute_path, Some(file_content.clone()))
            .await
            .map_err(|e| AppError::external(format!("Failed to backup file before writing: {}", e), e.to_string(), false))?;
    }

    let latest_content_bytes = tokio::fs::read(&absolute_path).await.unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&latest_content_bytes);
    let latest_sha = hex::encode(hasher.finalize());

    if latest_sha != current_sha {
        if staged_backup {
            if let (Some(tx_service), Some(tx_id)) = (&context.edit_transaction_service, context.transaction_id) {
                let _ = tx_service.discard_staged_backup(tx_id, &absolute_path).await;
            }
        }
        return Err(AppError::conflict(
            "File changed after validation. Re-Read the current version before editing.",
        ));
    }

    tokio::fs::write(&absolute_path, updated.as_bytes())
        .await
        .map_err(|e| AppError::storage(format!("Failed to write file: {}", e), e.to_string(), false))?;

    let mut hasher = Sha256::new();
    hasher.update(updated.as_bytes());
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

    Ok(format!(
        "Successfully applied {} edits to {}",
        args.edits.len(),
        absolute_path.display()
    ))
}
