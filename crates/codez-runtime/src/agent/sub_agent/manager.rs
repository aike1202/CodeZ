use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::agent::state::AgentStatus;
use crate::agent::sub_agent::mailbox::SubAgentMailbox;

pub struct SubAgentEntry {
    pub name: String,
    pub role: String,
    pub status: AgentStatus,
    pub mailbox: SubAgentMailbox,
}

pub struct SubAgentManager {
    sub_agents: Arc<RwLock<HashMap<String, SubAgentEntry>>>,
}

impl SubAgentManager {
    pub fn new() -> Self {
        Self {
            sub_agents: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn spawn_sub_agent(&self, name: String, role: String) -> Result<(), String> {
        let mut map = self.sub_agents.write().await;
        if map.contains_key(&name) {
            return Err(format!("Sub-agent with name '{}' already exists", name));
        }

        map.insert(name.clone(), SubAgentEntry {
            name,
            role,
            status: AgentStatus::Idle,
            mailbox: SubAgentMailbox::new(),
        });

        Ok(())
    }

    pub async fn update_status(&self, name: &str, status: AgentStatus) -> Result<(), String> {
        let mut map = self.sub_agents.write().await;
        if let Some(entry) = map.get_mut(name) {
            entry.status = status;
            Ok(())
        } else {
            Err(format!("Sub-agent '{}' not found", name))
        }
    }

    pub async fn get_mailbox(&self, name: &str) -> Option<SubAgentMailbox> {
        let map = self.sub_agents.read().await;
        map.get(name).map(|e| e.mailbox.clone())
    }

    pub async fn list_sub_agents(&self) -> Vec<(String, String, AgentStatus)> {
        let map = self.sub_agents.read().await;
        map.values().map(|e| (e.name.clone(), e.role.clone(), e.status.clone())).collect()
    }
}
