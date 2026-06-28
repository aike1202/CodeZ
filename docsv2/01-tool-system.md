# 01 工具系统收敛：search / read_files / apply_patch / shell

## 1. 用户需求

用户需要 Agent 能真实理解项目，而不是猜文件、猜代码、猜命令。工具系统要简单、稳定、可控，让模型知道：

```text
查代码用 search
读代码用 read_files
改代码用 apply_patch
验证用 shell
```

## 2. 当前项目依据

当前已有工具：

- `src/main/tools/Tool.ts`
- `src/main/tools/ToolManager.ts`
- `src/main/tools/builtin/ListFilesTool.ts`
- `src/main/tools/builtin/ReadFileTool.ts`
- `src/main/tools/builtin/ReadManyFilesTool.ts`
- `src/main/tools/builtin/SearchTextTool.ts`
- `src/main/tools/builtin/SearchCodeTool.ts`
- `src/main/tools/builtin/GetProjectSnapshotTool.ts`
- `src/main/tools/builtin/GetSymbolMapTool.ts`
- `src/main/tools/builtin/FastContextTool.ts`
- `src/main/tools/builtin/WriteToFileTool.ts`
- `src/main/tools/builtin/ReplaceFileContentTool.ts`
- `src/main/tools/builtin/RunCommandTool.ts`
- `src/main/tools/builtin/RollbackLastEditTool.ts`

问题不是没有工具，而是工具心智模型分散。

## 3. 最终目的

形成一个面向模型的最小稳定工具面：

| 目标工具 | 作用 | 内部可复用现有能力 |
| --- | --- | --- |
| `search` | 文件名、文本、正则、符号、模糊搜索 | `SearchTextTool`, `SearchCodeTool`, `GetSymbolMapTool`, `FastContextTool` |
| `read_files` | 单文件、多文件、范围、搜索结果上下文读取 | `ReadFileTool`, `ReadManyFilesTool` |
| `apply_patch` | 修改已有代码的主路径 | 可新增；可复用 `ReplaceFileContentTool` 和事务服务 |
| `shell` | 测试、构建、运行命令 | `RunCommandTool` |

## 4. 需求拆解

### 4.1 search

需求：

- 支持文件名搜索。
- 支持文本搜索。
- 支持正则搜索。
- 支持符号搜索。
- 支持项目级快照搜索：识别多子项目、技术栈、脚本、入口文件、docs 索引。
- 精确搜索失败后支持模糊搜索。
- 返回结构化结果。

返回字段至少包括：

```ts
type SearchResult = {
  kind: 'file' | 'text' | 'symbol' | 'fuzzy'
  path: string
  line?: number
  column?: number
  name?: string
  preview?: string
  score?: number
  reason?: string
}
```

### 4.2 read_files

需求：

- 支持单文件读取。
- 支持多文件读取。
- 支持行范围读取。
- 支持围绕搜索命中行读取上下文。
- 返回行号、总行数、截断状态和 hash。
- 必须有 `maxTotalLines` / `maxTotalBytes` 预算。

### 4.3 apply_patch

需求：

- 作为已有代码修改的默认工具。
- 支持上下文不匹配失败。
- 支持失败后提示重新读取文件。
- 支持 `expectedHashByPath`。
- 删除文件必须走更高权限。

### 4.4 shell

需求：

- 用于 `npm test`、`npm run typecheck`、`npm run build` 等验证命令。
- 不用于 `grep`、`cat`、`find` 等已有专用工具覆盖的操作。
- cwd 必须限制在 workspace 内。
- 必须有 timeout 和输出截断。

## 5. 实施顺序

1. 保留现有工具，但在 ToolManager 中增加面向模型的推荐分组或别名。
2. 将 `search_text/search_code/get_symbol_map/fast_context` 的能力收敛到 `search` 设计。
3. 将 `read_file/read_many_files` 的能力收敛到 `read_files` 设计。
4. 强化 `get_project_snapshot`，让它覆盖真实项目分析中的高频动作：根目录识别、子项目识别、技术栈识别、脚本识别、docs 索引、推荐读取文件。
5. 新增或规划 `apply_patch`，避免继续扩大全量写入工具使用。
6. 更新工具 description，让模型明确工具选择顺序。
7. 更新测试，覆盖 search/read_files/project_snapshot 的核心返回结构。

## 5.1 来自 proxy_logs.db 的工具启示

`docs/proxy-logs-restaurant-pos-analysis.md` 显示 Claude Code 分析 RestaurantPos 时实际用了大量 Bash：`ls`、`find`、`cat | head`、`grep`、`tree`。这些动作应被 CodeZ 的结构化工具替代：

| 真实日志动作 | CodeZ v2 目标工具 |
| --- | --- |
| `ls -la` | `get_project_snapshot` / `search` |
| `find ... -name "*.java"` | `get_project_snapshot` / `search` |
| `cat file | head` | `read_files` 范围读取 |
| `grep "多语言"` | `search` 带上下文 |
| `tree` | `get_project_snapshot` 或 `read_files` 目录树模式 |

这也是本阶段的关键验收依据：项目分析任务应尽量少用 shell 做搜索和读取。

## 6. 验证方式

### 6.1 单元验证

- 搜索 `AgentRunner` 能返回 `src/main/agent/AgentRunner.ts`。
- 搜索 `run_command` 能返回命令工具相关文件。
- 搜索拼写错误的 `AgentRunnr` 能给出高置信候选。
- `read_files` 能读取多个文件并带行号和截断信息。
- 超过预算时返回 `omitted`，不能静默丢内容。

### 6.2 行为验证

给 Agent 一个任务：

```text
找出当前项目中执行 shell 命令的工具在哪里。
```

期望行为：

1. 先调用 `search`。
2. 再调用 `read_files`。
3. 不用 shell 做 grep/find/cat。
4. 能定位 `src/main/tools/builtin/RunCommandTool.ts`。

### 6.3 命令验证

- `npm test`
- `npm run typecheck`

## 7. 完成标准

- Agent 工具选择路径清晰。
- 工具返回结构化结果。
- 搜索和读取不再依赖 shell。
- 修改已有代码的默认策略转向 Patch。
- 项目分析任务优先使用 `get_project_snapshot`、`search`、`read_files`，而不是用 shell 组合 `ls/find/cat/grep/tree`。
