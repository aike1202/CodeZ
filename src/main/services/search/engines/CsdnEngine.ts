// src/main/services/search/engines/CsdnEngine.ts
// CSDN 搜索：直连（国内技术社区）。使用其站内搜索 API（返回 JSON）。
// 结果 title/snippet 常含 <em> 高亮标签，需清理。

import type { SearchEngine, SearchResult } from '../SearchEngine'
import { httpGet } from '../httpClient'
import { stripTags } from '../htmlUtils'

/** 从 CSDN 搜索 API 的 JSON 响应解析结果。导出供离线测试。 */
export function parseCsdnJson(body: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  let json: any
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error('CSDN 响应非合法 JSON')
  }
  const list: any[] = Array.isArray(json?.result_vos)
    ? json.result_vos
    : Array.isArray(json?.data?.items)
      ? json.data.items
      : Array.isArray(json?.items)
        ? json.items
        : []
  for (const item of list) {
    if (results.length >= limit) break
    const rawTitle: string = item.title || item.name || ''
    const title = stripTags(rawTitle) // 清理 <em> 等高亮标签
    if (!title) continue
    const url: string = item.url || item.link || ''
    if (!url || !/^https?:\/\//i.test(url)) continue
    const rawSnippet: string = item.description || item.desc || item.summary || item.content || ''
    const snippet = stripTags(rawSnippet)
    results.push({ title, url, snippet, source: 'CSDN', engine: 'csdn' })
  }
  return results
}

export class CsdnEngine implements SearchEngine {
  readonly id = 'csdn'
  readonly useProxy = false

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url =
      `https://so.csdn.net/api/v3/search?q=${encodeURIComponent(query)}` +
      `&t=all&p=1&s=0&tm=0&lv=-1&ft=0&l=&u=&ct=-1&pnv=-1&ac=-1&c=&type=&mid=&kw=${encodeURIComponent(
        query
      )}&size=${Math.min(limit * 2, 30)}`
    const res = await httpGet(url, {
      useProxy: this.useProxy,
      headers: { accept: 'application/json, text/plain, */*', referer: 'https://so.csdn.net/' }
    })
    if (res.status !== 200) {
      throw new Error(`CSDN 返回 HTTP ${res.status}`)
    }
    const parsed = parseCsdnJson(res.body, limit)
    if (parsed.length === 0) {
      throw new Error('CSDN 解析出 0 条结果（可能接口改版）')
    }
    return parsed
  }
}
