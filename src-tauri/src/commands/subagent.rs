use tauri::{command, State};
use serde_json::{json, Value};

use crate::state::AppState;
use crate::commands::settings::settings_get;

#[command]
pub async fn subagent_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    // In a full implementation, this might read from an agent manifest.
    // For now we mock the built-in subagents similar to how the frontend does it, 
    // but reading the settings to determine their enabled state.
    let _settings = settings_get(state).await.unwrap_or(json!({}));
    
    // We expect settings.subAgentModels to dictate models, and subAgentEnabled to dictate status
    let agents = vec![
        json!({
            "type": "terminal",
            "name": "Terminal Expert",
            "description": "Terminal and shell execution specialist",
            "enabled": true
        }),
        json!({
            "type": "browser",
            "name": "Browser Expert",
            "description": "Web automation and scraping specialist",
            "enabled": true
        }),
        json!({
            "type": "analyst",
            "name": "Analyst",
            "description": "Data analysis and code review specialist",
            "enabled": true
        }),
        json!({
            "type": "planner",
            "name": "Planner",
            "description": "Task breakdown and planning specialist",
            "enabled": true
        })
    ];
    
    Ok(agents)
}

#[command]
pub async fn subagent_toggle(_state: State<'_, AppState>, _subagent_type: String, _enabled: bool) -> Result<(), String> {
    // For now, this is a placeholder. SubAgent toggle state is usually saved in settings
    Ok(())
}

#[command]
pub async fn subagent_get_detail(_state: State<'_, AppState>, _subagent_type: String) -> Result<Value, String> {
    Ok(Value::Null)
}

#[command]
pub async fn subagent_set_model(_state: State<'_, AppState>, _subagent_type: String, _selections: Vec<Value>) -> Result<(), String> {
    // For now, this is a placeholder
    Ok(())
}
