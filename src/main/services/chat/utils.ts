import type { ThinkingConfig } from '../../../shared/types/provider'

export function buildThinkingPayload(
  thinking: ThinkingConfig | undefined,
  model: string,
  baseUrl: string,
  hasTools?: boolean
): Record<string, unknown> {
  if (!thinking?.enabled || thinking.mode === 'none') return {}

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
    case 'anthropic':
      return {
        thinking: { type: 'adaptive', display: 'summarized' }
      }
    case 'deepseek':
      return {
        reasoning: { enabled: true }
      }
    case 'qwen':
      return {
        enable_thinking: true
      }
    case 'gemini':
      return {
        google: {
          thinking_config: {
            include_thoughts: true,
            thinking_budget: 2048
          }
        },
        thinking_config: {
          thinking_budget: 2048
        }
      }
    case 'openrouter':
      return {
        include_reasoning: true
      }
    case 'openai':
    default:
      return {
        reasoning: { enabled: true },
        enable_thinking: true
      }
  }
}
