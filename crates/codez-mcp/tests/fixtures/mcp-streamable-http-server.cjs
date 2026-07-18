const { randomUUID } = require('crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const {
  isInitializeRequest,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} = require('@modelcontextprotocol/sdk/types.js')
const { z } = require('zod')

const app = createMcpExpressApp()
const transports = new Map()
const servers = new Set()
const subscriptions = new Set()
let initializedCount = 0
let generic404Pending = false

app.all('/mcp', async (request, response) => {
  const sessionId = request.headers['mcp-session-id']
  const body = request.body

  if (generic404Pending && sessionId && body?.method === 'tools/call') {
    generic404Pending = false
    response.status(404).json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: -32000, message: 'Generic route not found' }
    })
    return
  }

  let runtime = sessionId ? transports.get(sessionId) : undefined
  if (!runtime && !sessionId && request.method === 'POST' && isInitializeRequest(body)) {
    initializedCount++
    const server = new McpServer(
      { name: 'codez-rmcp-http-spike', version: '1.0.0' },
      { instructions: 'Streamable HTTP interoperability fixture.' }
    )
    server.server.registerCapabilities({ resources: { subscribe: true } })

    let transport
    server.registerTool('echo', {
      description: 'Echo over Streamable HTTP',
      inputSchema: { message: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false }
    }, async ({ message }) => ({
      content: [{ type: 'text', text: `http:${message}:session:${initializedCount}` }]
    }))
    server.registerTool('expire_session', {
      description: 'Expire the current session after this call returns',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false }
    }, async () => {
      const expiredId = transport.sessionId
      if (expiredId) transports.delete(expiredId)
      return { content: [{ type: 'text', text: 'session-expired' }] }
    })
    server.registerTool('arm_generic_404', {
      description: 'Return a generic HTTP 404 for the next tool call',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false }
    }, async () => {
      generic404Pending = true
      return { content: [{ type: 'text', text: 'generic-404-armed' }] }
    })
    server.registerTool('notify_resource', {
      description: 'Send a resource update notification',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false }
    }, async () => {
      setTimeout(() => transport.send({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: 'test://base' }
      }), 100)
      return { content: [{ type: 'text', text: 'resource-notified' }] }
    })
    server.registerResource('base', 'test://base', { mimeType: 'text/plain' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'http-resource' }]
    }))
    server.registerPrompt('review', {
      description: 'Review prompt',
      argsSchema: { subject: z.string().optional() }
    }, async ({ subject }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Review ${subject || 'code'}` } }]
    }))
    server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
      subscriptions.add(params.uri)
      return {}
    })
    server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
      subscriptions.delete(params.uri)
      return {}
    })

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        transports.set(id, { server, transport })
      },
      onsessionclosed: (id) => {
        transports.delete(id)
      }
    })
    servers.add(server)
    runtime = { server, transport }
    await server.connect(transport)
  }

  if (!runtime) {
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

  await runtime.transport.handleRequest(request, response, body)
})

const http = app.listen(0, '127.0.0.1', () => {
  const address = http.address()
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp` })}\n`)
})

async function shutdown() {
  await Promise.all([...servers].map((server) => server.close().catch(() => undefined)))
  http.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
