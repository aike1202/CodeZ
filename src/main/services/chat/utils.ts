import type { ApiFormat, ThinkingConfig, ThinkingEffort } from '../../../shared/types/provider'
import { getReasoningCapabilities, resolveReasoningBudgetTokens } from '../../../shared/utils/reasoningCapabilities'

function isAdaptiveAnthropicModel(model: string): boolean {
  const modelLower = model.toLowerCase()
  return modelLower.includes('claude-opus-4-8')
    || modelLower.includes('claude-opus-4-7')
    || modelLower.includes('claude-opus-4-6')
    || modelLower.includes('claude-sonnet-4-6')
    || modelLower.includes('claude-sonnet-5')
    || modelLower.includes('claude-fable-5')
    || modelLower.includes('claude-mythos-5')
    || modelLower.includes('claude-mythos-preview')
}

function getSupportedEffort(
  effort: ThinkingEffort | undefined,
  supported: ThinkingEffort[]
): ThinkingEffort | undefined {
  if (!effort || effort === 'auto' || effort === 'custom') return undefined
  return supported.includes(effort) ? effort : undefined
}

export function buildThinkingPayload(
  thinking: ThinkingConfig | undefined,
  model: string,
  baseUrl: string,
  _hasTools?: boolean,
  apiFormat: ApiFormat = 'openai'
): Record<string, unknown> {
  if (!thinking?.enabled || thinking.mode === 'none') return {}

  const capabilities = getReasoningCapabilities({
    model,
    baseUrl,
    apiFormat,
    mode: thinking.mode
  })
  if (capabilities.control === 'none') return {}

  const resolvedTokens = resolveReasoningBudgetTokens(thinking)
  const effort = getSupportedEffort(thinking.effort, capabilities.efforts)

  switch (capabilities.mode) {
    case 'anthropic': {
      const anthropicPayload: Record<string, unknown> = {}
      if (isAdaptiveAnthropicModel(model)) {
        anthropicPayload.thinking = { type: 'adaptive', display: 'summarized' }
      } else if (resolvedTokens) {
        anthropicPayload.thinking = { type: 'enabled', budget_tokens: Math.max(1024, resolvedTokens) }
      }
      if (effort) anthropicPayload.output_config = { effort }
      return anthropicPayload
    }
    case 'deepseek': {
      const payload: Record<string, unknown> = {
        thinking: { type: 'enabled' }
      }
      if (effort) payload.reasoning_effort = effort
      return payload
    }
    case 'qwen': {
      const payload: Record<string, unknown> = {
        enable_thinking: true
      }
      if (resolvedTokens) payload.thinking_budget = resolvedTokens
      return payload
    }
    case 'gemini': {
      if (apiFormat === 'openai') {
        return effort ? { reasoning_effort: effort } : {}
      }
      const thinkingConfig: Record<string, unknown> = { includeThoughts: true }
      if (capabilities.control === 'effort' && effort) {
        thinkingConfig.thinkingLevel = effort
      } else if (capabilities.control === 'budget') {
        thinkingConfig.thinkingBudget = resolvedTokens ?? -1
      }
      return { google: { thinkingConfig } }
    }
    case 'openrouter':
      if (thinking.budgetTokens && thinking.budgetTokens > 0) {
        return { reasoning: { max_tokens: thinking.budgetTokens } }
      }
      if (capabilities.control === 'budget' && resolvedTokens) {
        return { reasoning: { max_tokens: resolvedTokens } }
      }
      return {
        reasoning: effort
          ? { effort }
          : { enabled: true }
      }
    case 'grok':
    case 'openai':
    default:
      return effort ? { reasoning_effort: effort } : {}
  }
}
