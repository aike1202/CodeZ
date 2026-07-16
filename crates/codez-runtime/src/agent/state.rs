use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Idle,
    Running,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub status: AgentStatus,
    pub session_id: String,
    pub task_id: String,
    pub steps_completed: usize,
    pub current_error: Option<String>,
}

impl AgentState {
    pub fn new(session_id: String, task_id: String) -> Self {
        Self {
            status: AgentStatus::Idle,
            session_id,
            task_id,
            steps_completed: 0,
            current_error: None,
        }
    }
}
