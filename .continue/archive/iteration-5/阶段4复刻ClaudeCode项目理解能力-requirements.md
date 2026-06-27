# 📋 需求文档 - 阶段 4：复刻 Claude Code 项目理解与高效 Agent 能力

> 迭代：iteration-5
> 创建时间：2026-06-26 09:10
> 最后更新：2026-06-26 09:10

## 需求概述

在阶段 3 已经完成基础 Agent Loop、只读工具调用、工具执行记录和 Provider thinking 配置的基础上，本阶段目标是让 MyAgent 的“分析项目 / 理解代码库”能力更接近 Claude Code：减少低效的逐层 `list_files` 与单文件 `read_file` 往返，改为由本地工具快速构建项目快照、批量读取关键文件、定向搜索符号和调用链，再由模型负责理解、归纳和输出结论。

本阶段同时需要沉淀一份“Claude Code 项目理解机制说明文档”，记录当前复刻目标、工具调用策略、与 MyAgent 现状的差距和优化路线，为后续持续演进 Agent Runtime 提供依据。

## 背景与问题分析

当前 MyAgent 的项目分析链路主要依赖三个只读工具：

- `list_files`
- `read_file`
- `search_text`

这使得模型在分析项目时经常出现如下串行过程：

```text
list_files .
read_file package.json
list_files src
list_files src/main
list_files src/renderer
read_file 某个文件
再决定下一步
```

这种方式的问题是：

1. **工具粒度太细**：模型需要多次调用工具才能得到基础项目轮廓。
2. **LLM 往返过多**：每次工具调用都可能触发一轮模型推理、等待、工具执行、再推理。
3. **本地确定性工作交给了模型决策**：列目录、读多个关键文件、识别项目类型、收集脚本等本应由本地代码快速完成。
4. **缺少项目级缓存**：重复分析同一个项目时，无法复用此前已经计算出的项目结构、入口文件、依赖和关键路径。
5. **缺少 Claude Code 式探索策略**：Claude Code 会优先使用 Glob/Grep/Read、并行读关键文件、按项目类型选择入口，而不是完全逐层探索。
6. **工具展示仍需保持真实和可读**：工具记录应清晰、可折叠、按真实事件顺序展示，真实 thinking/reasoning 只能来自模型返回，不能使用伪造 fallback。

## Claude Code 项目理解机制说明

### Claude Code 在理解项目时的典型工具选择

当用户要求“分析项目 / 理解代码库”时，Claude Code 一般会优先使用：

- **Glob**：快速发现文件集合，如 `src/**/*.ts`、`**/package.json`、`**/*config*`。
- **Grep**：快速定位关键符号、入口、IPC、路由、Store、Service、工具调用等。
- **Read**：按需读取关键文件，并避免一次性读取大量无关文件。
- **Bash**：仅在需要运行构建、测试、项目命令或获取 git 状态时使用。
- **Subagent / Explore Agent**：当需要大范围搜索或并行理解多个子系统时使用，而不是所有情况都串行读文件。

对于 Electron + React 项目，Claude Code 通常会优先查看：

```text
package.json
README.md
electron.vite.config.ts
tsconfig.json
src/main/index.ts
src/preload/index.ts
src/renderer/src/App.tsx
src/shared/ipc/channels.ts
src/main/services/*
src/main/agent/*
src/main/tools/*
src/renderer/src/stores/*
src/renderer/src/components/chat/*
```

### 与当前 MyAgent 的差异

| 能力 | Claude Code | 当前 MyAgent |
|---|---|---|
| 项目结构发现 | Glob/Grep 高效发现 | `list_files` 逐层探索 |
| 多文件读取 | 可并行、按片段读取 | 单个 `read_file` 为主 |
| 代码搜索 | ripgrep 级内容搜索 | 简单 `search_text` |
| 项目类型识别 | 基于经验和文件结构快速判断 | 部分依赖模型逐步判断 |
| 本地预分析 | 工具和 harness 提供丰富上下文 | 缺少项目快照工具 |
| 缓存 | 会话和上下文复用更成熟 | 缺少项目索引缓存 |
| 执行展示 | 真实工具/思考/命令时间线 | 阶段 3 已初步完成，仍需优化 |

### 复刻目标

本阶段不是直接复制 Claude Code 的内部实现，而是复刻其关键设计原则：

1. **让本地代码负责确定性分析**：项目类型、目录树、依赖、脚本、入口文件、符号索引。
2. **让模型负责语义理解**：架构归纳、职责说明、风险分析、下一步建议。
3. **减少模型工具往返**：使用项目快照和批量读取替代多次细粒度工具调用。
4. **按任务类型预设探索策略**：例如项目分析任务优先调用 `get_project_snapshot`。
5. **保持真实执行轨迹**：思考内容只展示模型真实返回，工具调用只展示真实工具执行，不伪造。

## 功能需求

### F1. 项目快照工具 `get_project_snapshot`

新增一个只读工具，用于一次性收集项目基础上下文。

输入：

```ts
{
  dirPath?: string
  maxDepth?: number
  includeFiles?: boolean
}
```

输出应包含：

- 项目根目录名称
- 项目类型，例如 `electron-react`、`react-vite`、`nodejs`、`unknown`
- 包管理器判断，例如 `npm`、`pnpm`、`yarn`
- `package.json` scripts
- dependencies / devDependencies 摘要
- 关键配置文件列表
- 顶层目录树，默认忽略：
  - `node_modules`
  - `out`
  - `dist`
  - `.git`
  - `.continue/archive`
- 可能的入口文件：
  - Electron main/preload/renderer 入口
  - React/Vite 入口
  - shared ipc/types/constants
- 推荐下一步读取文件列表 `recommendedFiles`

验收标准：

- [ ] 对当前 MyAgent 项目，能够识别为 Electron + React + TypeScript 项目。
- [ ] 能返回 `dev/typecheck/test/build` 等 npm scripts。
- [ ] 能返回 `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx` 等推荐文件。
- [ ] 默认不会扫描 `node_modules` 和 `out`。

### F2. 批量读取工具 `read_many_files`

新增一个只读工具，用于一次读取多个文件，减少多次 `read_file` 往返。

输入：

```ts
{
  filePaths: string[]
  maxCharsPerFile?: number
}
```

输出：

- 每个文件的：
  - path
  - content
  - truncated
  - totalLines
  - error（如果失败）

验收标准：

- [ ] 能一次读取 `package.json`、`README.md`、`src/main/index.ts` 等多个文件。
- [ ] 单文件内容超限时截断，并明确标记 `truncated: true`。
- [ ] 任一文件读取失败不会导致整个工具失败。
- [ ] 所有路径必须限制在 workspace root 内。

### F3. 增强代码搜索工具 `search_code`

新增或升级现有 `search_text`，提供更适合代码分析的搜索能力。

输入：

```ts
{
  query: string
  dirPath?: string
  includeGlobs?: string[]
  maxResults?: number
  contextLines?: number
}
```

输出：

- 文件路径
- 行号
- 匹配行
- 前后文

验收标准：

- [ ] 能搜索 `ipcMain.handle`、`contextBridge`、`CHAT_STREAM`、`tool_calls` 等关键字。
- [ ] 支持限定目录，例如 `src/main`。
- [ ] 支持结果上限，避免爆 token。

### F4. 简单符号索引工具 `get_symbol_map`

新增轻量符号索引工具，初期可基于正则，无需完整 AST。

识别对象：

- `class Xxx`
- `function xxx`
- `export function xxx`
- `export class Xxx`
- `const xxx =`
- `ipcMain.handle(...)`
- `contextBridge.exposeInMainWorld(...)`

输出：

```ts
{
  symbols: [
    { name, kind, path, line }
  ]
}
```

验收标准：

- [ ] 能识别 `AgentRunner`、`ChatService`、`ProviderService`、`ToolManager`。
- [ ] 能识别 IPC handler 和 preload API 暴露点。

### F5. Agent 项目分析策略优化

当用户请求“分析项目 / 了解项目 / 看看这个项目 / 项目架构是什么”时，Agent 应优先使用高层工具，而不是逐层目录探索。

推荐策略：

```text
1. 调用 get_project_snapshot
2. 调用 read_many_files 读取 snapshot.recommendedFiles
3. 必要时调用 search_code 定向搜索关键模式
4. 生成项目分析报告
```

验收标准：

- [ ] 对当前 MyAgent 项目，分析项目一般不超过 3 轮工具调用。
- [ ] 不再出现大量连续 `list_files` 逐层探索。
- [ ] 分析报告包含技术栈、目录结构、核心模块、运行命令、当前阶段、风险或下一步建议。

### F6. 执行记录展示优化

继续保留阶段 3 已完成的执行记录原则：

- 最外层执行记录默认折叠。
- 展开后工具组默认折叠。
- 同类连续工具调用合并展示。
- 真实 thinking/reasoning 只在模型返回时显示。
- 不使用伪造 thinking fallback。
- 不使用 Emoji。

新增要求：

- `get_project_snapshot` 显示为 `已分析项目快照`。
- `read_many_files` 显示为 `已读取 N 个文件`，展开后列出每个文件。
- `search_code` 显示为 `已搜索代码 query` 或 `已搜索 N 处匹配`。
- `get_symbol_map` 显示为 `已建立符号索引`。

### F7. 项目快照缓存

为项目快照引入轻量缓存，避免重复分析同一项目时每次重新扫描。

缓存建议字段：

```ts
{
  rootPath: string
  updatedAt: string
  packageJsonHash?: string
  lockfileHash?: string
  snapshot: ProjectSnapshot
}
```

缓存失效条件：

- `package.json` 改变
- lockfile 改变
- 用户显式刷新
- 后续可加入文件变更监听

验收标准：

- [ ] 重复调用 `get_project_snapshot` 时可复用缓存。
- [ ] package.json 变化后缓存失效。
- [ ] 工具输出中标记是否来自缓存。

## 非功能需求

- **性能**：项目分析应明显减少工具调用轮数；当前项目分析目标控制在 2-3 轮工具调用内。
- **安全**：所有读文件、搜索、快照工具必须限制在 workspace root 内，不允许路径穿越。
- **Token 控制**：所有工具输出必须有上限，超限截断并明确标记。
- **可维护性**：新工具应复用 `WorkspaceService` 的路径校验和忽略规则。
- **可扩展性**：后续可替换正则符号索引为 AST 索引，不影响工具接口。
- **用户体验**：工具记录真实、紧凑、可折叠，最终回答与执行过程分离。

## 约束条件

- 继续使用当前 Electron + React + TypeScript 架构。
- 本阶段仍以只读能力为主，不引入写文件、终端执行、编辑工具。
- 不直接依赖 Claude 原生 SDK；当前 Provider 仍以 OpenAI-compatible 为主，但保留后续 Anthropic native Provider 的扩展空间。
- Thinking/reasoning 只展示模型真实返回内容，不做伪造。

## 验收标准

- [ ] 生成并保存 Claude Code 项目理解机制说明文档。
- [ ] 新增 `get_project_snapshot` 工具并集成到 `ToolManager`。
- [ ] 新增 `read_many_files` 工具并集成到 `ToolManager`。
- [ ] 新增或增强 `search_code` 工具。
- [ ] 新增 `get_symbol_map` 工具。
- [ ] Agent 在分析项目时优先使用高层工具。
- [ ] 当前 MyAgent 项目分析工具调用轮数明显减少。
- [ ] 执行记录能正确展示新增工具。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run build` 通过。
- [ ] `npm test` 通过。

## 待澄清事项

当前需求已经足够进入计划阶段。后续可在计划阶段进一步决定：

1. `get_project_snapshot` 第一版是否只支持 Node/Electron/React，还是同时扩展到更多项目类型。
2. `search_code` 是否继续使用 Node.js 原生文件扫描，还是调用系统 ripgrep。
3. 项目快照缓存存放在应用 userData，还是 workspace 下的 `.myagent/`。
