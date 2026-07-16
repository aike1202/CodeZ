use crate::tools::types::{PreparedToolCall, ToolExecutionWave, ToolConcurrency};

fn resource_base(key: &str) -> String {
    if let Some(stripped) = key.strip_suffix(":read") {
        stripped.to_string()
    } else if let Some(stripped) = key.strip_suffix(":write") {
        stripped.to_string()
    } else {
        key.to_string()
    }
}

fn conflicts(a: &PreparedToolCall, b: &PreparedToolCall) -> bool {
    if a.handler.descriptor().behavior().concurrency == ToolConcurrency::Exclusive {
        return true;
    }
    if b.handler.descriptor().behavior().concurrency == ToolConcurrency::Exclusive {
        return true;
    }
    for left in &a.resource_keys {
        for right in &b.resource_keys {
            if resource_base(left) != resource_base(right) {
                continue;
            }
            if left.ends_with(":read") && right.ends_with(":read") {
                continue;
            }
            return true;
        }
    }
    false
}

struct PlacedCall {
    call: PreparedToolCall,
    wave_index: usize,
}

pub struct ToolScheduler;

impl ToolScheduler {
    pub fn plan(calls: &[PreparedToolCall]) -> Vec<ToolExecutionWave> {
        let mut waves: Vec<ToolExecutionWave> = Vec::new();
        let mut placed: Vec<PlacedCall> = Vec::new();
        
        let mut sorted_calls = calls.to_vec();
        sorted_calls.sort_by_key(|c| c.call.position);

        for call in sorted_calls {
            let exclusive = call.handler.descriptor().behavior().concurrency == ToolConcurrency::Exclusive;
            let mut wave_index = if exclusive { waves.len() } else { 0 };

            for previous in &placed {
                if conflicts(&previous.call, &call) {
                    wave_index = std::cmp::max(wave_index, previous.wave_index + 1);
                }
            }

            while waves.len() <= wave_index {
                waves.push(ToolExecutionWave {
                    index: waves.len(),
                    calls: Vec::new(),
                    reason: "independent".to_string(),
                });
            }

            waves[wave_index].calls.push(call.clone());
            
            waves[wave_index].reason = if exclusive {
                "exclusive".to_string()
            } else if wave_index == 0 {
                "independent".to_string()
            } else {
                "resource-serialized".to_string()
            };

            placed.push(PlacedCall { call, wave_index });
        }

        waves
    }
}
