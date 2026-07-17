//! Deterministic, provider-aware measurement for one model context request.

use codez_core::{
    ComposerImageAttachment,
    context::NormalizedModelMessage,
    provider::{ProviderTokenUsage, ToolDefinition},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const IMAGE_TILE_EDGE: u32 = 512;
const IMAGE_BASE_TOKENS: u32 = 85;
const IMAGE_TILE_TOKENS: u32 = 170;
const PROTOCOL_TOKENS_PER_MESSAGE: u32 = 4;

/// Provider limits that determine how much model input can be admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelContextCapabilities {
    pub context_window_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub max_input_tokens: Option<u32>,
    pub reasoning_counts_against_context: Option<bool>,
}

/// Resolved hard limit, output reserve, and safety margin for one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLimits {
    pub hard_input_limit: u32,
    pub usable_input_budget: u32,
    pub output_reserve_tokens: u32,
    pub safety_margin_tokens: u32,
}

/// Action requested by the current and projected context pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextPressureLevel {
    Normal,
    Warning,
    Prune,
    Compact,
    Overflow,
}

/// Indicates whether a request measurement is heuristic or provider-anchored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextEstimateSource {
    Heuristic,
    Provider,
}

/// Token estimate and pressure decision for a complete provider request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetSnapshot {
    pub hard_input_limit: u32,
    pub usable_input_budget: u32,
    pub output_reserve_tokens: u32,
    pub safety_margin_tokens: u32,
    pub system_prompt_tokens: u32,
    pub tool_schema_tokens: u32,
    pub instruction_tokens: u32,
    pub protocol_tokens: u32,
    pub summary_tokens: u32,
    pub recent_history_tokens: u32,
    pub raw_history_tokens: u32,
    pub current_input_tokens: u32,
    pub total_input_tokens: u32,
    pub provider_adjustment_tokens: i64,
    pub pressure_level: ContextPressureLevel,
    pub estimate_source: ContextEstimateSource,
    pub history_version: u32,
}

/// Borrowed inputs needed to measure one provider request without cloning history.
pub struct MeasureContextRequest<'a> {
    pub capabilities: &'a ModelContextCapabilities,
    pub system_prompt: &'a str,
    pub tool_schemas: &'a [ToolDefinition],
    pub instructions: &'a [String],
    pub summary: Option<&'a str>,
    /// Durable history excluding the current input, which is measured separately.
    pub recent_history: &'a [NormalizedModelMessage],
    pub raw_history_tokens: Option<u32>,
    pub current_input: &'a str,
    pub current_attachments: &'a [ComposerImageAttachment],
    pub history_version: u32,
    pub provider_usage: Option<&'a ProviderTokenUsage>,
    pub provider_usage_additional_tokens: u32,
    pub reasoning_budget_tokens: u32,
    pub projected_additional_tokens: u32,
}

/// Typed failures raised while validating or measuring a model request.
#[derive(Debug, Error)]
pub enum ContextBudgetError {
    #[error("context budget input could not be serialized: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("model context window must be a positive token count")]
    InvalidContextWindow,
    #[error("model maximum input tokens must be positive and no larger than the context window")]
    InvalidMaxInputTokens,
    #[error("model maximum output tokens must be positive and smaller than the context window")]
    InvalidMaxOutputTokens,
    #[error("the current model input has neither text nor an attachment")]
    CurrentInputMissing,
    #[error(
        "the current model input requires {tokens} estimated tokens, exceeding the hard input limit of {hard_input_limit}"
    )]
    CurrentInputTooLarge { tokens: u32, hard_input_limit: u32 },
}

/// Stateless context measurement operations shared by chat and compaction runtimes.
pub struct ContextBudgetService;

impl ContextBudgetService {
    #[must_use]
    pub fn estimate_string_tokens(text: &str) -> u32 {
        if text.is_empty() {
            return 0;
        }

        let cjk_count = text
            .chars()
            .filter(|character| {
                let codepoint = u32::from(*character);
                (0x3400..=0x9fff).contains(&codepoint)
                    || (0x3000..=0x303f).contains(&codepoint)
                    || (0xff00..=0xffef).contains(&codepoint)
            })
            .count();
        let utf16_units = text.encode_utf16().count();
        let other_units = utf16_units.saturating_sub(cjk_count);
        let numerator = (cjk_count as u64)
            .saturating_mul(8)
            .saturating_add((other_units as u64).saturating_mul(3));
        u32::try_from(numerator.div_ceil(12)).unwrap_or(u32::MAX)
    }

    pub fn estimate_value_tokens<T>(value: &T) -> Result<u32, ContextBudgetError>
    where
        T: Serialize,
    {
        let serialized = serde_json::to_string(value)?;
        Ok(Self::estimate_string_tokens(&serialized))
    }

    #[must_use]
    pub fn estimate_image_tokens(width: u32, height: u32) -> u32 {
        let horizontal_tiles = width.div_ceil(IMAGE_TILE_EDGE);
        let vertical_tiles = height.div_ceil(IMAGE_TILE_EDGE);
        let tiles = horizontal_tiles.saturating_mul(vertical_tiles).max(1);
        IMAGE_BASE_TOKENS.saturating_add(tiles.saturating_mul(IMAGE_TILE_TOKENS))
    }

    pub fn estimate_message_tokens(
        message: &NormalizedModelMessage,
    ) -> Result<u32, ContextBudgetError> {
        let serialized_tokens = Self::estimate_value_tokens(message)?;
        let image_tokens = message.attachments.as_deref().map_or(0, |attachments| {
            attachments.iter().fold(0_u32, |total, attachment| {
                let (width, height) = attachment_dimensions(attachment);
                total.saturating_add(Self::estimate_image_tokens(width, height))
            })
        });
        Ok(serialized_tokens.saturating_add(image_tokens))
    }

    #[must_use]
    pub fn resolve_limits(
        capabilities: &ModelContextCapabilities,
        reasoning_budget_tokens: u32,
    ) -> ContextLimits {
        let context_window_tokens = capabilities.context_window_tokens.unwrap_or(1).max(1);
        let ordinary_reserve = capabilities
            .max_output_tokens
            .unwrap_or_else(|| default_max_output_tokens(context_window_tokens))
            .max(1);
        let reasoning_reserve = if capabilities.reasoning_counts_against_context == Some(true) {
            reasoning_budget_tokens
        } else {
            0
        };
        let output_reserve_tokens = context_window_tokens
            .saturating_sub(1)
            .min(ordinary_reserve.saturating_add(reasoning_reserve));
        let hard_input_limit = capabilities
            .max_input_tokens
            .unwrap_or_else(|| context_window_tokens.saturating_sub(output_reserve_tokens))
            .max(1);
        let safety_margin_tokens = ((u64::from(hard_input_limit) * 3) / 100)
            .clamp(256, 2_048)
            .min(u64::from(hard_input_limit.saturating_sub(1)))
            as u32;

        ContextLimits {
            hard_input_limit,
            usable_input_budget: hard_input_limit.saturating_sub(safety_margin_tokens).max(1),
            output_reserve_tokens,
            safety_margin_tokens,
        }
    }

    #[must_use]
    pub fn pressure_level(ratio: f64, projected_overflow: bool) -> ContextPressureLevel {
        if ratio > 1.0 {
            ContextPressureLevel::Overflow
        } else if projected_overflow || ratio >= 0.9 {
            ContextPressureLevel::Compact
        } else if ratio >= 0.8 {
            ContextPressureLevel::Prune
        } else if ratio >= 0.7 {
            ContextPressureLevel::Warning
        } else {
            ContextPressureLevel::Normal
        }
    }

    #[must_use]
    pub fn pressure_level_for_tokens(
        total_input_tokens: u32,
        usable_input_budget: u32,
        projected_input_tokens: u32,
    ) -> ContextPressureLevel {
        let usable = usable_input_budget.max(1);
        if total_input_tokens > usable {
            return ContextPressureLevel::Overflow;
        }

        let auto_compact_buffer = usable.saturating_div(10).clamp(1_000, 13_000);
        let earlier_stage_buffer = usable.saturating_div(20).clamp(1_000, 20_000);
        let compact_at = usable.saturating_sub(auto_compact_buffer).max(1);
        let prune_at = compact_at.saturating_sub(earlier_stage_buffer).max(1);
        let warning_at = prune_at.saturating_sub(earlier_stage_buffer).max(1);

        if projected_input_tokens >= compact_at || total_input_tokens >= compact_at {
            ContextPressureLevel::Compact
        } else if total_input_tokens >= prune_at {
            ContextPressureLevel::Prune
        } else if total_input_tokens >= warning_at {
            ContextPressureLevel::Warning
        } else {
            ContextPressureLevel::Normal
        }
    }

    #[must_use]
    pub fn recent_tail_budget(usable_input_budget: u32) -> u32 {
        let proportional_cap = usable_input_budget.saturating_mul(35) / 100;
        let preferred = (usable_input_budget.saturating_mul(25) / 100).clamp(1_000, 8_000);
        proportional_cap.min(preferred)
    }

    pub fn assert_current_input_fits(
        current_input: &str,
        attachments: &[ComposerImageAttachment],
        capabilities: &ModelContextCapabilities,
        reasoning_budget_tokens: u32,
    ) -> Result<(), ContextBudgetError> {
        validate_capabilities(capabilities)?;
        if current_input.trim().is_empty() && attachments.is_empty() {
            return Err(ContextBudgetError::CurrentInputMissing);
        }
        let tokens = current_input_tokens(current_input, attachments);
        let hard_input_limit =
            Self::resolve_limits(capabilities, reasoning_budget_tokens).hard_input_limit;
        if tokens > hard_input_limit {
            return Err(ContextBudgetError::CurrentInputTooLarge {
                tokens,
                hard_input_limit,
            });
        }
        Ok(())
    }

    pub fn measure_request(
        input: &MeasureContextRequest<'_>,
    ) -> Result<ContextBudgetSnapshot, ContextBudgetError> {
        Self::assert_current_input_fits(
            input.current_input,
            input.current_attachments,
            input.capabilities,
            input.reasoning_budget_tokens,
        )?;
        let limits = Self::resolve_limits(input.capabilities, input.reasoning_budget_tokens);
        let system_prompt_tokens = Self::estimate_string_tokens(input.system_prompt);
        let tool_schema_tokens = input.tool_schemas.iter().try_fold(0_u32, |total, schema| {
            Self::estimate_value_tokens(schema).map(|tokens| total.saturating_add(tokens))
        })?;
        let instruction_tokens = input.instructions.iter().fold(0_u32, |total, instruction| {
            total.saturating_add(Self::estimate_string_tokens(instruction))
        });
        let summary_tokens = input.summary.map_or(0, Self::estimate_string_tokens);
        let recent_history_tokens =
            input
                .recent_history
                .iter()
                .try_fold(0_u32, |total, message| {
                    Self::estimate_message_tokens(message)
                        .map(|tokens| total.saturating_add(tokens))
                })?;
        let current_input_tokens =
            current_input_tokens(input.current_input, input.current_attachments);
        let protocol_message_count = u32::try_from(input.recent_history.len())
            .unwrap_or(u32::MAX)
            .saturating_add(1);
        let protocol_tokens = protocol_message_count.saturating_mul(PROTOCOL_TOKENS_PER_MESSAGE);
        let local_input_tokens = system_prompt_tokens
            .saturating_add(tool_schema_tokens)
            .saturating_add(instruction_tokens)
            .saturating_add(protocol_tokens)
            .saturating_add(summary_tokens)
            .saturating_add(recent_history_tokens)
            .saturating_add(current_input_tokens);

        let provider_baseline = input.provider_usage.and_then(|usage| {
            (usage.input_tokens > 0).then(|| {
                usage
                    .input_tokens
                    .saturating_add(usage.output_tokens)
                    .saturating_add(input.provider_usage_additional_tokens)
            })
        });
        let (total_input_tokens, provider_adjustment_tokens, estimate_source) = provider_baseline
            .map_or(
                (local_input_tokens, 0, ContextEstimateSource::Heuristic),
                |baseline| {
                    (
                        baseline,
                        i64::from(baseline) - i64::from(local_input_tokens),
                        ContextEstimateSource::Provider,
                    )
                },
            );
        let projected_input_tokens =
            total_input_tokens.saturating_add(input.projected_additional_tokens);

        Ok(ContextBudgetSnapshot {
            hard_input_limit: limits.hard_input_limit,
            usable_input_budget: limits.usable_input_budget,
            output_reserve_tokens: limits.output_reserve_tokens,
            safety_margin_tokens: limits.safety_margin_tokens,
            system_prompt_tokens,
            tool_schema_tokens,
            instruction_tokens,
            protocol_tokens,
            summary_tokens,
            recent_history_tokens,
            raw_history_tokens: input.raw_history_tokens.unwrap_or(recent_history_tokens),
            current_input_tokens,
            total_input_tokens,
            provider_adjustment_tokens,
            pressure_level: Self::pressure_level_for_tokens(
                total_input_tokens,
                limits.usable_input_budget,
                projected_input_tokens,
            ),
            estimate_source,
            history_version: input.history_version,
        })
    }
}

fn default_max_output_tokens(context_window_tokens: u32) -> u32 {
    let window = context_window_tokens.max(2);
    let proportional = window.saturating_mul(20) / 100;
    proportional.clamp(1_024, 8_192).min((window / 2).max(1))
}

fn validate_capabilities(
    capabilities: &ModelContextCapabilities,
) -> Result<(), ContextBudgetError> {
    let context_window_tokens = capabilities
        .context_window_tokens
        .filter(|tokens| *tokens > 0)
        .ok_or(ContextBudgetError::InvalidContextWindow)?;
    if capabilities
        .max_input_tokens
        .is_some_and(|tokens| tokens == 0 || tokens > context_window_tokens)
    {
        return Err(ContextBudgetError::InvalidMaxInputTokens);
    }
    if capabilities
        .max_output_tokens
        .is_some_and(|tokens| tokens == 0 || tokens >= context_window_tokens)
    {
        return Err(ContextBudgetError::InvalidMaxOutputTokens);
    }
    Ok(())
}

fn attachment_dimensions(attachment: &ComposerImageAttachment) -> (u32, u32) {
    match attachment {
        ComposerImageAttachment::Session(image) => (image.width, image.height),
        ComposerImageAttachment::Draft(image) => (image.width, image.height),
    }
}

fn current_input_tokens(input: &str, attachments: &[ComposerImageAttachment]) -> u32 {
    attachments.iter().fold(
        ContextBudgetService::estimate_string_tokens(input),
        |total, attachment| {
            let (width, height) = attachment_dimensions(attachment);
            total.saturating_add(ContextBudgetService::estimate_image_tokens(width, height))
        },
    )
}

#[cfg(test)]
mod tests {
    use codez_core::{
        ComposerImageAttachment, SessionImageAttachment,
        context::NormalizedModelMessage,
        provider::{ProviderTokenUsage, ToolDefinition, ToolDefinitionFunction},
    };

    use super::{
        ContextBudgetError, ContextBudgetService, ContextEstimateSource, ContextPressureLevel,
        MeasureContextRequest, ModelContextCapabilities,
    };

    fn capabilities() -> ModelContextCapabilities {
        ModelContextCapabilities {
            context_window_tokens: Some(10_000),
            max_output_tokens: Some(2_000),
            max_input_tokens: None,
            reasoning_counts_against_context: Some(false),
        }
    }

    fn attachment(width: u32, height: u32) -> ComposerImageAttachment {
        ComposerImageAttachment::Session(SessionImageAttachment {
            id: "image-1".to_string(),
            kind: "image".to_string(),
            name: "image.png".to_string(),
            mime_type: "image/png".to_string(),
            width,
            height,
            size_bytes: 100,
            storage_key: "images/image-1.png".to_string(),
            scope: "session".to_string(),
            session_id: "session-1".to_string(),
        })
    }

    fn message(id: &str, content: &str) -> NormalizedModelMessage {
        NormalizedModelMessage {
            id: id.to_string(),
            client_message_id: None,
            turn_id: "turn-1".to_string(),
            role: "assistant".to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            status: "complete".to_string(),
            created_at: "2026-07-17T00:00:00Z".to_string(),
            source_sequence: Some(1),
            attachments: None,
            file_references: None,
        }
    }

    fn tool_schema() -> ToolDefinition {
        ToolDefinition {
            r#type: "function".to_string(),
            function: ToolDefinitionFunction {
                name: "Read".to_string(),
                description: "Read a file".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": { "path": { "type": "string" } }
                }),
            },
        }
    }

    #[test]
    fn resolve_limits_reserves_visible_output_reasoning_and_safety_margin() {
        let mut input = capabilities();
        input.reasoning_counts_against_context = Some(true);

        let limits = ContextBudgetService::resolve_limits(&input, 1_000);

        assert_eq!(
            (
                limits.output_reserve_tokens,
                limits.hard_input_limit,
                limits.safety_margin_tokens,
                limits.usable_input_budget,
            ),
            (3_000, 7_000, 256, 6_744)
        );
    }

    #[test]
    fn explicit_input_limit_is_not_reduced_by_output_reserve() {
        let mut input = capabilities();
        input.max_input_tokens = Some(7_000);
        input.reasoning_counts_against_context = Some(true);

        let limits = ContextBudgetService::resolve_limits(&input, 1_000);

        assert_eq!(limits.hard_input_limit, 7_000);
    }

    #[test]
    fn image_estimate_counts_provider_style_tiles() {
        assert_eq!(
            ContextBudgetService::estimate_image_tokens(1_024, 1_024),
            765
        );
    }

    #[test]
    fn recent_tail_budget_uses_the_bounded_proportional_formula() {
        assert_eq!(ContextBudgetService::recent_tail_budget(20_000), 5_000);
    }

    #[test]
    fn token_pressure_uses_absolute_ordered_thresholds() {
        assert_eq!(
            [6_999, 7_000, 8_000, 9_000, 10_001].map(|tokens| {
                ContextBudgetService::pressure_level_for_tokens(tokens, 10_000, tokens)
            }),
            [
                ContextPressureLevel::Normal,
                ContextPressureLevel::Warning,
                ContextPressureLevel::Prune,
                ContextPressureLevel::Compact,
                ContextPressureLevel::Overflow,
            ]
        );
    }

    #[test]
    fn projected_growth_can_request_compaction_before_current_usage_reaches_it() {
        assert_eq!(
            ContextBudgetService::pressure_level_for_tokens(6_999, 10_000, 9_000),
            ContextPressureLevel::Compact
        );
    }

    #[test]
    fn current_input_requires_text_or_an_attachment() {
        let error = ContextBudgetService::assert_current_input_fits("  ", &[], &capabilities(), 0)
            .expect_err("empty input must be rejected");

        assert!(matches!(error, ContextBudgetError::CurrentInputMissing));
    }

    #[test]
    fn request_measurement_rejects_missing_model_limits_instead_of_using_a_tiny_fallback() {
        let invalid = ModelContextCapabilities {
            context_window_tokens: None,
            max_output_tokens: None,
            max_input_tokens: None,
            reasoning_counts_against_context: None,
        };

        let error = ContextBudgetService::assert_current_input_fits("input", &[], &invalid, 0)
            .expect_err("missing context window must be rejected");

        assert!(matches!(error, ContextBudgetError::InvalidContextWindow));
    }

    #[test]
    fn reasoning_reserve_applies_to_current_input_validation() {
        let input = ModelContextCapabilities {
            context_window_tokens: Some(2_000),
            max_output_tokens: Some(500),
            max_input_tokens: None,
            reasoning_counts_against_context: Some(true),
        };
        let content = "x".repeat(4_001);

        let error = ContextBudgetService::assert_current_input_fits(&content, &[], &input, 500)
            .expect_err("reasoning reserve must reduce available input");

        assert!(matches!(
            error,
            ContextBudgetError::CurrentInputTooLarge {
                hard_input_limit: 1_000,
                ..
            }
        ));
    }

    #[test]
    fn measure_request_counts_every_model_visible_component() {
        let tools = vec![tool_schema()];
        let instructions = vec!["follow repository rules".to_string()];
        let history = vec![message("assistant-1", "prior response")];
        let attachments = vec![attachment(1_024, 1_024)];
        let request = MeasureContextRequest {
            capabilities: &capabilities(),
            system_prompt: "system prompt",
            tool_schemas: &tools,
            instructions: &instructions,
            summary: Some("summary"),
            recent_history: &history,
            raw_history_tokens: Some(321),
            current_input: "current input",
            current_attachments: &attachments,
            history_version: 7,
            provider_usage: None,
            provider_usage_additional_tokens: 0,
            reasoning_budget_tokens: 0,
            projected_additional_tokens: 0,
        };

        let snapshot = ContextBudgetService::measure_request(&request)
            .expect("fixed request must be measurable");
        let components = snapshot
            .system_prompt_tokens
            .saturating_add(snapshot.tool_schema_tokens)
            .saturating_add(snapshot.instruction_tokens)
            .saturating_add(snapshot.protocol_tokens)
            .saturating_add(snapshot.summary_tokens)
            .saturating_add(snapshot.recent_history_tokens)
            .saturating_add(snapshot.current_input_tokens);

        assert_eq!(
            (
                snapshot.total_input_tokens,
                snapshot.raw_history_tokens,
                snapshot.current_input_tokens,
                snapshot.history_version,
                snapshot.estimate_source,
            ),
            (
                components,
                321,
                ContextBudgetService::estimate_string_tokens("current input") + 765,
                7,
                ContextEstimateSource::Heuristic,
            )
        );
    }

    #[test]
    fn provider_usage_replaces_the_local_estimate_without_counting_hidden_reasoning() {
        let history = vec![message("assistant-1", "prior response")];
        let usage = ProviderTokenUsage {
            input_tokens: 2_000,
            output_tokens: 300,
            reasoning_tokens: Some(9_000),
            total_tokens: Some(11_300),
        };
        let request = MeasureContextRequest {
            capabilities: &capabilities(),
            system_prompt: "system prompt",
            tool_schemas: &[],
            instructions: &[],
            summary: None,
            recent_history: &history,
            raw_history_tokens: None,
            current_input: "current input",
            current_attachments: &[],
            history_version: 1,
            provider_usage: Some(&usage),
            provider_usage_additional_tokens: 50,
            reasoning_budget_tokens: 0,
            projected_additional_tokens: 0,
        };

        let snapshot = ContextBudgetService::measure_request(&request)
            .expect("fixed request must be measurable");

        assert_eq!(
            (snapshot.total_input_tokens, snapshot.estimate_source),
            (2_350, ContextEstimateSource::Provider)
        );
    }
}
