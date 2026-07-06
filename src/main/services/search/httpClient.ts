// src/main/services/search/httpClient.ts
// 基于 undici 的 HTTP 请求封装：统一 UA / 超时 / 重定向 / 按 useProxy 挂 ProxyAgent。
// 引擎实现不关心代理，只声明 useProxy；代理地址由 SearchService 通过 configureProxy 注入。

import { request, ProxyAgent, Agent } from 'undici'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REDIRECTIONS = 5

/** 模块级代理地址，由 SearchService 在每次搜索前注入（空串表示直连）。 */
let currentProxy = ''
let proxyAgent: ProxyAgent | null = null
let directAgent: Agent | null = null

/** 配置代理地址（供需要代理的引擎使用）。传空串即直连。 */
export function configureProxy(proxy: string): void {
  const normalized = (proxy || '').trim()
  if (normalized === currentProxy) return
  currentProxy = normalized
  // 代理地址变化时重建 ProxyAgent
  if (proxyAgent) {
    proxyAgent.close().catch(() => {})
    proxyAgent = null
  }
}

export interface HttpGetOptions {
  /** 是否走代理。为 true 但未配置代理时抛错。 */
  useProxy?: boolean
  timeoutMs?: number
  headers?: Record<string, string>
  /** 最大重定向次数，默认 5；设 0 则不跟随（用于读取 Location）。 */
  maxRedirections?: number
}

export interface HttpResponse {
  status: number
  body: string
  /** 最终 URL（跟随重定向后）。 */
  headers: Record<string, string | string[] | undefined>
}

function getDispatcher(useProxy: boolean) {
  if (useProxy) {
    if (!currentProxy) {
      throw new Error('该引擎需要代理，但未配置 httpProxy（请在设置中填写 HTTP 代理）')
    }
    if (!proxyAgent) {
      proxyAgent = new ProxyAgent({ uri: currentProxy, connectTimeout: DEFAULT_TIMEOUT_MS })
    }
    return proxyAgent
  }
  if (!directAgent) {
    directAgent = new Agent({ connectTimeout: DEFAULT_TIMEOUT_MS })
  }
  return directAgent
}

/** GET 请求并返回文本正文。 */
export async function httpGet(url: string, opts: HttpGetOptions = {}): Promise<HttpResponse> {
  const useProxy = opts.useProxy ?? false
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirections = opts.maxRedirections ?? MAX_REDIRECTIONS
  const dispatcher = getDispatcher(useProxy)

  const res = await request(url, {
    method: 'GET',
    dispatcher,
    maxRedirections,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    headers: {
      'user-agent': DEFAULT_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(opts.headers || {})
    }
  })

  const body = await res.body.text()
  return {
    status: res.statusCode,
    body,
    headers: res.headers as Record<string, string | string[] | undefined>
  }
}

/** POST JSON 请求并返回文本正文（掘金搜索 API 用）。 */
export async function httpPostJson(
  url: string,
  jsonBody: unknown,
  opts: HttpGetOptions = {}
): Promise<HttpResponse> {
  const useProxy = opts.useProxy ?? false
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const dispatcher = getDispatcher(useProxy)

  const res = await request(url, {
    method: 'POST',
    dispatcher,
    maxRedirections: opts.maxRedirections ?? MAX_REDIRECTIONS,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    body: JSON.stringify(jsonBody),
    headers: {
      'user-agent': DEFAULT_UA,
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(opts.headers || {})
    }
  })
  const body = await res.body.text()
  return {
    status: res.statusCode,
    body,
    headers: res.headers as Record<string, string | string[] | undefined>
  }
}

/** 仅取响应头（不下载正文），用于还原重定向真实 URL。 */
export async function httpHead(
  url: string,
  opts: HttpGetOptions = {}
): Promise<{ status: number; location?: string }> {
  const useProxy = opts.useProxy ?? false
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const dispatcher = getDispatcher(useProxy)

  const res = await request(url, {
    method: 'GET',
    dispatcher,
    maxRedirections: 0, // 不跟随，读取首个 Location
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    headers: { 'user-agent': DEFAULT_UA }
  })
  // 主动丢弃 body，避免连接挂起
  res.body.dump().catch(() => {})

  const loc = res.headers['location']
  return {
    status: res.statusCode,
    location: Array.isArray(loc) ? loc[0] : loc
  }
}
