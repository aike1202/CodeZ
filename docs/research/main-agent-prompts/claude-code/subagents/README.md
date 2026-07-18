# Claude Code 子智能体提示词

## 内置 Agent 清单

| Agent | 作用 | 模型 | 工具 | 可用性 |
|---|---|---|---|---|
| `general-purpose` | 多步研究、复杂检索、实现 | 默认 subagent model | `*` | 默认 |
| `Explore` | 快速只读代码定位 | 外部默认 Haiku；内部可 inherit | 禁止 Agent/ExitPlan/Edit/Write/NotebookEdit | feature/A-B gate |
| `Plan` | 只读架构与实施计划 | inherit | 与 Explore 相同的只读面 | feature/A-B gate |
| `claude-code-guide` | Claude Code/Agent SDK/API 官方文档问答 | Haiku | Read/Search/WebFetch/WebSearch | 非 SDK 入口 |
| `statusline-setup` | 配置 statusLine | Sonnet | Read/Edit | 默认 |
| `verification` | 对实现做对抗性验证 | inherit | 禁止项目写工具 | verification A/B gate |

Coordinator mode 还会替换为 coordinator workers；用户也可在 `.claude/agents/` 中定义 custom agents。本目录只保存当前恢复源码能验证的内置 Agent。

## 文件

- `main-agent-delegation-prompt.md`：主 Agent 看到的 Agent 工具描述、何时不用、并发和 brief 规则。
- `explore.md`：Explore 的 when-to-use、完整 system prompt 和工具限制。
- `general-purpose.md`：general-purpose 完整 prompt。
- `plan.md`：Plan 完整 prompt。
- `claude-code-guide.md`：Guide 的 prompt 和动态配置附加层。
- `statusline-setup.md`：statusline prompt 的职责与完整来源说明。
- `verification.md`：feature-gated verifier 的提示词契约。

## 通用增强层

大多数子 Agent 的专用 prompt 之后还会追加 `enhanceSystemPromptWithEnvDetails()`：

```text
Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

{{ optional discover-skills guidance }}
{{ environment block }}
```

因此单看专用 Agent prompt 仍不是完整子 Agent 请求；真实样例见 `../context-requests/02-real-explore-subagent-reconstructed.md`。

