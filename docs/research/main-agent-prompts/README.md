# 主 Agent 提示词与请求上下文档案

本目录用于长期记录 Claude Code、OpenAI Codex、Grok Build 和 CodeZ 的主 Agent 提示词、动态装配方式以及真实或模拟的完整请求上下文。每个平台拥有独立文件夹，避免不同产品、版本和证据等级互相污染。

## 目录

```text
main-agent-prompts/
|-- README.md
|-- context-layer-comparison.md
|-- cross-product-analysis.md
|-- codez-optimization-blueprint.md
|-- subagent-io-and-interaction.md
|-- claude-code/
|   |-- README.md
|   |-- main-agent-prompt.md
|   |-- assembly-map.md
|   |-- sources.json
|   |-- context-layers/
|   |-- subagents/
|   |-- tools/
|   `-- context-requests/
|       |-- README.md
|       |-- 01-real-main-session-reconstructed.md
|       `-- 02-real-explore-subagent-reconstructed.md
|-- codex/
|   |-- README.md
|   |-- main-agent-prompt.md
|   |-- assembly-map.md
|   |-- sources.json
|   |-- context-layers/
|   |-- subagents/
|   |-- tools/
|   `-- context-requests/
|       |-- README.md
|       `-- 01-real-rollout-sanitized.md
|-- grok-build/
    |-- README.md
    |-- main-agent-prompt.md
    |-- assembly-map.md
    |-- sources.json
    |-- context-layers/
    |-- subagents/
    |-- tools/
    `-- context-requests/
        |-- README.md
|       `-- 01-source-derived-request.md
`-- codez/
    |-- README.md
    |-- main-agent-prompt.md
    |-- assembly-map.md
    |-- sources.json
    |-- context-layers/
    |-- subagents/
    |   `-- legacy-electron/
    |-- tools/
    `-- context-requests/
        |-- README.md
        |-- 01-real-ledger-source-reconstructed.md
        |-- 02-real-explore-agent-reconstructed.md
        `-- 03-reviewer-source-derived.md
```

## “完整”的定义

这里不把“完整提示词”错误地理解为一条永远不变的字符串。每个平台至少记录两部分：

1. **代表性完整快照**：在明确版本、模式、工具集和环境假设下，给出一份可阅读的完整提示词或上下文请求。
2. **完整装配图**：列出静态基座、运行时注入、工具 schema、项目规则、技能、权限、会话历史、压缩摘要及 feature flag 的装配顺序。

只有两部分同时存在，才能用于自身产品的提示词设计。单个 session 快照不能代表平台所有版本与运行模式。

## 证据等级

| 等级 | 含义 |
|---|---|
| A | 本机真实 rollout/transcript 中逐字存在，可定位到会话与记录 |
| B | 对应版本源码中的逐字模板或确定性装配代码 |
| C | 真实日志与源码联合反推，顺序可信但隐藏层不是日志原文 |
| D | 为解释协议而构造的源码驱动模拟样例 |

所有请求样例必须明确写出 `real`、`reconstructed` 或 `simulated`，不得把模拟数据描述为抓包结果。

## 与早期报告的关系

子智能体触发、Explore 误用、并发预算和 CodeZ 事故分析仍保留在 [subagent-delegation-systems-research.md](../../subagent-delegation-systems-research.md)。本目录聚焦“主 Agent 收到了什么”和“完整请求是如何组成的”。

SubAgent 启动参数、完成 envelope、运行中消息和恢复协议见 `subagent-io-and-interaction.md`。四个平台的工具 schema 与源码算法分别保存在各自 `tools/` 目录。

基础 system、运行时指令、工具、项目规则、环境权限、目录、历史、提醒/压缩和当前请求的逐层对照见 `context-layer-comparison.md`，具体内容位于每个平台的 `context-layers/`。

面向 CodeZ 的分阶段落地方案见 [codez-optimization-blueprint.md](codez-optimization-blueprint.md)。该文档把三家机制映射为 P0/P1/P2 工作项、代码落点、验收条件和回归评测，不把竞品的版本相关 prompt 直接当成 CodeZ 产品常量。

## 更新规则

- 更新提示词时同时更新 `sources.json` 中的 revision、文件、符号和证据等级。
- 新版本不要覆盖旧版本事实；新增快照并写出差异。
- 原始日志可能包含用户路径、项目内容、凭据和私有工具名。纳入仓库前必须脱敏。
- 工具 schema 变化会显著影响输入 token，分析上下文成本时不能只计算文本消息。
- 子 Agent 日志必须记录父调用参数、子 Agent 类型、实际模型、工具限制和首轮 token usage。
