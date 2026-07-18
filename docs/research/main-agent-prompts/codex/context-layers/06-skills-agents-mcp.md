# 06 Skills、Agent、Plugins 与 MCP

## Skills

Developer 层列出 skill name、description、location 和读取协议。命中后主 Agent必须完整读取 `SKILL.md`；正文及必要 references 通过工具结果进入 history。目录和 loaded body 应分开计费。

## Plugins

Plugin 是 skills、MCP servers、apps/tools 的组合，不是单段 prompt。Developer 层定义触发、相关性和 fallback；实际 catalog 取决于安装、版本、信任和 feature availability。

## Agents

公开 built-ins 为 `default`、`worker`、`explorer`；自定义 `.toml` 可提供 description、developer instructions、model、sandbox、MCP 和 skill 配置。选定 runtime 另注入 explicit-request-only 总开关。

完整 Agent 协议见 [subagents/README.md](../subagents/README.md) 和 [agent-and-task.md](../tools/agent-and-task.md)。

## MCP/App Dynamic Tools

`dynamic_tools` 可包含 `codex_app` namespace；MCP resources/tools 则按 server 动态加入。需要记录 provider、tool schema hash、defer status、auth/permission 和本轮是否加载。
