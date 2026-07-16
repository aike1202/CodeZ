use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::agent::state::AgentState;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPlan {
    pub task_id: String,
    pub title: String,
    pub description: String,
    pub steps: Vec<String>,
}

pub struct AgentPersistence {
    storage_root: PathBuf,
}

impl AgentPersistence {
    pub fn new(storage_root: PathBuf) -> Self {
        Self { storage_root }
    }

    pub async fn save_state(&self, state: &AgentState) -> Result<(), String> {
        let path = self.storage_root.join(format!("agent_state_{}.json", state.session_id));
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }

        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        fs::write(path, json).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn load_state(&self, session_id: &str) -> Result<AgentState, String> {
        let path = self.storage_root.join(format!("agent_state_{}.json", session_id));
        let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;
        let state: AgentState = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(state)
    }

    pub async fn save_plan(&self, plan: &TaskPlan) -> Result<(), String> {
        let path = self.storage_root.join(format!("task_plan_{}.json", plan.task_id));
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }

        let json = serde_json::to_string_pretty(plan).map_err(|e| e.to_string())?;
        fs::write(path, json).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn load_plan(&self, task_id: &str) -> Result<TaskPlan, String> {
        let path = self.storage_root.join(format!("task_plan_{}.json", task_id));
        let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;
        let plan: TaskPlan = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(plan)
    }
}
