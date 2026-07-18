# 04 项目规则

Grok Build 搜索 `AGENTS.md`、`Agents.md`、`Claude.md`、`AGENT.md` 等项目 instruction files，保留路径、scope 和内容。

## 注入格式

`format_agents_md_section()` 将完整规则渲染为 user-role `<system-reminder>`：

```text
<system-reminder>
As you answer the user's questions, you can use the following context ...

<path and scoped rule content>

Follow these instructions exactly. When working in subdirectories not listed above,
check for additional project instruction files ...
</system-reminder>
```

它的来源是项目规则，但 role 可能是 user/synthetic reminder，不应误记成基础 system prompt。

## Scope 与优先级

更深目录规则覆盖更高层规则，显式用户指令优先。子 Agent 收到 compacted project instructions；详细 build/test 规则应复制进 task brief。

## Resume

源码有对 legacy untagged AGENTS copies 的结构检测，说明恢复会话时必须去重旧 reminder，避免同一规则多次进入上下文。
