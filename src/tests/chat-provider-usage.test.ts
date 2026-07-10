import { describe, expect, it } from 'vitest'
import { extractOpenAIUsage } from '../main/services/chat/OpenAIProvider'
import { extractAnthropicUsage } from '../main/services/chat/AnthropicProvider'
import { extractGeminiUsage } from '../main/services/chat/GeminiProvider'
import { classifyProviderError } from '../main/services/chat/errors'

describe('provider usage normalization', () => {
  it('maps OpenAI, Anthropic, and Gemini usage fields', () => {
    expect(extractOpenAIUsage({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }))
      .toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 })
    expect(extractAnthropicUsage({ input_tokens: 11, output_tokens: 4 }))
      .toEqual({ inputTokens: 11, outputTokens: 4, totalTokens: 15 })
    expect(extractGeminiUsage({ promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 19 }))
      .toEqual({ inputTokens: 12, outputTokens: 5, reasoningTokens: 2, totalTokens: 19 })
  })

  it('classifies context overflow independently of one exact message', () => {
    expect(classifyProviderError(400, '{"error":{"code":"context_length_exceeded"}}')).toBe('CONTEXT_OVERFLOW')
    expect(classifyProviderError(400, 'maximum context length is 8192 tokens')).toBe('CONTEXT_OVERFLOW')
    expect(classifyProviderError(401, 'invalid key')).toBe('AUTHENTICATION')
  })
})
