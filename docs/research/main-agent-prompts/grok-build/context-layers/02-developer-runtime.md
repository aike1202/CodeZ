# 02 Developer 与运行时指令

## 没有固定 Developer Role

Grok Build 源码中的主要角色是 system + conversation messages + tool definitions。没有发现等同 Codex `role=developer` 的固定第二层消息。功能等价内容分布在：

这里没有遗漏一段可复制的 Developer 原文：当前源码协议没有独立 Developer message。可逐字保存的是 system 模板、role/persona 片段、user reminder 和工具 descriptions；它们属于各自原始层，不能合成后再冒充一条真实 Developer message。

- `PromptContext` 的 role/persona/memory/runtime placeholders。
- host 选择的 prompt mode、audience 和 template override。
- 第一条 user prefix 与 project instruction reminders。
- ToolRegistry 的 capability、requires expression 和参数配置。
- session mode、goal harness、MCP/skill/plugin runtime state。

## 运行时模式

Primary/Subagent、interactive/non-interactive、plan mode、goal mode、custom persona 和 capability mode 都会改变最终 prompt 或工具面。

## 硬边界

Task 最大深度、tool capability、background dependency、permission/sandbox 和 worktree isolation 在运行时执行，不只是文本规则。Prompt body 仍负责 scope、工作方法和输出约定。

## 记录建议

保存 resolved prompt mode/audience/template、role/persona source、tool params、behavior contract version、feature flags 和 host config；否则无法从最终文本解释哪些条件块为何消失。
