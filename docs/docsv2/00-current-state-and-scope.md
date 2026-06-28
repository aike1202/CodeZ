# 00 当前状态确认与优化范围冻结

## 1. 用户需求

用户希望把现有 `docs` 内容重新整理成 `docs/docsv2/` 文档目录，并以此作为后续优化本项目的依据。文档必须：

- 覆盖用户想要的 AI Coding Agent 能力。
- 结合当前 CodeZ 项目的真实实现，而不是只写通用路线图。
- 按有限顺序拆解为 5-10 个优化步骤。
- 每个步骤都写清楚需求、最终目的和验证方式。
- 需求整理完成后，再开始优化项目代码。

## 2. 当前项目状态

当前项目已经具备一定 AI Coding Agent 基础：

| 能力 | 当前依据 |
| --- | --- |
| Agent 循环 | `src/main/agent/AgentRunner.ts` |
| 上下文裁剪 | `src/main/agent/ContextManager.ts` |
| 工具系统 | `src/main/tools/Tool.ts`, `src/main/tools/ToolManager.ts` |
| 文件搜索 / 读取 | `SearchTextTool.ts`, `SearchCodeTool.ts`, `ReadFileTool.ts`, `ReadManyFilesTool.ts` |
| 写入 / 替换 | `WriteToFileTool.ts`, `ReplaceFileContentTool.ts` |
| 命令执行 | `RunCommandTool.ts` |
| 回滚 | `EditTransactionService.ts`, `RollbackLastEditTool.ts` |
| 多 Provider | `AnthropicProvider.ts`, `OpenAIProvider.ts`, `GeminiProvider.ts` |
| Chat IPC | `src/main/ipc/chat.handlers.ts` |
| Renderer 状态 | `src/renderer/src/stores/chatStore.ts` |
| 测试 | `src/tests/*.test.ts`, `npm test` |

## 3. 当前主要缺口

| 缺口 | 影响 |
| --- | --- |
| 工具很多但心智不够收敛 | 模型容易在 `search_text/search_code/fast_context/read_many_files` 间选择混乱。 |
| 工具结果偏字符串化 | UI、错误恢复、测试断言不够稳定。 |
| 缺少统一权限层 | Shell、写文件、删除、联网等风险难以分级控制。 |
| 缺少明确 Diff/Patch 主路径 | 当前有写入/替换/事务，但缺少统一 Patch 和结构化 Diff 审查模型。 |
| AgentLoop 缺少充分测试 | 多轮 tool call、provider 差异、失败恢复风险较高。 |
| 验证不是独立闭环 | 有 `run_command`，但没有“修改后如何选择验证并处理失败”的稳定流程。 |
| Swarm 设计过早 | 当前单 Agent 闭环未稳定时，不宜直接做多 Agent 并发。 |

## 4. 本阶段最终目的

在任何代码优化开始前，先明确：

1. 第一轮只优化单 Agent Coding 闭环。
2. Swarm、多 Agent、MCP、插件放到后续阶段。
3. 当前所有优化都必须保护用户已有改动。
4. 每次改动都要能通过测试或构建验证。
5. `docs/docsv2/` 成为后续实施路线的唯一依据。

## 5. 范围冻结

第一轮允许关注：

- `src/main/agent/AgentRunner.ts`
- `src/main/agent/ContextManager.ts`
- `src/main/tools/Tool.ts`
- `src/main/tools/ToolManager.ts`
- `src/main/tools/builtin/*`
- `src/main/services/chat/*`
- `src/main/services/EditTransactionService.ts`
- `src/main/ipc/chat.handlers.ts`
- `src/renderer/src/stores/chatStore.ts`
- `src/tests/*`

第一轮不主动做：

- SwarmDispatcher。
- AgentBlackboard。
- 插件安装市场。
- 完整 MCP 管理。
- 长期向量记忆。
- GitHub PR 自动化。

## 6. 验证方式

本阶段验证不是跑代码，而是检查文档是否满足：

- `docs/docsv2/` 是目录，不是单文件。
- 至少包含 5-10 个顺序步骤。
- 每个步骤都有“用户需求 / 最终目的 / 实施内容 / 验证方式”。
- 文档引用了当前项目真实文件路径。
- 文档明确先做单 Agent，再做高级能力。

## 7. 完成标准

- 用户确认 `docs/docsv2/` 的结构和内容可作为优化依据。
- 用户确认第一轮优化范围。
- 用户确认是否需要新分支或 worktree。
- 用户确认是否先处理当前 Git 状态中的文档整理提交。
