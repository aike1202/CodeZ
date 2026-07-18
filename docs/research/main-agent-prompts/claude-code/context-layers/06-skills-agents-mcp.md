# 06 Skills、Agent 与 MCP 目录

## Skill 目录

真实首轮有 `skill_listing` attachment，共 25 个名称。目录只提供名称/描述等轻量信息；调用 `Skill` 后，完整 skill body 作为 meta user message 进入后续上下文。

真实 Explore 样本载入大型 Skill 后，请求达到约 134,661 input tokens 加 18,944 cache-read tokens，说明 loaded body 必须单独预算。

## Agent 目录

真实首轮 `agent_listing_delta` 增加 `claude`、`claude-code-guide`、`Explore`、`general-purpose`、`Plan`、`statusline-setup`。每项包含 when-to-use、工具限制等，直接影响主 Agent 是否委派。

完整内置提示词见 [subagents/README.md](../subagents/README.md)。目录可以 delta 注入，避免 Agent 变化破坏稳定工具块缓存。

## MCP

MCP server instructions、tools 和 resources 可进入 system 动态段或工具 catalog。认证状态、server 可用性和 permission rules 会过滤最终定义。List/Read resource 与 MCP tool call 的结果随后进入 history。

## 必须记录

```text
catalog item name/version/source
lightweight description hash
selected/loaded body hash and size
MCP server/tool/resource identity
Agent tool allow/deny/model
delta add/remove event
```
