import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider, openAIOutputLimitPayload } from '../main/services/chat/OpenAIProvider'
import { AnthropicProvider } from '../main/services/chat/AnthropicProvider'
import { GeminiProvider } from '../main/services/chat/GeminiProvider'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function capturePayload(provider: { streamChat: Function }, config: Record<string, unknown>) {
  let payload: any
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    payload = JSON.parse(String(init.body))
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }))
  await provider.streamChat({
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'key',
    model: 'model',
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 2345,
    ...config
  }, {
    onChunk: () => undefined,
    onDone: () => undefined,
    onError: (error: string) => { throw new Error(error) }
  }, new AbortController().signal)
  return payload
}

describe('provider output limits', () => {
  it('uses max_completion_tokens for official OpenAI reasoning models only', () => {
    expect(openAIOutputLimitPayload('gpt-5', 'https://api.openai.com/v1', 1234))
      .toEqual({ max_completion_tokens: 1234 })
    expect(openAIOutputLimitPayload(
      'o3',
      'https://example-resource.openai.azure.com/openai/deployments/o3',
      1234
    )).toEqual({ max_completion_tokens: 1234 })
    expect(openAIOutputLimitPayload('gpt-5', 'https://gateway.example/v1', 1234))
      .toEqual({ max_tokens: 1234 })
  })

  it('passes configured output limits to OpenAI, Anthropic, and Gemini payloads', async () => {
    const openai = await capturePayload(new OpenAIProvider(), {})
    const anthropic = await capturePayload(new AnthropicProvider(), { apiFormat: 'anthropic' })
    const gemini = await capturePayload(new GeminiProvider(), { apiFormat: 'gemini' })

    expect(openai.max_tokens).toBe(2345)
    expect(anthropic.max_tokens).toBe(2345)
    expect(gemini.generationConfig.maxOutputTokens).toBe(2345)
  })

  it('adds the explicit Anthropic thinking budget to the visible output limit', async () => {
    const anthropic = await capturePayload(new AnthropicProvider(), {
      apiFormat: 'anthropic',
      thinking: { enabled: true, mode: 'anthropic', budgetTokens: 4096 }
    })

    expect(anthropic.max_tokens).toBe(2345 + 4096)
    expect(anthropic.thinking).toMatchObject({ budget_tokens: 4096 })
  })
})
