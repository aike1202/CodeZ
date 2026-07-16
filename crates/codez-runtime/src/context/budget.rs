use serde::{Deserialize, Serialize};

// Simple port of ContextBudgetService

pub struct ModelContextCapabilities {
    pub context_window_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub max_input_tokens: Option<u32>,
    pub reasoning_counts_against_context: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextLimits {
    pub hard_input_limit: u32,
    pub usable_input_budget: u32,
    pub output_reserve_tokens: u32,
    pub safety_margin_tokens: u32,
}

pub struct ContextBudgetService;

impl ContextBudgetService {
    pub fn estimate_string_tokens(text: &str) -> u32 {
        if text.is_empty() {
            return 0;
        }
        // Approximate heuristic: count CJK characters and ASCII characters
        let cjk_count = text.chars().filter(|c| {
            let u = *c as u32;
            (0x3400..=0x9fff).contains(&u) || 
            (0x3000..=0x303f).contains(&u) || 
            (0xff00..=0xffef).contains(&u)
        }).count() as u32;
        
        let other_count = text.chars().count() as u32 - cjk_count;
        ((cjk_count as f32 / 1.5) + (other_count as f32 / 4.0)).ceil() as u32
    }

    pub fn resolve_limits(capabilities: &ModelContextCapabilities, reasoning_budget_tokens: u32) -> ContextLimits {
        let context_window_tokens = capabilities.context_window_tokens.unwrap_or(1).max(1);
        
        let default_reserve = 4096.min(context_window_tokens / 4); // simplistic default_max_output_tokens
        let ordinary_reserve = capabilities.max_output_tokens.unwrap_or(default_reserve).max(1);
        
        let reasoning_reserve = if capabilities.reasoning_counts_against_context.unwrap_or(false) {
            reasoning_budget_tokens
        } else {
            0
        };
        
        let output_reserve_tokens = (context_window_tokens.saturating_sub(1)).min(ordinary_reserve + reasoning_reserve);
        
        let hard_input_limit = capabilities.max_input_tokens
            .unwrap_or_else(|| context_window_tokens.saturating_sub(output_reserve_tokens))
            .max(1);
            
        let mut safety_margin_tokens = (hard_input_limit as f32 * 0.03).floor() as u32;
        safety_margin_tokens = safety_margin_tokens.clamp(256, 2048);
        safety_margin_tokens = safety_margin_tokens.min(hard_input_limit.saturating_sub(1));
        
        ContextLimits {
            hard_input_limit,
            usable_input_budget: (hard_input_limit.saturating_sub(safety_margin_tokens)).max(1),
            output_reserve_tokens,
            safety_margin_tokens,
        }
    }

    pub fn pressure_level(ratio: f32, projected_overflow: bool) -> String {
        if ratio > 1.0 {
            "overflow".to_string()
        } else if projected_overflow || ratio >= 0.9 {
            "compact".to_string()
        } else if ratio >= 0.8 {
            "prune".to_string()
        } else if ratio >= 0.7 {
            "warning".to_string()
        } else {
            "normal".to_string()
        }
    }
}
