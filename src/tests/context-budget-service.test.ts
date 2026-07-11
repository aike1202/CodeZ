import { describe, expect, it } from 'vitest'
import { ContextBudgetService } from '../main/services/context/ContextBudgetService'

describe('ContextBudgetService', () => {
  const service = new ContextBudgetService()

  it('subtracts output reserve and a clamped 3 percent safety margin', () => {
    const limits = service.resolveLimits({ contextWindowTokens: 10_000, maxOutputTokens: 2_000 })
    expect(limits.hardInputLimit).toBe(8_000)
    expect(limits.safetyMarginTokens).toBe(256)
    expect(limits.usableInputBudget).toBe(7_744)
  })

  it('does not subtract output twice from an explicit input limit', () => {
    const limits = service.resolveLimits({
      contextWindowTokens: 10_000,
      maxInputTokens: 9_000,
      maxOutputTokens: 2_000
    })
    expect(limits.hardInputLimit).toBe(9_000)
  })

  it.each([
    [0.69, 'normal'], [0.70, 'warning'], [0.80, 'prune'], [0.90, 'compact']
  ] as const)('maps ratio %s to %s', (ratio, level) => {
    expect(service.pressureLevel(ratio)).toBe(level)
  })

  it('uses the token-based recent-tail formula', () => {
    expect(service.recentTailBudget(20_000)).toBe(5_000)
    expect(service.recentTailBudget(100_000)).toBe(8_000)
  })

  it('counts all request components in the budget snapshot', () => {
    const snapshot = service.measureRequest({
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system',
      toolSchemas: [{ name: 'Read' }],
      instructions: ['rule'],
      summary: 'summary',
      recentHistory: ['history'],
      currentInput: 'input',
      historyVersion: 3
    })
    expect(snapshot.totalInputTokens).toBe(
      snapshot.systemPromptTokens + snapshot.toolSchemaTokens + snapshot.instructionTokens +
      snapshot.protocolTokens + snapshot.summaryTokens + snapshot.recentHistoryTokens +
      snapshot.currentInputTokens + snapshot.providerAdjustmentTokens
    )
    expect(snapshot.historyVersion).toBe(3)
  })

  it('replaces the estimate with provider-reported input usage', () => {
    const estimated = service.measureRequest({
      capabilities: {
        contextWindowTokens: 200_000,
        maxInputTokens: 191_800,
        maxOutputTokens: 8_200
      },
      systemPrompt: 'system',
      recentHistory: ['short history'],
      currentInput: 'input',
      historyVersion: 4
    })

    const actual = service.applyProviderUsage(estimated, {
      inputTokens: 295_000,
      outputTokens: 20,
      totalTokens: 295_020
    })

    expect(actual.totalInputTokens).toBe(295_000)
    expect(actual.providerAdjustmentTokens).toBe(295_000 - estimated.totalInputTokens)
    expect(actual.estimateSource).toBe('provider')
    expect(actual.pressureLevel).toBe('overflow')
    expect(actual.rawHistoryTokens).toBe(estimated.rawHistoryTokens)
  })
})
