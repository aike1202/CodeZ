import { describe, expect, it, vi } from 'vitest'
import { ToolCallAssembler } from '../main/tools/runtime/ToolCallAssembler'
import { ToolScheduler } from '../main/tools/runtime/ToolScheduler'
import { ToolExecutionPipeline } from '../main/tools/runtime/ToolExecutionPipeline'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'
import type { PreparedToolCall, ToolHandler } from '../main/tools/runtime/types'

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function splitRandomly(value: string, next: () => number): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < value.length;) {
    const size = 1 + Math.floor(next() * Math.min(12, value.length - offset))
    chunks.push(value.slice(offset, offset + size))
    offset += size
  }
  return chunks
}

function prepared(position: number, keys: string[]): PreparedToolCall {
  return {
    call: { callId: `c${position}`, position, name: `T${position}`, rawArguments: '{}' },
    handler: { descriptor: { name: `T${position}`, behavior: { concurrency: 'resource-locked' } } } as any,
    input: {}, approvalPreference: null, effects: { effects: [], analysisStatus: 'parsed' }, resourceKeys: keys
  }
}

describe('Tool Runtime properties', () => {
  it('reassembles randomly split JSON arguments exactly', () => {
    const next = random(0xC0DE)
    for (let iteration = 0; iteration < 200; iteration++) {
      const raw = JSON.stringify({ iteration, text: `Unicode 中文 ${String.fromCodePoint(0x1F600 + iteration % 50)}`, values: [next(), next()] })
      const assembler = new ToolCallAssembler(`turn-${iteration}`)
      const chunks = splitRandomly(raw, next)
      chunks.forEach((chunk, index) => assembler.push({
        provider: 'openai', position: 0, callId: index === 0 ? `call-${iteration}` : undefined,
        nameDelta: index === 0 ? 'Example' : undefined,
        argumentsDelta: chunk,
        isFinal: index === chunks.length - 1
      }))
      expect(assembler.finalize({ requireFinal: true })[0].rawArguments).toBe(raw)
    }
  })

  it('places every random scheduled call exactly once and separates conflicting keys', () => {
    const next = random(0x5CED)
    for (let iteration = 0; iteration < 100; iteration++) {
      const calls = Array.from({ length: 1 + Math.floor(next() * 32) }, (_, position) => prepared(
        position,
        [...new Set(Array.from({ length: 1 + Math.floor(next() * 3) }, () => `resource:${Math.floor(next() * 8)}:write`))]
      ))
      const waves = new ToolScheduler().plan(calls)
      expect(waves.flatMap((wave) => wave.calls).map((call) => call.call.position).sort((a, b) => a - b))
        .toEqual(calls.map((call) => call.call.position))
      for (const wave of waves) {
        const keys = wave.calls.flatMap((call) => call.resourceKeys)
        expect(new Set(keys).size).toBe(keys.length)
      }
    }
  })

  it('returns one result per denied call without executing the handler', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, modelContent: 'unexpected' }))
    const handler = {
      descriptor: {
        name: 'DeniedExternal', aliases: [], version: '1', source: 'mcp', sourceId: 'mcp:test',
        summary: 'denied', description: 'denied', inputSchema: { type: 'object', additionalProperties: false },
        approval: { modelPreference: 'not-applicable' },
        availability: { enabled: () => true, roles: '*', exposure: 'core' },
        behavior: { readOnly: () => false, destructive: () => true, concurrency: 'resource-locked', interrupt: 'cancel', maxResultChars: 1000 },
        planEffects: async () => ({ effects: [{ kind: 'external-effect', target: 'test' }], analysisStatus: 'parsed' }),
        resourceKeys: async () => ['mcp:test']
      }, execute
    } as ToolHandler<Record<string, unknown>>
    const registry = new ToolRegistry(); registry.register(handler)
    const catalog = registry.createSnapshot({ platform: process.platform, agentRole: 'main' })
    const calls = Array.from({ length: 50 }, (_, position) => ({
      callId: `denied-${position}`, position, name: 'DeniedExternal', rawArguments: '{}'
    }))
    const results = await new ToolExecutionPipeline().executeBatch(calls, {
      catalog, workspaceRoot: process.cwd(), agentRole: 'main',
      authorize: async () => ({
        allowed: false, requestId: 'denied',
        error: { code: 'TOOL_DENIED', message: 'denied', recoverable: false }
      }),
      createToolContext: () => ({ workspaceRoot: process.cwd() })
    })
    expect(results).toHaveLength(calls.length)
    expect(results.every((result) => result.result.status === 'denied')).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })
})
