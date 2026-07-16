use std::sync::Arc;
use tokio::sync::Mutex;
use futures::future::join_all;

use crate::agent::loop_impl::AgentLoop;
use crate::agent::state::AgentStatus;

pub struct ParallelOrchestrator {
    agents: Arc<Mutex<Vec<Arc<AgentLoop>>>>,
}

impl ParallelOrchestrator {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn add_agent(&self, agent: Arc<AgentLoop>) {
        let mut list = self.agents.lock().await;
        list.push(agent);
    }

    pub async fn run_wave(&self) -> Vec<Result<AgentStatus, String>> {
        let list = self.agents.lock().await;
        let futures: Vec<_> = list.iter().map(|agent| {
            let a = agent.clone();
            async move {
                a.run_step().await
            }
        }).collect();

        join_all(futures).await
    }

    pub async fn stop_all(&self) {
        let list = self.agents.lock().await;
        for agent in list.iter() {
            agent.stop().await;
        }
    }
}
