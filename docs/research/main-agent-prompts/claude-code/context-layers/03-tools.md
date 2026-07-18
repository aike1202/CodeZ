# 03 工具描述与 JSON Schema

## 模型实际收到什么

每个启用工具向模型提供：

```text
name
description / prompt
input JSON schema
```

工具结果作为后续 user-role `tool_result` 返回。output schema、UI metadata、permission function、内部 diff/cache 和执行状态不一定全部发送给模型。

## 代表性 catalog

选定 transcript 能观察到或目录中声明了 Skill、Agent、Task、Bash、Glob、Grep、Read、Edit、Write 等；实际 catalog 还受入口、feature、permission、MCP 和 Agent tool allow/deny 影响。

完整模块清单与核心算法见 [tools/README.md](../tools/README.md)：

- [Read](../tools/read.md)
- [Edit/Write](../tools/edit.md)
- [Grep](../tools/grep.md)
- [Glob](../tools/glob.md)
- [Shell](../tools/shell.md)
- [Agent/Task](../tools/agent-and-task.md)

## Context 成本

工具 schema 是首轮 48K input tokens 的重要来源。大 catalog 不应每轮无条件全量注入；Claude 通过 ToolSearch、MCP delta、Agent listing delta 等机制把目录和完整定义拆分。

## 不可见控制状态

`readFileState`、mtime、sandbox adapter、background task handle、permission decision trace 和完整 UI diff 会影响执行，但不是普通 tool schema 内容。日志系统应同时记录 model-visible definition 和 runtime enforcement state。
