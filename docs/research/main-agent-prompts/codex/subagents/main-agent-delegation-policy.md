# Codex 主 Agent 委派策略

## 旧 rollout 的团队契约

本机 2026-07-16/17 rollout 的 developer 层确认了以下运行时结构：

```text
root Agent
-> spawn_agent(task_name, message, fork_turns, optional model/effort)
-> send_message / followup_task / interrupt_agent
-> wait_agent / list_agents
```

子智能体共享同一文件系统和工作目录，修改立即互相可见。该版本说明总并发槽位为 4，包含 root，因此最多同时运行 3 个子 Agent。

同一 developer 层另有明确总开关：

```text
Do not spawn sub-agents unless the user or applicable AGENTS.md/skill
instructions explicitly ask for sub-agents, delegation, or parallel agent work.
```

这条规则优先于泛化的“可以用多 Agent 加速”建议，是防止简单问题误派发的关键。

## `fork_turns`

| 值 | 语义 | 成本 |
|---|---|---|
| `none` | 不继承周边会话 | 最小，但 brief 必须自包含 |
| 正整数字符串 | 继承最近 N 个 turn | 平衡上下文和隔离 |
| `all` | 继承完整周边历史 | 信息最全，token 与噪声最高 |

本机抽样派发大量使用 `all`。这能保留缓存和全部背景，但也会把与子任务无关的历史、skills 目录和工具结果复制给每个子线程。CodeZ 不应把全量 fork 作为无条件默认。

## 当前官方策略

2026-07-18 获取的公开手册说明 local Codex 在用户直接要求或项目/skill 指令要求时委派；`agents.max_threads` 默认 6，`agents.max_depth` 默认 1。手册明确要求子 Agent 返回摘要，避免原始命令输出重新污染主上下文。

## 版本解释

```text
4 slots = 某次 rollout 的宿主约束
6 threads = 当前公开配置默认值
```

两者并不矛盾：宿主可用更严格的运行时 developer 指令覆盖产品默认配置。调研或实现时必须记录版本和宿主，不能只保留一个常数。
