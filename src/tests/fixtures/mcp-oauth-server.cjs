const { createHash } = require('crypto')
const { createServer } = require('http')

let origin = ''
let codeChallenge = ''
let issuedAccessTokens = 0

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const http = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1')

  if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    sendJson(response, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['mcp']
    })
    return
  }

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    sendJson(response, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp']
    })
    return
  }

  if (url.pathname === '/register' && request.method === 'POST') {
    const metadata = JSON.parse(await readBody(request))
    sendJson(response, {
      ...metadata,
      client_id: 'codez-rmcp-spike-client',
      token_endpoint_auth_method: 'none'
    }, 201)
    return
  }

  if (url.pathname === '/authorize' && request.method === 'GET') {
    if (url.searchParams.get('code_challenge_method') !== 'S256') {
      sendJson(response, { error: 'invalid_request', error_description: 'S256 is required' }, 400)
      return
    }
    codeChallenge = url.searchParams.get('code_challenge') || ''
    const callback = new URL(url.searchParams.get('redirect_uri'))
    callback.searchParams.set('code', 'authorization-code')
    callback.searchParams.set('state', url.searchParams.get('state') || '')
    callback.searchParams.set('iss', origin)
    response.writeHead(302, { Location: callback.toString() }).end()
    return
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    const params = new URLSearchParams(await readBody(request))
    const grantType = params.get('grant_type')
    if (grantType === 'authorization_code') {
      const verifier = params.get('code_verifier') || ''
      const actualChallenge = createHash('sha256').update(verifier).digest('base64url')
      if (params.get('code') !== 'authorization-code' || actualChallenge !== codeChallenge) {
        sendJson(response, { error: 'invalid_grant', error_description: 'PKCE validation failed' }, 400)
        return
      }
    } else if (grantType === 'refresh_token') {
      if (params.get('refresh_token') !== 'refresh-1') {
        sendJson(response, { error: 'invalid_grant', error_description: 'Unknown refresh token' }, 400)
        return
      }
    } else {
      sendJson(response, { error: 'unsupported_grant_type' }, 400)
      return
    }

    sendJson(response, {
      access_token: `access-${++issuedAccessTokens}`,
      refresh_token: 'refresh-1',
      token_type: 'bearer',
      expires_in: 3600,
      scope: 'mcp'
    })
    return
  }

  response.writeHead(404).end()
})

http.listen(0, '127.0.0.1', () => {
  const address = http.address()
  origin = `http://127.0.0.1:${address.port}`
  process.stdout.write(`${JSON.stringify({ origin })}\n`)
})

function shutdown() {
  http.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
