import type {
  ApiFormat,
  ModelConfig,
  ProviderConfig,
  ThinkingConfig
} from '../../shared/types/provider'
import type { SubAgentModelSelection } from '../../shared/types/subagent'
import { getProviderService } from '../ipc/provider.handlers'
import type { SubAgentContext, SubAgentDefinition } from './SubAgentManager'

interface ResolvedModel {
  provider: ProviderConfig
  apiKey: string
  model: ModelConfig
  apiFormat: ApiFormat
}

function resolveThinking(model: ModelConfig, fallback: ThinkingConfig): ThinkingConfig {
  const thinking: ThinkingConfig = { ...fallback }
  if (model.thinkingMode) thinking.mode = model.thinkingMode
  if (model.thinkingEffort) thinking.effort = model.thinkingEffort
  if (model.thinkingBudgetTokens === null) delete thinking.budgetTokens
  else if (model.thinkingBudgetTokens !== undefined) {
    thinking.budgetTokens = model.thinkingBudgetTokens
  }
  return thinking
}

function resolveCandidate(selection: SubAgentModelSelection): ResolvedModel | undefined {
  const service = getProviderService()
  const provider = service.getConfig(selection.providerId)
  const model = provider?.models.find((item) => item.name === selection.model)
  const apiKey = provider ? service.getApiKey(provider.id) : null
  if (!provider || !model || apiKey === null) return undefined
  return {
    provider,
    apiKey,
    model,
    apiFormat: model.apiFormat || provider.apiFormat || 'openai'
  }
}

export function resolveSubAgentModelContext(
  def: SubAgentDefinition,
  ctx: SubAgentContext,
  configuredModels: SubAgentModelSelection[]
): SubAgentContext {
  let resolved: ResolvedModel | undefined
  if (configuredModels.length > 0) {
    resolved = configuredModels.map(resolveCandidate).find(Boolean)
    if (!resolved) {
      throw new Error(
        `Configured models for subagent '${def.type}' are unavailable. Update them in Settings > Agents.`
      )
    }
  }
  if (!resolved) return ctx

  const { provider, model, apiKey, apiFormat } = resolved
  const contextCapabilities = {
    contextWindowTokens: model.maxContextTokens,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    reasoningCountsAgainstContext: model.reasoningCountsAgainstContext
  }
  return {
    ...ctx,
    providerId: provider.id,
    modelOverride: model.name,
    contextCapabilities,
    apiConfig: {
      ...ctx.apiConfig,
      baseUrl: provider.baseUrl,
      apiKey,
      apiFormat,
      model: model.name,
      thinking: resolveThinking(model, provider.thinking),
      contextWindowTokens: contextCapabilities.contextWindowTokens,
      maxInputTokens: contextCapabilities.maxInputTokens,
      maxOutputTokens: contextCapabilities.maxOutputTokens,
      reasoningCountsAgainstContext: contextCapabilities.reasoningCountsAgainstContext
    }
  }
}
