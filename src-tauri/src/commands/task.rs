use tauri::{command, State};
use serde_json::Value;

use crate::state::AppState;

#[command]
pub async fn task_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.paths.data_directory().join("tasks.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let tasks: Vec<Value> = serde_json::from_str(&data).unwrap_or(vec![]);
    Ok(tasks)
}

#[command]
pub async fn task_get(state: State<'_, AppState>, task_id: String) -> Result<Value, String> {
    let tasks = task_list(state).await?;
    if let Some(task) = tasks.into_iter().find(|t| t.get("id").and_then(|id| id.as_str()) == Some(&task_id)) {
        Ok(task)
    } else {
        Ok(Value::Null)
    }
}

#[command]
pub async fn task_get_by_project(state: State<'_, AppState>, project_id: String) -> Result<Vec<Value>, String> {
    let tasks = task_list(state).await?;
    let filtered = tasks.into_iter().filter(|t| t.get("projectId").and_then(|p| p.as_str()) == Some(&project_id)).collect();
    Ok(filtered)
}

#[command]
pub async fn task_save(state: State<'_, AppState>, task: Value) -> Result<(), String> {
    let mut tasks = task_list(state.clone()).await?;
    let task_id = task.get("id").and_then(|v| v.as_str()).ok_or("Missing task id")?;
    
    if let Some(idx) = tasks.iter().position(|t| t.get("id").and_then(|id| id.as_str()) == Some(task_id)) {
        tasks[idx] = task;
    } else {
        tasks.push(task);
    }
    
    let path = state.paths.data_directory().join("tasks.json");
    let json_str = serde_json::to_string_pretty(&tasks).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, json_str).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn task_delete(state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    let mut tasks = task_list(state.clone()).await?;
    let original_len = tasks.len();
    tasks.retain(|t| t.get("id").and_then(|id| id.as_str()) != Some(&task_id));
    
    if tasks.len() < original_len {
        let path = state.paths.data_directory().join("tasks.json");
        let json_str = serde_json::to_string_pretty(&tasks).map_err(|e| e.to_string())?;
        tokio::fs::write(&path, json_str).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
