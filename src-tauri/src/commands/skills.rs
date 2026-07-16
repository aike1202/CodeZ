use std::path::PathBuf;
use tauri::{command, State};
use serde_json::{json, Value};

use crate::state::AppState;
use codez_runtime::extension::skills::SkillLoader;

#[command]
pub async fn skill_get_all(state: State<'_, AppState>, root_path: Option<String>) -> Result<Vec<Value>, String> {
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut paths_to_check = vec![];
    
    // Workspace skills
    if let Some(root) = root_path {
        let ws_skills = PathBuf::from(&root).join(".agents").join("skills");
        paths_to_check.push((ws_skills, "workspace"));
    }
    
    // Global skills
    let global_skills = state.paths.data_directory().join("config").join("skills");
    paths_to_check.push((global_skills, "global"));

    for (dir, scope) in paths_to_check {
        if dir.exists() && dir.is_dir() {
            if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let path = entry.path();
                    if path.is_dir() {
                        let id = entry.file_name().to_string_lossy().to_string();
                        if seen.contains(&id) {
                            continue;
                        }
                        seen.insert(id.clone());
                        
                        let md_path = path.join("SKILL.md");
                        if md_path.exists() {
                            let (name, description) = if let Ok(meta) = SkillLoader::load_skill(&path).await {
                                (meta.name, meta.description)
                            } else {
                                (id.clone(), "Invalid or missing SKILL.md".to_string())
                            };
                            
                            skills.push(json!({
                                "id": id,
                                "name": name,
                                "description": description,
                                "scope": scope,
                                "dirPath": path.to_string_lossy(),
                                "enabled": true
                            }));
                        }
                    }
                }
            }
        }
    }

    Ok(skills)
}

#[command]
pub async fn skill_toggle(_state: State<'_, AppState>, _root_path: Option<String>, _id: String, _enabled: bool) -> Result<(), String> {
    // Basic placeholder for skill_toggle. Currently frontend relies on rules and this API simply returns ok.
    Ok(())
}

#[command]
pub async fn skill_check_external(_state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!({ "hasUpdates": false, "totalCount": 0, "sources": [] }))
}

#[command]
pub async fn skill_import_external(_state: State<'_, AppState>) -> Result<bool, String> {
    Ok(true)
}

#[command]
pub async fn skill_list_external(_state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    Ok(vec![])
}

#[command]
pub async fn skill_import_single(_state: State<'_, AppState>, _source_name: String, _dir_name: String) -> Result<bool, String> {
    Ok(true)
}

#[command]
pub async fn skill_remove(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let global_skill_path = state.paths.data_directory().join("config").join("skills").join(&id);
    if global_skill_path.exists() {
        tokio::fs::remove_dir_all(&global_skill_path).await.map_err(|e| e.to_string())?;
    }
    Ok(true)
}
