import type {
  ModelContextCapabilities,
  ProviderTokenUsage
} from '../../../shared/types/provider'
import type {
  ContextBudgetSnapshot,
  ContextPressureLevel
} from '../../../shared/types/context'
import type { ImageAttachment } from '../../../shared/types/attachment'

const CJK_REGEX = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function serialize(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export interface ContextLimits {
  hardInputLimit: number
  usableInputBudget: number
  outputReserveTokens: number
  safetyMarginTokens: number
}

export interface MeasureRequestInput {
  capabilities: ModelContextCapabilities
  systemPrompt: string
  toolSchemas?: unknown[]
  instructions?: string[]
  summary?: string
  recentHistory?: unknown[]
  rawHistoryTokens?: number
  currentInput: string
  currentAttachments?: Array<Pick<ImageAttachment, 'width' | 'height'>>
  historyVersion: number
  providerUsage?: ProviderTokenUsage
  reasoningBudgetTokens?: number
  projectedAdditionalTokens?: number
}

export class ContextBudgetService {
  estimateStringTokens(text: string): number {
    if (!text) return 0
    const cjkCount = text.match(CJK_REGEX)?.length || 0
    return Math.ceil(cjkCount / 1.5 + (text.length - cjkCount) / 4)
  }

  estimateValueTokens(value: unknown): number {
    const attachments = value && typeof value === 'object' && Array.isArray((value as any).attachments)
      ? (value as any).attachments as Array<Pick<ImageAttachment, 'width' | 'height'>>
      : []
    return this.estimateStringTokens(serialize(value)) + attachments.reduce(
      (total, image) => total + this.estimateImageTokens(image), 0
    )
  }

  estimateImageTokens(image: Pick<ImageAttachment, 'width' | 'height'>): number {
    const tiles = Math.max(1, Math.ceil(image.width / 512) * Math.ceil(image.height / 512))
    return 85 + tiles * 170
  }

  resolveLimits(
    capabilities: ModelContextCapabilities,
    reasoningBudgetTokens = 0
  ): ContextLimits {
    const contextWindowTokens = Math.max(1, Math.floor(capabilities.contextWindowTokens || 1))
    const defaultReserve = Math.min(
      clamp(Math.floor(contextWindowTokens * 0.2), 1024, 8192),
      Math.max(1, Math.floor(contextWindowTokens * 0.5))
    )
    const ordinaryReserve = Math.max(1, Math.floor(capabilities.maxOutputTokens || defaultReserve))
    const reasoningReserve = capabilities.reasoningCountsAgainstContext
      ? Math.max(0, Math.floor(reasoningBudgetTokens))
      : 0
    const outputReserveTokens = Math.min(
      contextWindowTokens - 1,
      ordinaryReserve + reasoningReserve
    )
    const hardInputLimit = Math.max(1, Math.floor(
      capabilities.maxInputTokens ?? contextWindowTokens - outputReserveTokens
    ))
    const safetyMarginTokens = Math.min(
      Math.max(0, hardInputLimit - 1),
      clamp(Math.floor(hardInputLimit * 0.03), 256, 2048)
    )
    return {
      hardInputLimit,
      usableInputBudget: Math.max(1, hardInputLimit - safetyMarginTokens),
      outputReserveTokens,
      safetyMarginTokens
    }
  }

  pressureLevel(ratio: number, projectedOverflow = false): ContextPressureLevel {
    if (ratio > 1) return 'overflow'
    if (projectedOverflow || ratio >= 0.9) return 'compact'
    if (ratio >= 0.8) return 'prune'
    if (ratio >= 0.7) return 'warning'
    return 'normal'
  }

  recentTailBudget(usableInputBudget: number): number {
    return Math.floor(Math.min(
      usableInputBudget * 0.35,
      clamp(usableInputBudget * 0.25, 1000, 8000)
    ))
  }

  measureRequest(input: MeasureRequestInput): ContextBudgetSnapshot {
    const limits = this.resolveLimits(input.capabilities, input.reasoningBudgetTokens)
    const systemPromptTokens = this.estimateStringTokens(input.systemPrompt)
    const toolSchemaTokens = (input.toolSchemas || []).reduce<number>(
      (total, schema) => total + this.estimateValueTokens(schema), 0
    )
    const instructionTokens = (input.instructions || []).reduce(
      (total, instruction) => total + this.estimateStringTokens(instruction), 0
    )
    const summaryTokens = this.estimateStringTokens(input.summary || '')
    const recentHistoryTokens = (input.recentHistory || []).reduce<number>(
      (total, message) => total + this.estimateValueTokens(message), 0
    )
    const currentInputTokens = this.estimateStringTokens(input.currentInput) +
      (input.currentAttachments || []).reduce(
        (total, image) => total + this.estimateImageTokens(image), 0
      )
    let protocolTokens = 4 * ((input.recentHistory?.length || 0) + 1)
    let totalInputTokens = systemPromptTokens + toolSchemaTokens + instructionTokens +
      protocolTokens + summaryTokens + recentHistoryTokens + currentInputTokens
    let estimateSource: ContextBudgetSnapshot['estimateSource'] = 'heuristic'

    if (input.providerUsage && input.providerUsage.inputTokens >= totalInputTokens) {
      protocolTokens += input.providerUsage.inputTokens - totalInputTokens
      totalInputTokens = input.providerUsage.inputTokens
      estimateSource = 'provider'
    }

    const projected = totalInputTokens + Math.max(0, input.projectedAdditionalTokens || 0)
    return {
      ...limits,
      systemPromptTokens,
      toolSchemaTokens,
      instructionTokens,
      protocolTokens,
      summaryTokens,
      recentHistoryTokens,
      rawHistoryTokens: input.rawHistoryTokens ?? recentHistoryTokens,
      currentInputTokens,
      totalInputTokens,
      providerAdjustmentTokens: 0,
      pressureLevel: this.pressureLevel(
        totalInputTokens / limits.usableInputBudget,
        projected > limits.hardInputLimit
      ),
      estimateSource,
      historyVersion: input.historyVersion
    }
  }

  applyProviderUsage(
    snapshot: ContextBudgetSnapshot,
    usage: ProviderTokenUsage
  ): ContextBudgetSnapshot {
    if (!Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0) return snapshot

    const totalInputTokens = Math.floor(usage.inputTokens)
    const providerAdjustmentTokens = snapshot.providerAdjustmentTokens +
      totalInputTokens - snapshot.totalInputTokens

    return {
      ...snapshot,
      totalInputTokens,
      providerAdjustmentTokens,
      pressureLevel: this.pressureLevel(totalInputTokens / snapshot.usableInputBudget),
      estimateSource: 'provider'
    }
  }

  assertCurrentInputFits(
    currentInput: string,
    capabilities: ModelContextCapabilities,
    attachments: Array<Pick<ImageAttachment, 'width' | 'height'>> = []
  ): void {
    const tokens = this.estimateStringTokens(currentInput) + attachments.reduce(
      (total, image) => total + this.estimateImageTokens(image), 0
    )
    const { hardInputLimit } = this.resolveLimits(capabilities)
    if (tokens > hardInputLimit) {
      throw Object.assign(new Error('Current input exceeds the model input limit'), {
        code: 'CURRENT_INPUT_TOO_LARGE',
        tokens,
        hardInputLimit
      })
    }
  }
}
