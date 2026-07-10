import type { ApiFormat, ModelConfig, ThinkingConfig, ThinkingEffort, ThinkingMode } from '../types/provider'

export type ReasoningControl = 'effort' | 'budget' | 'toggle' | 'none'

export interface ReasoningCapabilityInput {
  model: string
  apiFormat?: ApiFormat
  baseUrl: string
  mode?: ThinkingMode
}

export interface ReasoningCapabilities {
  mode: ThinkingMode
  control: ReasoningControl
  efforts: ThinkingEffort[]
  budgetPresets?: number[]
  supportsBudget?: boolean
  mandatory?: boolean
}

export function mergeModelThinkingConfig(
  defaults: ThinkingConfig,
  model?: ModelConfig
): ThinkingConfig {
  const merged: ThinkingConfig = {
    ...defaults,
    ...(model?.thinkingMode ? { mode: model.thinkingMode } : {}),
    ...(model?.thinkingEffort ? { effort: model.thinkingEffort } : {})
  }
  if (model?.thinkingBudgetTokens !== undefined) {
    merged.budgetTokens = model.thinkingBudgetTokens ?? undefined
  }
  return merged
}

export function resolveReasoningBudgetTokens(thinking: ThinkingConfig): number | undefined {
  if (thinking.budgetTokens && thinking.budgetTokens > 0) return thinking.budgetTokens
  switch (thinking.effort) {
    case 'minimal': return 512
    case 'low': return 1024
    case 'medium': return 4096
    case 'high': return 16384
    case 'xhigh': return 24576
    case 'max': return 32768
    case 'auto':
    default: return undefined
  }
}

const capability = (
  mode: ThinkingMode,
  control: ReasoningControl,
  efforts: ThinkingEffort[] = [],
  extras: Pick<ReasoningCapabilities, 'budgetPresets' | 'supportsBudget' | 'mandatory'> = {}
): ReasoningCapabilities => ({ mode, control, efforts, ...extras })

export function resolveThinkingMode(input: ReasoningCapabilityInput): ThinkingMode {
  if (input.mode && input.mode !== 'auto') return input.mode

  const model = input.model.toLowerCase()
  const baseUrl = input.baseUrl.toLowerCase()
  if (baseUrl.includes('openrouter.ai')) return 'openrouter'
  if (input.apiFormat === 'anthropic') return 'anthropic'
  if (input.apiFormat === 'gemini') return 'gemini'
  if (model.includes('gemini')) return 'gemini'
  if (model.includes('deepseek') || model.includes('-r1')) return 'deepseek'
  if (model.includes('qwen') || model.includes('qwq')) return 'qwen'
  if (model.includes('claude') || model.includes('anthropic')) return 'anthropic'
  if (model.includes('grok')) return 'grok'
  return 'openai'
}

function getOpenAICapabilities(model: string, allowGeneric: boolean): ReasoningCapabilities {
  if (model.includes('gpt-5.6')) {
    return capability('openai', 'effort', ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  }
  if (/gpt-5\.(?:4|5)/.test(model)) {
    return capability('openai', 'effort', ['none', 'low', 'medium', 'high', 'xhigh'])
  }
  if (model.includes('gpt-5')) {
    return capability('openai', 'effort', ['minimal', 'low', 'medium', 'high'])
  }
  if (/^o[134](?:-|$)/.test(model) || model.includes('gpt-oss')) {
    return capability('openai', 'effort', ['low', 'medium', 'high'])
  }
  if (allowGeneric && !model.includes('gpt-4') && !model.includes('gpt-3')) {
    return capability('openai', 'effort', ['low', 'medium', 'high'])
  }
  return capability('openai', 'none')
}

function getAnthropicCapabilities(model: string, allowGeneric: boolean): ReasoningCapabilities {
  if (/(?:fable-?5|mythos-?5|sonnet-?5|opus-?4[-.]?(?:7|8))/.test(model)) {
    return capability('anthropic', 'effort', ['low', 'medium', 'high', 'xhigh', 'max'])
  }
  if (/(?:mythos-preview|(?:opus|sonnet)-?4[-.]?6)/.test(model)) {
    return capability('anthropic', 'effort', ['low', 'medium', 'high', 'max'])
  }
  if (/opus-?4[-.]?5/.test(model)) {
    return capability('anthropic', 'effort', ['low', 'medium', 'high'], {
      budgetPresets: [1024, 4096, 8192, 16384, 32768],
      supportsBudget: true
    })
  }
  if (/claude-?3[-.]?7/.test(model) || allowGeneric) {
    return capability('anthropic', 'budget', [], {
      budgetPresets: [1024, 4096, 8192, 16384, 32768],
      supportsBudget: true
    })
  }
  return capability('anthropic', 'none')
}

function getGeminiCapabilities(
  model: string,
  apiFormat: ApiFormat | undefined,
  allowGeneric: boolean
): ReasoningCapabilities {
  if (apiFormat === 'openai') {
    const thinkingLevels = getGeminiThinkingLevels(model)
    const efforts: ThinkingEffort[] = model.includes('2.5-pro')
      ? ['minimal', 'low', 'medium', 'high']
      : model.includes('2.5')
        ? ['none', 'minimal', 'low', 'medium', 'high']
        : thinkingLevels.length > 0
          ? thinkingLevels
          : allowGeneric
            ? ['low', 'medium', 'high']
            : []
    if (efforts.length === 0) return capability('gemini', 'none')
    return capability('gemini', 'effort', efforts, {
      mandatory: !efforts.includes('none')
    })
  }

  if (model.includes('2.5')) {
    return capability('gemini', 'budget', [], {
      budgetPresets: model.includes('2.5-pro')
        ? [1024, 4096, 8192, 16384, 32768]
        : [1024, 4096, 8192, 16384, 24576],
      supportsBudget: true,
      mandatory: model.includes('2.5-pro')
    })
  }

  const efforts = getGeminiThinkingLevels(model)
  return efforts.length > 0
    ? capability('gemini', 'effort', efforts, { mandatory: true })
    : allowGeneric
      ? capability('gemini', 'toggle')
      : capability('gemini', 'none')
}

function getGeminiThinkingLevels(model: string): ThinkingEffort[] {
  if (model.includes('3.1-flash-lite-image')) return ['minimal', 'high']
  if (model.includes('3-pro')) return ['low', 'high']
  if (model.includes('3.1-pro')) return ['low', 'medium', 'high']
  if (model.includes('3')) return ['minimal', 'low', 'medium', 'high']
  return []
}

function getGrokCapabilities(model: string): ReasoningCapabilities {
  if (model.includes('4.5')) {
    return capability('grok', 'effort', ['low', 'medium', 'high'], { mandatory: true })
  }
  if (model.includes('4.3')) {
    return capability('grok', 'effort', ['none', 'low', 'medium', 'high'])
  }
  return capability('grok', 'none')
}

function getOpenRouterCapabilities(model: string): ReasoningCapabilities {
  const modelId = model.split('/').pop() || model
  let underlying: ReasoningCapabilities
  if (model.includes('claude') || model.includes('anthropic')) {
    underlying = getAnthropicCapabilities(modelId, false)
  } else if (model.includes('gemini')) {
    underlying = getGeminiCapabilities(modelId, 'openai', false)
  } else if (model.includes('deepseek') || model.includes('-r1')) {
    underlying = modelId.includes('deepseek-v4')
      ? capability('deepseek', 'effort', ['high', 'max'])
      : capability('deepseek', 'toggle')
  } else if (model.includes('qwen') || model.includes('qwq')) {
    underlying = capability('qwen', 'effort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  } else if (model.includes('grok')) {
    underlying = getGrokCapabilities(modelId)
  } else {
    underlying = getOpenAICapabilities(modelId, false)
  }

  return { ...underlying, mode: 'openrouter' }
}

export function getReasoningCapabilities(input: ReasoningCapabilityInput): ReasoningCapabilities {
  const model = input.model.trim().toLowerCase()
  const mode = resolveThinkingMode(input)

  switch (mode) {
    case 'none':
      return capability('none', 'none')
    case 'openrouter':
      return getOpenRouterCapabilities(model)
    case 'anthropic':
      return getAnthropicCapabilities(model, input.mode === 'anthropic')
    case 'gemini':
      return getGeminiCapabilities(model, input.apiFormat, input.mode === 'gemini')
    case 'deepseek':
      return model.includes('deepseek-v4')
        ? capability('deepseek', 'effort', ['high', 'max'])
        : capability('deepseek', 'toggle')
    case 'qwen':
      return capability('qwen', 'budget', [], {
        budgetPresets: [1024, 4096, 8192, 16384],
        supportsBudget: true
      })
    case 'grok':
      return getGrokCapabilities(model)
    case 'openai':
    default:
      return getOpenAICapabilities(model, input.mode === 'openai')
  }
}
