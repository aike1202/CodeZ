# Grok Build 主 Agent 档案

## 状态

本目录基于本地 Grok Build 源码 revision `8adf9013a0929e5c7f1d4e849492d2387837a28d`。本次没有找到与该 revision 对齐的本机真实 Grok 会话日志，因此：

- `main-agent-prompt.md` 中的主模板为源码逐字文本，证据等级 B。
- 动态装配顺序来自 Rust 实现，证据等级 B。
- `context-requests/01-source-derived-request.md` 是源码驱动的完整逻辑模拟，证据等级 D，不是网络抓包。

## 文件说明

- `main-agent-prompt.md`：`templates/prompt.md` 的逐字主模板与变量说明。
- `assembly-map.md`：`PromptContext`、`ToolBridge`、首条 user prefix、工具目录和规则注入顺序。
- `sources.json`：模板、builder、user message 和子 Agent 定义位置。
- `context-layers/`：九层源码档案，含首条 user prefix 全文与完整逻辑 request。
- `subagents/`：共享 system 模板、三个内置 prompt 和动态 task 描述。
- `tools/`：Read/SearchReplace/Grep/ListDir/Shell/Task 等 Rust 核心算法。
- `context-requests/01-source-derived-request.md`：Windows 工作区的完整逻辑请求样例。

## 主 Agent 与子 Agent

主 Agent 使用 `templates/prompt.md`。子 Agent 使用 `templates/subagent_prompt.md` 作为共同基座，再拼接以下内置 prompt body：

- `general-purpose`
- `explore`
- `plan`

工具名称不会硬编码，而是通过 `${{ tools.by_kind.* }}` 从最终 ToolRegistry 解析。缺少某类工具时，MiniJinja 条件块会整段消失。
