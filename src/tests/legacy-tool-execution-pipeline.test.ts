import { describe, expect, it, vi } from 'vitest'
import { LegacyToolExecutionPipeline } from '../main/tools/runtime/LegacyToolExecutionPipeline'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'
import type { ToolHandler } from '../main/tools/runtime/types'

describe('LegacyToolExecutionPipeline', () => {
  it('uses canonical validation before the fallback authorizes or executes', async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      status: 'success' as const,
      modelContent: JSON.stringify(input)
    }))
    const handler = {
      descriptor: {
        name: 'LegacyExample', aliases: [], version: '1', source: 'builtin', sourceId: 'test',
        summary: 'legacy', description: 'legacy', inputSchema: {
          type: 'object', properties: { required: { type: 'string' } }, required: ['required']
        },
        approval: { modelPreference: 'not-applicable' },
        availability: { enabled: () => true, roles: '*', exposure: 'core' },
        behavior: { readOnly: () => true, destructive: () => false, concurrency: 'safe', interrupt: 'cancel', maxResultChars: 1000 },
        planEffects: async () => ({ effects: [], analysisStatus: 'parsed' }),
        resourceKeys: async () => []
      },
      execute
    } as ToolHandler<Record<string, unknown>>
    const registry = new ToolRegistry()
    registry.register(handler)
    const catalog = registry.createSnapshot({ platform: process.platform, agentRole: 'main' })
    const [result] = await new LegacyToolExecutionPipeline().executeBatch([
      { callId: 'c1', position: 0, name: 'LegacyExample', rawArguments: '{}' }
    ], {
      catalog, workspaceRoot: 'C:\\workspace', agentRole: 'main',
      authorize: async () => ({ allowed: true, requestId: 'p1' }),
      createToolContext: () => ({ workspaceRoot: 'C:\\workspace' })
    })
    expect(result.result.status).toBe('error')
    expect(result.result.status === 'error' && result.result.error.code).toBe('TOOL_INPUT_INVALID')
    expect(execute).not.toHaveBeenCalled()
  })
})
