import { describe, expect, it } from 'vitest'
import { evaluateModelDownshiftCompaction } from '../main/services/context/ModelDownshiftPolicy'
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
  it('requires preflight compaction for persisted history near the new model budget', () => {
    const result = evaluateModelDownshiftCompaction({
      previousModel: 'large-model',
      nextModel: 'small-model',
      scope: scope('H'.repeat(30_000)),
      capabilities: { contextWindowTokens: 10_000, maxOutputTokens: 2_000 },
      systemPrompt: 'system'
    })
    expect(result.required).toBe(true)
    expect(result.budget?.currentInputTokens).toBe(0)
  })

  it('does not compact when the model is unchanged or persisted history fits', () => {
    expect(evaluateModelDownshiftCompaction({
      previousModel: 'same', nextModel: 'same', scope: scope('H'.repeat(30_000)),
      capabilities: { contextWindowTokens: 10_000 }, systemPrompt: 'system'
    }).required).toBe(false)
    expect(evaluateModelDownshiftCompaction({
      previousModel: 'large', nextModel: 'small', scope: scope('short'),
      capabilities: { contextWindowTokens: 10_000 }, systemPrompt: 'system'
    }).required).toBe(false)
  })
})
