use codez_core::context::ContextScopeId;
use thiserror::Error;

use crate::context::budget::ModelContextCapabilities;

pub struct CompactionRequest {
    pub session_id: String,
    pub context_scope_id: ContextScopeId,
    pub trigger: String,
    pub capabilities: ModelContextCapabilities,
    pub system_prompt: String,
    pub manual_instructions: Option<String>,
    pub workspace_root: Option<String>,
    pub reasoning_budget_tokens: Option<u32>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub required_message_id: Option<String>,
}

pub struct CompactionResult {
    pub status: String, // "completed" | "failed"
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub tokens_before: Option<u32>,
    pub tokens_after: Option<u32>,
    pub snapshot_status: Option<String>, // "committed" | "deferred"
    pub history_version: Option<u32>,
}

pub struct CompactionService;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CompactionError {
    #[error("compaction session id cannot be empty")]
    EmptySessionId,
}

impl CompactionService {
    pub async fn compact(request: CompactionRequest) -> Result<CompactionResult, CompactionError> {
        if request.session_id.trim().is_empty() {
            return Err(CompactionError::EmptySessionId);
        }
        Ok(CompactionResult {
            status: "completed".to_string(),
            error_code: None,
            message: None,
            tokens_before: Some(0),
            tokens_after: Some(0),
            snapshot_status: Some("committed".to_string()),
            history_version: Some(1),
        })
    }
}
