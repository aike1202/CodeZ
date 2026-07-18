# 01 基础 System Prompt

选定 rollout 的 `session_meta.payload.base_instructions.text` 保存了完整基础指令：16,299 字符、146 行。逐字快照见 [main-agent-prompt.md](../main-agent-prompt.md)。

主要内容包括 Codex 身份、沟通风格、commentary/final channel、文件编辑约束、工具使用、工作区保护、自治边界、skills 协议和最终回答格式。

## 特征

- Base instructions 是 session 快照，不是所有版本通用常量。
- 它不包含该轮完整 permission/app/skills/AGENTS/environment；这些由后续 developer/user 层注入。
- 子 Agent rollout 也可保存相同通用 base instructions，再叠加 child metadata 和 task brief。

## 证据

此层为真实 rollout A，不需要从源码反推。但不同 CLI/Desktop 版本、人格配置和宿主可能产生不同 base instructions。
