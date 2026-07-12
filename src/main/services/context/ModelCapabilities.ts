import type { ModelConfig, ModelContextCapabilities } from '../../../shared/types/provider'

export function defaultMaxOutputTokens(contextWindowTokens: number): number {
  const window = Math.max(2, Math.floor(contextWindowTokens))
  const proportional = Math.min(8192, Math.max(1024, Math.floor(window * 0.2)))
  return Math.min(proportional, Math.max(1, Math.floor(window * 0.5)))
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  const normalized = Math.floor(value)
  if (!Number.isFinite(value) || normalized < 1) {
    throw new Error(`${field} must be a positive token count or left empty`)
  }
  return normalized
}

export function resolveModelContextCapabilities(
  model: ModelConfig | undefined
): ModelContextCapabilities {
  if (!model) throw new Error('Selected model is not present in the provider configuration')
  if (!Number.isFinite(model.maxContextTokens) || model.maxContextTokens <= 0) {
    throw new Error(`Model ${model.name} requires a positive context window configuration`)
  }

  const contextWindowTokens = Math.floor(model.maxContextTokens)
  const maxInputTokens = optionalPositiveInteger(model.maxInputTokens, 'maxInputTokens')
  const maxOutputTokens = optionalPositiveInteger(model.maxOutputTokens, 'maxOutputTokens') ??
    defaultMaxOutputTokens(contextWindowTokens)
  if (maxInputTokens && maxInputTokens > contextWindowTokens) {
    throw new Error('maxInputTokens cannot exceed the model context window')
  }
  if (maxOutputTokens && maxOutputTokens >= contextWindowTokens) {
    throw new Error('maxOutputTokens must be smaller than the model context window')
  }

  return {
    contextWindowTokens,
    ...(maxInputTokens ? { maxInputTokens } : {}),
    maxOutputTokens,
    ...(model.reasoningCountsAgainstContext !== undefined
      ? { reasoningCountsAgainstContext: model.reasoningCountsAgainstContext }
      : {})
  }
}
