use tauri::{command, State};
use serde_json::Value;
use std::path::PathBuf;

use crate::state::AppState;

fn settings_path(state: &AppState) -> PathBuf {
    state.paths.data_directory().join("settings.json")
}

#[command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<Value, String> {
    let path = settings_path(&state);
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&data).unwrap_or(serde_json::json!({}));
    Ok(parsed)
}

#[command]
pub async fn settings_save(state: State<'_, AppState>, settings: Value) -> Result<bool, String> {
    let path = settings_path(&state);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let json_str = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, json_str).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[command]
pub async fn session_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let sessions_dir = state.paths.data_directory().join("user-data").join("sessions");
    if !sessions_dir.exists() {
        return Ok(vec![]);
    }
    let mut sessions = vec![];
    let mut entries = tokio::fs::read_dir(&sessions_dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(data) = tokio::fs::read_to_string(&path).await {
                if let Ok(val) = serde_json::from_str::<Value>(&data) {
                    sessions.push(val);
                }
            }
        }
    }
    Ok(sessions)
}

#[command]
pub async fn session_get(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    let path = state.paths.data_directory()
        .join("user-data").join("sessions").join(format!("{}.json", session_id));
    if !path.exists() {
        return Ok(Value::Null);
    }
    let data = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
    Ok(parsed)
}

#[command]
pub async fn session_save(state: State<'_, AppState>, session: Value) -> Result<(), String> {
    let session_id = session.get("id").and_then(|v| v.as_str()).ok_or("Missing session id")?;
    let dir = state.paths.data_directory().join("user-data").join("sessions");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", session_id));
    let json_str = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, json_str).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn session_delete(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let path = state.paths.data_directory()
        .join("user-data").join("sessions").join(format!("{}.json", session_id));
    if path.exists() {
        tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
