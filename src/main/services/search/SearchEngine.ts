// src/main/services/search/SearchEngine.ts
// 搜索引擎统一接口与相关类型定义。

/** 单条搜索结果。 */
export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** 来源站点名（可选，展示用）。 */
  source?: string
  /** 产出该结果的引擎 id。 */
  engine: string
}

/** SearchService.search 的调用级选项。 */
export interface SearchOptions {
  /** 返回结果数上限。 */
  limit?: number
  /** 仅保留这些域名（子串匹配 host）。 */
  allowedDomains?: string[]
  /** 排除这些域名（子串匹配 host）。 */
  blockedDomains?: string[]
  /** 调用级覆盖：仅用这些引擎（默认取 settings）。 */
  engines?: string[]
}

/**
 * 单个搜索引擎。职责单一：请求 + 解析某家站点的 HTML。
 * 加引擎 = 加一个实现文件，不改动其它。
 */
export interface SearchEngine {
  /** 引擎唯一标识：'baidu' | 'juejin' | 'csdn'。 */
  readonly id: string
  /** 是否需要走代理（当前引擎均为国内直连 false，保留字段以备扩展）。 */
  readonly useProxy: boolean
  /** 执行搜索，返回结果列表；失败应抛出错误由 SearchService 兜底。 */
  search(query: string, limit: number): Promise<SearchResult[]>
}
