// src/main/services/search/ContentFetcher.ts
// WebFetch 支撑：抓取 URL → 抽正文 → 转 Markdown（带截断上限）。
// 轻量实现：不引入无头浏览器；JS 重渲染页面不保证完整（已知限制）。

import { httpGet } from './httpClient'
import { decodeEntities } from './htmlUtils'

const MAX_CONTENT_CHARS = 40_000

export interface FetchResult {
  url: string
  title: string
  markdown: string
  /** 是否因超长被截断。 */
  truncated: boolean
}

/** 将 HTML 正文转为精简 Markdown。导出供离线测试。 */
export function htmlToMarkdown(html: string): { title: string; markdown: string } {
  // 提取 <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''

  // 优先取 <main> / <article>，否则取 <body>
  let content =
    matchBlock(html, 'article') || matchBlock(html, 'main') || matchBlock(html, 'body') || html

  // 移除噪声块
  content = content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 结构化转换
  content = content
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${inline(t)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${inline(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${inline(t)}\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_m, t) => `\n#### ${inline(t)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${inline(t)}`)
    .replace(/<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi, (_m, t) => `\n\`\`\`\n${stripInner(t)}\n\`\`\`\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<a[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
      const text = inline(t)
      return text ? `[${text}](${href})` : ''
    })

  // 剥离剩余标签、解码、折叠空行
  const text = decodeEntities(content.replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim()

  return { title, markdown: text }
}

function matchBlock(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1] : null
}

/** 内联文本：剥标签 + 解码 + 单行折叠。 */
function inline(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/** 代码块内部：仅剥标签与解码，保留换行。 */
function stripInner(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim()
}

export class ContentFetcher {
  /**
   * 抓取 URL 正文。
   * @param url 目标 URL
   * @param proxy 代理地址（空串直连）
   * @param useProxy 是否走代理（默认 false；国外站点可传 true）
   */
  async fetch(url: string, useProxy = false): Promise<FetchResult> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`无效的 URL: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不支持的协议: ${parsed.protocol}`)
    }

    const res = await httpGet(url, { useProxy })
    if (res.status < 200 || res.status >= 400) {
      throw new Error(`抓取失败: HTTP ${res.status}`)
    }
    const contentType = String(res.headers['content-type'] || '')
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      throw new Error(`非 HTML 内容（Content-Type: ${contentType}），无法抽取正文`)
    }

    const { title, markdown } = htmlToMarkdown(res.body)
    const truncated = markdown.length > MAX_CONTENT_CHARS
    return {
      url,
      title,
      markdown: truncated ? markdown.slice(0, MAX_CONTENT_CHARS) : markdown,
      truncated
    }
  }
}
