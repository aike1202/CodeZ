# WebSearch / WebFetch 联网搜索设计文档

> 创建时间：2026-07-05
> 状态：approved
> 范围：src/main/services/search/（新增）+ src/main/tools/builtin/ + src/main/services/PermissionManager.ts + src/shared/types/settings.ts + src/renderer 设置与执行日志 UI

## 1. 目标

为 CodeZ 增加两个内置工具，让模型能联网获取训练数据之外的信息：

- **WebSearch** — 搜索网络，返回结果标题/URL/摘要。覆盖国内技术社区（百度、掘金、CSDN）与国外（DuckDuckGo）。
- **WebFetch** — 抓取指定 URL 的正文并转 Markdown，用于读官方文档（腾讯云、阿里云、组件官网等）。

**核心约束（决定了整个方案形状）：**

1. **纯自研、内置**：不引入外部服务/常驻进程/额外运行时依赖。搜索是"发 HTTP 请求 + 解析 HTML"的纯函数逻辑，跑在 Electron 主进程。
2. **国内可用**：主力用户在国内网络。百度/掘金/CSDN 直连可用（已实测）。
3. **免 key**：不依赖任何商业搜索 API。
4. **支持国外 + 网络自适应（手动）**：国外引擎（DuckDuckGo）走用户已配置的 `httpProxy`；用户在设置里按自己的网络勾选启用哪些引擎。
5. **博客站可控**：用户可在设置界面控制哪些站点/引擎参与搜索。

## 2. 背景与选型结论（为什么自研）

前期做过充分调研与实测，结论固化于此，避免后续反复：

| 方案 | 结论 |
|------|------|
| 模型原生 web search（Anthropic/OpenAI/Gemini） | 依赖特定 Provider，第三方中转 API 格式碎片化，且需绑定具体模型能力，放弃 |
| Firecrawl / Maxun（重型爬取平台） | 独立服务 + Docker 全家桶（Redis/Postgres/Playwright），无法作为库嵌入桌面 app，放弃 |
| open-webSearch（MCP/daemon） | 可用，但需常驻子进程 + 打包依赖；其百度实现返回 302（我们裸爬百度成功），Bing/搜狗 301；结果含脏标签。放弃直接依赖 |
| **自研 SearchProvider** | **选定**。零进程、零依赖、融入现有 Tool 架构；百度/掘金/CSDN/DDG 已全部实测可爬 |

**实测数据（决定引擎清单）：**

| 引擎 | 国内直连（本机） | 走代理（本机） | 结论 |
|------|:---:|:---:|------|
| 百度 | ✅ | — | 国内主力 |
| 掘金 | ✅ | — | 国内技术社区 |
| CSDN | ✅（结果含 `<em>` 需清理） | — | 国内技术社区 |
| DuckDuckGo | 不稳 | ✅（Android官方/Wikipedia 等优质源） | 国外，走代理 |
| Bing / 搜狗 | ❌ 301 | ❌ 301 | 放弃 |

## 3. 整体架构

```
┌─ 工具层 (src/main/tools/builtin/)
│   ├─ WebSearchTool    → SearchService.search()
│   └─ WebFetchTool     → ContentFetcher.fetch()
│
├─ 服务层 (src/main/services/search/)
│   ├─ SearchService         统一编排：选引擎、并发/兜底、去重、结果侧域名过滤、截断
│   ├─ SearchEngine (接口)    search(query, opts): Promise<SearchResult[]>
│   │   ├─ engines/BaiduEngine        国内，直连
│   │   ├─ engines/JuejinEngine       国内，直连
│   │   ├─ engines/CsdnEngine         国内，直连（清理 <em> 标签）
│   │   └─ engines/DuckDuckGoEngine   国外，useProxy=true
│   ├─ ContentFetcher         WebFetch：抓 URL → 抽正文 → 转 Markdown
│   └─ httpClient             undici 请求封装（UA/超时/重定向/按 useProxy 挂 ProxyAgent）
│
└─ 配置：WebSearchSettings 存 settings.json
```

**设计原则：**

- **每个 `SearchEngine` 是独立单元**，单一职责（只管"请求 + 解析这家 HTML"），实现同一接口，可用离线 HTML 样本独立测试。加引擎 = 加一个文件，不改动其它。
- **`SearchService` 是唯一编排者**：决定启用哪些引擎、失败兜底、聚合去重、域名过滤。工具层只依赖它，不接触引擎细节。
- **代理由 `httpClient` 按引擎的 `useProxy` 标志统一处理**：国内引擎直连，DuckDuckGoEngine 挂 `ProxyAgent`（读现有 `httpProxy`）。引擎实现不关心代理。

## 4. 数据流

### WebSearch

```
模型调 WebSearch(query, allowed_domains?, blocked_domains?)
  → PermissionManager 检查（network → 首次 ask，可永久允许）
  → SearchService.search(query, opts):
      1. 读 WebSearchSettings，确定启用的引擎列表
      2. 对启用引擎并发请求（Promise.allSettled，单引擎失败不影响其它）
      3. 各引擎返回 SearchResult[]
      4. 聚合 → 按 url 去重 → 域名过滤（settings.blockedDomains + 调用参数 allowed/blocked_domains）
      5. 截断到 maxResults
  → 返回 token 友好文本（编号列表 + 末尾 Sources 列表）
```

### WebFetch

```
模型调 WebFetch(url, prompt?)
  → PermissionManager 检查（network → ask）
  → ContentFetcher.fetch(url): 抓 HTML → 抽正文 → 转 Markdown（截断上限）
  → 返回正文文本
```

### 类型定义

```typescript
interface SearchResult {
  title: string
  url: string
  snippet: string
  source?: string   // 来源站点名（可选，展示用）
  engine: string    // 产出该结果的引擎 id
}

interface SearchOptions {
  limit?: number
  allowedDomains?: string[]   // 调用级：仅保留这些域名（子串匹配 host）
  blockedDomains?: string[]   // 调用级：排除这些域名
  engines?: string[]          // 调用级覆盖：仅用这些引擎（默认取 settings）
}

interface SearchEngine {
  readonly id: string          // 'baidu' | 'juejin' | 'csdn' | 'duckduckgo'
  readonly useProxy: boolean   // 国内 false，国外 true
  search(query: string, limit: number): Promise<SearchResult[]>
}
```

## 5. 配置（settings.json 新增 webSearch 字段）

```typescript
interface WebSearchSettings {
  enabled: boolean            // 总开关，默认 true
  engines: {
    baidu: boolean            // 默认 true
    juejin: boolean           // 默认 true
    csdn: boolean             // 默认 true
    duckduckgo: boolean       // 默认 false（需代理）
  }
  blockedDomains: string[]    // 用户自定义排除站点，默认 []
  maxResults: number          // 默认 10
}
```

**默认值加入 `defaultSettings`**（`src/shared/types/settings.ts`）。

**"博客站开关" 的落地** = `engines` 勾选（引擎级：关掉 CSDN 则不启用该引擎）+ `blockedDomains` 域名过滤（结果级：想搜但排除某域名）。

**网络自适应 = 手动选**：用户按自身网络在设置勾引擎（能翻墙 → 勾 duckduckgo 并配代理；纯国内 → 勾百度/掘金/CSDN）。不做自动探测。

**代理来源**：复用现有 `httpProxy` 设置（当前为空壳，本次首次真正接入）。DuckDuckGoEngine 请求经 `httpClient` 挂 `ProxyAgent(httpProxy)`。若启用了国外引擎但 `httpProxy` 为空，该引擎失败并提示需配置代理。

## 6. 错误处理

| 情况 | 处理 |
|------|------|
| 单引擎失败（302/超时/解析空） | `allSettled` 捕获，记入返回的 `partialFailures`，不影响其它引擎 |
| 全部引擎失败 | 返回明确错误，列出各引擎失败原因（不假装"无结果"） |
| 无匹配结果 | 返回"未找到相关结果" |
| 启用国外引擎但未配代理 | 该引擎失败并提示"需配置 httpProxy" |
| 解析出 0 条（反爬/改版） | 记为该引擎失败，便于诊断是网络问题还是解析规则失效 |
| WebFetch 抓取失败 / 非 HTML 内容 | 返回错误说明 |

**原则**：失败可见、可诊断。单引擎抖动不拖垮整体（`Promise.allSettled`）；全失败才报错。

## 7. 权限

`PermissionManager.checkToolPermission` 与 `createPermissionRequest` 增加 `WebSearch` / `WebFetch` 分支：

- risk = `network`
- `full-access` → allow
- `auto-approve-safe` / `ask` → ask（走 `PermissionRuleStore`，用户可选"本会话/永久允许"）
- 描述：`搜索网络: <query>` / `读取网页: <url>`

不加入 base safe 白名单（出网 + 将 query 发往第三方，非纯本地只读）。

## 8. UI（复用现有链路，不新增复杂组件）

- `ExecutionLog/utils/itemParsers.ts`：`getToolNoun` 加 `WebSearch`→"网页搜索"、`WebFetch`→"网页"
- `ExecutionLog/utils/timelineBuilder.ts`：verb `Searching/Searched`、`Fetching/Fetched`；targetDisplay 展示 query / url
- `ExecutionLogDetail`：搜索结果先走默认渲染（Parameters + Output 文本），后续可增强为结果卡片
- **设置界面**（`SettingsGeneralTab`）：新增"联网搜索"区块
  - 启用总开关
  - 引擎勾选：国内组（百度/掘金/CSDN）、国外组（DuckDuckGo，注明"需代理"）
  - 自定义排除站点（blockedDomains 增删）

## 9. 只读工具归类

WebSearch/WebFetch 是只读（不改文件系统），可考虑加入 `ToolManager.READ_ONLY_TOOL_NAMES` 使 Plan 模式 / Research 子智能体可用。**但它们出网**，与现有只读工具（纯本地）语义不同。

**决策**：本期**不**加入只读集合，保持"只读 = 纯本地"的既有语义清晰；Plan 模式下不联网。若后续 Research 子智能体明确需要联网，再单独评估。

## 10. 测试

- **各 Engine 解析**：用离线 HTML 样本单测（`src/tests/search-engines.test.ts`），不依赖实时网络，避免 CI 抖动与反爬干扰。样本从实测响应中采集。
- **SearchService**：去重、域名过滤（allowed/blocked）、`allSettled` 兜底、截断逻辑单测。
- **手动验证**：`npm run dev` 中真实触发 WebSearch/WebFetch，确认权限弹窗、结果展示、代理路径（国外引擎）。注意：解析依赖目标站 HTML 结构，改版时样本测试会先失效，作为回归信号。

## 11. 文件清单

```
新增：
  src/main/services/search/SearchService.ts
  src/main/services/search/SearchEngine.ts          （接口 + 类型）
  src/main/services/search/engines/BaiduEngine.ts
  src/main/services/search/engines/JuejinEngine.ts
  src/main/services/search/engines/CsdnEngine.ts
  src/main/services/search/engines/DuckDuckGoEngine.ts
  src/main/services/search/ContentFetcher.ts
  src/main/services/search/httpClient.ts
  src/main/tools/builtin/WebSearchTool.ts
  src/main/tools/builtin/WebFetchTool.ts
  src/tests/search-engines.test.ts

修改：
  src/shared/types/settings.ts                      （+ webSearch 配置 + 默认值）
  src/main/tools/ToolManager.ts                     （注册 2 个工具）
  src/main/services/PermissionManager.ts            （network 分支 x2）
  src/renderer/.../ExecutionLog/utils/itemParsers.ts
  src/renderer/.../ExecutionLog/utils/timelineBuilder.ts
  src/renderer/.../SettingsGeneralTab/...           （联网搜索设置区块）
```

## 12. 范围与取舍（YAGNI）

- 引擎聚焦 4 个（百度/掘金/CSDN/DDG），均已实测可行；加引擎为后续增量，只需新增 engine 文件
- Bing/搜狗放弃（实测 301，open-webSearch 亦失败）
- 无自动网络探测（手动选引擎，简单可控）
- 结果展示先用默认渲染，不做花哨卡片
- WebFetch 正文抽取用轻量方式（无头浏览器不引入）；JS 重渲染页面不保证完整，属已知限制
- 百度跳转链（`baidu.com/link?url=`）需在 BaiduEngine 内还原真实 URL（跟随重定向读 Location），作为该引擎实现细节
```
