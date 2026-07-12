import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

const CROSS_ORIGIN_STRIPPED_HEADERS = [
  'cookie', 'proxy-authorization', 'mcp-session-id', 'mcp-protocol-version'
]

function redirectedRequestInit(status: number, init: RequestInit): RequestInit {
  const method = (init.method || 'GET').toUpperCase()
  if (status !== 303 && !((status === 301 || status === 302) && method === 'POST')) return init
  const headers = new Headers(init.headers)
  headers.delete('content-type')
  headers.delete('content-length')
  return { ...init, method: 'GET', body: undefined, headers }
}

async function normalizeOAuthErrorBody(response: Response): Promise<Response> {
  if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('json')) return response
  let parsed: unknown
  try { parsed = JSON.parse(await response.clone().text()) } catch { return response }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return response
  const body = parsed as Record<string, unknown>
  if (typeof body.error !== 'string' || 'access_token' in body || 'jsonrpc' in body) return response
  return new Response(await response.text(), {
    status: 400,
    statusText: 'OAuth Error',
    headers: response.headers
  })
}

function crossOriginAllowed(url: URL): boolean {
  return url.protocol === 'https:' || (
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  )
}

export function createSafeMcpFetch(
  expectedOrigin: string,
  baseFetch: typeof fetch = fetch,
  configuredHeaders: HeadersInit = {}
): FetchLike {
  const fetchRedirect = async (input: string | URL | Request, init: RequestInit = {}, depth = 0): Promise<Response> => {
    if (depth > 3) throw new Error('MCP HTTP redirect limit exceeded.')
    const requestUrl = input instanceof Request ? new URL(input.url) : new URL(input.toString())
    const isMcpOrigin = requestUrl.origin === expectedOrigin
    if (!isMcpOrigin && !crossOriginAllowed(requestUrl)) {
      throw new Error('MCP OAuth request must use HTTPS or a loopback HTTP origin.')
    }
    const headers = new Headers(isMcpOrigin ? configuredHeaders : undefined)
    const incomingHeaders = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
    incomingHeaders.forEach((value, name) => headers.set(name, value))
    if (!isMcpOrigin) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name)
    }
    const requestInit = { ...init, headers, redirect: 'manual' as const }
    const response = await baseFetch(input, requestInit)
    if (![301, 302, 303, 307, 308].includes(response.status)) return normalizeOAuthErrorBody(response)
    const location = response.headers.get('location')
    if (!location) throw new Error('MCP server returned a redirect without Location.')
    const target = new URL(location, requestUrl)
    if (target.origin !== requestUrl.origin) {
      throw new Error('MCP cross-origin redirect was blocked to protect authorization headers.')
    }
    return fetchRedirect(target, redirectedRequestInit(response.status, requestInit), depth + 1)
  }
  return fetchRedirect as FetchLike
}
