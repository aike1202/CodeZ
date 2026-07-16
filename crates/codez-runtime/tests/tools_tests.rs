use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use sha2::{Digest, Sha256};
use codez_core::AppPaths;
use codez_runtime::edit_transaction::EditTransactionService;
use codez_runtime::fingerprint::ReadFingerprintStore;
use codez_runtime::mutation_coordinator::FileMutationCoordinator;
use codez_runtime::tools::builtin::edit::{execute_edit, EditArgs, EditOperation, EditToolContext};
use tempfile::TempDir;

#[tokio::test]
async fn test_edit_tool_replaces_string_correctly() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().to_path_buf();
    
    let mutation = Arc::new(FileMutationCoordinator::new());
    let fingerprint = Arc::new(ReadFingerprintStore::new(100, 1000));
    
    let file_path = root.join("test.txt");
    fs::write(&file_path, "Hello world!\nThis is a test.").await.unwrap();
    
    let mut hasher = Sha256::new();
    hasher.update(b"Hello world!\nThis is a test.");
    let sha = hex::encode(hasher.finalize());
    
    fingerprint.record_delivery("session1", "context1", &file_path, &sha);
    
    let args = EditArgs {
        file_path: "test.txt".to_string(),
        edits: vec![EditOperation {
            old_string: "world!".to_string(),
            new_string: "Rust!".to_string(),
            replace_all: false,
        }],
    };
    
    let context = EditToolContext {
        workspace_root: &root,
        session_id: Some("session1"),
        context_scope_id: "context1",
        transaction_id: None,
        mutation_coordinator: mutation.clone(),
        fingerprint_store: fingerprint.clone(),
        edit_transaction_service: None,
    };
    
    let res = execute_edit(args, &context).await;
    assert!(res.is_ok(), "Edit failed: {:?}", res);
    
    let content = fs::read_to_string(&file_path).await.unwrap();
    assert_eq!(content, "Hello Rust!\nThis is a test.");
}

use codez_runtime::tools::builtin::write::{execute_write, WriteArgs, WriteToolContext};

#[tokio::test]
async fn test_write_tool_creates_file() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().to_path_buf();
    
    let mutation = Arc::new(FileMutationCoordinator::new());
    let fingerprint = Arc::new(ReadFingerprintStore::new(100, 1000));
    
    let args = WriteArgs {
        file_path: "new_file.txt".to_string(),
        content: "New content".to_string(),
    };
    
    let context = WriteToolContext {
        workspace_root: &root,
        session_id: Some("session1"),
        context_scope_id: "context1",
        transaction_id: None,
        mutation_coordinator: mutation.clone(),
        fingerprint_store: fingerprint.clone(),
        edit_transaction_service: None,
    };
    
    let res = execute_write(args, &context).await;
    assert!(res.is_ok(), "Write failed: {:?}", res);
    
    let content = fs::read_to_string(root.join("new_file.txt")).await.unwrap();
    assert_eq!(content, "New content");
}

use codez_runtime::tools::builtin::notebook_edit::{execute_notebook_edit, NotebookEditArgs, NotebookEditToolContext};

#[tokio::test]
async fn test_notebook_edit_replaces_cell() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path().to_path_buf();
    
    let mutation = Arc::new(FileMutationCoordinator::new());
    let fingerprint = Arc::new(ReadFingerprintStore::new(100, 1000));
    
    let file_path = root.join("test.ipynb");
    let initial_nb = serde_json::json!({
        "cells": [
            {
                "cell_type": "code",
                "id": "cell-1",
                "source": ["print('Hello')"],
                "outputs": ["Hello"]
            }
        ],
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 2
    });
    let initial_text = serde_json::to_string_pretty(&initial_nb).unwrap();
    fs::write(&file_path, &initial_text).await.unwrap();
    
    let mut hasher = Sha256::new();
    hasher.update(initial_text.as_bytes());
    let sha = hex::encode(hasher.finalize());
    fingerprint.record_delivery("session1", "context1", &file_path, &sha);
    
    let args = NotebookEditArgs {
        notebook_path: "test.ipynb".to_string(),
        cell_id: Some("cell-1".to_string()),
        cell_type: None,
        new_source: Some("print('Rust')".to_string()),
        edit_mode: Some("replace".to_string()),
    };
    
    let context = NotebookEditToolContext {
        workspace_root: &root,
        session_id: Some("session1"),
        context_scope_id: "context1",
        transaction_id: None,
        mutation_coordinator: mutation.clone(),
        fingerprint_store: fingerprint.clone(),
        edit_transaction_service: None,
    };
    
    let res = execute_notebook_edit(args, &context).await;
    assert!(res.is_ok(), "Notebook edit failed: {:?}", res);
    
    let new_text = fs::read_to_string(&file_path).await.unwrap();
    let updated_nb: serde_json::Value = serde_json::from_str(&new_text).unwrap();
    
    let source = updated_nb["cells"][0]["source"].as_array().unwrap();
    assert_eq!(source[0].as_str().unwrap(), "print('Rust')");
    
    // Outputs should be cleared for replace code cell
    let outputs = updated_nb["cells"][0]["outputs"].as_array().unwrap();
    assert!(outputs.is_empty());
}
