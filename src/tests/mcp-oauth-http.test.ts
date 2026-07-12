import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server } from 'http'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  shell: { openExternal: vi.fn(async () => undefined) }
}))

import * as os from 'os'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { McpOAuthProvider, revokeMcpOAuthTokens } from '../main/services/mcp/McpOAuthProvider'
import { createSafeMcpFetch } from '../main/services/mcp/safeFetch'

const servers: Server[] = []

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

describe('MCP OAuth over a real HTTP authorization server', () => {
  it('preserves credentials when different server identities write concurrently', async () => {
    const key = randomUUID()
    const first = new McpOAuthProvider(
      `concurrent-a-${key}`, 'a', { type: 'http', url: 'https://a.example.test/mcp' }
    )
    const second = new McpOAuthProvider(
      `concurrent-b-${key}`, 'b', { type: 'http', url: 'https://b.example.test/mcp' }
    )
    await Promise.all([
      first.saveClientInformation({ client_id: 'client-a' }),
      second.saveClientInformation({ client_id: 'client-b' })
    ])
    expect(await first.clientInformation()).toMatchObject({ client_id: 'client-a' })
    expect(await second.clientInformation()).toMatchObject({ client_id: 'client-b' })
    await Promise.all([first.clear(), second.clear()])
  })

  it('discovers metadata, validates PKCE, refreshes, and revokes refresh before access', async () => {
    let origin = ''
    let challenge = ''
    let issuedAccess = 0
    let rejectRefresh = false
    let rejectRevoke = false
    const revokeOrder: string[] = []
    const http = createServer(async (request, response) => {
      const url = new URL(request.url || '/', origin || 'http://127.0.0.1')
      const json = (value: unknown, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['mcp'] })
        return
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none']
        })
        return
      }
      if (url.pathname === '/register' && request.method === 'POST') {
        const metadata = JSON.parse(await body(request))
        json({ ...metadata, client_id: 'codez-test-client', token_endpoint_auth_method: 'none' }, 201)
        return
      }
      if (url.pathname === '/authorize') {
        challenge = url.searchParams.get('code_challenge') || ''
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        const redirect = new URL(url.searchParams.get('redirect_uri')!)
        redirect.searchParams.set('code', 'authorization-code')
        redirect.searchParams.set('state', url.searchParams.get('state') || '')
        response.writeHead(302, { Location: redirect.toString() }).end()
        return
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const params = new URLSearchParams(await body(request))
        if (params.get('grant_type') === 'authorization_code') {
          expect(params.get('code')).toBe('authorization-code')
          const verifier = params.get('code_verifier') || ''
          expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
          json({ access_token: `access-${++issuedAccess}`, refresh_token: 'refresh-1', token_type: 'bearer', expires_in: 3600 })
          return
        }
        if (params.get('grant_type') === 'refresh_token') {
          expect(params.get('refresh_token')).toBe('refresh-1')
          if (rejectRefresh) { json({ error: 'invalid_grant', error_description: 'expired refresh token' }); return }
          json({ access_token: `access-${++issuedAccess}`, refresh_token: 'refresh-1', token_type: 'bearer', expires_in: 3600 })
          return
        }
      }
      if (url.pathname === '/revoke' && request.method === 'POST') {
        if (rejectRevoke) { response.writeHead(500, { 'Content-Type': 'text/plain' }).end('non-standard failure'); return }
        const params = new URLSearchParams(await body(request))
        revokeOrder.push(`${params.get('token_type_hint')}:${params.get('token')}`)
        response.writeHead(200).end()
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    servers.push(http)
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('OAuth test server did not bind.')
    origin = `http://127.0.0.1:${address.port}`
    const oauthFetch = createSafeMcpFetch(origin)

    let provider!: McpOAuthProvider
    provider = new McpOAuthProvider(
      `oauth-test-${randomUUID()}`,
      'oauth-test',
      { type: 'http', url: `${origin}/mcp`, oauth: { scope: 'mcp' } },
      async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: 'manual' })
        const callback = authorization.headers.get('location')
        if (!callback) throw new Error('Authorization endpoint did not redirect.')
        const callbackResponse = await fetch(callback)
        expect(callbackResponse.status).toBe(200)
      }
    )
    provider.setInteractive(true)
    await provider.prepareCallback()

    await expect(auth(provider, { serverUrl: `${origin}/mcp`, scope: 'mcp', fetchFn: oauthFetch })).resolves.toBe('REDIRECT')
    const code = await provider.waitForAuthorizationCode()
    await expect(auth(provider, {
      serverUrl: `${origin}/mcp`, authorizationCode: code, scope: 'mcp', fetchFn: oauthFetch
    })).resolves.toBe('AUTHORIZED')
    expect(await provider.tokens()).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' })

    await expect(auth(provider, { serverUrl: `${origin}/mcp`, scope: 'mcp', fetchFn: oauthFetch })).resolves.toBe('AUTHORIZED')
    const refreshed = await provider.tokens()
    expect(refreshed).toMatchObject({ access_token: 'access-2', refresh_token: 'refresh-1' })
    await revokeMcpOAuthTokens(`${origin}/mcp`, refreshed!)
    expect(revokeOrder).toEqual(['refresh_token:refresh-1', 'access_token:access-2'])

    rejectRefresh = true
    await provider.prepareCallback()
    await expect(auth(provider, { serverUrl: `${origin}/mcp`, scope: 'mcp', fetchFn: oauthFetch })).resolves.toBe('REDIRECT')
    expect(await provider.tokens()).toBeUndefined()

    await provider.saveTokens({ access_token: 'local-access', refresh_token: 'local-refresh', token_type: 'bearer' })
    rejectRevoke = true
    try {
      await expect(revokeMcpOAuthTokens(`${origin}/mcp`, (await provider.tokens())!)).rejects.toThrow(/HTTP 500/)
    } finally {
      await provider.clear()
    }
    expect(await provider.tokens()).toBeUndefined()
  }, 20_000)
})
