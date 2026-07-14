import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { once } from 'events'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { McpConfigService } from '../main/services/mcp/McpConfigService'
import { McpConnectionManager } from '../main/services/mcp/McpConnectionManager'
import { ToolManager } from '../main/tools/ToolManager'
import { getMcpInstructionRegistry } from '../main/services/mcp/McpInstructionRegistry'

const roots: string[] = []
const managers: McpConnectionManager[] = []
const httpServerCleanups: Array<() => Promise<void>> = []
const originalTestSecret = process.env.CODEZ_MCP_TEST_TOKEN
afterEach(async () => {
  if (originalTestSecret === undefined) delete process.env.CODEZ_MCP_TEST_TOKEN
  else process.env.CODEZ_MCP_TEST_TOKEN = originalTestSecret
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(httpServerCleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRecoverableHttpMcpServer(): Promise<{
  url: string
  expireNextToolCall(): void
  rejectNextToolCallWith401(): void
  initializedSessions: string[]
  receivedMeta: Array<Record<string, unknown> | undefined>
}> {
  const app = createMcpExpressApp()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const servers = new Set<McpServer>()
  const initializedSessions: string[] = []
  const receivedMeta: Array<Record<string, unknown> | undefined> = []
  let expireNextToolCall = false
  let rejectNextToolCallWith401 = false

  app.all('/mcp', async (request: any, response: any) => {
    const sessionId = request.headers['mcp-session-id'] as string | undefined
    const body = request.body
    if (expireNextToolCall && sessionId && body?.method === 'tools/call') {
      expireNextToolCall = false
      response.status(404).json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32001, message: 'Session not found' }
      })
      return
    }
    if (rejectNextToolCallWith401 && sessionId && body?.method === 'tools/call') {
      rejectNextToolCallWith401 = false
      response.status(401).json({ error: 'invalid_token' })
      return
    }

    let transport = sessionId ? transports.get(sessionId) : undefined
    if (!transport && !sessionId && request.method === 'POST' && isInitializeRequest(body)) {
      const server = new McpServer(
        { name: 'codez-http-test', version: '1.0.0' },
        { instructions: 'Use echo for HTTP recovery tests.' }
      )
      server.registerTool('echo', {
        description: 'Echo over Streamable HTTP',
        inputSchema: { message: z.string() },
        annotations: { readOnlyHint: true, destructiveHint: false }
      }, async ({ message }, extra) => {
        receivedMeta.push(extra._meta as Record<string, unknown> | undefined)
        return { content: [{ type: 'text', text: `http:${message}` }] }
      })
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          initializedSessions.push(id)
          transports.set(id, transport!)
        }
      })
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId)
      }
      servers.add(server)
      await server.connect(transport)
    }

    if (!transport) {
      response.status(sessionId ? 404 : 400).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: {
          code: sessionId ? -32001 : -32000,
          message: sessionId ? 'Session not found' : 'No valid session ID provided'
        }
      })
      return
    }
    await transport.handleRequest(request, response, body)
  })

  const httpServer = app.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const address = httpServer.address() as AddressInfo
  httpServerCleanups.push(async () => {
    await Promise.all([...servers].map((server) => server.close().catch(() => undefined)))
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    expireNextToolCall: () => { expireNextToolCall = true },
    rejectNextToolCallWith401: () => { rejectNextToolCallWith401 = true },
    initializedSessions,
    receivedMeta
  }
}

describe('McpConnectionManager', () => {
  it('connects a real stdio server and exposes tools, resources, and prompts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-'))
    roots.push(root)
    const config = new McpConfigService(root)
    const fixture = path.resolve(__dirname, 'fixtures', 'mcp-stdio-server.cjs')
    process.env.CODEZ_MCP_TEST_TOKEN = 'stdio-secret-value'
    await config.saveUserServers({
      test: {
        type: 'stdio', command: process.execPath, args: [fixture],
        env: { CODEZ_MCP_TEST_TOKEN: '${env:CODEZ_MCP_TEST_TOKEN}' }
      }
    })
    const toolManager = new ToolManager()
    const manager = new McpConnectionManager(config, toolManager)
    managers.push(manager)
    await manager.syncWorkspace(root)

    expect(manager.getStatuses()[0]).toMatchObject({
      name: 'test', state: 'connected', toolCount: 4, resourceCount: 2, promptCount: 1
    })
    expect(getMcpInstructionRegistry().render()).toContain(
      'Use the echo tool when the user asks to repeat text.'
    )
    expect(getMcpInstructionRegistry().render()).toContain('policy="tool-hints" trust="external"')
    expect(manager.getCatalog('test')).toMatchObject({
      server: 'test',
      stale: false,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'echo', description: expect.any(String), inputSchema: expect.any(Object) })
      ]),
      resources: expect.arrayContaining([expect.objectContaining({ uri: 'test://example' })]),
      prompts: expect.arrayContaining([expect.objectContaining({ name: 'review' })])
    })
    const handler = toolManager.getRegistry().resolve('mcp__test__echo')
    expect(handler?.descriptor.availability.exposure).toBe('deferred')
    const catalog = toolManager.createCatalogSnapshot()
    const initialExposure = toolManager.createExposurePlan({ catalog })
    expect(initialExposure.eagerTools.some((tool) => tool.name === 'mcp__test__echo')).toBe(false)
    const activated = new Set<string>()
    await toolManager.getRegistry().resolve('ToolSearch')!.execute(
      { query: 'select:mcp__test__echo' },
      {
        workspaceRoot: root,
        toolExposure: {
          deferredTools: initialExposure.deferredTools,
          activate: (names) => names.forEach((name) => activated.add(name))
        }
      }
    )
    expect(initialExposure.eagerTools.some((tool) => tool.name === 'mcp__test__echo')).toBe(false)
    expect(toolManager.createExposurePlan({ catalog, activatedDeferredTools: activated }).eagerTools)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'mcp__test__echo' })]))
    const result = await handler!.execute({ message: 'hello' }, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    expect(result.status).toBe('success')
    expect(result.status === 'success' && result.modelContent).toContain('echo:hello')
    expect(manager.listResources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ server: 'test', uri: 'test://example' })
    ]))
    expect(await manager.readResource('test', 'test://example', { workspaceRoot: root, sessionId: 'session-1' })).toMatchObject({
      contents: [expect.objectContaining({ text: 'resource-content' })]
    })
    expect(manager.listResources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ server: 'test', uri: 'test://items/{id}', template: true })
    ]))
    expect(await manager.readResource('test', 'test://items/42', { workspaceRoot: root, sessionId: 'session-1' })).toMatchObject({
      contents: [expect.objectContaining({ text: 'item:42' })]
    })
    expect(manager.listPrompts()[0]).toMatchObject({ server: 'test', name: 'review' })
    expect(await manager.getPrompt('test', 'review', { subject: 'runtime' })).toMatchObject({
      messages: [expect.objectContaining({ role: 'user' })]
    })
    await expect(manager.readResource('test', 'file:///etc/passwd', { workspaceRoot: root, sessionId: 'session-1' }))
      .rejects.toThrow(/not advertised/)
    await expect(manager.getPrompt('test', 'not-advertised')).rejects.toThrow(/not advertised/)

    await toolManager.getRegistry().resolve('mcp__test__log_secret')!.execute({}, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const serializedLogs = JSON.stringify(manager.getStatuses()[0].logs)
    expect(serializedLogs).toContain('[REDACTED]')
    expect(serializedLogs).not.toContain('stdio-secret-value')

    await toolManager.getRegistry().resolve('mcp__test__flood_logs')!.execute({}, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.getStatuses()[0].logs.length).toBeLessThanOrEqual(200)

    const pidResult = await toolManager.getRegistry().resolve('mcp__test__pid')!.execute({}, {
      workspaceRoot: root, sessionId: 'session-1'
    })
    const pid = Number(pidResult.status === 'success' && /pid:(\d+)/.exec(pidResult.modelContent)?.[1])
    expect(pid).toBeGreaterThan(0)
    await manager.setUserServerEnabled('test', false)
    expect(manager.getStatuses()[0]).toMatchObject({ name: 'test', state: 'disabled' })
    expect(manager.getCatalog('test')).toMatchObject({
      stale: true,
      tools: expect.arrayContaining([expect.objectContaining({ name: 'echo' })])
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)

  it('bounds stderr from an abnormal stdio server exit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-stderr-'))
    roots.push(root)
    const config = new McpConfigService(root)
    await config.saveUserServers({
      failed: {
        type: 'stdio', command: process.execPath,
        args: [path.resolve(__dirname, 'fixtures', 'mcp-stdio-failure.cjs')],
        reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 100 }
      }
    })
    const manager = new McpConnectionManager(config, new ToolManager())
    managers.push(manager)
    await manager.syncWorkspace(root)
    const status = manager.getStatuses()[0]
    expect(status.state).toBe('failed')
    expect(status.logs.length).toBeLessThanOrEqual(200)
    expect(status.logs.every((entry) => entry.message.length <= 8192)).toBe(true)
  }, 15_000)

  it('enforces a configurable handshake timeout and closes the hanging process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-timeout-'))
    roots.push(root)
    const config = new McpConfigService(root)
    await config.saveUserServers({
      hanging: {
        type: 'stdio', command: process.execPath,
        args: [path.resolve(__dirname, 'fixtures', 'mcp-stdio-hang.cjs')],
        handshakeTimeoutMs: 100,
        reconnect: { enabled: false, maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 100 }
      }
    })
    const manager = new McpConnectionManager(config, new ToolManager())
    managers.push(manager)
    await manager.syncWorkspace(root)
    expect(manager.getStatuses()[0]).toMatchObject({
      state: 'failed', error: { code: 'MCP_HANDSHAKE_TIMEOUT' }
    })
  }, 5000)

  it('recovers a real expired Streamable HTTP session and preserves tool-call metadata', async () => {
    const server = await createRecoverableHttpMcpServer()
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-http-'))
    roots.push(root)
    const config = new McpConfigService(root)
    await config.saveUserServers({
      remote: { type: 'http', url: server.url, reconnect: {
        enabled: false, maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 100
      } }
    })
    const toolManager = new ToolManager()
    const manager = new McpConnectionManager(config, toolManager)
    managers.push(manager)
    await manager.syncWorkspace(root)
    expect(manager.getStatuses()[0]).toMatchObject({ name: 'remote', state: 'connected', toolCount: 1 })
    expect(server.initializedSessions).toHaveLength(1)

    server.expireNextToolCall()
    const result = await toolManager.getRegistry().resolve('mcp__remote__echo')!.execute(
      { message: 'after-expiry' },
      { workspaceRoot: root, sessionId: 'session-http', toolCallId: 'toolu_http_recovery' }
    )
    expect(result.status).toBe('success')
    expect(result.status === 'success' && result.modelContent).toContain('http:after-expiry')
    expect(server.initializedSessions).toHaveLength(2)
    expect(server.receivedMeta).toEqual([
      expect.objectContaining({ 'claudecode/toolUseId': 'toolu_http_recovery' })
    ])
    expect(manager.getStatuses()[0].logs.some((entry) =>
      entry.message.includes('session recovered')
    )).toBe(true)
  }, 10_000)

  it('moves a real Streamable HTTP server to needs-auth after a tool-call 401', async () => {
    const server = await createRecoverableHttpMcpServer()
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-mcp-http-auth-'))
    roots.push(root)
    const config = new McpConfigService(root)
    await config.saveUserServers({ remote: { type: 'http', url: server.url } })
    const toolManager = new ToolManager()
    const manager = new McpConnectionManager(config, toolManager)
    managers.push(manager)
    await manager.syncWorkspace(root)

    const handler = toolManager.getRegistry().resolve('mcp__remote__echo')!
    server.rejectNextToolCallWith401()
    await expect(handler.execute({ message: 'private' }, {
      workspaceRoot: root, toolCallId: 'toolu_auth_expired'
    })).resolves.toMatchObject({
      status: 'error', error: { code: 'MCP_NEEDS_AUTH' }
    })
    expect(manager.getStatuses()[0]).toMatchObject({
      name: 'remote', state: 'needs-auth', error: { code: 'MCP_NEEDS_AUTH' }
    })
    expect(toolManager.getRegistry().resolve('mcp__remote__echo')).toBeUndefined()
    expect(manager.getCatalog('remote').stale).toBe(true)
    expect(getMcpInstructionRegistry().render()).not.toContain('Use echo for HTTP recovery tests.')
  }, 10_000)
})
