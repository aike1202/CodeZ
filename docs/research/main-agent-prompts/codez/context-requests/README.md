# CodeZ 请求与日志样例

## 样例

| 文件 | 分类 | 证据 | 内容 |
|---|---|---:|---|
| `01-real-ledger-source-reconstructed.md` | real event + source reconstructed request | C | 真实主会话首轮 |
| `02-real-explore-agent-reconstructed.md` | real child + source reconstructed request | C | 真实 architecture Explore |
| `03-reviewer-source-derived.md` | simulated source-derived | D | 当前 Reviewer 完整逻辑样例 |

## 为什么没有 A 级完整 HTTP body

选定 Ledger 保存：

- 完整 user/assistant/tool messages
- tool call arguments 和 results
- request fingerprint
- token usage
- context scope
- Agent mailbox 和 durable records

但没有保存 outbound System Prompt、tools array 和 HTTP body。`proxy_logs.db` 的 request body 只覆盖旧 Gemini 请求，与当前 Rust session/版本不对齐。因此 A 级“真实发生过”的消息可以直接引用，System/tools 只能由同版本源码重建为 C 级。

每个样例都直接显示 System、messages、tool catalog 和 transport envelope，不使用 `content_ref` 或“见另一个文件”替代正文。源码重建的动态值会明确标注，不声称 byte-identical。
