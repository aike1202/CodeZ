import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { randomUUID } from 'crypto'
import { mkdtemp, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { McpConfigService } from '../main/services/mcp/McpConfigService'
import { McpConnectionManager } from '../main/services/mcp/McpConnectionManager'
import { ToolManager } from '../main/tools/ToolManager'

const roots: string[] = []
const managers: McpConnectionManager[] = []
const servers: Server[] = []
const transportClosers: Array<() => Promise<void>> = []

function echoServer(name: string, onSlowCancelled?: () => void, version = '1.0.0'): McpServer {
  const server = new McpServer({ name, version })
  server.registerTool('echo', {
    description: 'Echo over a network transport',
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ message }) => ({ content: [{ type: 'text', text: `${name}:${message}` }] }))
  server.registerTool('slow', {
    description: 'Wait until cancelled',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async (_input, extra) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000)
      extra.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        onSlowCancelled?.()
        reject(new Error('cancelled by client'))
      }, { once: true })
    })
    return { content: [{ type: 'text', text: 'finished' }] }
  })
  server.registerResource('base-resource', 'test://base', { mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'base' }]
  }))
  server.registerResource('slow-resource', 'test://slow', { mimeType: 'text/plain' }, async (uri, extra) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000)
      extra.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        onSlowCancelled?.()
        reject(new Error('resource cancelled by client'))
      }, { once: true })
    })
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'slow' }] }
  })
  server.registerPrompt('base-prompt', { description: 'Base prompt' }, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'base prompt' } }]
  }))
  return server
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.')
  servers.push(server)
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function createHttpMcpServer(): Promise<{
  port: number
  sessionCount: () => number
  cancelled: () => number
  addDynamicCatalog: () => void
  subscriptionCount: () => number
  unsubscribeCount: () => number
  sendResourceUpdate: (uri: string) => Promise<void>
  changeIdentity: () => void
}> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>()
  const subscriptions = new Set<string>()
  let cancellationCount = 0
  let resourceUnsubscribeCount = 0
  let serverVersion = '1.0.0'
  let activeServer: McpServer | undefined
  const http = createServer(async (request, response) => {
    if (new URL(request.url || '/', 'http://127.0.0.1').pathname !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    const sessionId = request.headers['mcp-session-id']
    let runtime = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (!runtime) {
      const mcp = echoServer('http-server', () => { cancellationCount++ }, serverVersion)
      mcp.server.registerCapabilities({ resources: { subscribe: true } })
      mcp.server.setRequestHandler(SubscribeRequestSchema, async (subscription) => {
        subscriptions.add(subscription.params.uri)
        return {}
      })
      mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (subscription) => {
        subscriptions.delete(subscription.params.uri)
        resourceUnsubscribeCount++
        return {}
      })
      let transport!: StreamableHTTPServerTransport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id): void => { sessions.set(id, { transport, server: mcp }) },
        onsessionclosed: (id): void => { sessions.delete(id) }
      })
      runtime = { transport, server: mcp }
      activeServer = mcp
      await mcp.connect(transport)
    }
    try {
      await runtime.transport.handleRequest(request, response)
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(String(error))
    }
  })
  transportClosers.push(async () => {
    await Promise.all([...sessions.values()].map(({ server }) => server.close().catch(() => undefined)))
    sessions.clear()
  })
  return {
    port: await listen(http),
    sessionCount: () => sessions.size,
    cancelled: () => cancellationCount,
    addDynamicCatalog: () => {
      activeServer?.registerTool('dynamic', {
        description: 'Dynamically added tool', inputSchema: {}, annotations: { readOnlyHint: true }
      }, async () => ({ content: [{ type: 'text', text: 'dynamic' }] }))
      activeServer?.registerResource('dynamic-resource', 'test://dynamic', { mimeType: 'text/plain' }, async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'dynamic' }]
      }))
      activeServer?.registerResource(
        'dynamic-template',
        new ResourceTemplate('test://dynamic/{id}', { list: undefined }),
        { mimeType: 'text/plain' },
        async (uri, variables) => ({
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: `dynamic:${variables.id}` }]
        })
      )
      activeServer?.registerPrompt('dynamic-prompt', { description: 'Dynamic prompt' }, async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: 'dynamic prompt' } }]
      }))
      activeServer?.sendToolListChanged()
      activeServer?.sendResourceListChanged()
      activeServer?.sendPromptListChanged()
    },
    subscriptionCount: () => subscriptions.size,
    unsubscribeCount: () => resourceUnsubscribeCount,
    sendResourceUpdate: async (uri) => { await activeServer?.server.sendResourceUpdated({ uri }) },
    changeIdentity: () => { serverVersion = '2.0.0' }
  }
}

async function createSseMcpServer(): Promise<number> {
  const transports = new Map<string, { transport: SSEServerTransport; server: McpServer }>()
  const http = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', response)
      const mcp = echoServer('sse-server')
      transports.set(transport.sessionId, { transport, server: mcp })
      transport.onclose = () => {
        transports.delete(transport.sessionId)
      }
      await mcp.connect(transport)
      return
    }
    if (request.method === 'POST' && url.pathname === '/messages') {
      const runtime = transports.get(url.searchParams.get('sessionId') || '')
      if (!runtime) { response.writeHead(404).end('Unknown session'); return }
      await runtime.transport.handlePostMessage(request, response)
      return
    }
    response.writeHead(404).end()
  })
  transportClosers.push(async () => {
    await Promise.all([...transports.values()].map(async ({ transport, server }) => {
      await server.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    }))
    transports.clear()
  })
  return listen(http)
}

async function managerFor(type: 'http' | 'sse', port: number): Promise<{ manager: McpConnectionManager; tools: ToolManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `codez-mcp-${type}-`))
  roots.push(root)
  const config = new McpConfigService(root)
  await config.saveUserServers({
    network: {
      type,
      url: `http://127.0.0.1:${port}/${type === 'http' ? 'mcp' : 'sse'}`,
      timeoutMs: 100,
      resourceSubscriptions: true
    }
  })
  const tools = new ToolManager()
  const manager = new McpConnectionManager(config, tools)
  managers.push(manager)
  await manager.syncWorkspace(root)
  return { manager, tools }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(transportClosers.splice(0).map((close) => close()))
  await Promise.all(servers.splice(0).map(closeServer))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('MCP network transports', () => {
  it('connects, discovers, and calls a real Streamable HTTP server', async () => {
    const server = await createHttpMcpServer()
    const { manager, tools } = await managerFor('http', server.port)
    expect(manager.getStatuses()[0]).toMatchObject({ state: 'connected', transport: 'http', toolCount: 2, resourceCount: 2, promptCount: 1 })
    expect(server.sessionCount()).toBe(1)
    const handler = tools.getRegistry().resolve('mcp__network__echo')
    const result = await handler!.execute({ message: 'hello' }, { workspaceRoot: roots[0], sessionId: 'http-test' })
    expect(result).toMatchObject({ status: 'success' })
    expect(result.status === 'success' && result.modelContent).toContain('http-server:hello')

    const oldCatalog = tools.createCatalogSnapshot()
    server.addDynamicCatalog()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(oldCatalog.handlersByCanonicalName.has('mcp__network__dynamic')).toBe(false)
    expect(tools.createCatalogSnapshot().handlersByCanonicalName.has('mcp__network__dynamic')).toBe(true)
    expect(manager.listResources()).toEqual(expect.arrayContaining([expect.objectContaining({ uri: 'test://dynamic' })]))
    expect(manager.listResources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'test://dynamic/{id}', template: true })
    ]))
    expect(manager.listPrompts()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'dynamic-prompt' })]))

    await manager.subscribeResource('network', 'test://base')

    const resourceController = new AbortController()
    const slowResource = manager.readResource('network', 'test://slow', {
      workspaceRoot: roots[0], sessionId: 'http-test', abortSignal: resourceController.signal
    })
    setTimeout(() => resourceController.abort(), 20)
    await expect(slowResource).rejects.toThrow()
    for (let attempt = 0; attempt < 20 && server.cancelled() < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(server.cancelled()).toBe(1)

    expect(server.subscriptionCount()).toBe(1)
    await server.sendResourceUpdate('test://base')
    for (let attempt = 0; attempt < 20 && !manager.getStatuses()[0].logs.some((entry) => entry.message.includes('resource updated')); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(manager.getStatuses()[0].logs.some((entry) => entry.message.includes('resource updated'))).toBe(true)
    await manager.unsubscribeResource('network', 'test://base')
    expect(server.subscriptionCount()).toBe(0)
    expect(server.unsubscribeCount()).toBe(1)
    await manager.subscribeResource('network', 'test://base')

    const controller = new AbortController()
    const slow = tools.getRegistry().resolve('mcp__network__slow')!.execute({}, {
      workspaceRoot: roots[0], sessionId: 'http-test', abortSignal: controller.signal
    })
    setTimeout(() => controller.abort(), 20)
    await expect(slow).resolves.toMatchObject({ status: 'cancelled' })
    for (let attempt = 0; attempt < 20 && server.cancelled() < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(server.cancelled()).toBe(2)
    const snapshotBeforeReconnect = tools.createCatalogSnapshot()
    server.changeIdentity()
    await manager.reconnect('network')
    expect(manager.getStatuses()[0]).toMatchObject({
      state: 'connected', serverInfo: { name: 'http-server', version: '2.0.0' }
    })
    expect(manager.getStatuses()[0].logs.some((entry) => entry.message.includes('identity changed'))).toBe(true)
    expect(tools.createCatalogSnapshot().fingerprint).not.toBe(snapshotBeforeReconnect.fingerprint)
    expect(snapshotBeforeReconnect.handlersByCanonicalName.has('mcp__network__dynamic')).toBe(true)
    await manager.stopAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server.subscriptionCount()).toBe(0)
    expect(server.unsubscribeCount()).toBe(2)
    expect(server.sessionCount()).toBe(0)
  }, 15_000)

  it('connects, discovers, and calls a real legacy SSE server', async () => {
    const { manager, tools } = await managerFor('sse', await createSseMcpServer())
    expect(manager.getStatuses()[0]).toMatchObject({ state: 'connected', transport: 'sse', toolCount: 2 })
    const handler = tools.getRegistry().resolve('mcp__network__echo')
    const result = await handler!.execute({ message: 'hello' }, { workspaceRoot: roots[0], sessionId: 'sse-test' })
    expect(result).toMatchObject({ status: 'success' })
    expect(result.status === 'success' && result.modelContent).toContain('sse-server:hello')
  }, 15_000)
})
