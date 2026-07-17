use std::{collections::HashSet, sync::Arc};

use serde_json::Value;

use crate::tools::{
    exposure::ToolExposureState,
    registry::{
        BoxFuture, DefaultToolDescriptor, ToolAvailability, ToolBehavior, ToolContext,
        ToolDescriptor, ToolHandler,
    },
    types::{
        DeferredToolSummary, ModelPreference, ToolApprovalMetadata, ToolConcurrency, ToolEffect,
        ToolEffectPlan, ToolExecutionResult, ToolExposure, ToolInterruptBehavior,
        ToolPlanningContext, ToolSource,
    },
};

const DEFAULT_MAX_RESULTS: usize = 5;

/// Searches only the deferred tools already admitted by the current immutable exposure plan.
pub struct ToolSearchTool {
    descriptor: DefaultToolDescriptor,
    exposure_state: Arc<ToolExposureState>,
}

impl ToolSearchTool {
    #[must_use]
    pub fn new(exposure_state: Arc<ToolExposureState>) -> Self {
        Self {
            descriptor: DefaultToolDescriptor {
                name: "ToolSearch",
                version: "1.0.0",
                source: ToolSource::Builtin,
                source_id: "builtin:tool-search".to_string(),
                summary: "Find and activate deferred tools.".to_string(),
                description: "Find tools whose schemas are deferred. Use select:<tool_name> for direct selection or capability keywords. Matching tools become available on the next model turn.".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "query": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Tool name or capability query. Use select:<tool_name> for direct selection."
                        },
                        "max_results": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 20,
                            "default": DEFAULT_MAX_RESULTS
                        }
                    },
                    "required": ["query"]
                }),
                approval: ToolApprovalMetadata {
                    model_preference: ModelPreference::NotApplicable,
                },
                availability: ToolAvailability {
                    roles: None,
                    platforms: None,
                    exposure: ToolExposure::Always,
                },
                behavior: ToolBehavior {
                    concurrency: ToolConcurrency::Safe,
                    interrupt: ToolInterruptBehavior::Cancel,
                    max_result_chars: 32 * 1024,
                    timeout_ms: Some(5_000),
                },
            },
            exposure_state,
        }
    }
}

impl ToolHandler for ToolSearchTool {
    fn descriptor(&self) -> &dyn ToolDescriptor {
        &self.descriptor
    }

    fn plan_effects<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, ToolEffectPlan> {
        Box::pin(async move {
            ToolEffectPlan {
                effects: vec![ToolEffect::Internal {
                    target: exposure_resource(context.session_id.as_deref(), "pending"),
                }],
                analysis_status: "parsed".to_string(),
            }
        })
    }

    fn resource_keys<'a>(
        &'a self,
        _input: &'a Value,
        context: &'a ToolPlanningContext,
    ) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move { vec![exposure_resource(context.session_id.as_deref(), "pending")] })
    }

    fn execute<'a>(
        &'a self,
        input: &'a Value,
        context: &'a ToolContext,
    ) -> BoxFuture<'a, ToolExecutionResult> {
        Box::pin(async move {
            if context.cancellation.is_cancelled() {
                return ToolExecutionResult::Cancelled {
                    error: tool_error("TOOL_CANCELLED", "Tool search was cancelled."),
                    model_content: None,
                    ui_content: None,
                    effects: None,
                };
            }
            let Some(query) = input.get("query").and_then(Value::as_str) else {
                return invalid_input("query is required");
            };
            let query = query.trim();
            if query.is_empty() {
                return invalid_input("query cannot be empty");
            }
            let max_results = input
                .get("max_results")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(DEFAULT_MAX_RESULTS)
                .clamp(1, 20);
            let matches = search_deferred(&context.deferred_tools, query, max_results);
            let activated = matches
                .iter()
                .map(|tool| tool.name.clone())
                .collect::<Vec<_>>();
            let Some(session_id) = context.session_id.as_deref() else {
                return ToolExecutionResult::Error {
                    error: tool_error(
                        "TOOL_SESSION_REQUIRED",
                        "Tool search requires an active session.",
                    ),
                    model_content: None,
                    ui_content: None,
                    effects: None,
                };
            };
            let scope_key = format!("{session_id}:{}", context.context_scope_id);
            self.exposure_state.activate(&scope_key, &activated);
            let data = serde_json::json!({
                "activated": activated,
                "availableNextTurn": true,
                "totalDeferredTools": context.deferred_tools.len(),
                "summaries": matches,
            });
            ToolExecutionResult::Success {
                model_content: data.to_string(),
                data: Some(data),
                ui_content: None,
                effects: Some(vec![ToolEffect::Internal {
                    target: exposure_resource(Some(session_id), &context.context_scope_id),
                }]),
            }
        })
    }
}

fn search_deferred(
    tools: &[DeferredToolSummary],
    query: &str,
    max_results: usize,
) -> Vec<DeferredToolSummary> {
    let normalized = query.trim().to_ascii_lowercase();
    if let Some(selected) = normalized.strip_prefix("select:") {
        let mut seen = HashSet::new();
        return selected
            .split(',')
            .filter_map(|name| find_exact(tools, name.trim()))
            .filter(|tool| seen.insert(tool.name.clone()))
            .take(max_results)
            .cloned()
            .collect();
    }
    if let Some(exact) = find_exact(tools, &normalized) {
        return vec![exact.clone()];
    }
    if normalized.starts_with("mcp__") {
        let prefix_matches = tools
            .iter()
            .filter(|tool| tool.name.to_ascii_lowercase().starts_with(&normalized))
            .take(max_results)
            .cloned()
            .collect::<Vec<_>>();
        if !prefix_matches.is_empty() {
            return prefix_matches;
        }
    }

    let mut required = Vec::new();
    let mut optional = Vec::new();
    for term in normalized.split_whitespace() {
        if let Some(term) = term.strip_prefix('+').filter(|term| !term.is_empty()) {
            required.push(term);
        } else {
            optional.push(term);
        }
    }
    let terms = if required.is_empty() {
        optional
    } else {
        required.iter().copied().chain(optional).collect()
    };
    let mut scored = tools
        .iter()
        .filter_map(|tool| {
            let name_parts = searchable_name(&tool.name);
            let name_text = name_parts.join(" ");
            let summary = format!(
                "{} {}",
                tool.summary,
                tool.search_hint.as_deref().unwrap_or_default()
            )
            .to_ascii_lowercase();
            if required
                .iter()
                .any(|term| !name_text.contains(term) && !summary.contains(term))
            {
                return None;
            }
            let score = terms.iter().fold(0_u32, |score, term| {
                let exact_part = name_parts.iter().any(|part| part == term);
                let partial_part = name_parts.iter().any(|part| part.contains(term));
                score
                    + if exact_part {
                        if tool.name.starts_with("mcp__") {
                            12
                        } else {
                            10
                        }
                    } else if partial_part {
                        5
                    } else {
                        0
                    }
                    + if summary.contains(term) { 3 } else { 0 }
            });
            (score > 0).then_some((score, tool))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.name.cmp(&right.name))
    });
    scored
        .into_iter()
        .take(max_results)
        .map(|(_, tool)| tool.clone())
        .collect()
}

fn searchable_name(name: &str) -> Vec<String> {
    let name = name.strip_prefix("mcp__").unwrap_or(name);
    let mut words = String::with_capacity(name.len());
    let mut previous_lowercase = false;
    for character in name.chars() {
        if matches!(character, '_' | '-') {
            words.push(' ');
            previous_lowercase = false;
        } else {
            if previous_lowercase && character.is_ascii_uppercase() {
                words.push(' ');
            }
            words.push(character.to_ascii_lowercase());
            previous_lowercase = character.is_ascii_lowercase();
        }
    }
    words.split_whitespace().map(str::to_string).collect()
}

fn find_exact<'a>(tools: &'a [DeferredToolSummary], name: &str) -> Option<&'a DeferredToolSummary> {
    let normalized = name.trim();
    tools
        .iter()
        .find(|tool| tool.name.eq_ignore_ascii_case(normalized))
}

fn invalid_input(message: &str) -> ToolExecutionResult {
    ToolExecutionResult::Error {
        error: tool_error("TOOL_INPUT_INVALID", message),
        model_content: None,
        ui_content: None,
        effects: None,
    }
}

fn tool_error(code: &str, message: &str) -> crate::tools::types::ToolExecutionError {
    crate::tools::types::ToolExecutionError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable: false,
        suggestion: None,
        retry_after_ms: None,
        details: None,
    }
}

fn exposure_resource(session_id: Option<&str>, context_scope_id: &str) -> String {
    format!(
        "tool-exposure:{}:{context_scope_id}",
        session_id.unwrap_or("unknown")
    )
}

#[cfg(test)]
mod tests {
    use codez_core::CancellationToken;

    use super::*;

    fn deferred() -> Vec<DeferredToolSummary> {
        vec![
            DeferredToolSummary {
                name: "WebFetch".to_string(),
                summary: "Fetch web page content".to_string(),
                search_hint: Some("http documentation".to_string()),
            },
            DeferredToolSummary {
                name: "WebSearch".to_string(),
                summary: "Search current web results".to_string(),
                search_hint: Some("internet query".to_string()),
            },
            DeferredToolSummary {
                name: "mcp__docs__lookup".to_string(),
                summary: "Look up product documentation".to_string(),
                search_hint: None,
            },
        ]
    }

    fn context(tools: Vec<DeferredToolSummary>) -> ToolContext {
        ToolContext {
            execution_id: "execution-1".to_string(),
            session_id: Some("session-1".to_string()),
            context_scope_id: "main".to_string(),
            transaction_id: None,
            workspace_root: std::env::temp_dir(),
            cancellation: CancellationToken::new(),
            authorized_effects: ToolEffectPlan {
                effects: Vec::new(),
                analysis_status: "parsed".to_string(),
            },
            file_services: None,
            deferred_tools: tools,
        }
    }

    #[test]
    fn exact_name_returns_only_the_exact_tool() {
        let matches = search_deferred(&deferred(), "webfetch", 5);
        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn required_keyword_filters_non_matching_tools() {
        let matches = search_deferred(&deferred(), "+documentation product", 5);
        assert_eq!(matches[0].name, "mcp__docs__lookup");
    }

    #[test]
    fn mcp_prefix_is_deterministic() {
        let matches = search_deferred(&deferred(), "mcp__docs", 5);
        assert_eq!(matches[0].name, "mcp__docs__lookup");
    }

    #[tokio::test]
    async fn execution_activates_only_current_plan_matches_for_next_turn() {
        let state = Arc::new(ToolExposureState::new());
        let tool = ToolSearchTool::new(Arc::clone(&state));
        let result = tool
            .execute(
                &serde_json::json!({"query": "select:WebFetch,HiddenWrite"}),
                &context(deferred()),
            )
            .await;

        assert!(matches!(result, ToolExecutionResult::Success { .. }));
        assert_eq!(
            state.get("session-1:main"),
            HashSet::from(["WebFetch".to_string()])
        );
    }
}
