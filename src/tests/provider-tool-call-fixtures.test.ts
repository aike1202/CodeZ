import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatProviderFactory } from '../main/services/chat/ChatProviderFactory'
import { ToolCallAssembler } from '../main/tools/runtime/ToolCallAssembler'
import type { AgentStopReason, ToolDefinition } from '../shared/types/provider'
import providerGolden from './fixtures/migration/provider-protocol-golden.json'

afterEach(() => { vi.unstubAllGlobals() })

type ProviderFixture = {
  provider: 'openai' | 'anthropic' | 'gemini'
  apiFormat: string
  baseUrl: string
  model: string
  tool: ToolDefinition
  expectedRequest: {
    url: string
    headers: Record<string, string>
    body: unknown
  }
  streamLines: string[]
  expectedCanonicalCall: { name: string; input: unknown }
  expectedStopReason: AgentStopReason
}

const fixtures = providerGolden.fixtures as unknown as ProviderFixture[]

function redactRequest(
  input: string | URL | Request,
  init?: RequestInit
): ProviderFixture['expectedRequest'] {
  const rawHeaders = { ...(init?.headers as Record<string, string> | undefined) }
  for (const key of Object.keys(rawHeaders)) {
    if (key.toLowerCase() === 'authorization') rawHeaders[key] = 'Bearer [REDACTED]'
    if (key.toLowerCase() === 'x-api-key') rawHeaders[key] = '[REDACTED]'
  }
  return {
    url: String(input).replace(/([?&]key=)[^&]+/, '$1[REDACTED]'),
    headers: rawHeaders,
    body: JSON.parse(String(init?.body || '{}'))
  }
}

async function runFixture(fixture: ProviderFixture) {
  let request: ProviderFixture['expectedRequest'] | undefined
  let stopReason: AgentStopReason | undefined
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    request = redactRequest(input, init)
    return new Response(fixture.streamLines.join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }))
  const assembler = new ToolCallAssembler(`${fixture.provider}-fixture`)
  const config = {
    baseUrl: fixture.baseUrl,
    apiKey: 'fixture-secret',
    model: fixture.model,
    apiFormat: fixture.apiFormat,
    messages: [
      { role: 'system' as const, content: 'You are a fixture.' },
      { role: 'user' as const, content: 'use a tool' }
    ],
    tools: [fixture.tool],
    maxOutputTokens: 256
  }
  const provider = ChatProviderFactory.createProvider(config)
  await provider.streamChat(config, {
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
    onDone: (_content, reason) => { stopReason = reason },
    onError: (error) => { throw new Error(error) }
  }, new AbortController().signal)

  const [call] = assembler.finalize()
  return {
    request,
    stopReason,
    canonicalCall: { name: call.name, input: JSON.parse(call.rawArguments) }
  }
}

describe('Provider tool call fixtures', () => {
  for (const fixture of fixtures) {
    it(`keeps the redacted ${fixture.provider} request envelope stable`, async () => {
      expect((await runFixture(fixture)).request).toEqual(fixture.expectedRequest)
    })

    it(`assembles ${fixture.provider} streaming fragments into the canonical call`, async () => {
      expect((await runFixture(fixture)).canonicalCall).toEqual(fixture.expectedCanonicalCall)
    })

    it(`normalizes the ${fixture.provider} terminal stop reason`, async () => {
      expect((await runFixture(fixture)).stopReason).toBe(fixture.expectedStopReason)
    })
  }

  it('does not persist the fixture API key in approved golden data', () => {
    expect(JSON.stringify(providerGolden.fixtures)).not.toContain('fixture-secret')
  })
})
