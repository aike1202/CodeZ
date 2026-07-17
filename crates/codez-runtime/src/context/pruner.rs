use std::collections::HashSet;

use codez_core::context::NormalizedModelMessage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::context::budget::{ContextBudgetError, ContextBudgetService};

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
    ) -> Result<ToolOutputPruneResult, ContextBudgetError> {
        let mut messages = source.to_vec();
        let tokens_before = estimate_total(&messages)?;
        let mut pruned_ids = HashSet::new();
        let mut records = Vec::new();
        let mut current_tokens = tokens_before;
        let max_single = options.max_single_tool_tokens.unwrap_or(u32::MAX);

        let mut oversized = candidates(&messages, options, &pruned_ids)
            .into_iter()
            .filter(|candidate| candidate.tokens > max_single)
            .collect::<Vec<_>>();
        oversized.sort_by_key(|candidate| (std::cmp::Reverse(candidate.tokens), candidate.index));
        for candidate in oversized {
            prune_candidate(
                &mut messages,
                candidate,
                &mut current_tokens,
                &mut pruned_ids,
                &mut records,
            )?;
        }

        let mut pressure = candidates(&messages, options, &pruned_ids)
            .into_iter()
            .filter(|candidate| candidate.index < options.protected_tail_start)
            .collect::<Vec<_>>();
        pressure.sort_by_key(|candidate| (std::cmp::Reverse(candidate.tokens), candidate.index));
        for candidate in pressure {
            if current_tokens <= options.target_tokens {
                break;
            }
            prune_candidate(
                &mut messages,
                candidate,
                &mut current_tokens,
                &mut pruned_ids,
                &mut records,
            )?;
        }

        Ok(ToolOutputPruneResult {
            messages,
            records,
            tokens_before,
            tokens_after: current_tokens,
        })
    }
}

#[derive(Clone, Copy)]
struct PruneCandidate {
    index: usize,
    tokens: u32,
}

fn candidates(
    messages: &[NormalizedModelMessage],
    options: &ToolOutputPruneOptions,
    pruned_ids: &HashSet<String>,
) -> Vec<PruneCandidate> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, message)| eligible(message, options, pruned_ids))
        .map(|(index, message)| PruneCandidate {
            index,
            tokens: ContextBudgetService::estimate_string_tokens(&message.content),
        })
        .collect()
}

fn eligible(
    message: &NormalizedModelMessage,
    options: &ToolOutputPruneOptions,
    pruned_ids: &HashSet<String>,
) -> bool {
    message.role == "tool"
        && message.status == "complete"
        && !matches!(
            message.name.as_deref(),
            Some("Skill" | "ActivateSkill" | "DeactivateSkill")
        )
        && options
            .protected_message_ids
            .as_ref()
            .is_none_or(|ids| !ids.contains(&message.id))
        && !is_error_result(&message.content)
        && !pruned_ids.contains(&message.id)
}

fn prune_candidate(
    messages: &mut [NormalizedModelMessage],
    candidate: PruneCandidate,
    current_tokens: &mut u32,
    pruned_ids: &mut HashSet<String>,
    records: &mut Vec<ToolOutputPruneRecord>,
) -> Result<(), ContextBudgetError> {
    let message = &mut messages[candidate.index];
    let before = ContextBudgetService::estimate_message_tokens(message)?;
    let original_chars = message.content.chars().count();
    let head_len = 160.min(original_chars.saturating_mul(3) / 5);
    let tail_len = 80.min(original_chars.saturating_sub(head_len));
    let head = message.content.chars().take(head_len).collect::<String>();
    let tail = message
        .content
        .chars()
        .skip(original_chars.saturating_sub(tail_len))
        .collect::<String>();
    let record = ToolOutputPruneRecord {
        message_id: message.id.clone(),
        tool_name: message
            .name
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        original_chars,
        original_tokens_estimate: candidate.tokens,
        sha256: format!("{:x}", Sha256::digest(message.content.as_bytes())),
    };
    message.content = serde_json::json!({
        "code": "TOOL_OUTPUT_PRUNED",
        "toolName": record.tool_name,
        "originalChars": record.original_chars,
        "originalTokensEstimate": record.original_tokens_estimate,
        "sha256": record.sha256,
        "head": head,
        "tail": tail
    })
    .to_string();
    if let Some(references) = &mut message.file_references {
        for reference in references {
            reference.content_included = false;
        }
    }
    let after = ContextBudgetService::estimate_message_tokens(message)?;
    *current_tokens = current_tokens.saturating_sub(before.saturating_sub(after));
    pruned_ids.insert(message.id.clone());
    records.push(record);
    Ok(())
}

fn estimate_total(messages: &[NormalizedModelMessage]) -> Result<u32, ContextBudgetError> {
    messages.iter().try_fold(0_u32, |total, message| {
        ContextBudgetService::estimate_message_tokens(message)
            .map(|tokens| total.saturating_add(tokens))
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use codez_core::context::NormalizedModelMessage;

    use super::{ToolOutputPruneOptions, ToolOutputPruner};

    fn tool_message(id: &str, content: &str) -> NormalizedModelMessage {
        NormalizedModelMessage {
            id: id.to_string(),
            client_message_id: None,
            turn_id: "turn-1".to_string(),
            role: "tool".to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: Some(format!("call-{id}")),
            name: Some("Read".to_string()),
            status: "complete".to_string(),
            created_at: "2026-07-17T00:00:00Z".to_string(),
            source_sequence: Some(1),
            attachments: None,
            file_references: None,
        }
    }

    #[test]
    fn pressure_prune_never_rewrites_the_protected_protocol_tail() {
        let history = vec![
            tool_message("old", &"a".repeat(8_000)),
            tool_message("tail", &"b".repeat(8_000)),
        ];

        let result = ToolOutputPruner::prune(
            &history,
            &ToolOutputPruneOptions {
                target_tokens: 1,
                protected_tail_start: 1,
                max_single_tool_tokens: None,
                protected_message_ids: None,
            },
        )
        .expect("fixed tool output must be measurable");

        assert_eq!(
            (
                result
                    .records
                    .as_slice()
                    .first()
                    .map(|record| record.message_id.as_str()),
                result.messages[1].content.as_str(),
            ),
            (Some("old"), history[1].content.as_str())
        );
    }

    #[test]
    fn emergency_prune_preserves_an_unconsumed_tool_result() {
        let history = vec![tool_message("active", &"x".repeat(8_000))];

        let result = ToolOutputPruner::prune(
            &history,
            &ToolOutputPruneOptions {
                target_tokens: u32::MAX,
                protected_tail_start: history.len(),
                max_single_tool_tokens: Some(10),
                protected_message_ids: Some(HashSet::from(["active".to_string()])),
            },
        )
        .expect("fixed tool output must be measurable");

        assert!(result.records.is_empty());
    }

    #[test]
    fn pruned_output_keeps_unicode_head_and_tail_on_character_boundaries() {
        let content = "你".repeat(1_000);
        let history = vec![tool_message("unicode", &content)];

        let result = ToolOutputPruner::prune(
            &history,
            &ToolOutputPruneOptions {
                target_tokens: u32::MAX,
                protected_tail_start: history.len(),
                max_single_tool_tokens: Some(1),
                protected_message_ids: None,
            },
        )
        .expect("Unicode tool output must be measurable");
        let payload: serde_json::Value =
            serde_json::from_str(&result.messages[0].content).expect("pruned output must be JSON");

        assert_eq!(
            (
                payload["head"]
                    .as_str()
                    .map(str::chars)
                    .map(Iterator::count),
                payload["tail"]
                    .as_str()
                    .map(str::chars)
                    .map(Iterator::count),
            ),
            (Some(160), Some(80))
        );
    }
}
