use std::collections::HashMap;

use crate::tools::types::{NormalizedToolCall, ToolCallFragment};

#[derive(Default)]
struct AccumulatedCall {
    call_id: String,
    name: String,
    arguments: String,
    thought_signature: Option<String>,
    complete: bool,
}

pub struct ToolCallAssembler {
    calls: HashMap<usize, AccumulatedCall>,
    id_prefix: String,
}

impl ToolCallAssembler {
    pub fn new(id_prefix: String) -> Self {
        Self {
            calls: HashMap::new(),
            id_prefix,
        }
    }

    pub fn push(&mut self, fragment: ToolCallFragment) {
        let pos = fragment.position;
        let prefix = &self.id_prefix;
        let current = self.calls.entry(pos).or_insert_with(|| AccumulatedCall {
            call_id: fragment.call_id.clone().unwrap_or_else(|| format!("{}_{}", prefix, pos)),
            name: String::new(),
            arguments: String::new(),
            thought_signature: None,
            complete: false,
        });

        if let Some(call_id) = fragment.call_id {
            current.call_id = call_id;
        }
        if let Some(name_delta) = fragment.name_delta {
            current.name.push_str(&name_delta);
        }
        if let Some(complete_args) = fragment.complete_arguments {
            current.arguments = serde_json::to_string(&complete_args).unwrap_or_default();
        } else if let Some(arguments_delta) = fragment.arguments_delta {
            current.arguments.push_str(&arguments_delta);
        }
        if let Some(thought_sig) = fragment.thought_signature {
            current.thought_signature = Some(thought_sig);
        }
        if let Some(true) = fragment.is_final {
            current.complete = true;
        }
    }

    pub fn finalize(&self, require_final: bool) -> Vec<NormalizedToolCall> {
        let mut entries: Vec<_> = self.calls.iter().collect();
        entries.sort_by_key(|(pos, _)| **pos);

        entries.into_iter()
            .filter(|(_, call)| !require_final || call.complete)
            .map(|(pos, call)| NormalizedToolCall {
                call_id: call.call_id.clone(),
                position: *pos,
                name: call.name.clone(),
                raw_arguments: if call.arguments.is_empty() { "{}".to_string() } else { call.arguments.clone() },
                thought_signature: call.thought_signature.clone(),
            })
            .collect()
    }

    pub fn reset(&mut self) {
        self.calls.clear();
    }
}
