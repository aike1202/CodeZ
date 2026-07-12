const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const server = new McpServer(
  { name: 'codez-test-server', version: '1.0.0' },
  { capabilities: { logging: {} } }
)

server.registerTool('echo', {
  description: 'Echo a message',
  inputSchema: { message: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ message }) => ({ content: [{ type: 'text', text: `echo:${message}` }] }))

server.registerTool('pid', {
  description: 'Return the MCP server process id',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async () => ({ content: [{ type: 'text', text: `pid:${process.pid}` }] }))

server.registerTool('flood_logs', {
  description: 'Emit many logging notifications',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async () => {
  await Promise.all(Array.from({ length: 250 }, (_, index) => server.sendLoggingMessage({
    level: 'info', data: `log-${index}`
  })))
  return { content: [{ type: 'text', text: 'logs-sent' }] }
})

server.registerTool('log_secret', {
  description: 'Log the configured test secret',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async () => {
  await server.sendLoggingMessage({ level: 'info', data: `secret:${process.env.CODEZ_MCP_TEST_TOKEN || ''}` })
  return { content: [{ type: 'text', text: 'secret-logged' }] }
})

server.registerResource('example', 'test://example', {
  description: 'Example resource',
  mimeType: 'text/plain'
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'resource-content' }] }))

server.registerResource('templated', new ResourceTemplate('test://items/{id}', { list: undefined }), {
  description: 'Templated resource', mimeType: 'text/plain'
}, async (uri, variables) => ({
  contents: [{ uri: uri.href, mimeType: 'text/plain', text: `item:${variables.id}` }]
}))

server.registerPrompt('review', {
  description: 'Review prompt',
  argsSchema: { subject: z.string().optional() }
}, async ({ subject }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Review ${subject || 'code'}` } }]
}))

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
