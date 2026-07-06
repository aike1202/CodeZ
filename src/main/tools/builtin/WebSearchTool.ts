// src/main/tools/builtin/WebSearchTool.ts
import { Tool, ToolContext } from '../Tool'
import { SearchService } from '../../services/search/SearchService'
import type { SearchOptions } from '../../services/search/SearchEngine'
import { getSettingsService } from '../../ipc/settings.handlers'

interface WebSearchArgs {
  query?: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export class WebSearchTool extends Tool {
  private searchService = new SearchService()

  get name() {
    return 'WebSearch'
  }

  get description() {
    return 'Search the web and return result titles, URLs, and snippets. Covers Chinese tech communities (Baidu, Juejin, CSDN). Use this to find information beyond the training data — recent library releases, docs, error messages, best practices. Filter with allowed_domains (only keep these hosts) or blocked_domains (exclude these hosts). After answering from results, cite the URLs you used.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only include results from these domains (host substring match).'
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude results from these domains (host substring match).'
        }
      },
      required: ['query']
    }
  }

  async execute(args: string): Promise<string> {
    let parsed: WebSearchArgs
    try {
      parsed = JSON.parse(args) as WebSearchArgs
    } catch {
      return 'Error: invalid JSON arguments.'
    }
    const query = (parsed.query || '').trim()
    if (!query) return 'Error: query is required.'

    const settings = getSettingsService().getSettings()
    const ws = settings.webSearch
    if (!ws?.enabled) {
      return 'Error: 联网搜索已在设置中关闭。'
    }

    const opts: SearchOptions = {
      allowedDomains: parsed.allowed_domains,
      blockedDomains: parsed.blocked_domains
    }

    try {
      const outcome = await this.searchService.search(query, ws, settings.httpProxy || '', opts)

      if (outcome.usedEngines.length === 0) {
        return 'Error: 未启用任何搜索引擎，请在设置中开启至少一个引擎。'
      }

      if (outcome.results.length === 0) {
        if (outcome.partialFailures.length === outcome.usedEngines.length) {
          const reasons = outcome.partialFailures
            .map((f) => `  - ${f.engine}: ${f.reason}`)
            .join('\n')
          return `Error: 所有引擎均失败：\n${reasons}`
        }
        return `未找到与 "${query}" 相关的结果。`
      }

      return this.format(query, outcome)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }

  private format(query: string, outcome: Awaited<ReturnType<SearchService['search']>>): string {
    const lines: string[] = []
    lines.push(`搜索 "${query}" 的结果（${outcome.results.length} 条，来自 ${outcome.usedEngines.join('/')}）：\n`)
    outcome.results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}${r.source ? ` [${r.source}]` : ''}`)
      lines.push(`   ${r.url}`)
      if (r.snippet) lines.push(`   ${r.snippet}`)
      lines.push('')
    })
    if (outcome.partialFailures.length > 0) {
      lines.push('部分引擎失败（不影响以上结果）：')
      outcome.partialFailures.forEach((f) => lines.push(`  - ${f.engine}: ${f.reason}`))
      lines.push('')
    }
    lines.push('Sources:')
    outcome.results.forEach((r) => lines.push(`- [${r.title}](${r.url})`))
    return lines.join('\n')
  }
}
