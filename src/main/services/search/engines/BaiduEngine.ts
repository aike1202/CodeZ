// src/main/services/search/engines/BaiduEngine.ts
// 百度搜索：直连（国内主力）。结果页 HTML 解析。
// 百度结果链接是跳转链（baidu.com/link?url=...），需还原真实 URL（读 Location）。

import type { SearchEngine, SearchResult } from '../SearchEngine'
import { httpGet, httpHead } from '../httpClient'
import { stripTags, extractAttr } from '../htmlUtils'

/** 从百度结果页 HTML 解析结果（未还原跳转链）。导出供离线测试。 */
export function parseBaiduHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  // 每个结果块以 <div ... class="result ..."> 开头；用 h3.t > a 提取标题与链接
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1)
  for (const block of blocks) {
    if (results.length >= limit) break
    const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
    if (!h3Match) continue
    const aMatch = h3Match[1].match(/<a[^>]*>[\s\S]*?<\/a>/i)
    if (!aMatch) continue
    const aTag = aMatch[0]
    const openTag = aTag.match(/<a[^>]*>/i)?.[0] || ''
    const url = extractAttr(openTag, 'href')
    if (!url) continue
    const title = stripTags(aTag)
    if (!title) continue
    // 摘要：优先 c-abstract / content-right 区域
    const abstractMatch =
      block.match(/<[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/<[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    const snippet = abstractMatch ? stripTags(abstractMatch[1]) : ''
    results.push({ title, url, snippet, source: '百度', engine: 'baidu' })
  }
  return results
}

export class BaiduEngine implements SearchEngine {
  readonly id = 'baidu'
  readonly useProxy = false

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.min(limit * 2, 50)}`
    const res = await httpGet(url, { useProxy: this.useProxy })
    if (res.status !== 200) {
      throw new Error(`百度返回 HTTP ${res.status}`)
    }
    const parsed = parseBaiduHtml(res.body, limit)
    if (parsed.length === 0) {
      throw new Error('百度解析出 0 条结果（可能反爬或页面改版）')
    }
    // 还原跳转链真实 URL（并发，失败则保留原链接）
    await Promise.all(
      parsed.map(async (r) => {
        if (/^https?:\/\/www\.baidu\.com\/link\?/i.test(r.url)) {
          try {
            const head = await httpHead(r.url, { useProxy: this.useProxy })
            if (head.location) r.url = head.location
          } catch {
            // 保留跳转链
          }
        }
      })
    )
    return parsed
  }
}
