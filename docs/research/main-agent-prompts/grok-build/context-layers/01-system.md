# 01 基础 System Prompt

Primary 默认模板是 `templates/prompt.md`，逐字快照见 [main-agent-prompt.md](../main-agent-prompt.md)。SubAgent 使用 `templates/subagent_prompt.md`，见 [shared-system-prompt.md](../subagents/shared-system-prompt.md)。

## 选择算法

```text
PromptMode::Extend
  custom override | codex/apply_patch template | primary/subagent template
  + optional prompt_body

PromptMode::Full
  prompt_body only
```

基座和 prompt body 都通过 ToolBridge/TemplateRenderer 使用 MiniJinja 渲染。`role_instructions`、`persona_instructions`、memory、OS、shell、cwd、date 和 tool kind 名称是变量。

## 能力驱动条件块

`${%- if tools.by_kind.edit %}` 等条件根据最终 toolset 删除无关规则，使只读 Agent 不会继续看到编辑指令。这个机制比在运行时移除工具但保留矛盾 prompt 更可靠。

## 证据

模板文本和渲染路径为源码 B；没有真实服务请求证明某个具体变量展开结果。
