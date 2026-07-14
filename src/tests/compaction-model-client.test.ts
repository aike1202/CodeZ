import { describe, expect, it, vi } from 'vitest'
import {
  ChatCompactionModelClient,
  CompactionModelError
} from '../main/services/context/CompactionModelClient'

describe('ChatCompactionModelClient', () => {
  it('disables thinking and caps output for the dedicated summary request', async () => {
    const streamChat = vi.fn(async (config: any, callbacks: any) => {
      callbacks.onUsage({ inputTokens: 100, outputTokens: 20 })
      callbacks.onDone('<summary>Continue.</summary>', 'stop')
    })
    const client = new ChatCompactionModelClient({
      baseUrl: 'https://example.invalid',
      apiKey: 'key',
      apiFormat: 'openai',
      model: 'gpt-test',
      thinking: { enabled: true, mode: 'openai', effort: 'xhigh' },
      maxOutputTokens: 50_000
    }, { streamChat } as any)

    await expect(client.generate({ coveredThroughSequence: 1, messages: [] }))
      .resolves.toMatchObject({
        text: '<summary>Continue.</summary>',
        stopReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 20 }
      })
    expect(streamChat.mock.calls[0][0]).toMatchObject({
      tools: undefined,
      maxOutputTokens: 20_000,
      thinking: { enabled: false, effort: 'none' }
    })
  })

  it('preserves the Provider error code for overflow recovery', async () => {
    const streamChat = vi.fn(async (_config: any, callbacks: any) => {
      callbacks.onError('prompt is too long', 'CONTEXT_OVERFLOW')
    })
    const client = new ChatCompactionModelClient({
      baseUrl: 'https://example.invalid', apiKey: 'key', model: 'm1'
    }, { streamChat } as any)

    await expect(client.generate({ coveredThroughSequence: 1, messages: [] }))
      .rejects.toMatchObject({
        message: 'prompt is too long',
        providerCode: 'CONTEXT_OVERFLOW'
      } satisfies Partial<CompactionModelError>)
  })
})
