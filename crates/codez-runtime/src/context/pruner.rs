use crate::context::budget::ContextBudgetService;
use codez_core::context::NormalizedModelMessage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub struct ToolOutputPruneOptions {
    pub target_tokens: u32,
    pub protected_tail_start: usize,
    pub max_single_tool_tokens: Option<u32>,
    pub protected_message_ids: Option<HashSet<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutputPruneRecord {
    pub message_id: String,
    pub tool_name: String,
    pub original_chars: usize,
    pub original_tokens_estimate: u32,
    pub sha256: String,
}

pub struct ToolOutputPruneResult {
    pub messages: Vec<NormalizedModelMessage>,
    pub records: Vec<ToolOutputPruneRecord>,
    pub tokens_before: u32,
    pub tokens_after: u32,
}

fn is_error_result(content: &str) -> bool {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(ok) = parsed.get("ok").and_then(|v| v.as_bool()) {
            if !ok {
                return true;
            }
        }
        if parsed.get("error").is_some() && parsed.get("ok").and_then(|v| v.as_bool()) != Some(true)
        {
            return true;
        }
    }

    let content_lower = content.to_lowercase();
    content_lower.contains("error")
        || content_lower.contains("fatal")
        || content_lower.contains("failed")
        || content_lower.contains("access denied")
}

pub struct ToolOutputPruner;

impl ToolOutputPruner {
    pub fn prune(
        source: &[NormalizedModelMessage],
        options: &ToolOutputPruneOptions,
    ) -> ToolOutputPruneResult {
        let mut messages = source.to_vec();

        let estimate_total = |msgs: &[NormalizedModelMessage]| -> u32 {
            msgs.iter()
                .map(|m| ContextBudgetService::estimate_string_tokens(&m.content)) // simplified
                .sum()
        };

        let tokens_before = estimate_total(&messages);
        let mut pruned_ids = HashSet::new();
        let mut records = Vec::new();
        let mut current_tokens = tokens_before;

        let protected_tools: HashSet<&str> = ["Skill", "ActivateSkill", "DeactivateSkill"]
            .iter()
            .cloned()
            .collect();

        // Pass 1: Prune tools over single limit
        let max_single = options.max_single_tool_tokens.unwrap_or(u32::MAX);

        for (i, msg) in messages.clone().iter().enumerate() {
            if current_tokens <= options.target_tokens && msg.role != "tool" {
                continue;
            }

            if msg.role == "tool" && msg.status == "complete" {
                let tool_name = msg.name.as_deref().unwrap_or("");
                if protected_tools.contains(tool_name) {
                    continue;
                }

                if let Some(protected_ids) = &options.protected_message_ids {
                    if protected_ids.contains(&msg.id) {
                        continue;
                    }
                }

                if is_error_result(&msg.content) {
                    continue;
                }
                if pruned_ids.contains(&msg.id) {
                    continue;
                }

                let tokens = ContextBudgetService::estimate_string_tokens(&msg.content);

                // Only prune if we are over target or single tool is over max single limit
                if current_tokens > options.target_tokens || tokens > max_single {
                    // PRUNE IT
                    let content = &msg.content;
                    let mut hasher = Sha256::new();
                    hasher.update(content.as_bytes());
                    let sha256 = format!("{:x}", hasher.finalize());

                    let record = ToolOutputPruneRecord {
                        message_id: msg.id.clone(),
                        tool_name: tool_name.to_string(),
                        original_chars: content.len(),
                        original_tokens_estimate: tokens,
                        sha256,
                    };

                    let head_len = 160.min((content.len() as f32 * 0.6) as usize);
                    let tail_len = 80.min(content.len().saturating_sub(head_len));

                    let head = content.chars().take(head_len).collect::<String>();
                    let tail = if tail_len > 0 {
                        let skip = content.chars().count().saturating_sub(tail_len);
                        content.chars().skip(skip).collect::<String>()
                    } else {
                        String::new()
                    };

                    let pruned_content = serde_json::json!({
                        "code": "TOOL_OUTPUT_PRUNED",
                        "toolName": record.tool_name,
                        "originalChars": record.original_chars,
                        "originalTokensEstimate": record.original_tokens_estimate,
                        "sha256": record.sha256,
                        "head": head,
                        "tail": tail
                    })
                    .to_string();

                    messages[i].content = pruned_content;
                    if let Some(refs) = &mut messages[i].file_references {
                        for r in refs.iter_mut() {
                            r.content_included = false;
                        }
                    }

                    let new_tokens =
                        ContextBudgetService::estimate_string_tokens(&messages[i].content);
                    current_tokens =
                        current_tokens.saturating_sub(tokens.saturating_sub(new_tokens));

                    pruned_ids.insert(msg.id.clone());
                    records.push(record);
                }
            }
        }

        let tokens_after = estimate_total(&messages);

        ToolOutputPruneResult {
            messages,
            records,
            tokens_before,
            tokens_after,
        }
    }
}
