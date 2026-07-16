use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One ordered Provider/model candidate configured for a built-in sub-agent.
///
/// The desktop host validates both identifiers against its current Provider
/// registry before persisting a selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct SubAgentModelSelection {
    pub provider_id: String,
    pub model: String,
}

/// Input for one bounded, tool-free built-in sub-agent run.
///
/// The desktop host validates identifiers, persisted enablement, configured
/// model candidates, and task size before the run is admitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct SubAgentRunRequest {
    #[serde(rename = "subagentType")]
    #[ts(rename = "subagentType")]
    pub subagent_type: String,
    pub session_id: String,
    pub task: String,
}

/// Public lifecycle state for an individual delegated run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum SubAgentRunStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

/// Redacted, durable state for one built-in sub-agent run.
///
/// The host persists this only after the run becomes terminal. It deliberately
/// excludes the task prompt, credentials, and private Provider diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct SubAgentRunState {
    pub run_id: String,
    #[serde(rename = "subagentType")]
    #[ts(rename = "subagentType")]
    pub subagent_type: String,
    pub session_id: String,
    pub provider_id: String,
    pub model: String,
    pub status: SubAgentRunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Result of requesting cancellation for one sub-agent run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SubAgentRunCancelResult {
    pub accepted: bool,
    pub state: SubAgentRunState,
}

/// Stable settings-facing information for one built-in sub-agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct SubAgentInfo {
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub kind: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_hint: Option<String>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured_models: Option<Vec<SubAgentModelSelection>>,
}

/// One field in a statically declared sub-agent output contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SubAgentOutputField {
    pub name: String,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub kind: String,
    pub description: String,
    pub required: bool,
}

/// A statically declared sub-agent structured-output contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SubAgentOutputSpec {
    pub description: String,
    pub fields: Vec<SubAgentOutputField>,
}

/// Detail fields that the current Rust runtime deliberately does not expose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum SubAgentUnavailableDetail {
    /// Prompts are assembled by a future execution runtime and are not static settings data.
    SystemPrompt,
    /// The current typed core does not own a definitive per-agent tool catalog.
    ToolCatalog,
}

/// Settings detail derived from Rust's static built-in sub-agent registry.
///
/// This intentionally excludes dynamic prompts and tool lists. Those values
/// are not owned by the typed Rust sub-agent core yet and must not be invented
/// at the desktop boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", optional_fields)]
pub struct SubAgentSettingsDetail {
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub kind: String,
    pub description: String,
    pub when_to_use: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_not_to_use: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_hint: Option<String>,
    #[ts(type = "number")]
    pub max_loops: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_run_in_background: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_spec: Option<SubAgentOutputSpec>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured_models: Option<Vec<SubAgentModelSelection>>,
}

/// Honest result of requesting one sub-agent's settings detail.
///
/// A `partial` result carries every static field the Rust registry owns and
/// names the dynamic fields that remain unsupported. This prevents the UI from
/// mistaking placeholders for executable runtime capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(tag = "kind", rename_all = "camelCase")]
pub enum SubAgentDetailResult {
    /// All requested fields are available from the typed Rust implementation.
    Available { detail: SubAgentSettingsDetail },
    /// Static settings detail is available, but named dynamic fields are not.
    Partial {
        detail: SubAgentSettingsDetail,
        unavailable: Vec<SubAgentUnavailableDetail>,
    },
    /// No built-in sub-agent has the requested type.
    NotFound {
        #[serde(rename = "subagentType")]
        #[ts(rename = "subagentType")]
        subagent_type: String,
    },
}

#[cfg(test)]
mod tests {
    use super::{
        SubAgentDetailResult, SubAgentModelSelection, SubAgentSettingsDetail,
        SubAgentUnavailableDetail,
    };

    #[test]
    fn partial_detail_serializes_its_unavailable_dynamic_capabilities() {
        let detail = SubAgentSettingsDetail {
            kind: "Explore".to_string(),
            description: "Read-only exploration".to_string(),
            when_to_use: "Inspect a codebase".to_string(),
            when_not_to_use: None,
            cost_hint: None,
            max_loops: 8,
            can_run_in_background: None,
            isolation: None,
            output_spec: None,
            enabled: true,
            configured_models: Some(vec![SubAgentModelSelection {
                provider_id: "provider-1".to_string(),
                model: "model-1".to_string(),
            }]),
        };
        let value = serde_json::to_value(SubAgentDetailResult::Partial {
            detail,
            unavailable: vec![
                SubAgentUnavailableDetail::SystemPrompt,
                SubAgentUnavailableDetail::ToolCatalog,
            ],
        })
        .expect("fixed detail fixture must serialize");

        assert_eq!(value["kind"], "partial");
        assert_eq!(
            value["unavailable"],
            serde_json::json!(["systemPrompt", "toolCatalog"])
        );
    }

    #[test]
    fn command_model_selection_should_reject_unknown_fields() {
        let error = serde_json::from_str::<SubAgentModelSelection>(
            r#"{"providerId":"provider-1","model":"model-1","extra":"reject"}"#,
        )
        .expect_err("command payload extensions must be rejected");

        assert!(error.to_string().contains("extra"));
    }
}
