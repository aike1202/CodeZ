# Tauri + Rust 迁移工作区

本目录记录实施证据，不替代需求、架构和计划文档。

## 当前状态

- Phase 0：进行中。D-01 至 D-08 已按 ADR 0001 冻结；Windows safeStorage、Rust MCP SDK 和 Windows PTY/进程树 spike 已完成，macOS/Linux 验证及其余高风险 spike 和清单语义复核尚未完成。
- Phase 1：基座进行中。Cargo workspace、依赖方向门禁、三平台 CI、Tauri v2 宿主、typed command、前端 `shared/desktop` 和迁移期启动页已经建立；主题、日志、退出协调和自动化桌面 smoke 尚未完成。
- Phase 2 至 Phase 10：未开始。
- Electron 基线：完整保留，禁止提前删除。

## 首轮验证

- `npm.cmd run check:rust`：通过，Rust 首批 13 个测试通过。
- `npm.cmd run typecheck`：通过。
- `npm.cmd test -- --run`：183 个文件、1,166 项测试通过。
- `npm.cmd run build`：Electron main/preload/renderer 生产构建通过。
- `npm.cmd run build:tauri -- --debug --no-bundle`：通过，生成 `target/debug/codez-desktop.exe`。
- `npm.cmd run build:renderer:tauri`：通过。
- `npm.cmd run dev:tauri`：真实 Windows 进程启动并保持响应，renderer 使用 `http://localhost:1420/tauri.html`；Electron 占用全局快捷键时降级为告警而不终止 Tauri。
- 迁移清单重复生成 SHA-256 稳定，当前 119 个声明 channel、0 个未声明 transport 引用。
- Windows `safeStorage` sentinel spike：通过，确认旧密文需要 `Local State` DPAPI 主密钥 + Chromium `v10` AES-256-GCM 只读兼容层；见 `docs/migration/spikes/windows-safe-storage.md`。
- Rust MCP SDK spike：通过，采用 `rmcp 2.2.0` 作为协议核心，legacy SSE、严格 session recovery 和安全策略由 CodeZ adapter 负责；见 `docs/migration/spikes/rust-mcp-sdk.md`。
- Windows PTY/进程树 spike：6 项真实 ConPTY 测试通过，采用 `portable-pty 0.9.0` 作为 PTY 原语，树级终止和有界输出由 CodeZ adapter 负责；见 `docs/migration/spikes/rust-pty.md`。

## 生成清单

运行：

```powershell
npm.cmd run analyze:tauri-migration
```

输出位于 `docs/migration/generated/`：

- `desktop-contracts.json`：IPC handler/listener/event、preload 调用和 `window.api` 消费位置。
- `persistence-literals.json`：旧主进程中的持久化文件、目录和 `userData` 字面量候选。
- `test-migration.csv`：现有测试文件的初始迁移分类；`reviewed=false` 表示仍需人工确认。
- `traceability.csv`：FR/NFR 到实现、测试和平台证据的追踪入口。
- `inventory-summary.md`：当前统计摘要。

生成结果只做语法级盘点。动态 channel、间接调用、数据引用关系、最大体积、恢复语义和测试行为仍需在 Phase 0 人工审计后才能标记完成。
