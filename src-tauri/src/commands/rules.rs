use std::path::PathBuf;
use tauri::{command, State};
use serde_json::{json, Value};

use crate::state::AppState;

#[command]
pub async fn rules_get_list(state: State<'_, AppState>, workspaces: Vec<Value>) -> Result<Vec<Value>, String> {
    let mut rules = Vec::new();

    // Global rules
    let global_config = state.paths.data_directory().join("config");
    let global_md = global_config.join("AGENTS.md");
    if global_md.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&global_md).await {
            rules.push(json!({
                "filename": "AGENTS.md",
                "path": global_md.to_string_lossy(),
                "content": content,
                "scope": "global"
            }));
        }
    } else {
        // Provide empty placeholder if missing
        rules.push(json!({
            "filename": "AGENTS.md",
            "path": global_md.to_string_lossy(),
            "content": "",
            "scope": "global"
        }));
    }

    // Workspace rules
    for ws in workspaces {
        if let Some(root) = ws.get("rootPath").and_then(|v| v.as_str()) {
            let ws_agents = PathBuf::from(root).join(".agents");
            let ws_md = ws_agents.join("AGENTS.md");
            if ws_md.exists() {
                if let Ok(content) = tokio::fs::read_to_string(&ws_md).await {
                    rules.push(json!({
                        "filename": "AGENTS.md",
                        "path": ws_md.to_string_lossy(),
                        "content": content,
                        "scope": "workspace",
                        "workspaceRoot": root
                    }));
                }
            } else {
                rules.push(json!({
                    "filename": "AGENTS.md",
                    "path": ws_md.to_string_lossy(),
                    "content": "",
                    "scope": "workspace",
                    "workspaceRoot": root
                }));
            }
        }
    }

    Ok(rules)
}

#[command]
pub async fn rules_save(_state: State<'_, AppState>, rule: Value, _workspace_root: Option<String>) -> Result<bool, String> {
    let path_str = rule.get("path").and_then(|v| v.as_str()).ok_or("Missing path")?;
    let content = rule.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let path = PathBuf::from(path_str);
    
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    
    tokio::fs::write(&path, content).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[command]
pub async fn rules_delete(_state: State<'_, AppState>, rule_path: String) -> Result<bool, String> {
    let path = PathBuf::from(rule_path);
    if path.exists() {
        tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    }
    Ok(true)
}

#[command]
pub async fn rules_rename(_state: State<'_, AppState>, old_path: String, new_filename: String, _workspace_root: Option<String>, _scope: String) -> Result<bool, String> {
    let old_p = PathBuf::from(old_path);
    let new_p = old_p.with_file_name(new_filename);
    if old_p.exists() {
        tokio::fs::rename(&old_p, &new_p).await.map_err(|e| e.to_string())?;
    }
    Ok(true)
}
