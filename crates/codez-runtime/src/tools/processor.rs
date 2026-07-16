use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;


use crate::tools::large_result::LargeToolResultStore;
use crate::tools::types::{ToolExecutionError, ToolExecutionResult, ToolPipelineResult};

fn truncate_middle(content: &str, limit: usize) -> String {
    let chars_count = content.chars().count();
    if chars_count <= limit {
        return content.to_string();
    }
    
    let head = (limit as f64 * 0.7).ceil() as usize;
    let tail = (limit as f64 * 0.3).floor() as usize;

    let chars: Vec<char> = content.chars().collect();
    let head_str: String = chars[0..head].iter().collect();
    let tail_str: String = chars[chars.len() - tail..].iter().collect();

    format!("{}\n...[truncated {} chars]...\n{}", head_str, chars_count - limit, tail_str)
}

pub struct ToolResultProcessorLimits {
    pub soft_chars: usize,
    pub hard_bytes: usize,
    pub batch_chars: usize,
    pub preview_chars: usize,
    pub error_chars: usize,
}

impl Default for ToolResultProcessorLimits {
    fn default() -> Self {
        Self {
            soft_chars: 50_000,
            hard_bytes: 400_000,
            batch_chars: 200_000,
            preview_chars: 2_000,
            error_chars: 10_000,
        }
    }
}

pub struct ToolResultProcessor {
    store: Arc<LargeToolResultStore>,
    limits: ToolResultProcessorLimits,
    persistence_enabled: bool,
}

impl ToolResultProcessor {
    pub fn new(store: Arc<LargeToolResultStore>, limits: Option<ToolResultProcessorLimits>, persistence_enabled: bool) -> Self {
        Self {
            store,
            limits: limits.unwrap_or_default(),
            persistence_enabled,
        }
    }

    pub async fn process_batch(
        &self,
        results: Vec<ToolPipelineResult>,
        workspace_root: &PathBuf,
        session_id: Option<&str>,
    ) -> Vec<ToolPipelineResult> {
        let mut processed = Vec::new();

        // Pass 1: truncate errors and stringify data
        for mut item in results {
            match &mut item.result {
                ToolExecutionResult::Success { model_content: _, .. } => {
                    // It is already a string in Rust struct.
                }
                ToolExecutionResult::Error { error, model_content, .. } |
                ToolExecutionResult::Denied { error, model_content, .. } |
                ToolExecutionResult::Cancelled { error, model_content, .. } => {
                    let content = model_content.clone().unwrap_or_else(|| format!("Error: {}", error.message));
                    *model_content = Some(truncate_middle(&content, self.limits.error_chars));
                }
            }
            processed.push(item);
        }

        let sid = match session_id {
            Some(id) => id,
            None => return processed,
        };

        #[derive(Clone)]
        struct Candidate {
            index: usize,
            chars: usize,
            bytes: usize,
            soft_chars: usize,
        }

        let mut candidates = Vec::new();
        for (i, item) in processed.iter().enumerate() {
            if let ToolExecutionResult::Success { model_content, .. } = &item.result {
                candidates.push(Candidate {
                    index: i,
                    chars: model_content.chars().count(),
                    bytes: model_content.as_bytes().len(),
                    soft_chars: item.max_result_chars.unwrap_or(self.limits.soft_chars),
                });
            } else {
                candidates.push(Candidate {
                    index: i,
                    chars: 0,
                    bytes: 0,
                    soft_chars: item.max_result_chars.unwrap_or(self.limits.soft_chars),
                });
            }
        }

        let mut batch_chars: usize = candidates.iter().map(|c| c.chars).sum();
        let mut must_persist = HashSet::new();

        for candidate in candidates.iter().filter(|c| c.chars > c.soft_chars || c.bytes > self.limits.hard_bytes) {
            must_persist.insert(processed[candidate.index].call.call_id.clone());
        }

        let mut sorted_candidates = candidates.clone();
        sorted_candidates.sort_by(|a, b| b.chars.cmp(&a.chars));

        for candidate in sorted_candidates {
            if batch_chars <= self.limits.batch_chars {
                break;
            }
            must_persist.insert(processed[candidate.index].call.call_id.clone());
            batch_chars = batch_chars.saturating_sub(candidate.chars);
        }

        if !self.persistence_enabled {
            for item in &mut processed {
                let is_success = matches!(item.result, ToolExecutionResult::Success { .. });
                if is_success && must_persist.contains(&item.call.call_id) {
                    item.result = ToolExecutionResult::Error {
                        error: ToolExecutionError {
                            code: "TOOL_RESULT_TOO_LARGE".to_string(),
                            message: "Tool output exceeded the hard model-result budget while result persistence was disabled.".to_string(),
                            recoverable: true,
                            suggestion: Some("Retry with a smaller limit or enable CODEZ_TOOL_RESULT_STORE.".to_string()),
                            retry_after_ms: None,
                            details: None,
                        },
                        model_content: Some("Error: Tool output exceeded the hard model-result budget.".to_string()),
                        ui_content: None,
                        effects: None,
                    };
                }
            }
            return processed;
        }

        let mut final_results = Vec::new();
        for mut item in processed {
            let is_success = matches!(item.result, ToolExecutionResult::Success { .. });
            if is_success && must_persist.contains(&item.call.call_id) {
                if let ToolExecutionResult::Success { model_content, ui_content, effects, data } = item.result {
                    let full_content = model_content;
                    match self.store.persist(workspace_root, sid, &item.call.call_id, &item.canonical_name, &full_content).await {
                        Ok(persisted) => {
                            let preview = truncate_middle(&full_content, self.limits.preview_chars);
                            let new_content = format!(
                                "<persisted-tool-result id=\"{}\" original_chars=\"{}\" sha256=\"{}\">\nOutput was too large. A preview follows.\n{}\n</persisted-tool-result>",
                                persisted.handle, persisted.original_chars, persisted.sha256, preview
                            );
                            item.result = ToolExecutionResult::Success {
                                data,
                                model_content: new_content,
                                ui_content,
                                effects,
                            };
                        }
                        Err(e) => {
                            item.result = ToolExecutionResult::Error {
                                error: ToolExecutionError {
                                    code: "TOOL_RESULT_PERSIST_FAILED".to_string(),
                                    message: e.to_string(),
                                    recoverable: false,
                                    suggestion: None,
                                    retry_after_ms: None,
                                    details: None,
                                },
                                model_content: Some("Error: The tool result exceeded the context budget and could not be persisted.".to_string()),
                                ui_content: None,
                                effects: None,
                            };
                        }
                    }
                }
            } else {
                // Not modified
            }
            final_results.push(item);
        }

        final_results
    }
}
