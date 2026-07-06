// src/main/tools/builtin/WebFetchTool.ts
import { Tool } from '../Tool'
import { ContentFetcher } from '../../services/search/ContentFetcher'
import { configureProxy } from '../../services/search/httpClient'
import { getSettingsService } from '../../ipc/settings.handlers'

interface WebFetchArgs {
  url?: string
  prompt?: string
}

export class WebFetchTool extends Tool {
  private fetcher = new ContentFetcher()

  get name() {
    return 'WebFetch'
  }

  get summary() {
    return 'Fetch and process content from a URL.'
  }

  get description() {
    return "Fetch a URL, extract the main content, and convert it to Markdown. Use this to read documentation, articles, or reference pages. Returns the page title and body text (truncated if very long). Note: JS-heavy pages that render content client-side may return incomplete text. The optional prompt describes what you're looking for on the page."
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch (http/https only).' },
        prompt: { type: 'string', description: 'Optional: what to look for on the page.' }
      },
      required: ['url']
    }
  }

  async execute(args: string): Promise<string> {
    let parsed: WebFetchArgs
    try {
      parsed = JSON.parse(args) as WebFetchArgs
    } catch {
      return 'Error: invalid JSON arguments.'
    }
    const url = (parsed.url || '').trim()
    if (!url) return 'Error: url is required.'

    const settings = getSettingsService().getSettings()
    // 国外站点可能需代理；这里统一注入代理地址，是否使用由 host 简单判断
    configureProxy(settings.httpProxy || '')
    const useProxy = this.shouldUseProxy(url, !!settings.httpProxy)

    try {
      const result = await this.fetcher.fetch(url, useProxy)
      const header = result.title ? `# ${result.title}\n\n来源: ${result.url}\n` : `来源: ${result.url}\n`
      const trunc = result.truncated ? '\n\n[内容过长已截断]' : ''
      const body = result.markdown || '(未抽取到正文内容)'
      return `${header}\n${body}${trunc}`
    } catch (err: any) {
      // 若直连失败且配置了代理，重试一次走代理（应对国外站点）
      if (!useProxy && settings.httpProxy) {
        try {
          const result = await this.fetcher.fetch(url, true)
          const header = result.title ? `# ${result.title}\n\n来源: ${result.url}\n` : `来源: ${result.url}\n`
          const trunc = result.truncated ? '\n\n[内容过长已截断]' : ''
          return `${header}\n${result.markdown || '(未抽取到正文内容)'}${trunc}`
        } catch (err2: any) {
          return `Error: ${err2.message}`
        }
      }
      return `Error: ${err.message}`
    }
  }

  /** 简单启发：非国内常见 host 且配置了代理时走代理。 */
  private shouldUseProxy(url: string, hasProxy: boolean): boolean {
    if (!hasProxy) return false
    try {
      const host = new URL(url).host.toLowerCase()
      const cnHints = ['.cn', 'baidu.', 'juejin.', 'csdn.', 'aliyun.', 'tencent.', 'qq.com', 'gitee.', 'zhihu.']
      return !cnHints.some((h) => host.includes(h))
    } catch {
      return false
    }
  }
}
