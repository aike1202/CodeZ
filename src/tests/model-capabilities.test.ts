import { describe, expect, it } from 'vitest'
import { resolveModelContextCapabilities } from '../main/services/context/ModelCapabilities'

describe('resolveModelContextCapabilities', () => {
  it('keeps explicit input and output limits visible to the budget service', () => {
    expect(resolveModelContextCapabilities({
      id: 'm1',
      name: 'large',
      maxContextTokens: 1_000_000,
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      reasoningCountsAgainstContext: true
    })).toEqual({
      contextWindowTokens: 1_000_000,
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      reasoningCountsAgainstContext: true
    })
  })

  it('resolves a deterministic provider output limit when the field is left automatic', () => {
    expect(resolveModelContextCapabilities({
      id: 'm1', name: 'automatic', maxContextTokens: 1_000_000
    }).maxOutputTokens).toBe(8_192)
    expect(resolveModelContextCapabilities({
      id: 'm2', name: 'small', maxContextTokens: 10_000
    }).maxOutputTokens).toBe(2_000)
  })

  it('rejects missing and zero context configurations instead of silently using 32K', () => {
    expect(() => resolveModelContextCapabilities(undefined)).toThrow('not present')
    expect(() => resolveModelContextCapabilities({
      id: 'm1', name: 'unknown', maxContextTokens: 0
    })).toThrow('positive context window')
  })

  it('rejects impossible explicit limits', () => {
    expect(() => resolveModelContextCapabilities({
      id: 'm1', name: 'bad-input', maxContextTokens: 10_000, maxInputTokens: 20_000
    })).toThrow('cannot exceed')
    expect(() => resolveModelContextCapabilities({
      id: 'm2', name: 'bad-output', maxContextTokens: 10_000, maxOutputTokens: 10_000
    })).toThrow('must be smaller')
    expect(() => resolveModelContextCapabilities({
      id: 'm3', name: 'fractional-input', maxContextTokens: 10_000, maxInputTokens: 0.5
    })).toThrow('positive token count')
  })
})
