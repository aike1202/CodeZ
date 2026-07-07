import type { ThinkingConfig } from '../../../shared/types/provider'

function resolveBudgetTokens(thinking: ThinkingConfig): number | undefined {
  if (thinking.effort === 'custom' || !thinking.effort) {
    return thinking.budgetTokens && thinking.budgetTokens > 0 ? thinking.budgetTokens : undefined
  }
  switch (thinking.effort) {
    case 'low': return 1024
    case 'medium': return 4096
    case 'high': return 16384
    case 'auto':
    default: return undefined
  }
}

function isAdaptiveOnlyAnthropicModel(model: string): boolean {
  const modelLower = model.toLowerCase()
  return modelLower.includes('claude-opus-4-8')
    || modelLower.includes('claude-opus-4-7')
    || modelLower.includes('claude-sonnet-5')
    || modelLower.includes('claude-fable-5')
    || modelLower.includes('claude-mythos-5')
}

function buildAnthropicEffortPayload(thinking: ThinkingConfig): Record<string, unknown> {
  if (thinking.effort && ['low', 'medium', 'high'].includes(thinking.effort)) {
    return { output_config: { effort: thinking.effort } }
  }
  return {}
}

export function buildThinkingPayload(
  thinking: ThinkingConfig | undefined,
  model: string,
  baseUrl: string,
  hasTools?: boolean
): Record<string, unknown> {
  if (!thinking?.enabled || thinking.mode === 'none') return {}

  const resolvedTokens = resolveBudgetTokens(thinking)

  let mode = thinking.mode
  if (mode === 'auto') {
    const modelLower = model.toLowerCase()
    const urlLower = baseUrl.toLowerCase()
    if (urlLower.includes('openrouter.ai')) {
      mode = 'openrouter'
    } else if (modelLower.includes('gemini')) {
      mode = 'gemini'
    } else if (modelLower.includes('deepseek') || modelLower.includes('-r1')) {
      mode = 'deepseek'
    } else if (modelLower.includes('qwen') || modelLower.includes('qwq')) {
      mode = 'qwen'
    } else if (modelLower.includes('claude') || modelLower.includes('anthropic')) {
      mode = 'anthropic'
    } else {
      mode = 'openai'
    }
  }

  switch (mode) {
    case 'anthropic': {
      const anthropicPayload: Record<string, unknown> = {}
      if (isAdaptiveOnlyAnthropicModel(model)) {
        anthropicPayload.thinking = { type: 'adaptive', display: 'summarized' }
        return {
          ...anthropicPayload,
          ...buildAnthropicEffortPayload(thinking),
        }
      }
      if (resolvedTokens) {
        anthropicPayload.thinking = { type: 'enabled', budget_tokens: Math.max(1024, resolvedTokens) }
      }
      return {
        ...anthropicPayload,
        ...buildAnthropicEffortPayload(thinking),
      }
    }
    case 'deepseek': {
      const payload: Record<string, unknown> = {
        reasoning: { enabled: true },
        thinking: { type: 'enabled' },
        max_completion_tokens: resolvedTokens
      }
      if (thinking.effort && ['low', 'medium', 'high'].includes(thinking.effort)) {
        payload.reasoning_effort = thinking.effort
      }
      return payload
    }
    case 'qwen': {
      const payload: Record<string, unknown> = {
        enable_thinking: true,
        max_completion_tokens: resolvedTokens
      }
      if (thinking.effort && ['low', 'medium', 'high'].includes(thinking.effort)) {
        payload.reasoning_effort = thinking.effort
      }
      return payload
    }
    case 'gemini':
      return {
        google: {
          thinking_config: {
            include_thoughts: true,
            thinking_budget: resolvedTokens || 2048
          }
        },
        thinking_config: {
          thinking_budget: resolvedTokens || 2048
        }
      }
    case 'openrouter':
      return {
        include_reasoning: true
      }
    case 'openai':
    default: {
      const payload: Record<string, unknown> = {
        reasoning: { enabled: true },
        enable_thinking: true,
        thinking: { type: 'enabled' },
        max_completion_tokens: resolvedTokens
      }
      if (thinking.effort && ['low', 'medium', 'high'].includes(thinking.effort)) {
        payload.reasoning_effort = thinking.effort
      }
      return payload
    }
  }
}
