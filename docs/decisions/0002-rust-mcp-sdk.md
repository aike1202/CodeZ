# ADR 0002: Rust MCP SDK 与兼容边界

> 状态：Accepted
>
> 日期：2026-07-15

## 背景

需求 D-06 要求用现有 stdio、HTTP/SSE、OAuth、订阅、反向请求和恢复行为验证 Rust SDK。完整自研 MCP 协议栈会扩大安全与兼容风险，但直接依赖 SDK 默认行为也无法满足 CodeZ 的信任、日志和恢复约束。

## 决策

Phase 7 使用官方 `rmcp 2.2.0` 作为协议编解码、握手、stdio、Streamable HTTP、OAuth 和 reverse request 核心，并固定版本直到现有 MCP 回归全部迁移。

CodeZ 保留独立 adapters/policy：

- 实现 legacy SSE client transport。
- 禁用 SDK 的宽泛 HTTP 404 自动恢复，只对 MCP `-32001 Session not found` 重建并重放一次。
- 使用统一进程 supervisor 管理握手超时、stderr、进程树和退出。
- 使用 OS credential store 与受限 state store，不采用内存或明文生产 fallback。
- 在 SDK handler 外执行配置合并、项目信任、secret expression、审批、日志脱敏、请求 guard、discovery 隔离和 content normalization。

`rmcp` 在 Phase 0 仅作为 dev dependency；Phase 7 开始生产实现时再提升为普通 dependency。

## 后果

- 不需要维护完整 MCP JSON-RPC 实现，可复用官方协议类型和跨 SDK 兼容性。
- legacy SSE 与严格 session recovery 是进入 Phase 7 的已知实现项，不得因 SDK 默认行为而删减。
- logging/roots/sampling 已被 SDK 标记为 deprecated，升级 `rmcp` 前必须运行 Rust spike 与现有 Electron MCP 回归。
- MCP 安全策略不依赖 SDK 注解或默认配置，仍由 `codez-core` port 和 `codez-mcp` adapter 组合实现。

验证证据见 `docs/migration/spikes/rust-mcp-sdk.md`。
