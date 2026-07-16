use std::collections::{HashMap, HashSet};
use codez_contracts::context::NormalizedModelMessage;
use crate::context::budget::ContextBudgetService;

pub struct ModelHistoryNormalizer;

struct PendingCall {
    call_id: String,
    name: String,
    turn_id: String,
    created_at: String,
}

impl ModelHistoryNormalizer {
    pub fn normalize_recovered_history(messages: &[NormalizedModelMessage]) -> Vec<NormalizedModelMessage> {
        let mut result = Vec::new();
        let mut pending = HashMap::new();

        let mut flush_interrupted = |pending: &mut HashMap<String, PendingCall>, result: &mut Vec<NormalizedModelMessage>| {
            for call in pending.values() {
                let mut msg = NormalizedModelMessage {
                    id: format!("interrupted:{}", call.call_id),
                    client_message_id: None,
                    turn_id: call.turn_id.clone(),
                    role: "tool".to_string(),
                    content: r#"{"ok":false,"error":{"code":"EXECUTION_INTERRUPTED","message":"Tool execution was interrupted before a durable result was recorded."}}"#.to_string(),
                    tool_calls: None,
                    tool_call_id: Some(call.call_id.clone()),
                    name: Some(call.name.clone()),
                    status: "interrupted".to_string(),
                    created_at: call.created_at.clone(),
                    source_sequence: None,
                    file_references: None,
                };
                result.push(msg);
            }
            pending.clear();
        };

        for original in messages {
            let mut message = original.clone();
            
            if message.role != "tool" && !pending.is_empty() {
                flush_interrupted(&mut pending, &mut result);
            }
            
            result.push(message.clone());

            if message.role == "assistant" {
                if let Some(tool_calls) = &message.tool_calls {
                    for call in tool_calls {
                        pending.insert(call.id.clone(), PendingCall {
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            turn_id: message.turn_id.clone(),
                            created_at: message.created_at.clone(),
                        });
                    }
                }
            } else if message.role == "tool" {
                if let Some(tool_call_id) = &message.tool_call_id {
                    pending.remove(tool_call_id);
                }
            }
        }

        flush_interrupted(&mut pending, &mut result);
        result
    }

    pub fn assert_protocol_invariant(messages: &[NormalizedModelMessage]) -> Result<(), String> {
        let mut calls: HashMap<String, bool> = HashMap::new();
        let mut unresolved = 0;

        for message in messages {
            if message.role == "user" && unresolved > 0 {
                return Err("new user message before pending tool results".to_string());
            }
            if message.role == "assistant" {
                if unresolved > 0 {
                    return Err("assistant message before pending tool results".to_string());
                }
                if let Some(tool_calls) = &message.tool_calls {
                    for call in tool_calls {
                        if calls.contains_key(&call.id) {
                            return Err(format!("duplicate tool call: {}", call.id));
                        }
                        calls.insert(call.id.clone(), false);
                        unresolved += 1;
                    }
                }
            }
            if message.role == "tool" {
                if let Some(call_id) = &message.tool_call_id {
                    match calls.get_mut(call_id) {
                        Some(resolved) => {
                            if *resolved {
                                return Err(format!("duplicate tool result: {}", call_id));
                            }
                            *resolved = true;
                            unresolved -= 1;
                        }
                        None => {
                            return Err(format!("orphan tool result: {}", call_id));
                        }
                    }
                } else {
                    return Err("orphan tool result: missing toolCallId".to_string());
                }
            }
        }

        if unresolved > 0 {
            return Err("incomplete tool protocol group".to_string());
        }

        Ok(())
    }

    pub fn select_protocol_safe_tail(
        messages: &[NormalizedModelMessage],
        token_budget: u32,
    ) -> Vec<NormalizedModelMessage> {
        if messages.is_empty() || token_budget == 0 {
            return vec![];
        }

        let mut start = messages.len();
        let mut tokens = 0;

        while start > 0 && tokens < token_budget {
            start -= 1;
            tokens += ContextBudgetService::estimate_string_tokens(&messages[start].content); // simplified
        }

        if start < messages.len() && messages[start].role == "tool" {
            let mut needed = HashSet::new();
            for index in start..messages.len() {
                if messages[index].role != "tool" {
                    break;
                }
                if let Some(id) = &messages[index].tool_call_id {
                    needed.insert(id.clone());
                }
            }

            for index in (0..start).rev() {
                if messages[index].role == "assistant" {
                    if let Some(calls) = &messages[index].tool_calls {
                        if calls.iter().any(|c| needed.contains(&c.id)) {
                            start = index;
                            break;
                        }
                    }
                }
            }
        }

        messages[start..].to_vec()
    }

    pub fn group_by_protocol_round(messages: &[NormalizedModelMessage]) -> Vec<Vec<NormalizedModelMessage>> {
        let mut groups = Vec::new();
        let mut current = Vec::new();
        let mut current_has_assistant = false;

        for message in messages {
            if message.role == "assistant" && current_has_assistant && !current.is_empty() {
                groups.push(current.clone());
                current.clear();
                current_has_assistant = false;
            }
            current.push(message.clone());
            if message.role == "assistant" {
                current_has_assistant = true;
            }
        }

        if !current.is_empty() {
            groups.push(current);
        }

        groups
    }

    pub fn truncate_oldest_protocol_rounds(
        messages: &[NormalizedModelMessage],
        token_gap: Option<u32>,
    ) -> Option<(Vec<NormalizedModelMessage>, Option<u32>)> {
        let groups = Self::group_by_protocol_round(messages);
        if groups.len() < 2 {
            return None;
        }

        let mut drop_count = 0;
        if let Some(gap) = token_gap {
            if gap > 0 {
                let mut removed_tokens = 0;
                while drop_count < groups.len() - 1 && removed_tokens < gap {
                    removed_tokens += groups[drop_count].iter().map(|m| ContextBudgetService::estimate_string_tokens(&m.content)).sum::<u32>();
                    drop_count += 1;
                }
            } else {
                drop_count = 1.max((groups.len() as f32 * 0.2).floor() as usize);
            }
        } else {
            drop_count = 1.max((groups.len() as f32 * 0.2).floor() as usize);
        }

        drop_count = drop_count.min(groups.len() - 1);
        
        let dropped: Vec<_> = groups[0..drop_count].iter().flat_map(|g| g.clone()).collect();
        let messages: Vec<_> = groups[drop_count..].iter().flat_map(|g| g.clone()).collect();
        let truncated_through_sequence = dropped.last().and_then(|m| m.source_sequence);

        Some((messages, truncated_through_sequence))
    }
}
