use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub const PERMISSION_CLASSIFIER_SYSTEM_PROMPT: &str = "Classify one already-parsed tool operation. Return JSON only. Allow only high-confidence local reads or local build/test work explicitly supported by the current user intent. Block network access, publishing, deployment, remote mutation, deletion, privilege changes, credential access, dynamic execution, and anything uncertain.";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PermissionAiContext {
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub user_intent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProjectInstruction {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiCommandCategory {
    LocalRead,
    LocalBuild,
    LocalEdit,
    LocalMutation,
    LocalDelete,
    Network,
    Publish,
    Deploy,
    RemoteMutation,
    Privilege,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionClassificationRequest {
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub tool_name: String,
    pub shell: String,
    pub command: String,
    pub operation: String,
    pub workspace_root: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub agent_role: String,
    pub user_intent: Option<String>,
    pub project_markers: Vec<String>,
    pub project_instructions: Vec<PermissionProjectInstruction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "snake_case", deny_unknown_fields)]
pub enum PermissionClassifierVerdict {
    Allow {
        category: AiCommandCategory,
        #[serde(rename = "confidencePercent")]
        confidence_percent: u8,
        reason: String,
    },
    Block {
        reason: String,
    },
    Unavailable,
}

impl PermissionClassifierVerdict {
    #[must_use]
    pub fn can_auto_allow(&self) -> bool {
        matches!(
            self,
            Self::Allow {
                category: AiCommandCategory::LocalRead | AiCommandCategory::LocalBuild,
                confidence_percent: 90..=100,
                ..
            }
        )
    }

    #[must_use]
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Allow { reason, .. } | Self::Block { reason } => Some(reason),
            Self::Unavailable => None,
        }
    }
}

#[async_trait]
pub trait PermissionAiClassifier: Send + Sync {
    async fn classify(
        &self,
        request: &PermissionClassificationRequest,
    ) -> PermissionClassifierVerdict;
}

#[cfg(test)]
mod tests {
    use super::{AiCommandCategory, PermissionClassifierVerdict};

    #[test]
    fn only_high_confidence_local_read_or_build_can_auto_allow() {
        let local_build = PermissionClassifierVerdict::Allow {
            category: AiCommandCategory::LocalBuild,
            confidence_percent: 95,
            reason: "local project verification".to_string(),
        };
        let remote = PermissionClassifierVerdict::Allow {
            category: AiCommandCategory::RemoteMutation,
            confidence_percent: 100,
            reason: "remote mutation".to_string(),
        };
        assert!(local_build.can_auto_allow());
        assert!(!remote.can_auto_allow());
    }

    #[test]
    fn strict_json_response_deserializes_to_a_bounded_verdict() {
        let verdict = serde_json::from_str::<PermissionClassifierVerdict>(
            r#"{"verdict":"allow","category":"local_build","confidencePercent":94,"reason":"local verification"}"#,
        )
        .expect("valid classifier JSON must deserialize");
        assert!(verdict.can_auto_allow());
    }

    #[test]
    fn strict_json_response_rejects_unknown_fields() {
        let verdict = serde_json::from_str::<PermissionClassifierVerdict>(
            r#"{"verdict":"allow","category":"local_build","confidencePercent":94,"reason":"local verification","execute":true}"#,
        );
        assert!(verdict.is_err());
    }
}
