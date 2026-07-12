import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { createSafeMcpFetch } from '../main/services/mcp/safeFetch'

const servers: Server[] = []
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind.')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('safe MCP fetch redirects', () => {
  it('preserves headers for same-origin redirects', async () => {
    let authorization = ''
    let origin = ''
    const server = createServer((request, response) => {
      if (request.url === '/start') { response.writeHead(307, { Location: `${origin}/final` }).end(); return }
      authorization = String(request.headers.authorization || '')
      response.writeHead(200).end('ok')
    })
    origin = await listen(server)
    const response = await createSafeMcpFetch(origin)(`${origin}/start`, {
      headers: { Authorization: 'Bearer secret-token' }
    })
    expect(await response.text()).toBe('ok')
    expect(authorization).toBe('Bearer secret-token')
  })

  it('blocks cross-origin redirects before secret headers reach the target', async () => {
    let targetRequests = 0
    let targetAuthorization = ''
    const targetOrigin = await listen(createServer((request, response) => {
      targetRequests++
      targetAuthorization = String(request.headers.authorization || '')
      response.writeHead(200).end('unexpected')
    }))
    const sourceOrigin = await listen(createServer((_request, response) => {
      response.writeHead(307, { Location: `${targetOrigin}/steal` }).end()
    }))
    await expect(createSafeMcpFetch(sourceOrigin)(`${sourceOrigin}/start`, {
      headers: { Authorization: 'Bearer secret-token', 'X-Secret': 'custom-secret' }
    })).rejects.toThrow(/cross-origin redirect/)
    expect(targetRequests).toBe(0)
    expect(targetAuthorization).toBe('')
  })

  it('allows a direct OAuth origin without forwarding MCP headers and normalizes HTTP 200 OAuth errors', async () => {
    let mcpHeader = ''
    let oauthMcpHeader = ''
    let oauthAuthorization = ''
    const mcpOrigin = await listen(createServer((request, response) => {
      mcpHeader = String(request.headers['x-mcp-secret'] || '')
      response.writeHead(200).end('mcp')
    }))
    const oauthOrigin = await listen(createServer((request, response) => {
      oauthMcpHeader = String(request.headers['x-mcp-secret'] || '')
      oauthAuthorization = String(request.headers.authorization || '')
      response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }))
    }))
    const safeFetch = createSafeMcpFetch(mcpOrigin, fetch, { 'X-Mcp-Secret': 'mcp-only' })

    expect(await (await safeFetch(`${mcpOrigin}/mcp`)).text()).toBe('mcp')
    const oauthResponse = await safeFetch(`${oauthOrigin}/token`, {
      method: 'POST', headers: { Authorization: 'Basic oauth-client' }
    })
    expect(oauthResponse.status).toBe(400)
    expect(mcpHeader).toBe('mcp-only')
    expect(oauthMcpHeader).toBe('')
    expect(oauthAuthorization).toBe('Basic oauth-client')
  })
})
