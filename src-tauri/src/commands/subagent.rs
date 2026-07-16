use codez_contracts::CommandError;
use codez_core::AppError;
use serde_json::{Map, Value, json};
use tauri::{State, command};

use crate::commands::settings::{settings_get, settings_save};
use crate::state::AppState;

fn object_setting<'a>(
    settings: &'a mut Value,
    key: &'static str,
) -> Result<&'a mut Map<String, Value>, AppError> {
    let root = settings.as_object_mut().ok_or_else(|| {
        AppError::storage(
            "Settings data is invalid",
            "settings document root is not an object",
            false,
        )
    })?;
    root.entry(key)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            AppError::storage(
                "Settings data is invalid",
                format!("settings field `{key}` is not an object"),
                false,
            )
        })
}

#[command]
pub async fn subagent_list(state: State<'_, AppState>) -> Result<Vec<Value>, CommandError> {
    let settings = settings_get(state.clone()).await?;
    let enabled_map = settings
        .get("subAgentEnabled")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let is_enabled = |key: &str| -> bool {
        enabled_map
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };

    let agents = codez_runtime::agent::registry::get_builtin_subagents()
        .into_iter()
        .map(|agent| {
            json!({
                "type": agent.r#type,
                "name": agent.name,
                "description": agent.description,
                "enabled": is_enabled(&agent.r#type)
            })
        })
        .collect();

    Ok(agents)
}

#[command]
pub async fn subagent_toggle(
    state: State<'_, AppState>,
    subagent_type: String,
    enabled: bool,
) -> Result<(), CommandError> {
    let mut settings = settings_get(state.clone()).await?;
    let enabled_map = object_setting(&mut settings, "subAgentEnabled")
        .map_err(|error| state.errors.report(error))?;
    enabled_map.insert(subagent_type, json!(enabled));

    settings_save(state, settings).await.map(|_| ())
}

#[command]
pub async fn subagent_get_detail(
    state: State<'_, AppState>,
    subagent_type: String,
) -> Result<Value, CommandError> {
    let settings = settings_get(state).await?;
    let selections = settings
        .get("subAgentModels")
        .and_then(Value::as_object)
        .and_then(|models| models.get(&subagent_type))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(json!({
        "type": subagent_type,
        "selections": selections
    }))
}

#[command]
pub async fn subagent_set_model(
    state: State<'_, AppState>,
    subagent_type: String,
    selections: Vec<Value>,
) -> Result<(), CommandError> {
    let mut settings = settings_get(state.clone()).await?;
    let model_map = object_setting(&mut settings, "subAgentModels")
        .map_err(|error| state.errors.report(error))?;
    model_map.insert(subagent_type, json!(selections));

    settings_save(state, settings).await.map(|_| ())
}
