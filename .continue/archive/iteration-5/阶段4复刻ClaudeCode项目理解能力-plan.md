# 📝 开发计划 - 阶段 4：复刻 Claude Code 项目理解与高效 Agent 能力

> 关联需求：阶段4复刻ClaudeCode项目理解能力-requirements.md
> 迭代：iteration-5
> 创建时间：2026-06-26 09:14
> 最后更新：2026-06-26 09:14
> 当前阶段：计划/设计

## 技术方案

阶段 4 的核心方案是将“项目分析”从模型驱动的逐层探索，改为“本地确定性快照 + 模型语义归纳”的混合流程。

当前阶段 3 的工具系统已经具备基本抽象：

- `src/main/tools/Tool.ts`
- `src/main/tools/ToolManager.ts`
- `src/main/tools/builtin/ListFilesTool.ts`
- `src/main/tools/builtin/ReadFileTool.ts`
- `src/main/tools/builtin/SearchTextTool.ts`

本阶段将在此基础上新增四个高层只读工具：

1. `get_project_snapshot`
2. `read_many_files`
3. `search_code`
4. `get_symbol_map`

同时优化 Agent 的项目分析策略提示，让模型在用户请求“分析项目 / 了解项目 / 梳理项目结构”时优先调用高层工具，而不是逐层调用 `list_files`。

项目快照、批量读取、代码搜索、符号索引都在主进程本地执行，严格复用 workspace root 约束，避免路径穿越。模型只接收已经整理过的结构化结果，从而减少工具调用轮数和 token 浪费。

## 架构设计

### 1. 工具层扩展

新增工具文件：

```text
src/main/tools/builtin/GetProjectSnapshotTool.ts
src/main/tools/builtin/ReadManyFilesTool.ts
src/main/tools/builtin/SearchCodeTool.ts
src/main/tools/builtin/GetSymbolMapTool.ts
```

并在以下文件注册：

```text
src/main/tools/ToolManager.ts
```

工具职责：

| 工具 | 主要职责 | 替代旧流程 |
|---|---|---|
| `get_project_snapshot` | 获取项目类型、目录树、scripts、依赖、入口、推荐文件 | 多次 `list_files` + 读 `package.json` |
| `read_many_files` | 一次读取多个关键文件 | 多次 `read_file` |
| `search_code` | 带行号和上下文的代码搜索 | 简单 `search_text` |
| `get_symbol_map` | 快速建立轻量符号索引 | 多次搜索 class/function/IPC |

### 2. 服务层扩展

为了避免工具类变得过重，新增项目分析服务：

```text
src/main/services/ProjectAnalysisService.ts
```

职责：

- 构建目录树
- 解析 `package.json`
- 判断项目类型
- 判断包管理器
- 识别入口文件
- 生成 recommendedFiles
- 计算 package/lockfile hash
- 管理项目快照缓存
- 提供公共的文件遍历/忽略规则

### 3. 类型层扩展

新增共享类型文件：

```text
src/shared/types/project-analysis.ts
```

建议类型：

```ts
export interface ProjectSnapshot {
  rootName: string
  rootPath: string
  projectType: string
  packageManager: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  configFiles: string[]
  entrypoints: string[]
  recommendedFiles: string[]
  tree: string
  fromCache: boolean
  updatedAt: string
}

export interface ReadManyFilesResult {
  files: Array<{
    path: string
    content: string
    truncated: boolean
    totalLines: number
    error?: string
  }>
}

export interface CodeSearchResult {
  matches: Array<{
    path: string
    line: number
    text: string
    before?: string[]
    after?: string[]
  }>
  truncated: boolean
}

export interface SymbolMapResult {
  symbols: Array<{
    name: string
    kind: string
    path: string
    line: number
  }>
  truncated: boolean
}
```

### 4. Agent 策略提示优化

修改 `src/main/ipc/chat.handlers.ts` 中传入模型的 system prompt，增加项目分析工具策略：

```text
当用户要求分析项目、理解项目结构、梳理代码库时：
1. 优先调用 get_project_snapshot。
2. 再调用 read_many_files 读取 recommendedFiles。
3. 必要时调用 search_code 定位关键符号。
4. 避免逐层调用 list_files，除非项目快照不足。
```

目标是让模型自然选择高层工具。

### 5. 执行记录适配

修改：

```text
src/renderer/src/components/chat/ExecutionLog.tsx
```

新增工具展示文案：

| 工具 | 折叠标题 |
|---|---|
| `get_project_snapshot` | 已分析项目快照 |
| `read_many_files` | 已读取 N 个文件 |
| `search_code` | 已搜索代码 query / 已搜索 N 处匹配 |
| `get_symbol_map` | 已建立符号索引 |

继续遵守：

- 最外层默认折叠。
- 工具详情默认折叠。
- 只显示真实工具结果。
- 真实 thinking/reasoning 只展示模型返回内容，不伪造。
- 不使用 Emoji。

### 6. 缓存策略

项目快照缓存优先放在应用 `userData` 下，而不是写入用户 workspace，避免污染项目目录。

建议文件：

```text
<app userData>/project-snapshots.json
```

缓存 key：

```text
rootPath
```

缓存失效：

- `package.json` hash 改变
- `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` hash 改变
- 工具输入 `forceRefresh: true`

首版可以不做文件监听，后续再优化。

## 任务拆解

| 任务ID | 任务描述 | 状态 | 复杂度 | 预计文件 | 验收标准 |
|--------|----------|------|--------|----------|----------|
| T1 | 新增项目分析共享类型 | ✅ 已完成 | 低 | `src/shared/types/project-analysis.ts`, `src/shared/types/index.ts` | 类型可被 main/renderer 引用，`npm run typecheck` 无类型错误 |
| T2 | 实现 `ProjectAnalysisService` 基础能力 | ✅ 已完成 | 高 | `src/main/services/ProjectAnalysisService.ts` | 可解析 package.json、scripts、依赖、项目类型、包管理器、entrypoints、recommendedFiles、目录树 |
| T3 | 实现项目快照缓存 | ✅ 已完成 | 中 | `src/main/services/ProjectAnalysisService.ts` | 重复调用可命中缓存，package/lockfile hash 变化后失效 |
| T4 | 实现 `get_project_snapshot` 工具 | ✅ 已完成 | 中 | `src/main/tools/builtin/GetProjectSnapshotTool.ts`, `src/main/tools/ToolManager.ts` | 当前项目可识别为 electron-react，并返回推荐文件与目录树 |
| T5 | 实现 `read_many_files` 工具 | ✅ 已完成 | 中 | `src/main/tools/builtin/ReadManyFilesTool.ts`, `src/main/tools/ToolManager.ts` | 可一次读取多个文件，单个失败不影响整体，超限截断 |
| T6 | 实现 `search_code` 工具 | ✅ 已完成 | 中 | `src/main/tools/builtin/SearchCodeTool.ts`, `src/main/tools/ToolManager.ts` | 支持目录范围、结果上限、行号、上下文，能搜索 `CHAT_STREAM` 等关键字 |
| T7 | 实现 `get_symbol_map` 工具 | ✅ 已完成 | 中 | `src/main/tools/builtin/GetSymbolMapTool.ts`, `src/main/tools/ToolManager.ts` | 能识别 `AgentRunner`、`ChatService`、`ProviderService`、IPC handler、preload API |
| T8 | 优化 Agent 项目分析系统提示 | ✅ 已完成 | 低 | `src/main/ipc/chat.handlers.ts` | 用户请求分析项目时，模型优先选择高层工具而非逐层 `list_files` |
| T9 | 适配执行记录展示新增工具 | ✅ 已完成 | 中 | `src/renderer/src/components/chat/ExecutionLog.tsx` | 新工具显示为“已分析项目快照”“已读取 N 个文件”“已搜索代码”等 |
| T10 | 增加/更新测试用例 | ✅ 已完成 | 中 | `src/tests/*.test.ts` | 覆盖 ProjectAnalysisService、批量读取、搜索、符号索引基础行为 |
| T11 | 编译验证 | ✅ 已完成 | 低 | - | `npm run typecheck` 和 `npm run build` 通过 |
| T12 | 测试验证 | ✅ 已完成 | 低 | - | `npm test` 通过 |

## 依赖关系

```text
T2 依赖 T1
T3 依赖 T2
T4 依赖 T2、T3
T5 依赖 T1
T6 依赖 T1
T7 依赖 T1
T8 依赖 T4、T5、T6、T7
T9 依赖 T4、T5、T6、T7
T10 依赖 T2-T7
T11 依赖 T1-T10
T12 依赖 T11
```

## 实现细节

### T2 ProjectAnalysisService 细节

方法建议：

```ts
class ProjectAnalysisService {
  async getProjectSnapshot(rootPath: string, options: SnapshotOptions): Promise<ProjectSnapshot>
  async readManyFiles(rootPath: string, filePaths: string[], maxCharsPerFile: number): Promise<ReadManyFilesResult>
  async searchCode(rootPath: string, options: SearchCodeOptions): Promise<CodeSearchResult>
  async getSymbolMap(rootPath: string, options: SymbolMapOptions): Promise<SymbolMapResult>
}
```

注意：

- 路径校验可复用或参考 `WorkspaceService.validatePath`。
- 忽略规则复用 `src/shared/constants/ignored.ts`。
- 文件扫描必须限制最大深度、最大文件数、最大输出字符数。
- 不要读取二进制文件。

### 项目类型识别规则

首版支持：

| 条件 | projectType |
|---|---|
| package.json 包含 electron/electron-vite + react | `electron-react` |
| package.json 包含 vite + react | `react-vite` |
| package.json 存在 | `nodejs` |
| 其他 | `unknown` |

### recommendedFiles 规则

对当前 MyAgent 推荐：

```text
package.json
README.md
electron.vite.config.ts
tsconfig.json
src/main/index.ts
src/preload/index.ts
src/renderer/src/App.tsx
src/shared/ipc/channels.ts
src/main/agent/AgentRunner.ts
src/main/services/ChatService.ts
src/main/services/ProviderService.ts
src/main/tools/ToolManager.ts
```

文件不存在时跳过，不报错。

### search_code 规则

- 默认跳过：`node_modules`、`out`、`dist`、`.git`、`.continue/archive`。
- 默认只搜索常见文本/代码文件。
- `query` 可作为普通字符串匹配，首版可不支持完整正则高级能力。
- 返回结果必须限制数量。

### get_symbol_map 规则

首版基于正则即可：

```text
/class\s+(\w+)/
/function\s+(\w+)/
/export\s+function\s+(\w+)/
/export\s+class\s+(\w+)/
/const\s+(\w+)\s*=/
/ipcMain\.handle\(([^,)]+)/
/contextBridge\.exposeInMainWorld\(([^,)]+)/
```

## 风险点

1. **输出过大**：项目快照和批量读取可能爆 token。
   - 应对：所有工具都有 maxDepth/maxResults/maxChars 限制。
2. **缓存过期不准确**：只用 package/lockfile hash 无法捕捉所有源码变化。
   - 应对：首版缓存只服务快照，不缓存文件内容；后续可加文件变更监听。
3. **正则符号索引不完整**：无法覆盖所有 TS/JS 语法。
   - 应对：首版作为轻量索引，后续可替换 AST。
4. **模型仍可能选择旧工具**：即使提示优先高层工具，模型可能仍调用 list_files。
   - 应对：工具描述中明确高层工具的触发条件，必要时在系统提示强化。
5. **不同项目类型支持有限**：首版重点支持 Node/Electron/React。
   - 应对：后续迭代增加 Kotlin/Android、Python、Rust 等识别器。

## 步骤状态

| 阶段 | 状态 | 开始时间 | 完成时间 |
|------|------|----------|----------|
| 需求分析 | ✅ 已完成 | 2026-06-26 09:10 | 2026-06-26 09:10 |
| 计划/设计 | ✅ 已完成 | 2026-06-26 09:14 | 2026-06-26 09:14 |
| 实现 | ✅ 已完成 | 2026-06-26 09:15 | 2026-06-26 10:20 |
| 编译验证 | ✅ 已完成 | 2026-06-26 10:21 | 2026-06-26 10:22 |
| 测试 | ✅ 已完成 | 2026-06-26 10:23 | 2026-06-26 10:24 |
| 完成 | ✅ 已完成 | 2026-06-26 10:25 | 2026-06-26 10:25 |

## 进度统计

- **总任务数**：12
- **已完成**：12
- **完成百分比**：100%

## 验收方式

### 手动验收

在应用中打开当前 MyAgent 项目，输入：

```text
分析这个项目
```

期望工具调用路径：

```text
get_project_snapshot
read_many_files
search_code 或 get_symbol_map（必要时）
```

不应出现大量逐层 `list_files` 调用。

### 自动验证

```bash
npm run typecheck
npm run build
npm test
```

全部通过。
