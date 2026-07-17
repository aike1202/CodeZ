use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolSource {
    Builtin,
    Skill,
    Mcp,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolExposure {
    Always,
    Core,
    Deferred,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolConcurrency {
    Safe,
    ResourceLocked,
    Exclusive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolInterruptBehavior {
    Cancel,
    Block,
    Detach,
}

pub type AgentRole = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelPreference {
    NotApplicable,
    Required,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalMetadata {
    pub model_preference: ModelPreference,
}

#[derive(Debug, Clone)]
pub struct ToolAvailabilityContext {
    pub platform: String,
    pub agent_role: AgentRole,
    pub workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ToolEffect {
    ReadFile {
        path: String,
        scope: String,
    }, // workspace | external
    WriteFile {
        path: String,
        mode: String,
    }, // create | modify | overwrite
    DeleteFile {
        path: String,
    },
    ExecuteCommand {
        shell: String,
        command: String,
    }, // bash | powershell
    Network {
        target: Option<String>,
        method: Option<String>,
    },
    ExternalEffect {
        target: String,
    },
    NotifyUser {
        channel: String,
    }, // desktop | remote
    SpawnAgent {
        role: String,
        isolation: Option<String>,
        #[serde(default)]
        read_only: bool,
    },
    ControlExecution {
        execution_id: String,
        action: String,
    },
    MutateTaskState {
        session_id: Option<String>,
    },
    ReadMemory {
        path: String,
    },
    Internal {
        target: String,
    },
    UserInteraction {
        channel: String,
    }, // ask-user
    Rollback {
        target: String,
    },
    Unknown {
        target: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEffectPlan {
    pub effects: Vec<ToolEffect>,
    pub analysis_status: String, // parsed | partial | unparsed
}

#[derive(Debug, Clone)]
pub struct ToolPlanningContext {
    pub workspace_root: PathBuf,
    pub session_id: Option<String>,
    pub agent_role: AgentRole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
    pub suggestion: Option<String>,
    pub retry_after_ms: Option<u32>,
    pub details: Option<Value>,
}

// Using a type alias with generic for structured return type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ToolExecutionResult<T = Value> {
    Success {
        data: Option<T>,
        model_content: String,
        ui_content: Option<String>,
        // file_references: Option<Vec<FileContextReference>>, // TODO: import Context types
        effects: Option<Vec<ToolEffect>>,
    },
    Error {
        error: ToolExecutionError,
        model_content: Option<String>,
        ui_content: Option<String>,
        effects: Option<Vec<ToolEffect>>,
    },
    Denied {
        error: ToolExecutionError,
        model_content: Option<String>,
        ui_content: Option<String>,
        effects: Option<Vec<ToolEffect>>,
    },
    Cancelled {
        error: ToolExecutionError,
        model_content: Option<String>,
        ui_content: Option<String>,
        effects: Option<Vec<ToolEffect>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeferredToolSummary {
    pub name: String,
    pub summary: String,
    pub search_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedToolCall {
    pub call_id: String,
    pub position: usize,
    pub name: String,
    pub raw_arguments: String,
    pub thought_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallFragment {
    pub position: usize,
    pub call_id: Option<String>,
    pub name_delta: Option<String>,
    pub arguments_delta: Option<String>,
    pub complete_arguments: Option<serde_json::Value>,
    pub thought_signature: Option<String>,
    pub is_final: Option<bool>,
}

#[derive(Clone)]
pub struct PreparedToolCall {
    pub call: NormalizedToolCall,
    pub canonical_name: String,
    pub handler: std::sync::Arc<dyn crate::tools::registry::ToolHandler>,
    pub input: serde_json::Value,
    pub effects: ToolEffectPlan,
    pub resource_keys: Vec<String>,
}

impl std::fmt::Debug for PreparedToolCall {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedToolCall")
            .field("call", &self.call)
            .field("canonical_name", &self.canonical_name)
            .field("input", &self.input)
            .field("effects", &self.effects)
            .field("resource_keys", &self.resource_keys)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct ToolExecutionWave {
    pub index: usize,
    pub calls: Vec<PreparedToolCall>,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct ToolPipelineResult {
    pub call: NormalizedToolCall,
    pub canonical_name: String,
    pub result: ToolExecutionResult,
    pub max_result_chars: Option<usize>,
}
