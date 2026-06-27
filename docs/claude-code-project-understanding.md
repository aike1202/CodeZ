# Claude Code 项目理解机制与 MyAgent 复刻路线

> 创建时间：2026-06-26 09:10
> 关联需求：`.continue/current/阶段4复刻ClaudeCode项目理解能力-requirements.md`

## 1. 目标

MyAgent 希望复刻 Claude Code 在“分析项目 / 理解代码库 / 定位代码问题”场景中的能力。这里的复刻不是复制内部实现，而是复刻关键工程原则：

- 工具粒度足够高，减少模型往返。
- 本地代码负责确定性工作，模型负责语义理解。
- 项目分析先拿快照，再按需深入。
- 工具记录真实、可折叠、可追踪。
- Thinking/reasoning 只展示模型真实返回的内容。

## 2. Claude Code 如何理解项目

Claude Code 在理解项目时，一般不会逐层目录探索，而是优先使用高效率工具：

### 2.1 文件发现

使用类似 Glob 的工具快速发现文件集合：

```text
**/package.json
src/**/*.ts
src/**/*.tsx
**/*config*.*
```

### 2.2 内容搜索

使用类似 Grep/ripgrep 的工具定位关键符号和调用链：

```text
ipcMain.handle
contextBridge.exposeInMainWorld
CHAT_STREAM
tool_calls
AgentRunner
ChatService
ProviderService
```

### 2.3 关键文件读取

按项目类型读取关键文件。例如 Electron + React 项目优先读取：

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

### 2.4 需要时才继续深入

如果任务只是“分析项目”，Claude Code 通常只需要：

1. 项目配置和 README。
2. 主进程、preload、renderer 的入口。
3. 核心服务和 IPC 通道。
4. 必要搜索结果。

不会把所有文件都读一遍。

## 3. 当前 MyAgent 的不足

当前 MyAgent 阶段 3 已实现：

- `AgentRunner`
- `ToolManager`
- `list_files`
- `read_file`
- `search_text`
- 工具调用执行记录
- Provider thinking 配置

但项目分析仍慢，主要原因如下。

### 3.1 工具粒度太细

当前模型需要这样探索：

```text
list_files .
read_file package.json
list_files src
list_files src/main
list_files src/renderer
read_file 某文件
```

这导致多轮模型推理和工具执行。

### 3.2 缺少批量读取

模型想读多个文件时，只能多次 `read_file`，而不是一次 `read_many_files`。

### 3.3 缺少项目快照

项目类型、脚本、依赖、入口文件、目录树，这些信息都可以本地一次性算出来，不应由模型逐步探索。

### 3.4 缺少代码搜索增强

当前 `search_text` 比较基础，需要升级为更适合代码理解的 `search_code`，返回行号、上下文和结果上限。

### 3.5 缺少符号索引

Claude Code 能通过搜索和上下文快速判断符号位置。MyAgent 可以先用正则实现轻量 `get_symbol_map`。

### 3.6 缺少缓存

重复分析同一项目时，应复用项目快照和关键文件摘要。

## 4. 复刻原则

### 4.1 本地代码做确定性分析

适合本地代码做的事情：

- 列目录
- 过滤忽略目录
- 判断项目类型
- 读取 package.json
- 解析 scripts/dependencies
- 找入口文件
- 扫描符号
- 搜索文本
- 缓存快照

### 4.2 模型做语义理解

适合模型做的事情：

- 解释架构
- 总结模块职责
- 分析风险
- 判断下一步读取哪些文件
- 生成最终报告

### 4.3 减少 LLM 往返

理想流程：

```text
用户：分析项目
  ↓
get_project_snapshot
  ↓
read_many_files(snapshot.recommendedFiles)
  ↓
search_code(必要关键词)
  ↓
模型总结
```

目标是 2-3 轮工具调用完成当前项目分析。

## 5. 建议新增工具

### 5.1 get_project_snapshot

一次性返回项目快照：

```ts
{
  projectType: string
  packageManager: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  tree: string
  entrypoints: string[]
  recommendedFiles: string[]
  fromCache: boolean
}
```

### 5.2 read_many_files

一次读取多个文件：

```ts
{
  filePaths: string[]
  maxCharsPerFile?: number
}
```

### 5.3 search_code

代码搜索增强版：

```ts
{
  query: string
  dirPath?: string
  includeGlobs?: string[]
  maxResults?: number
  contextLines?: number
}
```

### 5.4 get_symbol_map

轻量符号索引：

```ts
{
  dirPath?: string
  maxResults?: number
}
```

识别：

- class
- function
- const
- ipcMain.handle
- contextBridge.exposeInMainWorld

## 6. 工具展示规范

### 6.1 最外层执行记录

默认折叠，只显示摘要：

```text
执行完成：分析项目快照，读取 6 个文件，搜索 3 处匹配
```

### 6.2 工具组

展开后工具组仍默认折叠：

```text
已分析项目快照 12ms
已读取 6 个文件 30ms
已搜索代码 CHAT_STREAM 15ms
```

### 6.3 工具详情

用户展开单个工具后才显示参数和输出。

### 6.4 Thinking/reasoning

只展示模型真实返回的 reasoning/thinking 内容：

- 不根据耗时伪造“已思考”。
- 不根据工具调用伪造“准备读取文件”。
- 如果模型没有返回 thinking/reasoning，则不显示思考块。

## 7. 性能优化策略

### 7.1 一次性项目快照

用 `get_project_snapshot` 替代多次 `list_files`。

### 7.2 批量读取关键文件

用 `read_many_files` 替代多次 `read_file`。

### 7.3 搜索代替遍历

用 `search_code` 定位关键调用，不靠模型猜路径。

### 7.4 缓存

缓存项目快照，减少重复扫描。

缓存失效条件：

- package.json hash 变化
- lockfile hash 变化
- 用户手动刷新

## 8. 推荐系统提示策略

当用户请求分析项目时，系统应鼓励模型：

```text
当用户要求分析项目、理解项目结构、梳理代码库时：
1. 优先调用 get_project_snapshot。
2. 再调用 read_many_files 读取 recommendedFiles。
3. 必要时调用 search_code 定位关键符号。
4. 避免逐层调用 list_files，除非项目快照不足。
5. 输出结论时说明技术栈、目录结构、核心模块、运行命令、风险和下一步建议。
```

## 9. 当前阶段 4 的实现目标

阶段 4 应优先实现：

1. `get_project_snapshot`
2. `read_many_files`
3. `search_code`
4. `get_symbol_map`
5. 工具展示适配
6. 项目快照缓存
7. Agent 分析项目策略提示

## 10. 验收目标

以当前 MyAgent 项目为例，用户输入：

```text
分析这个项目
```

理想工具调用：

```text
get_project_snapshot
read_many_files([...recommendedFiles])
search_code("ipcMain.handle|contextBridge|CHAT_STREAM|tool_calls")
```

最终报告应包含：

- 项目定位
- 技术栈
- 目录结构
- 主进程 / preload / renderer / shared 的职责
- AgentRunner / ChatService / ToolManager 的关系
- 运行与测试命令
- 当前能力阶段
- 后续优化建议
