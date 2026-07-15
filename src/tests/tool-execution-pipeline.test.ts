import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../main/tools/Tool'
import { ToolExecutionPipeline } from '../main/tools/runtime/ToolExecutionPipeline'
import { ToolRegistry } from '../main/tools/runtime/ToolRegistry'
import type { ToolHandler, ToolRuntimeHook } from '../main/tools/runtime/types'

function createHandler(execute = vi.fn(async (input: Record<string, unknown>) => ({
  status: 'success' as const,
  data: input,
  modelContent: JSON.stringify(input)
}))): ToolHandler<Record<string, unknown>> {
  return {
    descriptor: {
      name: 'Example',
      aliases: [],
      version: '1',
      source: 'builtin',
      sourceId: 'test',
      summary: 'Example',
      description: 'Example tool',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      },
      approval: { modelPreference: 'not-applicable' },
      availability: { enabled: () => true, roles: '*', exposure: 'core' },
      behavior: {
        readOnly: () => true,
        destructive: () => false,
        concurrency: 'resource-locked',
        interrupt: 'cancel',
        maxResultChars: 10_000
      },
      planEffects: async (input) => ({
        effects: [{ kind: 'read-file' as const, path: String((input as any).path), scope: 'workspace' as const }],
        analysisStatus: 'parsed' as const
      }),
      resourceKeys: async (input) => [`file:${String((input as any).path)}:read`]
    },
    execute
  }
}

function createEffectfulHandler(execute = vi.fn(async (input: Record<string, unknown>) => ({
  status: 'success' as const,
  data: input,
  modelContent: JSON.stringify(input)
}))): ToolHandler<Record<string, unknown>> {
  const handler = createHandler(execute)
  handler.descriptor.approval = { modelPreference: 'required' }
  handler.descriptor.behavior.readOnly = () => false
  return handler
}

function setup(handler: ToolHandler, hooks: readonly ToolRuntimeHook[] = []) {
  const registry = new ToolRegistry()
  registry.register(handler)
  const catalog = registry.createSnapshot({ platform: process.platform, agentRole: 'main' })
  const authorize = vi.fn(async () => ({ allowed: true, requestId: 'permission-1' }))
  const createToolContext = vi.fn((_call, requestId): ToolContext => ({
    workspaceRoot: 'C:\\workspace',
    permissionRequestId: requestId
  }))
  return {
    pipeline: new ToolExecutionPipeline({ hooks }),
    context: {
      catalog,
      workspaceRoot: 'C:\\workspace',
      agentRole: 'main' as const,
      authorize,
      createToolContext
    },
    authorize,
    createToolContext
  }
}

describe('ToolExecutionPipeline', () => {
  it('requires and strips model approval metadata before planning and execution', async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      status: 'success' as const,
      data: input,
      modelContent: JSON.stringify(input)
    }))
    const handler = createEffectfulHandler(execute)
    const { pipeline, context, authorize } = setup(handler)
    const [missing] = await pipeline.executeBatch([
      { callId: 'missing', position: 0, name: 'Example', rawArguments: '{"path":"a.txt"}' }
    ], context)
    expect(missing.result.status).toBe('error')
    expect(authorize).not.toHaveBeenCalled()

    const [allowed] = await pipeline.executeBatch([
      { callId: 'allowed', position: 0, name: 'Example', rawArguments: '{"path":"a.txt","approval":"auto"}' }
    ], context)
    expect(allowed.result.status).toBe('success')
    expect(allowed.input).toEqual({ path: 'a.txt' })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      approvalPreference: 'auto',
      input: { path: 'a.txt' }
    }))
    expect(execute).toHaveBeenCalledWith({ path: 'a.txt' }, expect.any(Object))
  })

  it('validates before authorization and does not execute invalid input', async () => {
    const handler = createHandler()
    const { pipeline, context, authorize } = setup(handler)
    const [result] = await pipeline.executeBatch([
      { callId: 'call-1', position: 0, name: 'Example', rawArguments: '{}' }
    ], context)

    expect(result.result.status).toBe('error')
    expect(result.result.status === 'error' && result.result.error.code).toBe('TOOL_INPUT_INVALID')
    expect(authorize).not.toHaveBeenCalled()
    expect(handler.execute).not.toHaveBeenCalled()
  })

  it('revalidates and replans hook replacement input before authorization', async () => {
    const handler = createHandler()
    const hook: ToolRuntimeHook = {
      name: 'replace-path',
      beforeExecute: async () => ({
        action: 'replace-input',
        input: { path: 'replacement.txt' },
        reason: 'test'
      })
    }
    const { pipeline, context, authorize } = setup(handler, [hook])
    const [result] = await pipeline.executeBatch([
      { callId: 'call-1', position: 0, name: 'Example', rawArguments: '{"path":"original.txt"}' }
    ], context)

    expect(result.result.status).toBe('success')
    expect(result.input).toEqual({ path: 'replacement.txt' })
    const authorizedCall = (authorize.mock.calls as any[][])[0][0]
    expect(authorizedCall.resourceKeys).toEqual(['file:replacement.txt:read'])
    expect(authorizedCall.effects.effects[0]).toMatchObject({ path: 'replacement.txt' })
    expect(handler.execute).toHaveBeenCalledWith(
      { path: 'replacement.txt' },
      expect.objectContaining({ permissionRequestId: 'permission-1' })
    )
  })

  it('rejects invalid hook replacement before authorization', async () => {
    const handler = createHandler()
    const hook: ToolRuntimeHook = {
      name: 'invalid-replacement',
      beforeExecute: async () => ({ action: 'replace-input', input: {}, reason: 'test' })
    }
    const { pipeline, context, authorize } = setup(handler, [hook])
    const [result] = await pipeline.executeBatch([
      { callId: 'call-1', position: 0, name: 'Example', rawArguments: '{"path":"original.txt"}' }
    ], context)

    expect(result.result.status).toBe('error')
    expect(authorize).not.toHaveBeenCalled()
    expect(handler.execute).not.toHaveBeenCalled()
  })

  it('does not reach an external handler after permission denial', async () => {
    const handler = createHandler()
    handler.descriptor.source = 'mcp'
    handler.descriptor.sourceId = 'mcp:test'
    const { pipeline, context } = setup(handler)
    const deniedContext = { ...context, authorize: vi.fn(async () => ({
      allowed: false,
      requestId: 'denied-1',
      error: { code: 'TOOL_DENIED', message: 'Denied by policy', recoverable: false }
    })) }
    const [result] = await pipeline.executeBatch([
      { callId: 'call-denied', position: 0, name: 'Example', rawArguments: '{"path":"remote"}' }
    ], deniedContext)
    expect(result.result.status).toBe('denied')
    expect(handler.execute).not.toHaveBeenCalled()
  })
})
