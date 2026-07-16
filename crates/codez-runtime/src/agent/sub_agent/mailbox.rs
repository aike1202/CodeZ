use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentMessage {
    pub sender: String,
    pub recipient: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Clone, Default)]
pub struct SubAgentMailbox {
    queue: Arc<Mutex<VecDeque<SubAgentMessage>>>,
}

impl SubAgentMailbox {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn send(&self, msg: SubAgentMessage) {
        let mut q = self.queue.lock().await;
        q.push_back(msg);
    }

    pub async fn receive(&self) -> Option<SubAgentMessage> {
        let mut q = self.queue.lock().await;
        q.pop_front()
    }

    pub async fn clear(&self) {
        let mut q = self.queue.lock().await;
        q.clear();
    }
}
