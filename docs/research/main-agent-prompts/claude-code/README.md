# Claude Code 主 Agent 档案

## 状态

本目录采用“真实日志 + 恢复源码”联合反推。

- 真实主会话：`fa503702-bb54-4c50-af71-1d5bd15fd0c7`，Claude Code `2.1.197`，入口 `claude-desktop-3p`。
- 真实 Explore 子会话：`agent-a1bfeaf20c9e0b1e7`，实际模型 `gpt-5.6-luna`，父调用工具 ID `call_nfRkNB6cxSsFi39ZEmW7e5v1`。
- 静态源码：`F:\MyProjectF\Claude-Code`，revision `b78dd22a091b717c8938ab98c736bc04825a8ee8`，由公开 npm source map 恢复，非官方仓库。
- 当前本机 CLI：`2.1.207`；不能把它与 `2.1.197` transcript 当作完全相同版本。

## 能从真实日志直接确认的内容

- `version`、`entrypoint`、`permissionMode`、`cwd`、`gitBranch`。
- 用户消息及图像附件引用。
- 初始 `agent_listing_delta` 和 `skill_listing`。
- Agent 工具的 `description`、`prompt`、`subagent_type`。
- 子 Agent 的独立 transcript、`agentId`、实际模型、所有工具调用和 token usage。
- 动态 `command_permissions`、`task_reminder`、`queued_command` 等附件。

## 日志没有直接保存的内容

- API 请求中的隐藏 system prompt 原文。
- 每个工具的完整 API schema。
- 服务端最终执行的缓存块划分。
- feature flag 的完整快照。

因此 [main-agent-prompt.md](main-agent-prompt.md) 是源码逐字模板形成的代表性快照；[context-requests](context-requests/README.md) 则用真实 transcript 固定动态层和调用顺序。两者的交集为高可信事实，版本差异单独列出。

## 文件说明

- `main-agent-prompt.md`：默认交互主 Agent 的源码驱动完整快照。
- `assembly-map.md`：`getSystemPrompt`、`buildEffectiveSystemPrompt`、context/attachment 的完整装配顺序。
- `sources.json`：日志、源码、版本和证据等级。
- `context-layers/`：基础 system 之外九层上下文及完整逻辑 request。
- `subagents/`：内置 Agent 提示词、主 Agent 委派描述和真实 Explore 证据。
- `tools/`：Read/Edit/Grep/Glob/Shell/Agent/Task/Skill 等工具 schema 与核心算法。
- `context-requests/01-real-main-session-reconstructed.md`：真实主会话首轮的脱敏重建。
- `context-requests/02-real-explore-subagent-reconstructed.md`：真实 Explore 子 Agent 首轮与 token 证据。

## 重要观察

真实 `2.1.197` 日志中的 Explore 目录描述比当前恢复源码更严格，明确写着不要用于 code review、设计文档审计、跨文件一致性检查或开放式分析。这说明 Agent `whenToUse` 文案是高频迭代面，产品实现不应把一份 description 永久硬编码到主提示词中。
