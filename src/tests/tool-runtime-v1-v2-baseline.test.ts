import { describe, expect, it, vi } from 'vitest'
import { LegacyToolExecutionPipeline } from '../main/tools/runtime/LegacyToolExecutionPipeline'
import { ToolExecutionPipeline } from '../main/tools/runtime/ToolExecutionPipeline'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'
import type {
  NormalizedToolCall,
  ToolEffect,
  ToolHandler,
  ToolPipelineResult
} from '../main/tools/runtime/types'

function handler(name: string, effect: ToolEffect): ToolHandler<Record<string, unknown>> {
  return {
    descriptor: {
      name,
      aliases: [],
      version: 'baseline-1',
      source: 'builtin',
      sourceId: 'baseline',
      summary: name,
      description: `${name} baseline tool`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      },
      availability: { enabled: () => true, roles: '*', exposure: 'core' },
      behavior: {
        readOnly: () => effect.kind === 'read-file',
        destructive: () => effect.kind === 'write-file',
        concurrency: 'resource-locked',
        interrupt: 'cancel',
        maxResultChars: 10_000
      },
      planEffects: async () => ({ effects: [effect], analysisStatus: 'parsed' }),
      resourceKeys: async (input) => [`file:${String((input as Record<string, unknown>).path)}`]
    },
    execute: vi.fn(async (input) => ({
      status: 'success' as const,
      data: { name, path: input.path },
      modelContent: `${name}:${String(input.path)}`
    }))
  }
}

async function run(
  pipeline: ToolExecutionPipeline | LegacyToolExecutionPipeline,
  calls: readonly NormalizedToolCall[]
): Promise<{ results: ToolPipelineResult[]; permissionCalls: number; resultBytes: number }> {
  const registry = new ToolRegistry()
  registry.register(handler('ReadBaseline', { kind: 'read-file', path: 'src/input.ts', scope: 'workspace' }))
  registry.register(handler('EditBaseline', { kind: 'write-file', path: 'src/output.ts', mode: 'modify' }))
  registry.register(handler('VerifyBaseline', { kind: 'execute-command', shell: 'powershell', command: 'npm test' }))
  const catalog = registry.createSnapshot({ platform: process.platform, agentRole: 'main' })
  let permissionCalls = 0
  const results = await pipeline.executeBatch(calls, {
    catalog,
    workspaceRoot: 'C:\\workspace',
    agentRole: 'main',
    authorize: async () => {
      permissionCalls++
      return { allowed: true, requestId: `permission-${permissionCalls}` }
    },
    createToolContext: () => ({ workspaceRoot: 'C:\\workspace' })
  })
  return {
    results,
    permissionCalls,
    resultBytes: results.reduce((total, item) => total + Buffer.byteLength(item.result.modelContent || '', 'utf8'), 0)
  }
}

describe('V1/V2 representative runtime baseline', () => {
  it('keeps read/edit/verify call-result counts, permissions, ordering, and result bytes comparable', async () => {
    const calls: NormalizedToolCall[] = [
      { callId: 'read-1', position: 0, name: 'ReadBaseline', rawArguments: '{"path":"src/input.ts"}' },
      { callId: 'edit-1', position: 1, name: 'EditBaseline', rawArguments: '{"path":"src/output.ts"}' },
      { callId: 'verify-1', position: 2, name: 'VerifyBaseline', rawArguments: '{"path":"package.json"}' }
    ]
    const v1 = await run(new LegacyToolExecutionPipeline(), calls)
    const v2 = await run(new ToolExecutionPipeline(), calls)

    const comparable = (value: typeof v1) => ({
      callCount: calls.length,
      resultCount: value.results.length,
      resultOrder: value.results.map((item) => item.call.callId),
      statuses: value.results.map((item) => item.result.status),
      permissionCalls: value.permissionCalls,
      resultBytes: value.resultBytes
    })
    expect(comparable(v2)).toEqual(comparable(v1))
    expect(comparable(v2)).toMatchObject({
      callCount: 3,
      resultCount: 3,
      resultOrder: ['read-1', 'edit-1', 'verify-1'],
      statuses: ['success', 'success', 'success'],
      permissionCalls: 3
    })
  })
})
