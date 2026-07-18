# Codex 主提示词装配图

## 真实 rollout 层级

选定 rollout 的首轮顺序是：

```text
session_meta.payload.base_instructions
response_item(role=developer): permissions + app-context + skills + plugins
response_item(role=developer): root multi-agent coordination contract
response_item(role=developer): explicit-request-only multi-agent policy
response_item(role=user): environment_context
world_state
turn_context
response_item(role=user): user request
tool catalog supplied by runtime
```

这里的 `base_instructions` 是稳定人格、交互、编辑和自治规则；权限、技能、插件、应用功能和协作模式作为可替换 developer 层注入。

## 完整逻辑请求

可以抽象为：

```json
{
  "model": "gpt-5.6-sol",
  "instructions": "<base_instructions>",
  "input": [
    { "role": "developer", "content": "<permissions + app + skills + plugins>" },
    { "role": "developer", "content": "<multi-agent coordinator contract>" },
    { "role": "developer", "content": "<delegation policy>" },
    { "role": "user", "content": "<environment_context>" },
    { "role": "user", "content": "<task>" }
  ],
  "tools": ["<runtime tool schemas>"],
  "metadata": { "cwd": "...", "approval_policy": "never" }
}
```

这不是声称 Codex Desktop 直接发送上述 JSON；它是 rollout 中可见角色层的协议中立表达。

## AGENTS.md

Codex 在环境上下文前后注入适用的 `AGENTS.md` 内容。规则遵循目录作用域，更深层文件覆盖更浅层文件，system/developer/user 的显式要求优先于仓库说明。

## Skills 和 Plugins

skills developer 层只提供目录、触发规则与读取协议。具体 `SKILL.md` 在任务命中后读取，读取到的内容成为后续上下文。插件不是单一 prompt，而是 skills、MCP tools 和 app tools 的集合。

## Subagents

公开手册的当前默认：

```text
root depth = 0
agents.max_depth = 1
agents.max_threads = 6
built-ins = default, worker, explorer
```

本地 app 还可能注入更严格的 developer policy。例如选定 rollout 明确写着只有用户直接要求，或 `AGENTS.md`/skill 指令要求时才派发。这类运行时 policy 优先于泛化的“可以并行”能力说明。

## 请求日志注意点

- `session_meta.base_instructions` 是快照，不代表所有 Codex 版本。
- spawn tool 的 message 参数可能在 rollout 存储中加密，不能假称已逐字恢复。
- 工具 schema 会随 app/plugin/MCP 状态变化。
- world state 和 turn context 是运行时状态记录，不一定逐字作为普通 message 发送给模型。

