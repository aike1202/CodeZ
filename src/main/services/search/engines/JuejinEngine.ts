// src/main/services/search/engines/JuejinEngine.ts
// 掘金搜索：直连（国内技术社区）。使用其公开搜索 API（返回 JSON）。

import type { SearchEngine, SearchResult } from '../SearchEngine'
import { httpGet } from '../httpClient'

/** 从掘金搜索 API 的 JSON 响应解析结果。导出供离线测试。 */
export function parseJuejinJson(body: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  let json: any
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error('掘金响应非合法 JSON')
  }
  const list: any[] = Array.isArray(json?.data) ? json.data : []
  for (const item of list) {
    if (results.length >= limit) break
    // 结果项结构：result_model.article_info / result_type
    const info =
      item?.result_model?.article_info ||
      item?.result_model?.info ||
      item?.article_info ||
      item?.result_model
    if (!info) continue
    const id = info.article_id || item?.result_model?.article_id || info.id
    const title: string = info.title || info.article_title || ''
    if (!title) continue
    const snippet: string = info.brief_content || info.content || info.summary || ''
    const url = id ? `https://juejin.cn/post/${id}` : info.url || ''
    if (!url) continue
    results.push({ title, url, snippet, source: '掘金', engine: 'juejin' })
  }
  return results
}

export class JuejinEngine implements SearchEngine {
  readonly id = 'juejin'
  readonly useProxy = false

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url =
      `https://api.juejin.cn/search_api/v1/search?query=${encodeURIComponent(query)}` +
      `&id_type=0&cursor=0&limit=${Math.min(limit * 2, 40)}&search_type=0&sort_type=0&aid=2608&uuid=0`
    const res = await httpGet(url, {
      useProxy: this.useProxy,
      headers: { accept: 'application/json, text/plain, */*', referer: 'https://juejin.cn/' }
    })
    if (res.status !== 200) {
      throw new Error(`掘金返回 HTTP ${res.status}`)
    }
    const parsed = parseJuejinJson(res.body, limit)
    if (parsed.length === 0) {
      throw new Error('掘金解析出 0 条结果（可能接口改版）')
    }
    return parsed
  }
}
