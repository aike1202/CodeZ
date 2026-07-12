import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatProviderFactory } from '../main/services/chat/ChatProviderFactory'
import { ToolCallAssembler } from '../main/tools/runtime/ToolCallAssembler'

afterEach(() => { vi.unstubAllGlobals() })

const fixtures = [
  {
    provider: 'openai' as const,
    apiFormat: 'openai',
    body: [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"openai-call","function":{"name":"Read","arguments":"{\\"files\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[{\\"file_path\\":\\"a.ts\\"}]}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]', ''
    ].join('\n'),
    expected: { name: 'Read', input: { files: [{ file_path: 'a.ts' }] } }
  },
  {
    provider: 'anthropic' as const,
    apiFormat: 'anthropic',
    body: [
      'event: content_block_start',
      'data: {"content_block":{"type":"tool_use","id":"anthropic-call","name":"Glob"}}',
      '',
      'event: content_block_delta',
      'data: {"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"**/*.ts\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {}',
      '',
      'event: message_delta',
      'data: {"delta":{"stop_reason":"tool_use"}}',
      ''
    ].join('\n'),
    expected: { name: 'Glob', input: { pattern: '**/*.ts' } }
  },
  {
    provider: 'gemini' as const,
    apiFormat: 'gemini',
    body: [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Grep","args":{"pattern":"needle"}},"thoughtSignature":"sig"}]},"finishReason":"STOP"}]}',
      'data: [DONE]', ''
    ].join('\n'),
    expected: { name: 'Grep', input: { pattern: 'needle' } }
  }
]

describe('Provider tool call fixtures', () => {
  for (const fixture of fixtures) {
    it(`assembles ${fixture.provider} streaming fragments into the canonical call`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })))
      const assembler = new ToolCallAssembler(`${fixture.provider}-fixture`)
      const provider = ChatProviderFactory.createProvider({
        baseUrl: 'https://provider.example/v1', apiKey: 'key', model: 'model',
        apiFormat: fixture.apiFormat, messages: [{ role: 'user', content: 'use a tool' }]
      })
      await provider.streamChat({
        baseUrl: 'https://provider.example/v1', apiKey: 'key', model: 'model',
        apiFormat: fixture.apiFormat, messages: [{ role: 'user', content: 'use a tool' }]
      }, {
        onChunk: (_delta, _reasoning, chunks, thoughtSignature) => {
          for (const chunk of chunks || []) {
            assembler.push({
              provider: fixture.provider,
              position: chunk.index,
              callId: chunk.id,
              nameDelta: chunk.function?.name,
              argumentsDelta: chunk.function?.arguments,
              thoughtSignature: chunk.thought_signature || thoughtSignature
            })
          }
        },
        onDone: () => undefined,
        onError: (error) => { throw new Error(error) }
      }, new AbortController().signal)

      const [call] = assembler.finalize()
      expect(call.name).toBe(fixture.expected.name)
      expect(JSON.parse(call.rawArguments)).toEqual(fixture.expected.input)
    })
  }
})
