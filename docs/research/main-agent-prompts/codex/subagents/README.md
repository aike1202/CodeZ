# OpenAI Codex 子智能体档案

## 能确认的事实

公开 Codex 手册列出三个内置 profile：

| profile | 官方描述 |
|---|---|
| `default` | general-purpose fallback agent |
| `worker` | execution-focused agent for implementation and fixes |
| `explorer` | read-heavy codebase exploration agent |

本机 rollout 可以确认子线程拥有独立 `session_meta`、独立工具历史和 token 统计，并记录 `parent_thread_id`、`depth`、`agent_path`、`agent_nickname` 和 `agent_role`。抽样真实子线程的 `agent_role` 为 `null`，说明任务名或昵称不等于 built-in profile。

## 不能确认的内容

本机 rollout 没有保存 `default`、`worker`、`explorer` 三个内置 profile 的私有 `developer_instructions` 原文，公开手册也只给出描述，不提供逐字提示词。因此本目录不会伪造所谓“完整 explorer prompt”。

## 文件

- `main-agent-delegation-policy.md`：主 Agent 的团队协调契约、显式触发总开关和版本差异。
- `built-in-profiles.md`：三个公开 profile 与自定义 Agent 配置层。
- `real-child-rollout.md`：本机真实子线程的 system、parent metadata 和上下文继承证据。

## 当前公开默认值

- `agents.max_threads = 6`
- `agents.max_depth = 1`
- `agents.interrupt_message = true`
- local Codex 默认只在用户直接要求，或 AGENTS.md/skill 明确要求时委派。

旧 rollout 的 4 槽位是该次运行时 developer 层快照，不是当前公开默认值。
