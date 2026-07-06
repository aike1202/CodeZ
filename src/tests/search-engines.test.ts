import { describe, it, expect } from 'vitest'
import { parseBaiduHtml } from '../main/services/search/engines/BaiduEngine'
import { parseJuejinJson } from '../main/services/search/engines/JuejinEngine'
import { parseCsdnJson } from '../main/services/search/engines/CsdnEngine'
import { htmlToMarkdown } from '../main/services/search/ContentFetcher'
import { stripTags, decodeEntities, extractAttr } from '../main/services/search/htmlUtils'
import { SearchService } from '../main/services/search/SearchService'
import type { SearchEngine, SearchResult } from '../main/services/search/SearchEngine'
import type { WebSearchSettings } from '../shared/types/settings'

describe('htmlUtils', () => {
  it('decodeEntities 解码命名与数字实体', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b')
    expect(decodeEntities('&#39;quote&#39;')).toBe("'quote'")
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>')
    expect(decodeEntities('&#x4e2d;')).toBe('中')
  })

  it('stripTags 移除标签并折叠空白', () => {
    expect(stripTags('<em>Hello</em>  <b>World</b>')).toBe('Hello World')
    expect(stripTags('<script>bad()</script>text')).toBe('text')
  })

  it('extractAttr 提取属性值', () => {
    expect(extractAttr('<a href="https://x.com/p">', 'href')).toBe('https://x.com/p')
    expect(extractAttr("<a href='http://y.com'>", 'href')).toBe('http://y.com')
  })
})

describe('BaiduEngine.parseBaiduHtml', () => {
  const html = `
    <div class="result c-container" >
      <h3 class="t"><a href="https://www.baidu.com/link?url=abc">标题<em>一</em></a></h3>
      <div class="c-abstract">这是<em>摘要</em>一。</div>
    </div>
    <div class="result c-container">
      <h3 class="t"><a href="https://real.example.com/page">标题二</a></h3>
      <div class="content-right">摘要二内容</div>
    </div>`

  it('解析标题、链接、摘要', () => {
    const res = parseBaiduHtml(html, 10)
    expect(res.length).toBe(2)
    expect(res[0].title).toBe('标题一')
    expect(res[0].url).toContain('baidu.com/link')
    expect(res[0].snippet).toBe('这是摘要一。')
    expect(res[0].engine).toBe('baidu')
    expect(res[1].title).toBe('标题二')
    expect(res[1].snippet).toBe('摘要二内容')
  })

  it('尊重 limit', () => {
    expect(parseBaiduHtml(html, 1).length).toBe(1)
  })
})

describe('JuejinEngine.parseJuejinJson', () => {
  const body = JSON.stringify({
    data: [
      {
        result_model: {
          article_info: { article_id: '7123', title: '掘金标题', brief_content: '简介内容' }
        }
      },
      { result_model: { article_info: { article_id: '7999', title: '第二篇' } } }
    ]
  })

  it('解析文章并构造 URL', () => {
    const res = parseJuejinJson(body, 10)
    expect(res.length).toBe(2)
    expect(res[0].title).toBe('掘金标题')
    expect(res[0].url).toBe('https://juejin.cn/post/7123')
    expect(res[0].snippet).toBe('简介内容')
    expect(res[0].engine).toBe('juejin')
  })

  it('非法 JSON 抛错', () => {
    expect(() => parseJuejinJson('not json', 10)).toThrow()
  })
})

describe('CsdnEngine.parseCsdnJson', () => {
  const body = JSON.stringify({
    result_vos: [
      {
        title: 'CSDN<em>标题</em>',
        url: 'https://blog.csdn.net/u/article/details/1',
        description: '这是<em>描述</em>'
      },
      { title: '无链接', url: '' }
    ]
  })

  it('清理 <em> 标签并过滤无效链接', () => {
    const res = parseCsdnJson(body, 10)
    expect(res.length).toBe(1)
    expect(res[0].title).toBe('CSDN标题')
    expect(res[0].snippet).toBe('这是描述')
    expect(res[0].engine).toBe('csdn')
  })
})

describe('ContentFetcher.htmlToMarkdown', () => {
  it('提取标题并转换正文', () => {
    const html = `
      <html><head><title>页面标题</title></head>
      <body>
        <nav>导航栏</nav>
        <article>
          <h1>大标题</h1>
          <p>第一段。</p>
          <ul><li>项目 A</li><li>项目 B</li></ul>
          <a href="https://x.com">链接</a>
        </article>
        <footer>页脚</footer>
      </body></html>`
    const { title, markdown } = htmlToMarkdown(html)
    expect(title).toBe('页面标题')
    expect(markdown).toContain('# 大标题')
    expect(markdown).toContain('第一段。')
    expect(markdown).toContain('- 项目 A')
    expect(markdown).toContain('[链接](https://x.com)')
    // 噪声块应被移除
    expect(markdown).not.toContain('导航栏')
    expect(markdown).not.toContain('页脚')
  })
})

// ---- SearchService 编排逻辑（用假引擎，不触网）----

class FakeEngine implements SearchEngine {
  constructor(
    public readonly id: string,
    public readonly useProxy: boolean,
    private readonly output: SearchResult[] | Error
  ) {}
  async search(): Promise<SearchResult[]> {
    if (this.output instanceof Error) throw this.output
    return this.output
  }
}

function makeSettings(overrides?: Partial<WebSearchSettings>): WebSearchSettings {
  return {
    enabled: true,
    engines: { baidu: true, juejin: true, csdn: true },
    blockedDomains: [],
    maxResults: 10,
    ...overrides
  }
}

function result(engine: string, url: string, title = 't'): SearchResult {
  return { title, url, snippet: '', engine }
}

describe('SearchService', () => {
  it('聚合多引擎并按 url 去重', async () => {
    const svc = new SearchService([
      new FakeEngine('baidu', false, [result('baidu', 'https://a.com/1'), result('baidu', 'https://b.com/2')]),
      new FakeEngine('juejin', false, [result('juejin', 'https://a.com/1/')]) // 与 baidu 重复（归一后）
    ])
    const out = await svc.search('q', makeSettings({ engines: { baidu: true, juejin: true, csdn: false } }), '')
    expect(out.results.length).toBe(2)
    expect(out.results.map((r) => r.url)).toEqual(['https://a.com/1', 'https://b.com/2'])
  })

  it('allSettled 兜底：单引擎失败记入 partialFailures', async () => {
    const svc = new SearchService([
      new FakeEngine('baidu', false, [result('baidu', 'https://a.com/1')]),
      new FakeEngine('csdn', false, new Error('CSDN 挂了'))
    ])
    const out = await svc.search('q', makeSettings({ engines: { baidu: true, juejin: false, csdn: true } }), '')
    expect(out.results.length).toBe(1)
    expect(out.partialFailures).toEqual([{ engine: 'csdn', reason: 'CSDN 挂了' }])
  })

  it('blockedDomains 过滤（settings + 调用级合并）', async () => {
    const svc = new SearchService([
      new FakeEngine('baidu', false, [
        result('baidu', 'https://spam.com/1'),
        result('baidu', 'https://good.com/2'),
        result('baidu', 'https://ads.net/3')
      ])
    ])
    const settings = makeSettings({
      engines: { baidu: true, juejin: false, csdn: false },
      blockedDomains: ['spam.com']
    })
    const out = await svc.search('q', settings, '', { blockedDomains: ['ads.net'] })
    expect(out.results.map((r) => r.url)).toEqual(['https://good.com/2'])
  })

  it('allowedDomains 仅保留匹配', async () => {
    const svc = new SearchService([
      new FakeEngine('baidu', false, [
        result('baidu', 'https://docs.example.com/a'),
        result('baidu', 'https://other.com/b')
      ])
    ])
    const settings = makeSettings({ engines: { baidu: true, juejin: false, csdn: false } })
    const out = await svc.search('q', settings, '', { allowedDomains: ['example.com'] })
    expect(out.results.map((r) => r.url)).toEqual(['https://docs.example.com/a'])
  })

  it('截断到 maxResults', async () => {
    const many = Array.from({ length: 20 }, (_, i) => result('baidu', `https://x.com/${i}`))
    const svc = new SearchService([new FakeEngine('baidu', false, many)])
    const settings = makeSettings({ maxResults: 5, engines: { baidu: true, juejin: false, csdn: false } })
    const out = await svc.search('q', settings, '')
    expect(out.results.length).toBe(5)
  })

  it('opts.engines 覆盖 settings', async () => {
    const svc = new SearchService([
      new FakeEngine('baidu', false, [result('baidu', 'https://a.com/1')]),
      new FakeEngine('juejin', false, [result('juejin', 'https://b.com/2')])
    ])
    const settings = makeSettings() // baidu/juejin/csdn 都开
    const out = await svc.search('q', settings, '', { engines: ['juejin'] })
    expect(out.usedEngines).toEqual(['juejin'])
    expect(out.results.map((r) => r.engine)).toEqual(['juejin'])
  })

  it('无启用引擎返回空', async () => {
    const svc = new SearchService([new FakeEngine('baidu', false, [])])
    const settings = makeSettings({ engines: { baidu: false, juejin: false, csdn: false } })
    const out = await svc.search('q', settings, '')
    expect(out.usedEngines).toEqual([])
    expect(out.results).toEqual([])
  })
})
