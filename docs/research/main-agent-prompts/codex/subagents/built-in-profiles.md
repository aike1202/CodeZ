# Codex 内置与自定义 Agent Profiles

## 内置 profiles

公开材料只确认：

```text
default  - general-purpose fallback agent
worker   - execution-focused agent for implementation and fixes
explorer - read-heavy codebase exploration agent
```

准确的 profile 指令正文、默认 model/effort 和工具裁剪算法没有出现在本机 rollout 或公开手册缓存中。这里把它们标为“未暴露”，而不是根据名称反推一份虚假的完整提示词。

## 自定义 Agent 文件

个人 Agent 位于 `~/.codex/agents/*.toml`，项目 Agent 位于 `.codex/agents/*.toml`。必填字段：

```toml
name = "security-reviewer"
description = "Review security-sensitive changes"
developer_instructions = "..."
```

可选字段包括 `nickname_candidates`，以及常规 session 配置如 `model`、`model_reasoning_effort`、`sandbox_mode`、MCP 和 skill 配置。自定义名称与 built-in 重名时，自定义 Agent 优先。

这说明 Codex 将 Agent profile 实现为“spawned session 的配置层”，而不是只有一段 role prompt。模型、sandbox、MCP 和 skills 都可以随 profile 一起变化。

## 对 CodeZ 的启示

Agent 类型最好由稳定身份字段、面向主模型的使用描述、子会话 developer instructions 和可执行 capability policy 共同组成。只保存一个 `prompt: string` 会丢失模型、工具、权限和隔离层的可审计性。
