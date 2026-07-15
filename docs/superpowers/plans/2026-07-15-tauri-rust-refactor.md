# CodeZ Tauri + Rust 重构实施计划

> 状态：Draft，等待需求和开工决策冻结
>
> 日期：2026-07-15
>
> 需求：`docs/superpowers/specs/2026-07-15-tauri-rust-refactor-requirements.md`
>
> 架构：`docs/superpowers/specs/2026-07-15-tauri-rust-architecture-design.md`

> 实施状态：已于 2026-07-15 开始；进展与生成清单见 `docs/migration/README.md`

## 1. 目标与约束

**目标：** 以 Tauri v2 + Rust 后端直接替换 Electron 主进程和 preload，保留 React UI 与现有核心行为，安全迁移用户数据，最终发布物不包含 Electron/Node 主进程。

**迁移方式：** 最终进行单次产品切换，不实现双运行时、运行时开关或 Electron/Tauri 数据双写。迁移期间完整保留并冻结 Electron 源码、测试、构建配置、依赖和稳定安装包，作为尚未迁移能力、行为对照与发布回退基线；只有 Tauri/Rust 完整迁移和安全验收通过后，才以独立阶段、独立提交删除 Electron。

**首要原则：**

- 先冻结外部行为和数据格式，再写 Rust。
- 按领域边界重构，不按 TypeScript 文件逐行翻译。
- 迁移同时完成工程架构整理，但只整理被迁移模块，不另开一条脱离迁移目标的大规模重构线。
- 安全边界先于功能便利；未知命令、路径逃逸和密钥降级均默认拒绝。
- 每一阶段必须有独立可验证的出口，不能到最后才做集成。
- Electron 删除是迁移完成后的动作，不是迁移过程中按模块随手清理的动作。
- 不在同一计划中进行 UI 重设计或数据库重构。

## 2. 已完成的前期基线

- [x] 盘点 Electron/main/preload/renderer/shared/test 的规模与职责。
- [x] 识别窗口、IPC、文件、子进程、PTY、safeStorage、MCP、ripgrep 和 tree-sitter 等替换面。
- [x] 记录主要应用数据文件和目录。
- [x] 运行 `npm.cmd run typecheck`，结果通过。
- [x] 运行 `npm.cmd test -- --run`，183 个文件、1,165 个测试通过。
- [x] 形成需求分析、工程架构设计与实施计划初稿。

这些检查只建立 2026-07-15 基线，不代表已开始 Tauri 或 Rust 实现。

## 3. 总体里程碑

| 阶段 | 主题 | 主要产出 | 出口 |
| --- | --- | --- | --- |
| Phase 0 | 冻结与技术验证 | 决策记录、契约清单、golden fixtures、关键 spike | 风险可实施 |
| Phase 1 | Rust/Tauri 基座 | Cargo workspace、Tauri shell、typed bridge、CI | 空壳可靠运行 |
| Phase 2 | 数据与平台层 | 路径、原子存储、密钥、迁移、日志、资源 | 数据安全可验证 |
| Phase 3 | Workspace 与本地执行 | 文件、搜索、编辑事务、Git/worktree、PTY、附件 | 本地工作流可用 |
| Phase 4 | Provider 与上下文 | 三类模型协议、流、ledger、压缩、恢复 | 单 Agent 可对话 |
| Phase 5 | 工具与权限 | 工具注册/执行、Schema、调度、权限与审计 | 副作用安全可控 |
| Phase 6 | Agent 与并行运行时 | 主/子 Agent、任务、计划、并行、执行控制 | Agent 核心闭环 |
| Phase 7 | MCP 与扩展 | MCP transports/OAuth/资源/工具、Skills/Rules | 扩展能力闭环 |
| Phase 8 | 前端切换与全链路 | React adapter、所有 command/channel、E2E | Tauri 功能完整 |
| Phase 9 | 完整迁移验收与发布准备 | 三平台构建、数据/密钥、安全、升级/回退验收 | 获得删除批准 |
| Phase 10 | Electron 独立清理 | 删除代码/配置/依赖并全量复验 | 最终发布候选通过 |

Phase 4-7 可在接口稳定后局部并行，但 Phase 2 的数据/平台契约和 Phase 5 的权限边界不能跳过。

## 4. Phase 0：需求冻结与高风险技术验证

### 4.1 决策冻结

- [x] 确认保留 React UI，不做 Rust/WASM UI 重写。
- [x] 确认首发平台和 CPU 架构；Windows x64 先验，macOS/Linux 随后。
- [ ] 确认应用 ID、产品名、签名主体和升级路径。应用 ID 与产品名已冻结；签名主体和升级 feed 待 Phase 9 发布环境确认。
- [x] 确认初期继续使用兼容 JSON/目录存储，不同时切换 SQLite。
- [x] 确认 Provider 密钥不回显，只允许 masked/configured 状态和替换操作。
- [x] 确认旧 Electron 数据至少保留一个稳定版本，默认不自动删除。
- [x] 审核架构设计中的 crate 边界、依赖规则和前端目标目录；结论见 `docs/decisions/0001-tauri-rust-migration-defaults.md`。

### 4.2 契约清单

- [x] 为现有 `window.api` 生成方法清单：输入、输出、错误、取消、事件和订阅释放语义；88 个方法的复核结果见 `docs/migration/generated/desktop-api-semantics.json`。
- [x] 记录所有 `ipcMain.handle/on` 与 `webContents.send`，并清除未定义在 `IPC_CHANNELS` 的静态散落字符串；动态请求响应 channel 已单独标记。
- [x] 为 Chat、Tool、SubAgent、Permission、AskUser、Terminal 和 MCP 事件定义稳定 envelope：

```ts
interface DesktopEvent<T> {
  version: 1
  streamId?: string
  sequence?: number
  kind: string
  payload: T
}
```

- [x] 记录 Provider 协议请求/响应 golden fixtures，必须脱敏；三种协议的请求、流片段、canonical tool call 和 stop reason 已由 `provider-protocol-golden.json` 锁定并通过现有适配器验证。
- [x] 记录工具 Schema、权限决策、危险命令语料和 Agent 状态转换 fixtures；fixtures 位于 `src/tests/fixtures/migration/`，共享 Shell parser 语料位于 `src/tests/fixtures/permission-shell-corpus.json`。
- [x] 记录每类持久化数据的路径、schema、最大体积、写入者、引用关系和恢复语义；23 类复核结果见 `docs/migration/generated/persistence-inventory.json`。

### 4.3 必做 spike

1. **safeStorage 兼容：** 分别验证 Windows/macOS/Linux 旧密文读取；失败时验证 `requires_reentry` 流程。
2. **MCP Rust 能力：** 以现有真实 stdio/HTTP 测试验证 SDK 的 tools/resources/prompts、SSE、OAuth、订阅、反向请求、重连和 session recovery。
3. **PTY/进程树：** 验证 Windows ConPTY、中文、resize、Ctrl+C、kill tree、退出清理；补 macOS/Linux smoke。
4. **Shell parser：** 用现有 Bash/PowerShell 权限语料对 Rust tree-sitter 解析结果做差异报告。
5. **Tauri 流：** 持续高吞吐聊天/终端事件，验证顺序、取消、背压、组件卸载和内存上限。
6. **资源与打包：** 验证 builtin skills、parser grammar/资源、`rg` 和安装后路径定位。

当前进展：Windows `safeStorage` sentinel 已验证为 `Local State` 用户 DPAPI 主密钥 + Chromium `v10` AES-256-GCM envelope，可实现只读 legacy reader；MCP 已选定 `rmcp 2.2.0` 作为协议核心，并确认 legacy SSE、严格 `-32001` session recovery 与安全策略由 CodeZ adapters 承担；Windows PTY/进程树已用 6 项真实 ConPTY 测试验证，选定 `portable-pty 0.9.0` 作为 PTY 原语，树级终止、有界输出和控制序列顺序由 CodeZ adapter 负责；Shell parser 已用 29 条共享语料完成差异报告，固定同版本 Rust tree-sitter 起点，并确认必须迁移 Bash/PowerShell masks 和原生 PowerShell AST fallback；Tauri 流已用 2.56 MiB 慢消费者与卸载模型验证，固定有界上游、4 KiB frame、累计 ACK 窗口和显式 cancel；Windows x64 资源已验证 20 个 builtin skill 文件、`rg 15.0.0`、固定安装 target 和 Tauri debug 构建。证据见 `docs/migration/spikes/windows-safe-storage.md`、`docs/migration/spikes/rust-mcp-sdk.md`、`docs/migration/spikes/rust-pty.md`、`docs/migration/spikes/rust-shell-parser.md`、`docs/migration/spikes/tauri-stream-backpressure.md`、`docs/migration/spikes/tauri-resource-packaging.md`、ADR 0002 至 ADR 0006。六项 spike 在 Windows x64 均有可执行结论；macOS/Linux safeStorage、PTY 和资源映射仍待目标平台验证。

### 4.4 性能与质量基线

- [x] 记录冷启动、首屏、空闲内存、安装包、文件树、搜索、首 Token 和 PTY 吞吐；可重复探针与 Windows x64 结果见 `scripts/tauri/measure-performance-baseline.ts` 和 `docs/migration/generated/performance-baseline.win32-x64.json`。
- [x] 将当前 184 个测试文件按 `port-to-rust`、`keep-frontend`、`replace-contract`、`replace-e2e`、`obsolete-electron` 分类，所有行均已标记 `reviewed=true`；生成器会随新增测试持续更新。
- [x] 建立 FR/NFR -> 阶段/owner -> 测试 -> 平台的 79 行追踪矩阵，见 `docs/migration/generated/traceability.csv`。

Windows x64 Electron 基线中位数：`ready-to-show 597.71 ms`、首个 animation frame `661.66 ms`、4 个进程合计工作集 `444,391,424 bytes`；当前 NSIS 安装包 `94,487,081 bytes`，仓库文件树 `22.74 ms`，`rg` 搜索 `29.64 ms`，无网络合成首 Token `1.25 ms`，legacy `node-pty` 吞吐 `0.82 MiB/s`。首 Token 数值明确排除网络，只用于比较 Provider 流解析路径。

**Phase 0 出口：** D-01 至 D-08 已确认；六个高风险领域均有可执行结论；不存在“等实现后再确认”的密钥、MCP 或 PTY 阻断项。

## 5. Phase 1：Tauri 与 Rust 工程基座

### 5.1 建议目录

```text
src-tauri/
  Cargo.toml
  tauri.conf.json
  capabilities/
  src/
crates/
  codez-contracts/
  codez-core/
  codez-runtime/
  codez-platform/
  codez-providers/
  codez-mcp/
  codez-storage/
src/renderer/src/desktop/
  api.ts
  events.ts
  errors.ts
  generated/
```

- [x] 建立 Cargo workspace、格式化、Clippy 和测试命令；依赖安全审计将在锁定审计工具后补充。
- [x] 为 workspace 增加依赖方向检查，禁止 core/runtime 反向依赖 Tauri 或具体平台 adapter。
- [x] 配置 Tauri v2、Vite dev/build、应用 ID、无边框窗口、最小尺寸和 CSP。
- [x] 建立 `AppState` 生命周期，只存放服务句柄，不把领域逻辑写入 command。
- [x] 建立统一 Rust 错误枚举、稳定错误码、脱敏日志和前端错误映射；`codez-core::AppError` 将用户消息与诊断分离，desktop `ErrorReporter` 生成 correlation ID 并映射为 `CommandError`，前端拒绝展示非结构化原始异常。
- [x] 选择并落地 `ts-rs` Rust -> TypeScript 类型生成方案，生成结果由 `npm run contracts:generate` 维护。
- [x] 建立前端 `desktopApi`，Tauri 迁移代码只通过该 adapter 调用 command。
- [ ] 实现最小窗口、主题、外链、目录选择、单实例、快捷键和安全退出 smoke。
- [x] 建立 Windows/macOS/Linux CI 矩阵；执行依赖方向、fmt、clippy、Rust test、前端 typecheck/test 和 Tauri build check。

**Phase 1 出口：** 干净环境可启动 Tauri React 页面；command、channel、event 和错误传递有自动化测试；capabilities 不授予通用 Shell/文件权限。

## 6. Phase 2：数据、密钥与通用平台层

### 6.1 数据基础设施

- [ ] 实现 `AppPaths`，统一应用数据、缓存、日志、资源、临时和工作区状态路径。
- [ ] 实现原子 JSON/JSONL 读写、权限设置、写队列、故障注入和损坏文件隔离。
- [ ] 为 session、settings、provider、permission、MCP、context、execution 等定义版本化 schema。
- [ ] 实现只读旧数据发现、清单、备份、幂等迁移、验证和完成标记。
- [ ] 建立真实但脱敏的旧数据 fixtures，覆盖旧版本字段、部分损坏和引用缺失。

### 6.2 密钥与日志

- [ ] 实现 OS 凭据存储 adapter，区分“不存在”“不可用”“权限拒绝”“密文损坏”。
- [ ] 实现旧 Provider/MCP/OAuth 密钥迁移或明确的重新录入标记。
- [ ] 禁止 Base64/明文 fallback；为日志和错误加入结构化脱敏测试。
- [ ] 以 `tracing` 实现滚动日志、日志等级和 session/stream/tool span。

### 6.3 通用平台 trait

- [ ] 定义 `FileSystem`、`ProcessRunner`、`CredentialStore`、`EventSink`、`Clock`、`IdGenerator` 等可测试边界。
- [ ] 区分用户取消、超时、进程失败、输入错误、权限拒绝与内部错误。
- [ ] 使用 `CancellationToken` 建立应用 -> session -> agent -> tool/process 的取消树。

**Phase 2 出口：** 迁移可重复执行且不会修改旧数据；故障注入下无半写文件；密钥不降级；应用异常退出后能识别未完成迁移和未完成运行状态。

## 7. Phase 3：Workspace、本地工具基础与终端

### 7.1 Workspace 和搜索

- [ ] 迁移目录选择、最近项目、项目识别、文件树和受限读取。
- [ ] 实现统一 `SafeWorkspacePath`，处理规范化、大小写、符号链接和 TOCTOU 复检。
- [ ] 迁移文件忽略、Glob/Grep/List/Read 与项目分析；先按 D-07 决定 `rg` 或纯 Rust。
- [ ] 迁移编辑器/资源管理器打开、Git 上下文和 worktree。

### 7.2 编辑事务和附件

- [ ] 迁移读取指纹、FileMutationCoordinator、Edit/Write/Notebook 和编辑事务。
- [ ] 保留备份、diff、逐文件接受/拒绝、冲突与符号链接防护。
- [ ] 迁移附件 draft/promote/rollback/preview/orphan cleanup 和大小/MIME 校验。

### 7.3 进程和 PTY

- [ ] 实现受控进程启动、环境合并、stdout/stderr 上限、超时、取消和进程树终止。
- [ ] 实现 Bash/PowerShell 平台选择和 UTF-8 约束。
- [ ] 实现 PTY start/write/resize/kill/output/exit，终端事件使用有界 channel。
- [ ] 退出时停止所有 PTY 和进程，并验证没有遗留子进程。

**Phase 3 出口：** 文件预览/搜索/编辑/回滚、Git/worktree、附件与终端可在目标平台运行；现有对应 golden/integration 测试完成 Rust 等价覆盖。

## 8. Phase 4：Provider、Chat 与 Context Runtime

### 8.1 Provider

- [ ] 迁移 Provider CRUD、模型能力、连接测试和安全凭据引用。
- [ ] 分别实现 OpenAI、Anthropic、Gemini 请求 adapter 和流解析器。
- [ ] 覆盖文本、推理、图片、工具调用、Usage、stop reason、错误、超时、取消和 overflow。
- [ ] 对脱敏 golden fixtures 进行请求/响应兼容测试。

### 8.2 Chat 与 Context

- [ ] 迁移 ModelLedgerStore、ModelContextBuilder、消息归一化和 ProviderUsage fingerprint。
- [ ] 迁移上下文预算、trigger policy、compaction、pruning、file/skill restore 和 crash recovery。
- [ ] 建立 Chat stream 状态机：starting/running/stopping/completed/failed/interrupted。
- [ ] 所有事件携带 stream/session 标识与有序语义，结束后丢弃迟到事件。
- [ ] 迁移 prompt pipeline、rules、skills、memory、environment 和 verification context。

**Phase 4 出口：** 不使用工具时，现有三类 Provider 均可完成流式会话、停止、压缩、保存和重启恢复；协议 golden 测试与故障场景通过。

## 9. Phase 5：工具运行时与权限系统

### 9.1 工具运行时

- [ ] 迁移 ToolDescriptor/Registry、Schema decoration、input validation 和 exposure planner。
- [ ] 迁移 call assembler、scheduler、hook、journal、large result store 和 result processor。
- [ ] 先实现 V2 canonical pipeline；确认无行为依赖后不移植仅用于 Electron 回退的 legacy pipeline。
- [ ] 为每个内置工具建立 Rust handler 和效果计划，统一返回结构化结果。
- [ ] 保留 resource key、并发约束、取消与执行中断。

### 9.2 权限

- [ ] 迁移 permission contract、decision engine、workspace mode、rule store 和 audit log。
- [ ] 迁移 Bash/PowerShell parser、nested expansion、path impact、command policies 和 critical guard。
- [ ] 完整移植危险命令 corpus、绝对红线、模型审批偏好和 allowed scope 测试。
- [ ] 授权后重验输入/资源身份；MCP/Hook/模型不能绕过 runtime policy。
- [ ] 接通 UI 审批请求/响应和 AskUserQuestion 请求/响应，取消或 UI 消失时默认拒绝。

**Phase 5 出口：** Read/Write/Edit/Shell/Web/Task 等工具通过运行时闭环；权限决策矩阵和危险命令语料达到 100% 预期结果；未分类或解析失败操作默认安全。

## 10. Phase 6：Agent、子 Agent 与并行执行

- [ ] 迁移主 Agent 状态机、provider loop、tool result protocol、重试和停滞保护。
- [ ] 迁移 runtime registry、status、steer、stop、resume 和 session coordination。
- [ ] 迁移子 Agent 定义、model resolver、生命周期、邮箱、父子取消、等待和恢复。
- [ ] 迁移 Task/Plan/resume state 及与 session 的持久化一致性。
- [ ] 迁移 parallel orchestrator、wave、worktree isolation、execution controller、接管、停止和产物状态。
- [ ] 使用确定性 fake clock/provider/tool runner 对并发状态机做性质测试和故障测试。
- [ ] 验证应用崩溃后不会自动重放副作用，丢失执行器能恢复为明确非运行态。

**Phase 6 出口：** 主 Agent、子 Agent、并行任务从输入到最终结果形成完整闭环；等待、取消、失败、恢复和重启用例全部通过。

## 11. Phase 7：MCP、Skills、Rules 与外部能力

### 11.1 MCP

- [ ] 迁移配置合并、校验、项目信任、secret expression 和 managed/dynamic scope。
- [ ] 实现 stdio、Streamable HTTP、SSE、握手超时、重连、session recovery 与状态事件。
- [ ] 实现 tools/resources/prompts、content normalization、resource subscription 和日志。
- [ ] 实现 OAuth、安全外链/回调、Token 存储、过期授权和 logout。
- [ ] 实现 sampling/elicitation reverse request policy 与请求防护。
- [ ] 将现有真实 MCP fixture server 测试迁移为 Rust 集成测试或跨进程测试。

### 11.2 扩展

- [ ] 迁移 builtin/external/workspace Skills 的发现、导入、切换、删除和 session lifecycle。
- [ ] 迁移 Rules、Memory、Prompt Prediction、系统通知和内置资源定位。
- [ ] 对外部配置和 Markdown front matter 保持兼容。

**Phase 7 出口：** 本地 stdio 与真实 HTTP MCP 集成测试通过；OAuth、信任和反向请求安全用例通过；Skills/Rules/Memory 的现有用户流程可用。

## 12. Phase 8：React 切换与全链路验收

### 12.1 前端迁移

- [ ] 将 preload 中的 API 迁入 `desktopApi`，使用生成类型和稳定错误码。
- [ ] 一次性把 stores/components 从 `window.api` 切换到 adapter。
- [ ] 将 Chat 多回调 API 改为单一 typed event stream，集中分发到 Zustand slices。
- [ ] 将 Terminal、MCP、Theme 等订阅改为显式 dispose，补组件卸载测试。
- [ ] 保持现有 UI 与文案，仅处理 Tauri WebView/平台差异。
- [ ] 删除前端对 Electron 类型、IPC channel 字符串和 preload global declaration 的依赖。

### 12.2 E2E 场景

- [ ] 首次启动与旧数据迁移。
- [ ] 打开中文路径项目、文件树、搜索、预览和编辑回滚。
- [ ] 配置 Provider、三类协议流式聊天、停止、重试、会话恢复。
- [ ] 工具审批、绝对红线拒绝、Shell 输出和中断。
- [ ] PTY 输入/resize/退出与多终端清理。
- [ ] 子 Agent、并行任务、worktree、暂停/恢复和应用重启。
- [ ] MCP stdio/HTTP/OAuth、项目信任、资源/Prompt/Tool。
- [ ] 主题、窗口、外链、全局快捷键、单实例和退出清理。

**Phase 8 出口：** 所有核心用户流程只经 Tauri/Rust 完成；前端没有 Electron bridge 调用；FR/NFR 追踪矩阵无阻断缺口。

## 13. Phase 9：完整迁移验收与删除批准

### 13.1 发布工程

- [ ] 配置 Tauri Windows installer、macOS bundle/DMG、Linux bundle，并确认架构矩阵。
- [ ] 配置签名、公证、升级 feed/策略和 SBOM/依赖审计。
- [ ] 验证安装、覆盖升级、降级/回退、应用数据路径和卸载不误删用户项目。
- [ ] 在干净虚拟机/真实机器验证 builtin resources、`rg`、PTY、MCP stdio 和系统密钥环。
- [ ] 输出性能、包体积、依赖、安全和兼容性对比报告。

### 13.2 迁移完成门禁

- [ ] FR/NFR 追踪矩阵无未迁移或无证据项；每个旧模块标记为 `ported/replaced/retained/approved-obsolete`。
- [ ] 所有有效 Electron 测试均已由 Rust、契约、前端或 E2E 测试承接并通过。
- [ ] 旧数据发现、备份、迁移、重复执行、部分失败恢复和损坏隔离在真实脱敏副本上通过。
- [ ] Provider、MCP 和 OAuth 密钥已安全迁移或明确进入 `requires_reentry`，不存在明文/Base64 降级。
- [ ] 权限红线、路径逃逸、编辑回滚、MCP trust、进程树和日志脱敏安全测试通过。
- [ ] 目标平台功能、性能、安装、覆盖升级、卸载、签名和资源定位通过。
- [ ] 从 Electron 稳定版升级到 Tauri 候选版，以及回退到 Electron 稳定安装包的演练通过。
- [ ] Electron 源码、测试、配置和依赖仍完整保留，且存在删除前恢复 tag/分支及安装包归档。
- [ ] 用户或指定负责人书面确认允许进入 Phase 10；没有确认时不得删除。

### 13.3 发布与回退准备

- [ ] 发布前备份/迁移机制已在真实旧数据副本上演练。
- [ ] 保留上一 Electron 稳定安装包作为发布级回退，不在应用内保留 Electron runtime。
- [ ] Tauri 首个稳定版不自动删除旧 Electron 数据。
- [ ] 若发生阻断，回退安装包不得读取或覆盖未确认兼容的新 schema；依靠迁移备份恢复。

**Phase 9 出口：** Tauri 安装包通过完整迁移、安全和目标平台验收；回退演练成功；Electron 基线仍完整可恢复；已获得明确的 Electron 删除批准。

## 14. Phase 10：Electron 独立清理与复验

### 14.1 删除原则

- [ ] Phase 10 使用独立分支、PR 或提交，不夹带新的 Rust 功能、UI 改版或数据格式调整。
- [ ] 删除前再次确认恢复 tag/分支、Electron 稳定安装包、旧数据备份和迁移报告可用。
- [ ] 按删除清单逐项处理，发现未迁移引用或测试缺口时立即停止清理并返回对应 Phase 修复。

### 14.2 删除清单

- [ ] 删除 `src/main` 中已被 Rust 完整替代的 Electron/Node 实现和 `src/preload`。
- [ ] 删除 `electron.vite.config*`、Electron Builder 配置、Electron scripts 和过时输出目录约定。
- [ ] 删除 `electron`、`electron-vite`、`electron-builder`、`@electron-toolkit/*`、`electron-log`、`node-pty` 等已替代依赖。
- [ ] 删除已无消费者的 Electron IPC shared channels、preload global types 和 mocks。
- [ ] 仅在等价测试已通过并有追踪证据时，删除 Electron-only/legacy 测试；仍有效的前端测试必须保留。
- [ ] 清理 Electron 专用资源定位、打包资源、日志入口、环境变量和生成输出引用。
- [ ] 确认 `rg -n "electron|ipcRenderer|ipcMain|contextBridge|window\.api"` 只命中文档、迁移记录或经批准保留的历史材料。
- [ ] 更新 README、开发环境、构建、测试、调试、数据迁移和发布文档。

### 14.3 删除后复验

- [ ] 从全新 checkout 安装依赖，执行 Rust fmt/clippy/test、前端 typecheck/test、契约测试和全部 E2E。
- [ ] 为所有目标平台重新构建、安装并运行 smoke test。
- [ ] 再次执行旧数据迁移、密钥状态、中文路径、PTY、Shell、Git/worktree、Agent、Tool、Permission 和 MCP 核心流程。
- [ ] 确认 npm/Cargo 依赖树、安装包、许可证与 SBOM 不再包含 Electron/Node 主进程组件。
- [ ] 确认源码清理未删除旧用户数据，也未改变迁移和发布级回退所需的归档。

**Phase 10 出口：** Electron 代码、配置、依赖和专用测试已按证据安全删除；删除后完整测试与目标平台发布构建再次通过；最终 Tauri 发布候选可交付。

## 15. 测试迁移策略

| 当前测试类型 | 目标 |
| --- | --- |
| 纯算法、状态机、权限矩阵 | 转为 Rust unit/property tests |
| 文件、编辑、持久化、进程 | Rust integration tests + 临时目录/真实子进程 |
| Provider/MCP 协议 | 脱敏 golden fixtures + 本地测试 server |
| preload/IPC | typed contract tests + Tauri adapter integration tests |
| React store/组件 | 保留 Vitest，mock `desktopApi` 而不是 Electron |
| Electron 窗口行为 | Tauri desktop smoke/E2E |
| Legacy V1/V2 对照 | 提取 canonical fixtures；Rust V2 稳定后删除 Electron-only 对照 |

测试数量不要求机械保持 1,165，但每个仍有效的行为断言必须有明确去向，尤其不能丢失权限、编辑事务、MCP 和恢复测试。

每个 Phase 的最小 CI：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
npm.cmd run typecheck
npm.cmd test -- --run
npm.cmd run tauri build -- --debug
```

实际脚本名在 Phase 1 固化；平台 E2E 不应全部塞进每次本地快速测试。

## 16. 工作量估算

在 D-01 保留 React、初期保持 JSON、现有功能不删减的前提下，单名熟悉当前代码和 Rust 的高级工程师粗估为 **14-22 人周**：

| 工作流 | 粗估 |
| --- | ---: |
| Phase 0-1 决策、spike、基座 | 2-3 人周 |
| Phase 2-3 数据、平台、Workspace/PTY | 3-5 人周 |
| Phase 4 Provider/Context | 2-3 人周 |
| Phase 5 Tool/Permission | 2.5-4 人周 |
| Phase 6 Agent/Parallel | 2.5-4 人周 |
| Phase 7 MCP/扩展 | 2-4 人周 |
| Phase 8-10 集成、跨平台、验收与清理 | 2-3 人周 |

这不是排期承诺。safeStorage、MCP Rust SDK、PTY 与三平台发布的 spike 结果可能显著改变估算。多人并行可以缩短日历时间，但 Agent/Tool/Permission/Context 的接口耦合使其不能按人数线性压缩。

## 17. 实施顺序与提交策略

- 每个 Phase 使用小步提交，提交必须对应一个可测试行为或基础设施能力。
- 先提交 fixtures/失败测试，再提交 Rust 实现和 adapter；不要在同一提交混入 UI 重构。
- 迁移期间不继续向 Electron main 增加新功能；阻断性缺陷只做最小修复，并同步更新 Rust 测试基线。
- 不建立 Electron/Tauri 双写或运行时 feature flag；测试对照依靠 fixtures 和独立基线记录。
- Phase 0-9 禁止删除 Electron 源码、配置、依赖和仍有效测试；Electron 删除只允许在获得明确批准后的 Phase 10 独立完成。
- 任何删除中发现的缺口都应停止清理并回到对应迁移 Phase 修复，不能用删除旧能力来缩小验收范围。

## 18. Definition of Done

- [ ] 需求文档的 D-01 至 D-08 已决策并记录。
- [ ] FR/NFR 追踪矩阵完成，所有阻断项关闭。
- [ ] Rust workspace、Tauri app、React adapter 和生成类型形成稳定边界。
- [ ] 旧数据迁移幂等、非破坏，密钥无不安全降级。
- [ ] Provider、Chat、Context、Tool、Permission、Agent、MCP、PTY 和 Workspace 全部通过目标验收。
- [ ] Rust/前端/契约/E2E/跨平台发布测试通过。
- [ ] 性能与包体积报告完成，退化已有批准或修复。
- [ ] 安装升级与发布级回退演练通过。
- [ ] Electron 删除前的追踪矩阵、恢复 tag/分支、稳定安装包归档和人工批准记录完整。
- [ ] Electron/Node 主进程代码、依赖、脚本和发布资源仅在上述门禁通过后由独立 Phase 10 移除。
- [ ] Electron 删除后完整测试、目标平台构建、安装 smoke 和数据迁移复验通过。
- [ ] README、开发、测试、调试、数据迁移和发布文档更新完成。
- [ ] crate/模块依赖、前端 feature 边界、command adapter 和 repository/port 边界符合架构设计，例外均有 ADR。
