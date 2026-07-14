import { describe, expect, it, vi } from 'vitest'
import { McpToolHandler } from '../main/tools/mcp/McpToolHandler'
import { McpRequestGuard } from '../main/services/mcp/McpRequestGuard'

describe('McpToolHandler', () => {
  it('keeps original call names, reports progress, and never lets readOnly annotations remove external permission effects', async () => {
    const progress = vi.fn()
    const callTool = vi.fn(async (_request, _schema, options) => {
      options.onprogress({ progress: 1, total: 2, message: 'working' })
      return {
        content: [{ type: 'text', text: 'done' }],
        structuredContent: { ok: true },
        _meta: { private: 'not-for-model' }
      }
    })
    const handler = new McpToolHandler(
      'server name', 'fingerprint-123456789',
      {
        name: 'tool.name', inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        annotations: { readOnlyHint: true, destructiveHint: false }
      },
      { callTool } as any,
      new McpRequestGuard({ maxAttempts: 1 }),
      1000,
      false,
      progress
    )
    expect(handler.descriptor.name).toBe('mcp__server_name__tool_name')
    expect((await handler.descriptor.planEffects({}, { workspaceRoot: '.', agentRole: 'main' })).effects)
      .toEqual([{ kind: 'external-effect', target: 'mcp:fingerprint-123456789:tool.name' }])
    const result = await handler.execute({}, {
      workspaceRoot: process.cwd(), sessionId: 'session', toolCallId: 'toolu_runtime_123'
    })
    expect(result.status).toBe('success')
    expect(callTool).toHaveBeenCalledWith(
      {
        name: 'tool.name',
        arguments: {},
        _meta: { 'claudecode/toolUseId': 'toolu_runtime_123' }
      },
      undefined,
      expect.objectContaining({ timeout: 1000 })
    )
    expect(progress).toHaveBeenCalledWith({ progress: 1, total: 2, message: 'working' })
    expect(result.modelContent).not.toContain('not-for-model')
    expect(result.uiContent).not.toContain('not-for-model')
  })

  it('uses MCP annotation defaults without bypassing external-effect permission planning', async () => {
    const handler = new McpToolHandler(
      'server', 'fingerprint', { name: 'unknown', inputSchema: { type: 'object' } },
      { callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })) } as any,
      new McpRequestGuard({ maxAttempts: 1 })
    )
    expect(handler.descriptor.behavior.readOnly({})).toBe(false)
    expect(handler.descriptor.behavior.destructive({})).toBe(false)
    expect(handler.descriptor.behavior.concurrency).toBe('resource-locked')
    expect(handler.descriptor.behavior.maxResultChars).toBe(100_000)
    await expect(handler.descriptor.planEffects({}, { workspaceRoot: '.', agentRole: 'main' }))
      .resolves.toMatchObject({
        effects: [{ kind: 'external-effect', target: 'mcp:fingerprint:unknown' }],
        analysisStatus: 'unparsed'
      })
  })

  it('reconnects and retries once after an expired Streamable HTTP session', async () => {
    const expired = Object.assign(
      new Error('HTTP 404: {"error":{"code":-32001,"message":"Session not found"}}'),
      { code: 404 }
    )
    const staleCall = vi.fn(async () => { throw expired })
    const recoveredCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'recovered' }] }))
    const staleClient = { callTool: staleCall } as any
    const recoveredClient = { callTool: recoveredCall } as any
    const recover = vi.fn(async (failedClient) => {
      expect(failedClient).toBe(staleClient)
      return recoveredClient
    })
    const handler = new McpToolHandler(
      'server', 'fingerprint', { name: 'write', inputSchema: { type: 'object' } },
      staleClient,
      new McpRequestGuard({ maxAttempts: 1 }),
      1000,
      false,
      undefined,
      recover
    )

    const result = await handler.execute({ value: 1 }, {
      workspaceRoot: process.cwd(), toolCallId: 'toolu_retry_1'
    })
    expect(result.status).toBe('success')
    expect(result.status === 'success' && result.modelContent).toContain('recovered')
    expect(staleCall).toHaveBeenCalledTimes(1)
    expect(recoveredCall).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recoveredCall).toHaveBeenCalledWith(
      {
        name: 'write',
        arguments: { value: 1 },
        _meta: { 'claudecode/toolUseId': 'toolu_retry_1' }
      },
      undefined,
      expect.objectContaining({ timeout: 1000 })
    )
  })

  it('does not recover a generic HTTP 404 that lacks the MCP session error code', async () => {
    const recover = vi.fn(async () => ({ callTool: vi.fn() }) as any)
    const handler = new McpToolHandler(
      'server', 'fingerprint', { name: 'missing', inputSchema: { type: 'object' } },
      {
        callTool: vi.fn(async () => {
          throw Object.assign(new Error('HTTP 404: endpoint not found'), { code: 404 })
        })
      } as any,
      new McpRequestGuard({ maxAttempts: 1 }),
      1000,
      false,
      undefined,
      recover
    )
    await expect(handler.execute({}, { workspaceRoot: process.cwd() })).resolves.toMatchObject({
      status: 'error', error: { code: 404 }
    })
    expect(recover).not.toHaveBeenCalled()
  })

  it('maps MCP 401 failures to re-authorization and notifies the connection owner', async () => {
    const onAuthRequired = vi.fn()
    const handler = new McpToolHandler(
      'server', 'fingerprint', { name: 'private', inputSchema: { type: 'object' } },
      {
        callTool: vi.fn(async () => {
          throw Object.assign(new Error('HTTP 401 Unauthorized'), { code: 401 })
        })
      } as any,
      new McpRequestGuard({ maxAttempts: 1 }),
      1000,
      false,
      undefined,
      undefined,
      onAuthRequired
    )
    await expect(handler.execute({}, { workspaceRoot: process.cwd() })).resolves.toMatchObject({
      status: 'error', error: { code: 'MCP_NEEDS_AUTH', recoverable: true }
    })
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
  })

  it('maps MCP isError to a typed recoverable failure', async () => {
    const handler = new McpToolHandler(
      'server', 'fingerprint', { name: 'fails', inputSchema: { type: 'object' } },
      { callTool: vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: 'remote failure' }] })) } as any,
      new McpRequestGuard({ maxAttempts: 1 })
    )
    await expect(handler.execute({}, { workspaceRoot: process.cwd() })).resolves.toMatchObject({
      status: 'error', error: { code: 'MCP_TOOL_ERROR', recoverable: true }
    })
  })
})
