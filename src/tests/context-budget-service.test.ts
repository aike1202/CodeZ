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

  it('reserves an Anthropic thinking budget in addition to visible output', () => {
    const limits = service.resolveLimits({
      contextWindowTokens: 10_000,
      maxOutputTokens: 2_000,
      reasoningCountsAgainstContext: true
    }, 1_000)
    expect(limits.outputReserveTokens).toBe(3_000)
    expect(limits.hardInputLimit).toBe(7_000)
  })

  it('uses the reasoning reserve when validating a single current input', () => {
    expect(() => service.assertCurrentInputFits(
      'A'.repeat(25_000),
      {
        contextWindowTokens: 10_000,
        maxOutputTokens: 2_000,
        reasoningCountsAgainstContext: true
      },
      [],
      2_000
    )).toThrowError(expect.objectContaining({ code: 'CURRENT_INPUT_TOO_LARGE' }))
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

  it('includes conservative image tokens in current input and history', () => {
    const image = { width: 1024, height: 1024 }
    expect(service.estimateImageTokens(image)).toBeGreaterThan(0)
    const snapshot = service.measureRequest({
      capabilities: { contextWindowTokens: 20_000 },
      systemPrompt: '',
      recentHistory: [],
      currentInput: '',
      currentAttachments: [image],
      historyVersion: 1
    })
    expect(snapshot.currentInputTokens).toBe(service.estimateImageTokens(image))
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

  it('waits until about 977K tokens before compacting a 1M context', () => {
    const capabilities = { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 }
    const before = service.measureRequest({
      capabilities,
      systemPrompt: '',
      currentInput: '',
      historyVersion: 1,
      providerUsage: { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 }
    })
    const atThreshold = service.measureRequest({
      capabilities,
      systemPrompt: '',
      currentInput: '',
      historyVersion: 1,
      providerUsage: { inputTokens: 976_760, outputTokens: 0, totalTokens: 976_760 }
    })

    expect(before.usableInputBudget).toBe(989_760)
    expect(before.pressureLevel).toBe('normal')
    expect(atThreshold.pressureLevel).toBe('compact')
  })

  it('applies the absolute thresholds to provider input usage shown in the UI', () => {
    const estimated = service.measureRequest({
      capabilities: { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 },
      systemPrompt: '',
      currentInput: '',
      historyVersion: 1
    })

    const belowWarning = service.applyProviderUsage(estimated, {
      inputTokens: 900_000,
      outputTokens: 10_000,
      totalTokens: 910_000
    })
    const atCompact = service.applyProviderUsage(estimated, {
      inputTokens: 976_760,
      outputTokens: 10_000,
      totalTokens: 986_760
    })

    expect(service.pressureLevel(900_000 / estimated.usableInputBudget)).toBe('compact')
    expect(belowWarning.pressureLevel).toBe('normal')
    expect(atCompact.pressureLevel).toBe('compact')
  })

  it('keeps absolute pressure thresholds ordered for a small context', () => {
    const capabilities = { contextWindowTokens: 10_000, maxOutputTokens: 2_000 }
    const measure = (totalTokens: number) => service.measureRequest({
      capabilities,
      systemPrompt: '',
      currentInput: '',
      historyVersion: 1,
      providerUsage: { inputTokens: totalTokens, outputTokens: 0, totalTokens }
    }).pressureLevel

    expect(measure(4_743)).toBe('normal')
    expect(measure(4_744)).toBe('warning')
    expect(measure(5_744)).toBe('prune')
    expect(measure(6_744)).toBe('compact')
    expect(measure(7_745)).toBe('overflow')
  })

  it('uses provider input plus visible output and newly added tokens as the next baseline', () => {
    const snapshot = service.measureRequest({
      capabilities: { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 },
      systemPrompt: 'short system prompt',
      recentHistory: ['short history'],
      currentInput: 'next input',
      historyVersion: 7,
      providerUsage: {
        inputTokens: 80_000,
        outputTokens: 20_000,
        reasoningTokens: 5_000,
        totalTokens: 110_000
      },
      providerUsageAdditionalTokens: 2_500
    })
    const localTokens = snapshot.systemPromptTokens + snapshot.toolSchemaTokens +
      snapshot.instructionTokens + snapshot.protocolTokens + snapshot.summaryTokens +
      snapshot.recentHistoryTokens + snapshot.currentInputTokens

    expect(snapshot.totalInputTokens).toBe(102_500)
    expect(snapshot.providerAdjustmentTokens).toBe(102_500 - localTokens)
    expect(snapshot.estimateSource).toBe('provider')
    expect(snapshot.pressureLevel).toBe('normal')
  })

  it('ignores provider total and hidden reasoning tokens when rebuilding the next request', () => {
    const snapshot = service.measureRequest({
      capabilities: { contextWindowTokens: 100_000, maxOutputTokens: 8_000 },
      systemPrompt: '',
      currentInput: '',
      historyVersion: 2,
      providerUsage: {
        inputTokens: 40_000,
        outputTokens: 3_000,
        reasoningTokens: 2_000,
        totalTokens: Number.NaN
      },
      providerUsageAdditionalTokens: 500
    })

    expect(snapshot.totalInputTokens).toBe(43_500)
    expect(snapshot.estimateSource).toBe('provider')
  })

  it('uses a valid provider baseline below the local heuristic estimate', () => {
    const snapshot = service.measureRequest({
      capabilities: { contextWindowTokens: 100_000, maxOutputTokens: 8_000 },
      systemPrompt: 'S'.repeat(20_000),
      recentHistory: ['H'.repeat(20_000)],
      currentInput: 'next input',
      historyVersion: 3,
      providerUsage: {
        inputTokens: 1_000,
        outputTokens: 100,
        reasoningTokens: 5_000,
        totalTokens: 6_100
      },
      providerUsageAdditionalTokens: 50
    })
    const localTokens = snapshot.systemPromptTokens + snapshot.toolSchemaTokens +
      snapshot.instructionTokens + snapshot.protocolTokens + snapshot.summaryTokens +
      snapshot.recentHistoryTokens + snapshot.currentInputTokens

    expect(localTokens).toBeGreaterThan(1_150)
    expect(snapshot.totalInputTokens).toBe(1_150)
    expect(snapshot.providerAdjustmentTokens).toBe(1_150 - localTokens)
    expect(snapshot.providerAdjustmentTokens).toBeLessThan(0)
    expect(snapshot.estimateSource).toBe('provider')
  })

  it('does not replace the heuristic estimate with an invalid provider anchor', () => {
    const snapshot = service.measureRequest({
      capabilities: { contextWindowTokens: 100_000 },
      systemPrompt: 'system',
      currentInput: 'input',
      historyVersion: 4,
      providerUsage: {
        inputTokens: Number.NaN,
        outputTokens: 100,
        totalTokens: 100
      }
    })

    expect(snapshot.totalInputTokens).toBeGreaterThan(0)
    expect(snapshot.providerAdjustmentTokens).toBe(0)
    expect(snapshot.estimateSource).toBe('heuristic')
  })
})
