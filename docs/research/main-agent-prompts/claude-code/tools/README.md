# Claude Code 工具系统

## 证据范围

本目录基于 `F:\MyProjectF\Claude-Code` 的恢复源码，revision `b78dd22a091b717c8938ab98c736bc04825a8ee8`。这是从公开 npm source map 恢复的 TypeScript，不是官方源码仓库；真实 transcript 版本为 2.1.197，恢复源码与该运行时不能假设字节级一致。

## 源码目录全量清单

源码中存在 50 多个工具目录，但会受平台、入口、permission mode、feature flag 和延迟加载影响，并非每个 session 同时暴露。

| 类别 | 工具模块 |
|---|---|
| 文件与代码 | `FileReadTool`、`FileEditTool`、`FileWriteTool`、`NotebookEditTool`、`GlobTool`、`GrepTool`、`LSPTool`、`SnipTool` |
| 命令执行 | `BashTool`、`PowerShellTool`、`REPLTool`、`TerminalCaptureTool`、`MonitorTool`、`SleepTool`、`ScheduleCronTool` |
| Agent/团队 | `AgentTool`、`SendMessageTool`、`TeamCreateTool`、`TeamDeleteTool` |
| Task/进度 | `TaskCreateTool`、`TaskGetTool`、`TaskListTool`、`TaskUpdateTool`、`TaskOutputTool`、`TaskStopTool`、`TodoWriteTool` |
| 计划/worktree | `EnterPlanModeTool`、`ExitPlanModeTool`、`VerifyPlanExecutionTool`、`BriefTool`、`EnterWorktreeTool`、`ExitWorktreeTool` |
| Skills/发现 | `SkillTool`、`DiscoverSkillsTool`、`ToolSearchTool`、`ConfigTool` |
| MCP | `MCPTool`、`McpAuthTool`、`ListMcpResourcesTool`、`ReadMcpResourceTool` |
| Web/浏览器 | `WebFetchTool`、`WebSearchTool`、`WebBrowserTool` |
| 用户与文件交付 | `AskUserQuestionTool`、`SendUserFileTool`、`ReviewArtifactTool` |
| 其他/实验 | `RemoteTriggerTool`、`WorkflowTool`、`TungstenTool`、`SyntheticOutputTool`、`OverflowTestTool` |

## 深度文档

- `read.md`：文本、图片、Notebook、PDF 读取，输出限制和去重缓存。
- `edit.md`：Edit/Write 的先读、mtime、唯一匹配、竞态与模型可见结果。
- `grep.md`：ripgrep schema、模式、截断和大结果持久化。
- `glob.md`：目录校验、mtime 排序、路径压缩和 100 项默认上限。
- `shell.md`：Bash schema、AST/legacy 解析、规则优先级、路径检查、sandbox 和后台任务。
- `agent-and-task.md`：Agent 目录、委派、Task/Todo 和后台输出。
- `skill-and-planning.md`：Skill 加载、ToolSearch、计划模式、MCP 和扩展工具。

## 最重要的架构事实

Claude Code 的 Tool 不只是一个 JSON schema。每个工具至少可能包含：model-facing description/prompt、Zod schema、`validateInput`、permission decision、执行器、模型结果映射、UI metadata、transcript metadata、输出持久化和压缩策略。CodeZ 若只复制 schema，会丢失行为控制的主体。
