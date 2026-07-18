# OpenAI Codex 主 Agent 档案

## 状态

Codex 部分以本机真实 rollout 为主证据：

- 会话：`019f69f8-1394-71b3-a0e3-2821d2e79fcf`
- 时间：2026-07-16
- 客户端：Codex Desktop
- CLI 版本：`0.144.2`
- 模型：`gpt-5.6-sol`
- rollout：`C:\Users\asus\.codex\sessions\2026\07\16\rollout-2026-07-16T16-08-21-019f69f8-1394-71b3-a0e3-2821d2e79fcf.jsonl`

`session_meta.payload.base_instructions.text` 保存了 16,299 字符、146 行的完整基础指令快照。后续 `response_item` 又逐层保存 permissions、app context、collaboration mode、skills/plugins、multi-agent policy、environment context 和用户消息，因此这一平台可以提供真正的 rollout 级上下文样例。

## 文件说明

- `main-agent-prompt.md`：真实 rollout 的 base instructions 逐字快照。
- `assembly-map.md`：基础指令、developer 层、环境、工具和用户历史的顺序。
- `sources.json`：rollout、公开 Codex 手册缓存和版本差异。
- `context-layers/`：真实 developer、environment、catalog、history/state 和当前请求分层。
- `subagents/`：内置 profile 的公开边界、委派策略和真实 child rollout。
- `tools/`：当前运行时工具契约、真实调用和不可见内部算法边界。
- `context-requests/01-real-rollout-sanitized.md`：真实首轮请求的脱敏逻辑展开。

## 子 Agent 事实

2026-07-18 获取的公开 Codex 手册列出内置 `default`、`worker`、`explorer`：

- `agents.max_threads` 默认 6。
- `agents.max_depth` 默认 1。
- 本地 Codex 在用户直接要求，或适用 `AGENTS.md`/skill 指令要求时委派。
- 子 Agent 应返回总结，不应把全部原始工具输出塞回主上下文。

较旧 rollout 中出现的“总共 4 个并发槽位”属于该次运行时开发者层，不应覆盖当前公开默认值。
