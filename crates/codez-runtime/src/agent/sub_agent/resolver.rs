use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentModelProfile {
    pub model_id: String,
    pub token_budget: usize,
    pub max_tokens: Option<usize>,
}

pub struct SubAgentModelResolver;

impl SubAgentModelResolver {
    pub fn resolve(role: &str) -> SubAgentModelProfile {
        match role {
            "coder" => SubAgentModelProfile {
                model_id: "claude-3-5-sonnet".to_string(),
                token_budget: 40_000,
                max_tokens: Some(4096),
            },
            "reviewer" => SubAgentModelProfile {
                model_id: "claude-3-5-sonnet-fast".to_string(),
                token_budget: 20_000,
                max_tokens: Some(2048),
            },
            _ => SubAgentModelProfile {
                model_id: "default-model".to_string(),
                token_budget: 30_000,
                max_tokens: None,
            },
        }
    }
}
