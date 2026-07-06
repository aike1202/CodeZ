// src/main/services/search/SearchService.ts
// 搜索编排层：唯一编排者。选引擎、并发/兜底、聚合去重、域名过滤、截断。
// 工具层只依赖它，不接触引擎细节。

import type { SearchEngine, SearchResult, SearchOptions } from './SearchEngine'
import { BaiduEngine } from './engines/BaiduEngine'
import { JuejinEngine } from './engines/JuejinEngine'
import { CsdnEngine } from './engines/CsdnEngine'
import { configureProxy } from './httpClient'
import type { WebSearchSettings } from '../../../shared/types/settings'

export interface EngineFailure {
  engine: string
  reason: string
}

export interface SearchOutcome {
  results: SearchResult[]
  partialFailures: EngineFailure[]
  /** 参与本次搜索的引擎 id 列表。 */
  usedEngines: string[]
}

export class SearchService {
  private readonly engines: Map<string, SearchEngine>

  constructor(engines?: SearchEngine[]) {
    const list = engines ?? [
      new BaiduEngine(),
      new JuejinEngine(),
      new CsdnEngine()
    ]
    this.engines = new Map(list.map((e) => [e.id, e]))
  }

  /**
   * 执行搜索。
   * @param query 查询词
   * @param settings 当前 WebSearch 配置（决定默认启用引擎、maxResults、blockedDomains）
   * @param proxy 代理地址（供国外引擎），空串则直连
   * @param opts 调用级选项（覆盖引擎列表、域名过滤、limit）
   */
  async search(
    query: string,
    settings: WebSearchSettings,
    proxy: string,
    opts: SearchOptions = {}
  ): Promise<SearchOutcome> {
    configureProxy(proxy)

    const limit = opts.limit ?? settings.maxResults ?? 10
    const engineIds = this.resolveEngineIds(settings, opts)
    const usedEngines = engineIds.slice()

    if (engineIds.length === 0) {
      return { results: [], partialFailures: [], usedEngines }
    }

    // 每个引擎多取一些，聚合后再截断，减少去重/过滤后不足的情况
    const perEngineLimit = Math.max(limit, 10)
    const partialFailures: EngineFailure[] = []

    const settled = await Promise.allSettled(
      engineIds.map((id) => {
        const engine = this.engines.get(id)
        if (!engine) return Promise.reject(new Error(`未知引擎: ${id}`))
        return engine.search(query, perEngineLimit)
      })
    )

    const aggregated: SearchResult[] = []
    settled.forEach((s, i) => {
      const id = engineIds[i]
      if (s.status === 'fulfilled') {
        aggregated.push(...s.value)
      } else {
        partialFailures.push({
          engine: id,
          reason: s.reason instanceof Error ? s.reason.message : String(s.reason)
        })
      }
    })

    const deduped = this.dedupeByUrl(aggregated)
    const filtered = this.filterByDomain(
      deduped,
      opts.allowedDomains,
      this.mergeBlocked(settings.blockedDomains, opts.blockedDomains)
    )
    const results = filtered.slice(0, limit)

    return { results, partialFailures, usedEngines }
  }

  /** 确定本次启用哪些引擎：opts.engines 覆盖 > settings 勾选。 */
  private resolveEngineIds(settings: WebSearchSettings, opts: SearchOptions): string[] {
    if (opts.engines && opts.engines.length > 0) {
      return opts.engines.filter((id) => this.engines.has(id))
    }
    const enabled: string[] = []
    if (settings.engines.baidu) enabled.push('baidu')
    if (settings.engines.juejin) enabled.push('juejin')
    if (settings.engines.csdn) enabled.push('csdn')
    return enabled.filter((id) => this.engines.has(id))
  }

  /** 按 url 去重（保留首次出现，即更靠前的引擎结果）。 */
  private dedupeByUrl(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>()
    const out: SearchResult[] = []
    for (const r of results) {
      const key = this.normalizeUrl(r.url)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
    return out
  }

  /** 域名过滤：allowed 非空则仅保留匹配，blocked 排除匹配（子串匹配 host）。 */
  private filterByDomain(
    results: SearchResult[],
    allowed?: string[],
    blocked?: string[]
  ): SearchResult[] {
    const hasAllowed = allowed && allowed.length > 0
    const hasBlocked = blocked && blocked.length > 0
    if (!hasAllowed && !hasBlocked) return results
    return results.filter((r) => {
      const host = this.getHost(r.url)
      if (hasAllowed && !allowed!.some((d) => host.includes(d.toLowerCase()))) return false
      if (hasBlocked && blocked!.some((d) => host.includes(d.toLowerCase()))) return false
      return true
    })
  }

  private mergeBlocked(a?: string[], b?: string[]): string[] {
    return [...(a || []), ...(b || [])]
  }

  private getHost(url: string): string {
    try {
      return new URL(url).host.toLowerCase()
    } catch {
      return url.toLowerCase()
    }
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url)
      // 去除末尾斜杠与常见追踪参数差异，简单归一
      return `${u.host}${u.pathname}`.replace(/\/$/, '').toLowerCase()
    } catch {
      return url.trim().toLowerCase()
    }
  }
}
