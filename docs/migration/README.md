# Tauri + Rust 迁移工作区

本目录记录实施证据，不替代需求、架构和计划文档。

## 当前状态

- Phase 0：Windows x64 基线已闭环。D-01 至 D-08 已按 ADR 0001 冻结；六项高风险 spike、88 个 `window.api` 方法语义、23 类持久化数据、183 个测试文件分类、79 条 FR/NFR 追踪矩阵和性能基线均已有可重复证据。macOS/Linux safeStorage、PTY、资源与性能验证仍由目标平台 CI 完成，Phase 9 的签名主体和升级 feed 仍未冻结。
- Phase 1：基座已闭环。Cargo workspace、依赖方向门禁、三平台 CI、Tauri v2 宿主、typed command、前端 `shared/desktop`、统一错误/脱敏诊断、迁移期启动页和有界四阶段安全退出已经建立；Tauri debug build、聚焦 host 测试和非视觉 smoke 通过。
- Phase 2：进行中。`AppPaths` 已统一应用数据、缓存、日志、资源、临时和工作区状态根并由 Tauri composition root 注入；`AtomicFileStore` 已提供按资源串行的原子 JSON/JSONL、同步落盘、大小限制、故障注入、安全权限和损坏 quarantine/有效前缀恢复。`codez-storage` 现已定义 19 个版本化 schema family，并按 23 类持久化清单实现只读发现、脱敏 manifest、源文件复核、幂等 no-clobber 精确备份及脱敏 `legacy-data-v0` fixtures；类型安全的 `CredentialStore` port 与 Windows Credential Manager/macOS Keychain/Linux Secret Service adapter 已注入 Tauri composition root，secret 不实现 `Debug`/`Serialize` 并在 drop 时清零。旧 Provider/MCP secret/MCP OAuth 迁移现已绑定已验证备份：Windows 通过 DPAPI + AES-256-GCM 只读旧 `safeStorage`，成功值直接进入 OS 凭据库，无法安全迁移的条目只写脱敏 `requires_reentry` 决策。迁移 transform、语义引用验证、原子完成标记、滚动日志、其他通用 ports 与取消树仍未完成。
- Phase 3 至 Phase 10：未开始。
- Electron 基线：完整保留，禁止提前删除。

## 首轮验证

- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings -D clippy::perf`：通过。
- `cargo test --workspace --locked`：通过，共 70 项 Rust 测试；其中 storage 27 项覆盖路径、原子替换、备份、凭据适配、三类旧凭据迁移、重录决策、脱敏、幂等与篡改阻断。
- `cargo test -p codez-desktop --all-targets --all-features --locked`：通过，8 项 desktop 单元测试与 2 项有界流集成测试通过。
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
- Windows PTY/进程树 spike：6 项真实 ConPTY 测试通过，采用 `portable-pty 0.9.0` 作为 PTY 原语，树级终止和有界输出由 CodeZ adapter 负责；见 `docs/migration/spikes/rust-pty.md`。
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
