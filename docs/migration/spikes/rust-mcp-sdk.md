# Rust MCP SDK capability spike

> 状态：通过，需 CodeZ 兼容与安全适配层
>
> 日期：2026-07-15
>
> 候选：官方 `modelcontextprotocol/rust-sdk`，crate `rmcp = 2.2.0`

## 目的

用现有 Electron MCP 行为和真实 JavaScript SDK fixture 验证 Rust SDK，而不是只比较 API。Spike 不替换 `McpConnectionManager`，`rmcp` 当前仅是 `codez-mcp` 的 dev dependency。

## 方法

1. Rust 通过 `TokioChildProcess` 连接现有 `mcp-stdio-server.cjs`，协商 MCP `2025-11-25`。
2. Rust 启动隔离的 Streamable HTTP fixture，验证 discovery、调用、订阅、通知和 session recovery。
3. Rust 启动隔离的 OAuth authorization server，验证 metadata discovery、动态注册、S256 PKCE、回调和 refresh。
4. Rust 通过内存双工 transport 执行真实 sampling 与 URL elicitation reverse requests。
5. 使用现有 hanging/failure fixture 验证握手超时、子进程退出和有界 stderr 排空。

可执行证据位于 `crates/codez-mcp/tests/rmcp_sdk_spike.rs`。JavaScript fixture 位于 `src/tests/fixtures/`。

## 结果

| 能力 | 结果 | 结论 |
| --- | --- | --- |
| stdio tools/resources/templates/prompts | 通过 | SDK 负责协议编解码、握手和基础 client API。 |
| tool call/resource read/prompt get | 通过 | 与现有 `@modelcontextprotocol/sdk` fixture 互操作。 |
| logging notification | 通过 | SDK 传递原始数据；CodeZ 必须负责脱敏和最多 200 条日志上限。 |
| handshake timeout | 通过适配验证 | CodeZ 在 `serve` 外层设置超时并记录稳定错误码。 |
| stderr 与子进程退出 | 通过适配验证 | SDK 暴露 stderr 和关闭能力；CodeZ 负责有界捕获（探针总量 8 KiB）、退出原因和进程树回收。 |
| Streamable HTTP | 通过 | discovery、tool/resource/prompt、subscribe/unsubscribe 和 resource update 可用。 |
| expired session recovery | 部分符合 | SDK 可自动重建，但对任意带 session 的 HTTP 404 都恢复；CodeZ 只允许 `-32001 Session not found`，必须禁用默认行为并实现严格适配。 |
| legacy SSE endpoint | SDK 缺口 | `rmcp 2.2.0` 只有 Streamable HTTP 使用的 SSE parser，没有旧 `/sse` + `/messages` client transport。CodeZ 必须实现受控兼容 transport。 |
| OAuth | 通过 | SDK 可完成 discovery、DCR、PKCE、state/issuer callback 和 refresh，并允许自定义 `CredentialStore`/`StateStore`。OS 安全存储、外链/回调宿主和 revoke/logout 仍由 CodeZ 负责。 |
| sampling/elicitation | 通过 | reverse request 可以到达 client handler；是否广告、审批、token 上限、禁止 tools、URL/form 策略仍由 CodeZ 决定。 |
| trust/config/retry/normalization | SDK 范围外 | 配置优先级、项目指纹、secret expression、请求 guard、schema 隔离、名称归一化和二进制内容句柄继续属于 CodeZ。 |

`rmcp 2.2.0` 已将 logging、roots 和 sampling 标记为 SEP-2577 deprecated，但现有 CodeZ 仍依赖这些兼容行为。Phase 7 初期固定已验证版本，升级必须重新运行本探针和 Electron MCP 回归。

## 决策

Phase 7 采用 `rmcp 2.2.0` 作为 MCP 协议核心，不自研完整 JSON-RPC/MCP 栈。`codez-mcp` 在它外部提供以下边界：

- `McpProcessSupervisor`：握手超时、stderr 上限、进程树、退出原因和取消。
- `McpHttpTransport`：安全 fetch、OAuth header、严格 session error 分类和 legacy SSE。
- `McpCredentialStore`/`McpStateStore`：OS 凭据存储、并发序列化、TTL 和 `requires_reentry`。
- `McpReverseRequestPolicy`：默认不广告，按 server/environment/user approval 收紧。
- `McpDiscovery`/`McpContentNormalizer`：分页环检测、schema 隔离、名称冲突、内容上限和二进制句柄。
- `McpConnectionManager`：配置、信任、重连、状态事件、catalog 生命周期与安全日志。

该选择不表示 Phase 7 已完成；它只关闭“Rust SDK 是否可作为协议核心”的 Phase 0 风险。

## 验证

2026-07-15 Windows x64：

```powershell
cargo test -p codez-mcp --test rmcp_sdk_spike
cargo clippy -p codez-mcp --all-targets --all-features --locked -- -D warnings -D clippy::perf
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-targets
npm.cmd run typecheck
npm.cmd run check:architecture
npm.cmd test
```

8 个 Rust spike 测试、workspace 全量 Rust 格式/Clippy/测试、TypeScript 类型检查和 8 个 crate 的架构检查均通过。Vitest 全量回归为 183 个文件、1,166 项测试全部通过；Electron MCP 的 stdio、HTTP、OAuth 真实 fixture 回归也通过。

## 限制

- 当前真实跨 SDK 运行证据来自 Windows x64；macOS/Linux 仍需 CI 与真实进程 smoke。
- OAuth fixture 不替代 OS credential store、安全浏览器回调和 revoke/logout 测试。
- legacy SSE 尚未实现，只完成缺口确认和责任归属。
- SDK 默认 session recovery 与现有 CodeZ 语义不一致，未完成严格适配前不得用于生产连接。
