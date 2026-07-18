# 四个平台完整上下文层对比

## 九层总矩阵

| 层 | Claude Code | OpenAI Codex | Grok Build | CodeZ |
|---|---|---|---|---|
| 基础 System | TypeScript 分段函数；日志不保存隐藏原文 | rollout `base_instructions` 完整快照 | `prompt.md` MiniJinja 模板 | Rust PromptPipeline：Core/Execution + dynamic boundary |
| Developer/运行时 | 无独立 role；system 动态段、tool prompt、reminder | 多条真实 developer messages | 无固定 role；PromptContext、user reminders、tool config | 无独立 role；工程政策、动态模块和宿主硬限制 |
| 工具 schema | 源码 Zod + runtime registry | core/runtime/dynamic tools；内部源码不可用 | finalized Rust ToolRegistry | Rust ToolDescriptor + immutable catalog + exposure plan |
| 项目规则 | CLAUDE.md/rules/memory | global/project/nested AGENTS.md | AGENTS/Claude 等 `<system-reminder>` | global/workspace files包装进 `<repository_instructions>` |
| 环境与权限 | system env + transcript metadata + permission attachments | developer permission + user environment + turn context | `<user_info>`/VCS prefix + capability/runtime policy | Environment System 段 + effect/receipt permission pipeline |
| Skills/Agent/MCP | listing delta + loaded body + MCP delta | developer catalog + plugins + custom/built-in agents + MCP/app | skills/plugins/Agent descriptors + MCP Full/Delta reminders | Skills catalog进 System；Agent registry 当前未接线；MCP 未并入 Chat tools |
| 历史与工具结果 | Anthropic messages/tool_result | response_item/event_msg | conversation + ToolOutput prompt projection | durable ledger scopes + normalized tool protocol + result handles |
| 附件/提醒/压缩 | attachments、system-reminder、micro/full compact | media、world/turn state、mailbox、summary | synthetic reminders、deferred prefix、compact/resume | session images、skill/file context、summary/resume、auto compaction |
| 当前请求 | content blocks + queued messages | 独立 user task，前有 environment message | prefix 后的 `<user_query>` | 主会话原始 user message；child 使用 mailbox payload |

## 首条 User Prefix 对比

| 平台 | 形式 |
|---|---|
| Claude Code | 没有单一固定 prefix；用户 content 与 Agent/Skill listings、rules reminders 等附件组合 |
| Codex | 通常先有独立 `environment_context` user message，再有用户原始 task |
| Grok Build | 同一首条 user content 中拼接 `<user_info>`、可选 VCS status、`<user_query>` |
| CodeZ | 没有固定 user prefix；环境/Git/规则在 System，用户消息保持原文 |

Grok 的 exact minimal 模板见 [09-current-request-and-prefix.md](grok-build/context-layers/09-current-request-and-prefix.md)。

## 三种可见性

| 标记 | 含义 | 示例 |
|---|---|---|
| `model_visible` | 实际进入模型输入的文本/schema/content part | system、tool description、Read result |
| `runtime_only` | 控制执行但不直接作为文本发送 | file cache、process handle、permission matcher state |
| `projection_unknown` | 日志有状态，但无法证明其 wire 投影 | Codex world_state/turn_context 的部分字段 |

所有上下文日志都应显式标记可见性。仅保存 runtime object 后声称“模型看到了”，会得出错误结论。

## 推荐的完整请求日志

```json
{
  "request_id": "...",
  "session_id": "...",
  "parent_agent_id": null,
  "agent_type": "main",
  "model": "...",
  "prompt_layers": [
    {
      "kind": "system|developer|project_rules|environment|catalog|reminder",
      "role": "system|developer|user|synthetic|runtime",
      "visibility": "model_visible|runtime_only|projection_unknown",
      "source": "path/event/config",
      "content_ref": "artifact://...",
      "content_hash": "sha256:...",
      "characters": 0,
      "tokens": 0,
      "precedence": 0
    }
  ],
  "tools": [
    {
      "name": "Read",
      "description_hash": "sha256:...",
      "schema_hash": "sha256:...",
      "source": "core|plugin|mcp|app",
      "enabled_reason": "..."
    }
  ],
  "messages": [],
  "runtime_state": [],
  "token_breakdown": {
    "system": 0,
    "developer": 0,
    "tool_schema": 0,
    "project_rules": 0,
    "catalogs": 0,
    "history": 0,
    "tool_results": 0,
    "attachments": 0,
    "current_request": 0
  },
  "compaction": {
    "boundary": null,
    "summary_ref": null,
    "cleared_tool_results": []
  }
}
```

## 记录原则

1. 保存 resolved layer graph，而不只保存最终拼接字符串。
2. 原始敏感内容可加密外置，但必须保存 hash、大小、来源和作用域。
3. 保存 exported tool schema 与 runtime-only enforcement 配置。
4. 工具结果同时保存 raw、model projection 和 artifact reference。
5. 保存当前请求原文，不能把 runtime prefix 合并后冒充用户输入。
6. 子 Agent 记录 parent、fork/resume 策略和最终报告投影。
7. 每次 compact、reminder、catalog delta 都作为独立事件记录。

## 平台档案入口

- [Claude Code context layers](claude-code/context-layers/README.md)
- [Codex context layers](codex/context-layers/README.md)
- [Grok Build context layers](grok-build/context-layers/README.md)
- CodeZ context layers：`codez/context-layers/README.md`
