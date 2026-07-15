# ADR 0001: Tauri + Rust 迁移默认决策

> 状态：Accepted
>
> 日期：2026-07-15

## 背景

CodeZ 已决定停止扩展 Electron 后端，按需求分析、工程架构和实施计划迁移到 Tauri v2 + Rust。2026-07-15 的开工指令要求按照这些文档开始重构，因此采用需求文档 D-01 至 D-08 的推荐默认值作为首轮实施决策。

## 决策

| ID | 结论 |
| --- | --- |
| D-01 | 保留 React + TypeScript + Zustand + xterm.js 表现层，不改写为 Rust/WASM UI。 |
| D-02 | Windows x64 为首个完整验证平台，随后验证 macOS 和 Linux；未完成验证的平台不宣称支持。 |
| D-03 | 保留产品名 `CodeZ` 和应用 ID `com.codez.desktop`，以维持升级和数据路径连续性。 |
| D-04 | 首轮保持 JSON/JSONL/目录格式兼容，存储升级必须另立 ADR。 |
| D-05 | 新契约不向前端回传 Provider/MCP/OAuth 密钥明文，只提供 configured/masked 状态和替换操作。 |
| D-06 | MCP 先以现有集成测试验证 Rust SDK；只有覆盖 stdio、HTTP/SSE、OAuth、订阅、反向请求和恢复后才选型。能力不足时再评估受控协议实现。 |
| D-07 | 首轮继续随包分发 `rg`，先保持搜索行为和性能，再单独评估纯 Rust 实现。 |
| D-08 | Electron 旧数据至少保留一个 Tauri 稳定版本，默认不自动删除。 |

签名主体、证书和升级 feed 属于 Phase 9 的发布环境输入。它们不阻断本地 Phase 0/1 开发，但必须在候选安装包验收前冻结。

## 约束

- Phase 0 至 Phase 9 保留 Electron 源码、测试、配置、依赖和可恢复构建基线。
- 不建立产品级双运行时、双写或 Electron/Tauri 运行时开关。
- Tauri 宿主页仅用于 Phase 1 验证，不能承载未迁移业务或成为独立产品界面。
- MCP、safeStorage、PTY、Shell parser、流背压和资源打包仍以 spike 证据作为后续业务迁移门禁。

## 后果

- 前端可逐步建立 typed adapter，但完整业务切换仍集中在 Phase 8。
- 用户密钥无法安全兼容时进入 `requires_reentry`，不得降级为明文或 Base64。
- Electron 删除只能在 Phase 9 获得明确批准后，以独立 Phase 10 提交执行。

## 后续决策

- D-06 已由 [ADR 0002](./0002-rust-mcp-sdk.md) 关闭：采用 `rmcp 2.2.0` 作为协议核心，并由 CodeZ 实现 legacy SSE、严格 session recovery 与安全策略适配层。
- PTY 原语已由 [ADR 0003](./0003-rust-pty.md) 冻结：采用 `portable-pty 0.9.0`，终端 owner、有界输出、控制序列顺序和进程树终止仍由 CodeZ adapter 负责。
