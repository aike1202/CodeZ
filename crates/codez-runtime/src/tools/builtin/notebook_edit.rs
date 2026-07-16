use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use codez_core::AppError;

use crate::{
    edit_transaction::EditTransactionService, fingerprint::ReadFingerprintStore,
    mutation_coordinator::FileMutationCoordinator,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct NotebookEditArgs {
    pub notebook_path: String,
    pub cell_id: Option<String>,
    pub cell_type: Option<String>,
    pub new_source: Option<String>,
    pub edit_mode: Option<String>, // "replace" | "insert" | "delete"
}

pub struct NotebookEditToolContext<'a> {
    pub workspace_root: &'a Path,
    pub session_id: Option<&'a str>,
    pub context_scope_id: &'a str,
    pub transaction_id: Option<&'a str>,
    pub mutation_coordinator: Arc<FileMutationCoordinator>,
    pub fingerprint_store: Arc<ReadFingerprintStore>,
    pub edit_transaction_service: Option<Arc<EditTransactionService>>,
}

fn cell_id_of(cell: &Value, index: usize) -> String {
    if let Some(id) = cell.get("id").and_then(|v| v.as_str()) {
        id.to_string()
    } else {
        format!("cell-{}", index)
    }
}

fn string_to_source(s: &str) -> Vec<String> {
    if s.is_empty() {
        return vec![];
    }
    let lines: Vec<&str> = s.split('\n').collect();
    let mut res = Vec::new();
    let len = lines.len();
    for (i, line) in lines.into_iter().enumerate() {
        if i < len - 1 {
            res.push(format!("{}\n", line));
        } else {
            res.push(line.to_string());
        }
    }
    res
}

pub async fn execute_notebook_edit(
    args: NotebookEditArgs,
    context: &NotebookEditToolContext<'_>,
) -> Result<String, AppError> {
    if args.notebook_path.is_empty() {
        return Err(AppError::validation("notebook_path is required"));
    }

    let requested_path = PathBuf::from(&args.notebook_path);
    let absolute_path = if requested_path.is_absolute() {
        requested_path
    } else {
        context.workspace_root.join(&requested_path)
    };

    let absolute_path = dunce::canonicalize(&absolute_path).map_err(|e| {
        AppError::validation(format!("Failed to resolve path: {}. Ensure the file exists.", e))
    })?;

    if !absolute_path.starts_with(context.workspace_root) || absolute_path == context.workspace_root {
        return Err(AppError::permission_denied("Access denied. Cannot modify file outside of workspace."));
    }

    if absolute_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase() != "ipynb" {
        return Err(AppError::validation("notebook_path must point to a .ipynb file."));
    }

    let _lock = context.mutation_coordinator.acquire(&absolute_path).await;

    let text = tokio::fs::read_to_string(&absolute_path)
        .await
        .map_err(|e| AppError::storage(format!("Failed to read file: {}", e), e.to_string(), false))?;

    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let current_sha = hex::encode(hasher.finalize());

    if let Some(session_id) = context.session_id {
        if !context.fingerprint_store.has_delivery(
            session_id,
            context.context_scope_id,
            &absolute_path,
            &current_sha,
        ) {
            return Err(AppError::validation(
                "You must Read the current version of this notebook in this agent context before editing it.",
            ));
        }
    } else {
        return Err(AppError::validation("Session ID is required for NotebookEdit tool."));
    }

    let mut nb: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::validation(format!("Invalid notebook JSON: {}", e)))?;

    let cells = nb.get_mut("cells")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| AppError::validation("Invalid notebook: missing cells array."))?;

    let mode = args.edit_mode.as_deref().unwrap_or("replace");
    let target_id = args.cell_id.as_deref();
    
    let target_idx = if let Some(id) = target_id {
        cells.iter().position(|c| {
            // Find index manually since we don't have cell_id_of taking just cell initially without index
            // Wait, cell_id_of requires index. Let's just iterate
            false // placeholder
        })
    } else {
        None
    };
    
    let mut actual_idx = None;
    if let Some(id) = target_id {
        for (i, cell) in cells.iter().enumerate() {
            if cell_id_of(cell, i) == id {
                actual_idx = Some(i);
                break;
            }
        }
    }

    if mode == "replace" {
        if target_id.is_none() {
            return Err(AppError::validation("cell_id is required for replace."));
        }
        let idx = actual_idx.ok_or_else(|| AppError::validation(format!("cell_id '{}' not found.", target_id.unwrap())))?;
        if args.new_source.is_none() {
            return Err(AppError::validation("new_source is required for replace."));
        }
        let mut cell = cells[idx].clone();
        cell["source"] = serde_json::json!(string_to_source(args.new_source.as_ref().unwrap()));
        // Clear outputs for code cell
        if cell.get("cell_type").and_then(|v| v.as_str()) == Some("code") {
            cell["outputs"] = serde_json::json!([]);
            cell["execution_count"] = serde_json::Value::Null;
        }
        cells[idx] = cell;
    } else if mode == "delete" {
        if target_id.is_none() {
            return Err(AppError::validation("cell_id is required for delete."));
        }
        let idx = actual_idx.ok_or_else(|| AppError::validation(format!("cell_id '{}' not found.", target_id.unwrap())))?;
        cells.remove(idx);
    } else if mode == "insert" {
        if args.new_source.is_none() {
            return Err(AppError::validation("new_source is required for insert."));
        }
        let mut new_cell = serde_json::json!({
            "cell_type": args.cell_type.unwrap_or_else(|| "code".to_string()),
            "source": string_to_source(args.new_source.as_ref().unwrap()),
            "metadata": {}
        });
        if new_cell["cell_type"] == "code" {
            new_cell["outputs"] = serde_json::json!([]);
            new_cell["execution_count"] = serde_json::Value::Null;
        }

        if let Some(id) = target_id {
            let idx = actual_idx.ok_or_else(|| AppError::validation(format!("cell_id '{}' not found.", id)))?;
            cells.insert(idx + 1, new_cell);
        } else {
            cells.insert(0, new_cell);
        }
    } else {
        return Err(AppError::validation(format!("Invalid edit_mode: {}", mode)));
    }

    let mut staged_backup = false;
    if let (Some(tx_service), Some(tx_id)) = (&context.edit_transaction_service, context.transaction_id) {
        staged_backup = tx_service
            .backup_file(tx_id, &absolute_path, Some(text.clone()))
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

    let updated = serde_json::to_string_pretty(&nb)
        .map_err(|e| AppError::internal(format!("Failed to serialize notebook: {}", e)))?;

    // Pretty stringify output differs from nodejs JSON.stringify(nb, null, 1)?
    // Usually rust's pretty uses 2 spaces. If nodejs uses 1 space, we can manually format, but standard json is fine.

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

    Ok(format!("Successfully edited notebook {}", absolute_path.display()))
}
