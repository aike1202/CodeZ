import { describe, expect, it } from 'vitest'
import { evaluateModelDownshiftCompaction } from '../main/services/context/ModelDownshiftPolicy'
import { fingerprintProviderRequest } from '../main/services/context/ProviderUsageRequestFingerprint'
import type { SessionRuntimeScopeSnapshot } from '../shared/types/context'

function scope(content: string): SessionRuntimeScopeSnapshot {
  return {
    historyVersion: 1,
    activeMessages: [{
      id: 'u1', turnId: 't1', role: 'user', content,
      status: 'complete', createdAt: '2026-07-10T00:00:00.000Z', sourceSequence: 1
    }],
    lastModel: 'large-model'
  }
}

describe('model downshift trigger policy', () => {
  it('requires preflight compaction for persisted history near the new model budget', async () => {
    const result = await evaluateModelDownshiftCompaction({
      previousModel: 'large-model',
      nextModel: 'small-model',
      scope: scope('H'.repeat(30_000)),
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })
    expect(result.required).toBe(true)
    expect(result.budget?.currentInputTokens).toBe(0)
  })

  it('does not compact when the model is unchanged or persisted history fits', async () => {
    expect((await evaluateModelDownshiftCompaction({
      previousModel: 'same', nextModel: 'same', scope: scope('H'.repeat(30_000)),
      capabilities: { contextWindowTokens: 10_000 }, systemPrompt: 'system'
    })).required).toBe(false)
    expect((await evaluateModelDownshiftCompaction({
      previousModel: 'large', nextModel: 'small', scope: scope('short'),
      capabilities: { contextWindowTokens: 10_000 }, systemPrompt: 'system'
    })).required).toBe(false)
  })

  it('treats a provider-only switch as a context identity change', async () => {
    const result = await evaluateModelDownshiftCompaction({
      previousProviderId: 'provider-large',
      nextProviderId: 'provider-small',
      previousModel: 'same-model',
      nextModel: 'same-model',
      scope: scope('H'.repeat(30_000)),
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })

    expect(result.required).toBe(true)
  })

  it('preflights an unchanged model when its configured budget no longer fits', async () => {
    const result = await evaluateModelDownshiftCompaction({
      previousProviderId: 'provider',
      nextProviderId: 'provider',
      previousModel: 'same-model',
      nextModel: 'same-model',
      scope: scope('H'.repeat(40_000)),
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })

    expect(result.budget?.pressureLevel).toBe('overflow')
    expect(result.required).toBe(true)
  })

  it('counts tool schemas and runtime instructions in the preflight budget', async () => {
    const result = await evaluateModelDownshiftCompaction({
      previousModel: 'large-model',
      nextModel: 'small-model',
      scope: scope('short'),
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system',
      toolSchemas: [{ description: 'T'.repeat(28_000) }],
      instructions: ['runtime reminder']
    })

    expect(result.budget?.toolSchemaTokens).toBeGreaterThan(6_000)
    expect(result.budget?.instructionTokens).toBeGreaterThan(0)
    expect(result.required).toBe(true)
  })

  it('uses a matching provider usage anchor for same-identity budget shrink checks', async () => {
    const anchored = scope('short')
    anchored.lastProviderId = 'provider'
    anchored.lastModel = 'same-model'
    anchored.lastProviderUsage = { inputTokens: 8_000, outputTokens: 100, totalTokens: 8_100 }
    anchored.activeMessages.push({
      id: 'a1', turnId: 't1', role: 'assistant', content: 'answer',
      status: 'complete', createdAt: '2026-07-10T00:00:01.000Z', sourceSequence: 2
    })
    anchored.historyVersion = 2
    anchored.lastProviderUsageMessageId = 'a1'
    anchored.lastProviderUsageProviderId = 'provider'
    anchored.lastProviderUsageModel = 'same-model'
    anchored.lastProviderUsageRequestFingerprint = fingerprintProviderRequest({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'short' }
      ],
      toolSchemas: []
    })

    const result = await evaluateModelDownshiftCompaction({
      previousProviderId: 'provider',
      nextProviderId: 'provider',
      previousModel: 'same-model',
      nextModel: 'same-model',
      scope: anchored,
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })

    expect(result.budget?.estimateSource).toBe('provider')
    expect(result.required).toBe(true)

    anchored.lastProviderUsageRequestFingerprint = '0'.repeat(64)
    const mismatched = await evaluateModelDownshiftCompaction({
      previousProviderId: 'provider', nextProviderId: 'provider',
      previousModel: 'same-model', nextModel: 'same-model',
      scope: anchored,
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })
    expect(mismatched.budget?.estimateSource).not.toBe('provider')
  })
})
