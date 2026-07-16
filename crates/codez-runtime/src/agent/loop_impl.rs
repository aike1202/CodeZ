use std::sync::Arc;
use tokio::sync::RwLock;

use crate::agent::state::{AgentState, AgentStatus};

pub struct AgentLoop {
    state: Arc<RwLock<AgentState>>,
}

impl AgentLoop {
    pub fn new(session_id: String, task_id: String) -> Self {
        Self {
            state: Arc::new(RwLock::new(AgentState::new(session_id, task_id))),
        }
    }

    pub async fn run_step(&self) -> Result<AgentStatus, String> {
        let mut state = self.state.write().await;
        if state.status == AgentStatus::Completed || state.status == AgentStatus::Failed {
            return Ok(state.status.clone());
        }

        state.status = AgentStatus::Running;
        
        // Simulating the execution step: LLM call -> Tool call -> Result
        state.steps_completed += 1;
        
        // Stagnation protection / test check: limit total steps
        if state.steps_completed > 100 {
            state.status = AgentStatus::Failed;
            state.current_error = Some("Agent execution stagnated (step count exceeded 100)".to_string());
            return Err("Execution stagnated".to_string());
        }

        state.status = AgentStatus::Idle;
        Ok(state.status.clone())
    }

    pub async fn current_status(&self) -> AgentStatus {
        self.state.read().await.status.clone()
    }

    pub async fn stop(&self) {
        let mut state = self.state.write().await;
        if state.status == AgentStatus::Running {
            state.status = AgentStatus::Paused;
        }
    }
}
