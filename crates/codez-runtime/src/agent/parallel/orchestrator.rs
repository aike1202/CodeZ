use std::sync::Arc;

use futures::future::join_all;
use tokio::sync::Mutex;

use crate::agent::loop_impl::{AgentLoop, AgentLoopError};
use crate::agent::state::AgentStatus;

#[derive(Default)]
pub struct ParallelOrchestrator {
    agents: Arc<Mutex<Vec<Arc<AgentLoop>>>>,
}

impl ParallelOrchestrator {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn add_agent(&self, agent: Arc<AgentLoop>) {
        let mut list = self.agents.lock().await;
        list.push(agent);
    }

    pub async fn run_wave(&self) -> Vec<Result<AgentStatus, AgentLoopError>> {
        let agents = self.agents.lock().await.clone();
        let futures: Vec<_> = agents
            .into_iter()
            .map(|agent| async move { agent.run_step().await })
            .collect();

        join_all(futures).await
    }

    pub async fn stop_all(&self) {
        let agents = self.agents.lock().await.clone();
        for agent in agents {
            let _stopped = agent.stop().await;
        }
    }
}
