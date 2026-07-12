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
    const result = await handler.execute({}, { workspaceRoot: process.cwd(), sessionId: 'session' })
    expect(result.status).toBe('success')
    expect(callTool).toHaveBeenCalledWith(
      { name: 'tool.name', arguments: {} },
      undefined,
      expect.objectContaining({ timeout: 1000 })
    )
    expect(progress).toHaveBeenCalledWith({ progress: 1, total: 2, message: 'working' })
    expect(result.modelContent).not.toContain('not-for-model')
    expect(result.uiContent).not.toContain('not-for-model')
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
