# Tauri + Rust 迁移工作区

本目录记录实施证据，不替代需求、架构和计划文档。

> **当前范围（2026-07-17）**：Tauri 只在 `~/.codez` 初始化并运行新状态；不读取、复制或迁移 Electron `userData`、旧 `~/.codez` 实验数据或旧密钥。Electron 的源码、测试、配置、依赖和安装基线永久保留，本项目不执行 Electron 删除。MCP 暂缓，不能阻塞 Workspace、Terminal、Skills、Host、Provider、Chat、Tool、Permission、Agent 和 Renderer bridge 的迁移。详情见 `current-execution-scope.md`；下方历史 Phase 2/9/10 描述仅保留审计记录，已被本说明覆盖。

## 当前状态

下列状态按当前工作树的代码边界记录。某个 crate、command 或测试存在，不等于对应用户流程已经由 Rust/Tauri 完整承接；只有各 Phase 的出口和 Phase 9 删除门禁才构成迁移完成证据。

- Phase 0-1：迁移清单、ADR、Cargo/Tauri 基座、契约和前端 adapter 已建立。当前仍有并行整合中的 workspace/Cargo 变更，历史绿灯必须在整合完成后重跑，不能据此宣布任一完整 Phase 已验收。
- Phase 2：底层 primitives 已覆盖大部分清单，但阶段尚未闭环。ADR 0007 已把新运行时唯一应用数据根固定为 `~/.codez`，cache/logs/temp/migrations 均位于其下；Electron `userData` 和升级前已有的 `~/.codez` 用户内容只作为迁移源。`AtomicFileStore`、19 个 schema family、23 类只读 discovery、no-clobber backup、transform、凭据决策、引用验证和 commit marker 已存在，且 composition 已在构造 repositories 前运行 migration coordinator。`AwaitingCredentials` 现有 fail-closed recovery state、typed status/submit/restart command 和 React 重录界面：仅能为已映射的 credential ID 写入 OS credential store，coordinator 重新验证并 activation 后才允许重启，正常 `AppState` 在重启前不可用。真实旧安装升级/回退、已有根与 migration staging 不相交安全性以及完整桌面 E2E 尚无证据，因此不得宣称端到端数据或密钥迁移完成。
- Phase 3：进行中。`WorkspaceRoot`/`SafeWorkspacePath`、受限文件系统、recent projects 和部分 Workspace commands 已实现。平台 PTY 已有创建、读写、resize、树级 kill 和有界事件实现；2026-07-16 的真实生产 `PtyManager.kill` 树终止用例通过，但原生 `ping.exe -t` 的 Ctrl+C 用例未能恢复 prompt，是 Phase 3 和发布阻断项。编辑事务、附件、Git/worktree、完整终端命令与前端流程仍未验收。
- Phase 4：Provider domain、存储边界、协议流解析、Context ledger 与 `AtomicPersistence` port 已有实现；它们尚未形成含 compact、持久化恢复和 tool/Agent loop 的完整会话。AskUser 已有受限 response registry、typed command/event 和 renderer bridge；答案会针对 pending request 验证，超时、取消或 renderer 不可用时会取消等待。当前 provider-only Rust chat runtime 尚未调用该边界，不能当作 live AskUser 功能。tool interrupt、compact、文件 accept/reject/diff 和 approval 仍明确返回 `UNSUPPORTED`。
- Phase 5-6：工具、权限、Agent 和并行执行存在部分 Rust domain 模块。`AgentLoop` 已提供有界 step、停止/恢复和取消状态机；`SubAgentManager` 已提供 validated ID/role、生命周期、邮箱和 model-profile foundations。它们尚未接入 Rust provider/chat、工具执行和 Tauri 用户流程，因而没有完整 Rust tool loop，不能作为用户可用功能或 Electron 替代品计入完成。
- Phase 7：`codez-mcp` 协议/配置基础和外部 Skills 的部分安全导入检查正在实现；MCP live gateway/reconciliation 仍在整合中，live 操作不能视为已迁移。Windows external Skills import 现以 no-clobber destination reservation、文件/目录 identity 复核和回滚保护避免预检后的覆盖，但仍存在同权限攻击者替换路径的残余 TOCTOU 风险，也尚无可恢复事务日志和可验证的更新/CAS 覆盖流程。
- Phase 8-10：尚未开始端到端验收、跨平台发布验证或 Electron 清理。React/Tauri adapter 的局部迁移不等于前端已脱离 Electron。
- Electron 基线：源码、测试、配置和依赖必须完整保留。Phase 0-9 禁止删除；仅在 Phase 9 全部迁移、安全、升级/回退、跨平台和人工批准门禁通过后，才能在独立的 Phase 10 删除。

## 历史基线与当前验证

以下是 2026-07-15 记录的历史基线，用于后续对比，不是当前工作树的统一验收结果。当前存在并行 Rust/Cargo 整合；Cargo.lock 稳定后必须重新执行严格 Rust、前端、契约和目标平台门禁。尤其不得用这些旧结果掩盖 Windows 原生 Ctrl+C、真实升级/回退与迁移恢复 E2E、Tool/Agent loop、MCP live gateway 或外部 Skills 事务安全的未完成项。

- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings -D clippy::perf`：通过。
- `cargo test --workspace --locked`：通过，共 101 项 Rust 单元/集成测试；其中 storage 37 项覆盖路径、原子替换、不可变创建、版本化 recent repository、备份、凭据适配、三类旧凭据迁移、transform、语义引用、重启阶段识别、完成标记、脱敏、幂等与篡改阻断；core/runtime/platform/desktop 覆盖进程边界、错误分类、UUID、取消树、路径值对象、Windows 大小写、symlink/TOCTOU、有界读取、原子写入、递归树、忽略规则、项目识别与预览，另有 1 项 `SecretValue` 不可序列化的 compile-fail rustdoc。
- `cargo test -p codez-desktop --all-targets --all-features --locked`：通过，12 项 desktop 单元测试与 2 项有界流集成测试通过。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run check:architecture`：通过，8 个 workspace package 依赖方向有效。
- `npm.cmd test -- --run`：183 个文件、1,166 项测试通过。
- `npm.cmd run build`：Electron main/preload/renderer 生产构建通过。
- `npm.cmd run build:tauri -- --debug --no-bundle`：通过，生成 `target/debug/codez-desktop.exe`。
- `npm.cmd run build:renderer:tauri`：通过。
- `npm.cmd run dev:tauri`：真实 Windows 进程启动并保持响应，renderer 使用 `http://localhost:1420/tauri.html`；Electron 占用全局快捷键时降级为告警而不终止 Tauri。
- 迁移清单重复生成 SHA-256 稳定，当前 119 个声明 channel、0 个未声明 transport 引用。
- Windows `safeStorage` sentinel spike：通过，确认旧密文需要 `Local State` DPAPI 主密钥 + Chromium `v10` AES-256-GCM 只读兼容层；见 `docs/migration/spikes/windows-safe-storage.md`。
- Rust MCP SDK spike：通过，采用 `rmcp 2.2.0` 作为协议核心，legacy SSE、严格 session recovery 和安全策略由 CodeZ adapter 负责；见 `docs/migration/spikes/rust-mcp-sdk.md`。
- Windows PTY/进程树 spike：2026-07-16 复验证实生产 `PtyManager.kill` 的树级终止通过，但 ConPTY 对原生 `ping.exe -t` 写入裸 `0x03` 后不能恢复 shell prompt；Windows Ctrl+C 仍是发布阻断项。`portable-pty 0.9.0` 仅是当前 PTY 原语候选，见 `docs/migration/spikes/rust-pty.md`。
- Rust Shell parser spike：29 条共享语料中裸 Rust 完全一致 18 条，确认必须迁移 Bash/PowerShell masks 和原生 PowerShell AST fallback；见 `docs/migration/spikes/rust-shell-parser.md`。
- Tauri 流/backpressure spike：2.56 MiB 慢消费和组件卸载模型通过，确认使用有界上游、4 KiB frame、累计 ACK 窗口与显式 cancel；见 `docs/migration/spikes/tauri-stream-backpressure.md`。
- Tauri 资源打包 spike：20 个 builtin skill 文件、`rg 15.0.0`、固定安装目标和 Tauri debug 构建通过；见 `docs/migration/spikes/tauri-resource-packaging.md`。
- `window.api` 语义清单：88 个方法全部复核，76 个请求、7 个显式释放订阅、1 个可取消流和 4 个 fire-and-forget 日志调用；仍有 30 个签名包含 legacy `any`，必须在前端切换前消除。
- Golden fixtures：OpenAI/Anthropic/Gemini 脱敏请求与流、工具 Schema 指纹、权限矩阵/危险命令及 Agent 状态转换通过 131 项定向测试。
- Windows x64 Electron 性能基线：3 次隔离启动中位数 `ready-to-show 597.71 ms`、首帧 `661.66 ms`、总工作集 `444,391,424 bytes`；当前安装包 `94,487,081 bytes`。完整方法与其他指标见 `docs/migration/generated/performance-baseline.win32-x64.json`。

## 生成清单

运行：

```powershell
npm.cmd run analyze:tauri-migration
```

输出位于 `docs/migration/generated/`：

- `desktop-contracts.json`：IPC handler/listener/event、preload 调用和 `window.api` 消费位置。
- `desktop-api-semantics.json`：88 个 `window.api` 方法的输入、输出、错误、取消、事件、channel 和订阅释放语义。
- `persistence-literals.json`：旧主进程中的持久化文件、目录和 `userData` 字面量候选。
- `persistence-inventory.json`：23 类持久化数据的路径、格式、schema、现有限额、写入者、引用与恢复策略。
- `test-migration.csv`：184 个测试文件的五类迁移归属，当前为 150 个 `port-to-rust`、27 个 `keep-frontend`、3 个 `replace-contract`、0 个 `replace-e2e` 和 4 个候选 `obsolete-electron`，无未复核行。0 个现有 E2E 是 Phase 8 必须补齐的测试缺口，不代表无需 E2E。
- `traceability.csv`：79 条 FR/NFR 到阶段、owner、实现、测试和平台证据的追踪入口。
- `performance-baseline.win32-x64.json`：当前 Electron 构建的无截图 Windows x64 性能与包体积基线。
- `inventory-summary.md`：当前统计摘要。

清单生成命令：

```powershell
npm.cmd run analyze:tauri-migration
npm.cmd run measure:tauri-baseline
```

AST 产物与人工复核规则共同生成这些证据。30 个 legacy `any`、现存未设字节上限的持久化格式以及 macOS/Linux 平台结果是后续阶段的显式迁移债务，不得因 Windows 基线完成而视为已解决。
