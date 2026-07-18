# Codex 完整上下文分层

本目录以 2026-07-16 本机真实 rollout `019f69f8-1394-71b3-a0e3-2821d2e79fcf` 为主快照。Codex 的 base instructions、developer/user messages、world state、turn context 和调用结果均可从 JSONL 定位，因此动态层的可见度高于 Claude transcript。

## 九层索引

| 层 | 文件 | 主要证据 |
|---:|---|---|
| 1 | `01-system.md` | `session_meta.base_instructions` A |
| 2 | `02-developer-runtime.md` | rollout developer records A |
| 3 | `03-tools.md` | runtime contracts + calls A；内部源码不可用 |
| 4 | `04-project-rules.md` | AGENTS developer protocol + environment A |
| 5 | `05-environment-permissions.md` | developer/environment/turn context A |
| 6 | `06-skills-agents-mcp.md` | developer catalog、dynamic tools、manual A |
| 7 | `07-history-tool-results.md` | response_item/event_msg A |
| 8 | `08-attachments-state-compaction.md` | rollout state + base instructions A |
| 9 | `09-current-request.md` | rollout user record A |

`10-resolved-request.md` 给出可审计的完整逻辑 envelope。

## 边界

Rollout 是运行时事件日志，不是公开 Responses API 的原始 HTTP 抓包。固定 core tools 的最终 wire schema、加密 reasoning/spawn payload 和服务端 cache block 不一定可恢复。
