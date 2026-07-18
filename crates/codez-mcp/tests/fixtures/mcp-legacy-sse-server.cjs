const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js')
const { z } = require('zod')
const { createServer } = require('http')

const sessions = new Map()
const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/sse') {
    const transport = new SSEServerTransport('/messages', response)
    const mcp = new McpServer({ name: 'codez-legacy-sse-fixture', version: '1.0.0' })
    mcp.registerTool('echo', {
      description: 'Echo over legacy SSE',
      inputSchema: { message: z.string() }
    }, async ({ message }) => ({ content: [{ type: 'text', text: `sse:${message}` }] }))
    mcp.registerResource('fixture', 'test://sse', { mimeType: 'text/plain' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'legacy SSE resource' }]
    }))
    mcp.registerPrompt('review', { description: 'Review over legacy SSE' }, async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'Review legacy SSE' } }]
    }))
    sessions.set(transport.sessionId, { transport, mcp })
    transport.onclose = () => sessions.delete(transport.sessionId)
    await mcp.connect(transport)
    return
  }
  if (request.method === 'POST' && url.pathname === '/messages') {
    const runtime = sessions.get(url.searchParams.get('sessionId') || '')
    if (!runtime) {
      response.writeHead(404).end('Unknown session')
      return
    }
    await runtime.transport.handlePostMessage(request, response)
    return
  }
  response.writeHead(404).end()
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}/sse` })}\n`)
})

async function shutdown() {
  await Promise.all([...sessions.values()].map(({ mcp, transport }) =>
    Promise.all([mcp.close().catch(() => undefined), transport.close().catch(() => undefined)])
  ))
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
