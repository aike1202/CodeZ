use tauri::{command, State};
use serde_json::{json, Value};

use crate::state::AppState;

fn get_mcp_path(state: &AppState) -> std::path::PathBuf {
    state.paths.data_directory().join("mcp.json")
}

async fn load_mcp_config(state: &AppState) -> Result<Value, String> {
    let path = get_mcp_path(state);
    if !path.exists() {
        return Ok(json!({ "mcpServers": {} }));
    }
    let data = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&data).unwrap_or(json!({ "mcpServers": {} }));
    Ok(parsed)
}

async fn save_mcp_config(state: &AppState, config: &Value) -> Result<(), String> {
    let path = get_mcp_path(state);
    let json_str = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, json_str).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn mcp_list(state: State<'_, AppState>) -> Result<Value, String> {
    let config = load_mcp_config(&state).await?;
    let servers = config.get("mcpServers").cloned().unwrap_or(json!({}));
    
    // In a real implementation we would query the running MCP server statuses
    // For now we just return the config structure
    let mut configs = Vec::new();
    let mut statuses = Vec::new();
    
    if let Some(obj) = servers.as_object() {
        for (name, conf) in obj {
            configs.push(json!({
                "name": name,
                "command": conf.get("command").unwrap_or(&Value::Null),
                "args": conf.get("args").unwrap_or(&Value::Null),
                "env": conf.get("env").unwrap_or(&Value::Null),
                "disabled": conf.get("disabled").unwrap_or(&Value::Null),
                "effective": true
            }));
            
            statuses.push(json!({
                "name": name,
                "status": "disconnected" // default status since we don't have the active runner wired yet
            }));
        }
    }
    
    Ok(json!({
        "configs": configs,
        "statuses": statuses
    }))
}

#[command]
pub async fn mcp_save_user(state: State<'_, AppState>, servers: Value) -> Result<Value, String> {
    let mut config = load_mcp_config(&state).await?;
    config["mcpServers"] = servers;
    save_mcp_config(&state, &config).await?;
    mcp_list(state).await
}

#[command]
pub async fn mcp_set_enabled(state: State<'_, AppState>, name: String, enabled: bool) -> Result<Value, String> {
    let mut config = load_mcp_config(&state).await?;
    if let Some(servers) = config.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        if let Some(server) = servers.get_mut(&name) {
            server["disabled"] = json!(!enabled);
        }
    }
    save_mcp_config(&state, &config).await?;
    mcp_list(state).await
}

#[command]
pub async fn mcp_get_catalog(_state: State<'_, AppState>, _name: String) -> Result<Value, String> {
    Ok(json!({ "tools": [], "resources": [], "prompts": [], "stale": false }))
}

#[command]
pub async fn mcp_reconnect(_state: State<'_, AppState>, _name: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn mcp_authorize(_state: State<'_, AppState>, _name: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn mcp_logout(_state: State<'_, AppState>, _name: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn mcp_trust_project(_state: State<'_, AppState>, _fingerprint: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn mcp_list_secret_keys(_state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    Ok(vec![])
}

#[command]
pub async fn mcp_set_secret(_state: State<'_, AppState>, _key: String, _value: String) -> Result<Vec<Value>, String> {
    Ok(vec![])
}

#[command]
pub async fn mcp_delete_secret(_state: State<'_, AppState>, _key: String) -> Result<Vec<Value>, String> {
    Ok(vec![])
}
