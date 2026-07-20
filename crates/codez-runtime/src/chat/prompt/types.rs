use chrono::{DateTime, Utc};
use codez_core::agent::{
    AgentBudget, AgentMessage, AgentPolicy, AgentProfile, AgentUsage, DelegatedTask,
    WorkspaceAssignment,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PromptLayer {
    Core = 0,
    Execution = 1,
    Context = 2,
    Dynamic = 3,
    Reminder = 4,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSkillSummary {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptToolSummary {
    pub name: String,
    pub summary: String,
}

#[derive(Debug, Clone)]
pub struct PromptAgentIdentity {
    pub root_run_id: String,
    pub agent_id: String,
    pub attempt_id: String,
    pub parent_agent_id: Option<String>,
    pub depth: u16,
}

#[derive(Debug, Clone)]
pub struct PromptAgentLimits {
    pub max_depth: u16,
    pub remaining_direct_children: u16,
    pub remaining_root_agents: u16,
    pub available_parallel_slots: u16,
}

#[derive(Debug, Clone)]
pub struct PromptAgentContext {
    pub identity: PromptAgentIdentity,
    pub task: DelegatedTask,
    pub profile: AgentProfile,
    pub effective_policy: AgentPolicy,
    pub workspace: WorkspaceAssignment,
    pub budget: AgentBudget,
    pub usage: AgentUsage,
    pub limits: PromptAgentLimits,
    pub mailbox_delta: Vec<AgentMessage>,
    pub finalization_required: bool,
}

#[derive(Debug, Clone)]
pub struct PromptContext {
    pub workspace_root: Option<PathBuf>,
    pub model_id: String,
    pub model_display_name: String,
    pub context_window_tokens: u32,
    pub session_id: Option<String>,
    pub api_format: Option<String>, // 'openai' | 'anthropic' | 'gemini'
    pub permission_mode: Option<String>, // 'auto' | 'full-access'
    pub thinking_enabled: Option<bool>,
    pub available_tools: Option<Vec<PromptToolSummary>>,
    pub deferred_tools: Option<Vec<PromptToolSummary>>,
    pub available_skills: Option<Vec<PromptSkillSummary>>,
    pub active_skills: Option<Vec<PromptSkillSummary>>,
    pub todo_state: Option<String>,
    pub global_rules: Option<String>,
    pub workspace_rules: Option<String>,
    pub directory_rules: Option<String>,
    pub git_status: Option<String>,
    pub now: Option<DateTime<Utc>>,
    pub agent: Option<PromptAgentContext>,
}

use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait PromptModule: Send + Sync {
    fn id(&self) -> &'static str;
    fn layer(&self) -> PromptLayer;
    fn priority(&self) -> i32;

    fn is_enabled<'a>(&'a self, _ctx: &'a PromptContext) -> BoxFuture<'a, bool> {
        Box::pin(async { true })
    }

    fn build<'a>(&'a self, ctx: &'a PromptContext) -> BoxFuture<'a, Option<String>>;
}
