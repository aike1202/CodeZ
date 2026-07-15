# CodeZ Tauri + Rust 重构需求分析

> 状态：Draft，待关键决策确认后冻结
>
> 日期：2026-07-15
>
> 架构设计：`docs/superpowers/specs/2026-07-15-tauri-rust-architecture-design.md`
>
> 关联计划：`docs/superpowers/plans/2026-07-15-tauri-rust-refactor.md`

## 1. 决策摘要

CodeZ 停止继续扩展 Electron 版本，桌面容器最终直接替换为 Tauri，Electron 不作为长期兼容运行时，也不设计 Electron/Tauri 双启动、运行时切换或双版本数据同步。迁移实施期间必须保留 Electron 源码、测试、构建配置和可用基线，直到 Tauri 功能、数据、安全、测试、安装升级与回退全部验收通过后，才在独立清理阶段删除；源码暂时保留不等于最终产品支持双运行时。

本分析采用以下默认解释：

- 保留现有 React + TypeScript + Vite 渲染层及用户界面。
- 将 Electron `main`、`preload` 以及其中承载的业务运行时重构到 Rust。
- Tauri 只承担桌面宿主和前后端边界；Agent Runtime、工具系统、权限、MCP、持久化、进程与文件操作等核心后端能力由 Rust 模块实现，而不是继续放在前端 TypeScript 中。
- 迁移完成门禁通过前，不提前删除 Electron 代码、测试、配置和依赖；最终发布物只包含 Tauri 应用，不包含 Electron、`electron-vite`、`electron-builder` 或 Node.js 主进程。

如果“改用 Rust”还包括把 React UI 改为 Rust/WASM UI，则属于另一项规模显著更大的产品决策，不包含在本文默认范围内。

## 2. 现状基线

### 2.1 技术与规模

当前项目为 Electron 31 + React 18 + TypeScript 5 + Vite 5：

| 区域 | 文件数 | 约代码行数 | 职责 |
| --- | ---: | ---: | --- |
| `src/main` | 229 | 32,326 | Electron 生命周期、IPC、Agent、工具、权限、MCP、数据与平台服务 |
| `src/preload` | 1 | 526 | `window.api` 请求/响应与流事件桥接 |
| `src/renderer` | 204 | 19,599 | React UI、Zustand 状态与交互 |
| `src/shared` | 24 | 2,050 | IPC、领域类型与共享常量 |
| `src/tests` | 183 | 20,348 | Node/Vitest 单元和集成测试 |

2026-07-15 的迁移前基线：

- `npm.cmd run typecheck`：通过。
- `npm.cmd test -- --run`：183 个测试文件、1,165 个测试全部通过。
- 当前安装目标声明为 Windows NSIS、macOS DMG、Linux AppImage。

这组结果是重构的行为基准，不代表测试可原样复用；涉及 Electron/Node 的测试需要转写为 Rust 测试或跨边界契约测试。

### 2.2 当前能力边界

1. 桌面宿主：单实例、无边框窗口、窗口控制、主题、外链、全局快捷键、应用退出清理、日志和打包资源。
2. Workspace：目录选择、文件树、受限文件读取、项目识别、最近项目、编辑器/资源管理器打开、Git 与 worktree。
3. 模型与聊天：OpenAI/Anthropic/Gemini 协议、流式响应、推理内容、工具调用、重试、上下文预算、压缩与会话恢复。
4. Agent Runtime：主 Agent、子 Agent、并行执行、邮箱通信、任务、计划、执行控制、等待/恢复与崩溃恢复。
5. 工具运行时：工具注册、Schema 验证、暴露策略、调度、日志、大结果存储、读写/编辑/Notebook、搜索、Shell 与回滚。
6. 权限：工作区模式、命令解析、路径影响、绝对红线、审批、规则、审计与模型选择的审批偏好。
7. MCP：stdio、HTTP、SSE、OAuth、资源/Prompt/Tool、反向请求、项目信任、密钥表达式和连接恢复。
8. 本地能力：PTY 终端、子进程、ripgrep、tree-sitter Bash/PowerShell、附件、系统通知、Skills、Rules、Memory。

### 2.3 Electron/Node 替换面

| 当前依赖/机制 | 当前用途 | Rust/Tauri 目标能力 | 风险 |
| --- | --- | --- | --- |
| `BrowserWindow`、`app` | 窗口和生命周期 | Tauri Window/AppHandle 与插件 | 中 |
| `ipcMain`、`ipcRenderer`、`contextBridge` | 请求、回调和流事件 | typed commands + channel/event | 高 |
| Node `fs/path/os` | 工作区与应用数据 | `std::fs`/`tokio::fs`、`PathBuf` | 高 |
| `child_process` | Shell、Git、MCP stdio、编辑器 | `tokio::process` 与受控进程管理器 | 高 |
| `node-pty` | 交互终端 | 跨平台 PTY crate/平台实现 | 高 |
| Electron `safeStorage` | Provider 与 MCP 密钥 | OS credential store/平台加密 | 极高 |
| `@modelcontextprotocol/sdk` | MCP 客户端 | Rust MCP SDK 或受控协议实现 | 极高 |
| `@vscode/ripgrep` | 文件/内容检索 | 随包分发 `rg` 或 Rust 搜索实现 | 中 |
| `web-tree-sitter` | Shell 权限分析 | Rust tree-sitter crates | 高 |
| `electron-log` | 主进程日志 | `tracing` 与滚动文件输出 | 低 |
| Electron Builder 资源 | 安装包和 WASM/Skills | Tauri bundle/resources | 中 |

## 3. 重构目标

### 3.1 业务目标

- 用户可从 Electron 版本迁移到 Tauri 版本，继续访问原有项目、会话、配置和非敏感运行时数据。
- 现有核心工作流在 Tauri 中保持可用，不以重构为由移除 Agent、工具、权限、MCP 或终端能力。
- 重构后以 Rust 后端为唯一桌面运行时，后续桌面能力优先在 Rust 中演进。
- 保持现有产品界面和交互习惯，重构阶段不同时进行大规模 UI 改版。

### 3.2 工程目标

- 消除 Electron 主进程、preload 和 Node 原生模块打包链路。
- 建立明确的 Rust 领域层、应用层和平台适配层，避免把全部逻辑堆入 Tauri command。
- 借迁移机会整理工程目录、模块职责、依赖方向和测试边界，消除当前 main/service/tool/IPC 之间的隐式耦合。
- 前后端契约可生成、可校验、可版本化，所有长任务均可取消、可观测并能安全退出。
- 将 1,165 个既有测试表达的有效行为逐步转化为 Rust 单元/集成测试、契约测试或端到端测试。
- 构建和发布可在声明支持的平台上复现，并能够验证资源、PTY、MCP 子进程和升级迁移。

## 4. 范围

### 4.1 本次包含

- Tauri v2 应用宿主与打包配置。
- Electron main/preload 能力的 Rust 重构。
- React 渲染层接入 Tauri command/channel/event。
- Agent Runtime、工具执行、权限、上下文、MCP 与平台服务的 Rust 实现。
- 原有应用数据发现、备份、迁移和版本管理。
- Windows、macOS、Linux 的构建与核心能力验证；实施优先级需在开工前确认。
- Rust 测试、前端契约测试、桌面端到端测试和发布检查。
- 迁移验收期间保留并冻结 Electron 基线，只允许阻断性缺陷的最小修复。
- 通过迁移完成门禁并人工确认后，以独立阶段清理 Electron 依赖、入口、构建产物与专用代码。

### 4.2 本次不包含

- Electron/Tauri 双运行时切换、灰度路由或长期共存。
- 将 React UI 重写为 Rust/WASM UI。
- 与迁移无关的视觉重设计或新增产品功能。
- 在同一阶段将全部 JSON 持久化改为数据库；先兼容原格式，再另行评估存储升级。
- 云同步、账号体系、远程遥测等新基础设施。
- 自动删除旧 Electron 用户数据；确认迁移成功前必须保留可恢复副本。

## 5. 功能需求

以下编号作为实现计划、测试和验收的追踪标识。

### FR-APP 桌面宿主

- **FR-APP-01** 应用应保持单实例；第二次启动应唤起并聚焦已有窗口。
- **FR-APP-02** 应保留当前无边框窗口、最小尺寸、最小化/最大化/关闭和最大化状态同步。
- **FR-APP-03** 应支持系统/浅色/深色主题，并向前端同步系统主题变化。
- **FR-APP-04** 外部 URL 必须由系统浏览器打开，WebView 不得直接导航到不受信任页面。
- **FR-APP-05** 应保留全局显示/隐藏快捷键，并在应用退出时注销。
- **FR-APP-06** 退出顺序必须停止聊天流、Agent、工具进程、PTY 和 MCP，再完成持久化。

### FR-WS Workspace 与文件操作

- **FR-WS-01** 支持目录选择、最近项目 CRUD、项目类型识别和文件树扫描。
- **FR-WS-02** 所有受工作区约束的文件操作必须经过规范化、边界校验和符号链接防逃逸检查。
- **FR-WS-03** 保留文件预览、编辑器/资源管理器打开、Git 上下文和 worktree 管理。
- **FR-WS-04** 搜索需保持忽略规则、结果限制、取消、超时和跨平台路径语义。

### FR-DATA 本地数据与密钥

- **FR-DATA-01** 兼容并迁移现有 `providers.json`、`sessions.json`、`settings.json`、最近项目、权限、MCP、附件、上下文、执行日志和编辑备份。
- **FR-DATA-02** 每类持久化数据必须有显式 `schemaVersion` 或等价迁移版本，不再依赖隐式结构猜测。
- **FR-DATA-03** 写入必须采用临时文件、刷新和原子替换策略；并发写入必须串行化或事务化。
- **FR-DATA-04** 首次迁移必须先建立清单和备份，迁移应幂等；失败时不得损坏旧数据。
- **FR-DATA-05** Provider API Key、MCP 密钥与 OAuth 凭据不得因迁移降级为明文或 Base64 存储。
- **FR-DATA-06** 无法解密旧 `safeStorage` 数据时，应用必须明确标记需重新录入，不得静默丢失或伪造成功。

### FR-PROVIDER 模型 Provider

- **FR-PROVIDER-01** 保留 Provider/模型 CRUD、激活 Provider、连接测试、思考参数和上下文/输出上限。
- **FR-PROVIDER-02** 保留 OpenAI Chat Completions、Anthropic Messages、Gemini 流式协议的消息、工具、图片、Usage 和错误归一化行为。
- **FR-PROVIDER-03** HTTP 客户端必须支持取消、连接/读取超时、流式背压、代理/证书错误提示和敏感字段脱敏。
- **FR-PROVIDER-04** 重试仅适用于可安全重试的请求；不得重复执行已经开始产生副作用的工具调用。

### FR-CHAT Chat、上下文与会话

- **FR-CHAT-01** 保留聊天增量、推理增量、结束原因、Usage、错误、停止和 steer 输入。
- **FR-CHAT-02** 保留 canonical ledger、上下文预算、压缩、文件/Skill 恢复、断点恢复与崩溃恢复。
- **FR-CHAT-03** 每个流必须使用稳定 `streamId`；事件必须带序号或满足可证明的有序单通道语义，终止后不得继续更新 UI。
- **FR-CHAT-04** 会话删除、软删除保留期、任务/Agent 运行时状态和历史回退行为保持兼容。
- **FR-CHAT-05** 应用重启后不得把已完成任务错误恢复为运行中，也不得把未完成副作用自动重放。

### FR-TOOL 工具运行时与编辑事务

- **FR-TOOL-01** 保留工具注册、Schema 验证、延迟暴露、调用组装、调度、Hook、执行日志和大结果裁剪/存储。
- **FR-TOOL-02** 保留 Read/List/Glob/Grep、Write/Edit/Notebook、Shell、Web、Task、Agent、MCP、通知和回滚等现有工具行为。
- **FR-TOOL-03** 所有副作用工具必须在执行前完成参数验证、影响规划和授权；执行器只能接收去除运行时控制字段后的业务参数。
- **FR-TOOL-04** 编辑事务必须保留指纹校验、备份、逐文件接受/拒绝、冲突检测和安全回滚。
- **FR-TOOL-05** 进程执行必须支持 stdout/stderr 增量、输出上限、超时、取消、进程树终止和退出状态归一化。
- **FR-TOOL-06** 工具并发必须服从资源键与调度规则，不能并发修改同一资源或绕过权限。

### FR-PERM 权限系统

- **FR-PERM-01** 保留 `auto | full-access` 工作区模式和现有模型审批偏好决策矩阵。
- **FR-PERM-02** 绝对红线、显式拒绝和工作区边界不得被模型输出、MCP 注解、Hook 或持久化 allow 规则绕过。
- **FR-PERM-03** Bash、PowerShell 与嵌套命令分析必须保持命令分类、路径影响、动态执行降级和解析失败默认安全。
- **FR-PERM-04** 审批请求应支持 once/session/project 等既有允许范围，并记录审批来源和审计日志。
- **FR-PERM-05** 授权后、执行前必须对输入快照或关键资源再次校验，防止审批与执行之间被替换。

### FR-AGENT Agent 与并行执行

- **FR-AGENT-01** 保留主 Agent 状态机、无固定轮次上限但有停滞保护的执行语义。
- **FR-AGENT-02** 保留子 Agent 生命周期、父子关系、消息邮箱、等待、恢复、终止传播和结果协议。
- **FR-AGENT-03** 保留并行 wave、执行器控制、worktree 隔离、接管、重试与产物状态。
- **FR-AGENT-04** Task、Plan 和 resume state 必须与 Agent 执行状态一致，重启后可恢复且不产生幽灵运行状态。
- **FR-AGENT-05** 所有运行任务必须归属于可取消作用域；父任务取消应按既定策略传播到子任务和子进程。

### FR-MCP MCP

- **FR-MCP-01** 保留 stdio、Streamable HTTP 与 SSE 配置、发现、调用、重连和状态通知。
- **FR-MCP-02** 保留 Tool、Resource、Prompt、日志、资源订阅及受策略控制的反向 Sampling/Elicitation。
- **FR-MCP-03** 保留用户/项目/本地/动态/托管配置优先级、项目指纹信任和敏感表达式解析。
- **FR-MCP-04** 保留 OAuth 授权、登出、过期恢复和安全回调；Token 必须存入系统安全存储。
- **FR-MCP-05** MCP 子进程必须有握手超时、stderr 上限、进程树回收和退出原因记录。

### FR-TERM 终端、附件与扩展

- **FR-TERM-01** PTY 支持启动、输入、尺寸调整、输出、退出和关闭；中文与 UTF-8 输出不能回退到 ANSI 默认编码。
- **FR-TERM-02** Skills、Rules、Memory、系统通知、附件导入/预览/清理保持可用。
- **FR-TERM-03** 内置 Skills、解析器或搜索二进制等随包资源必须能在开发与安装环境中可靠定位。

### FR-MIG 迁移保留与 Electron 删除门禁

- **FR-MIG-01** 从迁移开始到迁移完成门禁通过，Electron 源码、preload、构建配置、依赖、有效测试和稳定安装包必须保留，不得因某个模块已移植而提前删除。
- **FR-MIG-02** Electron 基线停止新增产品功能；确需修复阻断性缺陷时只做最小改动，并同步更新 Tauri/Rust 的行为基线与测试。
- **FR-MIG-03** 每个 Electron 模块、IPC 和测试必须在迁移追踪矩阵中标记为 `ported`、`replaced`、`retained` 或经批准的 `obsolete`，且附对应代码/测试证据。
- **FR-MIG-04** 只有功能、数据、密钥、安全、性能、跨平台构建、安装升级、回退演练和测试全部通过后，才能批准 Electron 删除阶段。
- **FR-MIG-05** Electron 删除必须使用独立提交或独立 PR；删除前建立可恢复 tag/分支和安装包归档，删除后重新运行完整测试与发布构建。
- **FR-MIG-06** 不得删除仍承载有效行为断言的 Electron 测试；只有等价 Rust、契约、前端或 E2E 测试已通过后才能删除原测试。

## 6. 非功能需求

### NFR-SEC 安全

- Tauri capabilities/permissions 采用最小权限，前端不能获得任意 Shell、文件系统或进程权限。
- 高权限操作只通过窄化、校验后的 Rust command 暴露；不提供通用 `execute(command)` 给 UI。
- WebView CSP 禁止不必要的远程脚本、`eval` 和任意导航；远程内容以数据处理，不作为应用页面执行。
- 日志、错误、事件、崩溃信息不得包含 API Key、OAuth Token、MCP 密钥或完整 Authorization Header。
- 所有外部路径、URL、命令、MCP 配置和模型返回的工具参数均视为不可信输入。

### NFR-REL 可靠性

- 长任务应支持取消和确定性收尾；退出清理设置总超时，不能无限阻塞应用关闭。
- 后端错误使用稳定错误码、用户可读消息和仅用于诊断的上下文，不向前端泄露敏感内部信息。
- 持久化和事件处理不得因单个会话失败导致其他会话状态损坏。
- 新版本应能检测并隔离损坏的数据文件，保留原件并给出恢复路径。

### NFR-PERF 性能

- 在 Phase 0 记录 Electron 的冷启动、空闲内存、首屏、文件树、搜索、首 Token、PTY 吞吐和安装包体积基线。
- Tauri 候选版在典型项目上的关键交互 P95 不得比基线退化超过 10%，除非有书面例外。
- 聊天和终端流采用有界上游队列、最大 4 KiB delta frame、累计 ACK 窗口和显式 cancel；Tauri Channel 只作为 wire transport，持续输出不能导致 WebView 内存无界增长，见 ADR 0005。
- 大文件、搜索结果、工具输出和 MCP 内容继续执行既有大小限制。

Phase 0 Windows x64 证据记录在 `docs/migration/generated/performance-baseline.win32-x64.json`：3 次隔离 Electron 启动中位数为 `ready-to-show 597.71 ms`、首个 animation frame `661.66 ms`，4 个进程合计工作集 `444,391,424 bytes`；当前 NSIS 安装包 `94,487,081 bytes`。文件树、搜索、无网络合成首 Token 和 PTY 吞吐使用同一文件中的明确方法口径，Phase 9 必须用相同探针比较 Tauri release 构建。

### NFR-PORT 跨平台

- 路径比较、大小写、符号链接、Shell、PTY、进程树、系统密钥环、全局快捷键和安装升级必须按平台测试。
- Windows 中文路径与 PowerShell UTF-8 是必须通过的发布用例。
- 若选择 Windows 优先，macOS/Linux 未通过验收前不得宣称已完成对应平台迁移。

### NFR-TEST 测试与可追踪性

- 每项 FR/NFR 至少关联一种自动化或明确的人工验收。
- Rust 核心逻辑以单元/性质测试覆盖；文件、进程、网络、MCP 与持久化以集成测试覆盖；关键用户流程以桌面 E2E 覆盖。
- 危险命令语料、Provider 协议样例、工具 Schema 和旧数据样例应转成不依赖 Electron 的 golden fixtures。
- 所有平台的发布构建必须从干净环境产生，安装后执行资源和数据迁移 smoke test。

Phase 0 的兼容证据入口为 `src/tests/fixtures/migration/`、`docs/migration/generated/desktop-api-semantics.json`、`persistence-inventory.json`、`test-migration.csv` 和 `traceability.csv`。生成器必须保持 0 个未复核测试分类和 0 条缺失阶段、owner、测试或平台的追踪行。

### NFR-MAINT 可维护性

- Tauri command 只做鉴权、反序列化、调用应用服务和错误映射，不包含领域流程。
- 领域模块不直接依赖 Tauri Window/AppHandle；通过 trait 注入事件、路径、凭据、进程等平台能力。
- Rust 类型是后端契约源，TypeScript 类型通过生成或机器校验保持一致，禁止长期手工复制两套结构。
- 异步共享状态必须有明确所有权；禁止跨 `await` 持有粗粒度全局锁。

## 7. 目标架构摘要

完整模块边界、依赖规则、状态与并发模型、前端组织、数据架构和工程规范见架构设计文档。本节只保留需求层面的架构结论。

```text
React + Zustand + xterm.js
        |
        | typed invoke / channel / event
        v
Tauri command/event adapters
        |
        v
Rust application services
        |
        +-- Agent / Chat / Context
        +-- Tool Runtime / Permission
        +-- Workspace / Edit / Git / PTY
        +-- MCP / Provider clients
        +-- Persistence / Secrets / Logs
        |
        v
OS filesystem, processes, credential store, network
```

建议使用 Cargo workspace，按真实边界组织而不是按 Electron 文件逐个翻译：

- `src-tauri`：Tauri 入口、窗口生命周期、command/event adapter、插件注册和打包。
- `crates/codez-contracts`：前后端 wire DTO、事件、错误码及 TypeScript 类型生成入口。
- `crates/codez-core`：纯领域类型、错误、权限决策、任务/计划状态机和无平台算法。
- `crates/codez-runtime`：Agent、Chat、Context、Tool Runtime、调度、取消和执行日志。
- `crates/codez-platform`：文件系统、进程、PTY、Git、搜索、通知、系统主题和资源定位。
- `crates/codez-providers`：OpenAI/Anthropic/Gemini 协议和流解析。
- `crates/codez-mcp`：MCP 配置、传输、OAuth、资源/工具/Prompt 与安全策略。
- `crates/codez-storage`：应用目录、原子文件、Schema migration、凭据和旧数据导入。

初期可以减少 crate 数量，但必须保持上述模块依赖方向；`core` 不依赖 Tauri，平台实现依赖 core trait，Tauri 入口位于最外层。

### 7.1 前后端通信

- 短请求：Tauri `command`，统一 `{ ok, data }`/稳定错误结构或等价 typed result。
- 高频流：使用 Tauri channel + 应用级累计 ACK/cancel；聊天、子 Agent、工具和终端事件不得为每种回调动态注册 command，也不得把 Channel 成功返回视为前端已消费。
- 全局低频状态：主题、MCP 状态等使用 event。
- 每个订阅返回可释放句柄；会话切换、组件卸载和流结束必须解除订阅。
- 前端新增单一 `desktopApi` adapter，组件与 store 不直接散布 `invoke()` 字符串。

### 7.2 Rust 技术候选

具体版本在技术验证后锁定，候选包括：

- 异步与取消：`tokio`、`tokio-util::CancellationToken`。
- 序列化与错误：`serde`、`serde_json`、`thiserror`。
- HTTP/流：`reqwest` 与经过验证的 SSE/字节流解析。
- 日志：`tracing`、`tracing-subscriber`、滚动文件 appender。
- Schema：`schemars` + 支持所需 Draft 的 JSON Schema validator。
- 文件检索：`ignore`/`globset`/`regex`，或继续以资源方式分发 `rg`。
- Shell 解析：固定 `tree-sitter 0.25.10`、Bash grammar `0.25.0` 和 PowerShell grammar `0.25.10` 作为迁移起点；必须移植现有等长 masks、原生 PowerShell AST fallback 和失败安全语义，见 ADR 0004。
- PTY：固定 `portable-pty 0.9.0` 作为 PTY 原语；Windows ConPTY 已通过中文、resize、Ctrl+C、kill tree 与退出清理验证，进程树和有界输出由 CodeZ adapter 负责，见 ADR 0003。
- 密钥：系统 credential store 或平台 API；旧 Electron 密文需要单独兼容探针。
- MCP：优先评估成熟 Rust SDK；若能力不完整，以协议兼容和测试覆盖为选择标准，不能只比较 API 表面。

## 8. 数据迁移要求

### 8.1 已识别数据

应用数据目录中至少包括：

- `providers.json`、`sessions.json`、`settings.json`、`recent-projects.json`
- `workspace-permissions.json`、`permission-rules.json`、`permission-audit.jsonl`
- `mcp.json`、`mcp-project-trust.json`、`mcp-secrets.secure`、`mcp-oauth.secure`、`mcp-content-v2/`
- `attachments/`、`edit-backups/`、`tool-execution-journal.jsonl`
- context runtime、large tool results、execution state、project snapshots、IDE icon cache和日志目录
- 用户目录与工作区中的 `.codez/`、`.codez-cache/`、`.mcp.json`、Rules、Skills 和 Memory 文件

实施前必须由脚本生成完整清单，不能只依赖本节手工列表。

### 8.2 迁移流程

1. 只读发现旧数据目录和版本，不扫描或打印密钥内容。
2. 校验文件类型、大小、权限和 JSON 结构，拒绝跟随危险符号链接。
3. 生成迁移清单与校验摘要，备份到带时间戳且权限受限的目录。
4. 迁移到版本化目标结构；每个步骤记录完成标记并可重复执行。
5. 验证记录数量、关键 ID、附件引用、会话 runtime 引用和密钥可用性。
6. 原子提交迁移完成标记；失败则继续使用未提交状态并提供重试/重新录入。
7. 不自动删除 Electron 数据；清理由后续独立功能或人工操作完成。

### 8.3 密钥迁移

- Windows 必须验证 Electron `safeStorage` 产物能否由 Rust 通过相同用户上下文解密。
- macOS/Linux 必须分别验证 Chromium safe storage 的格式与系统依赖，不能根据 Windows 结果推断。
- 若某平台无法安全兼容，保留非敏感 Provider/MCP 配置，将密钥标记为 `requires_reentry`。
- 禁止用明文、Base64 或日志输出作为迁移兜底。

## 9. 验收标准

只有同时满足以下条件，才可批准进入 Electron 删除阶段；删除完成并再次通过同一组验证后，才可认定 Electron -> Tauri/Rust 重构完成：

1. 删除前，Electron 基线代码、测试、构建配置和稳定安装包仍可恢复；删除后，最终依赖和发布物不包含 Electron、Electron Builder、preload 或 Node 主进程。
2. React 全部主流程通过 typed Tauri API 工作，不再依赖 `window.api` Electron bridge，且追踪矩阵无未迁移调用。
3. FR-APP 至 FR-TERM 的核心行为完成自动化或人工验收，并有追踪矩阵。
4. 危险操作、路径逃逸、密钥、OAuth、MCP 信任、编辑回滚等安全测试通过。
5. 旧版非敏感数据迁移完整；密钥要么安全迁移，要么明确要求重新录入，且旧数据未被破坏。
6. Windows 中文路径、PTY、PowerShell、Git/worktree、ripgrep/搜索、MCP stdio 和安装升级通过。
7. 目标平台发布构建从干净环境通过；未验证的平台不标记为支持。
8. 冷启动、交互 P95、持续流内存和安装包体积已有对比报告，关键性能无未批准退化。
9. Rust 测试、前端类型检查/测试、契约测试和桌面 smoke/E2E 全部通过。
10. 删除门禁有明确验收记录；Electron 源码、配置、脚本、依赖、构建产物引用和过时文档随后在独立清理阶段完成删除。

## 10. 风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| 32k 行主进程逻辑逐行翻译造成语义漂移 | 极高 | 按领域重构；先提取 golden fixtures 和状态机测试；每阶段设行为门槛 |
| Electron `safeStorage` 无法跨实现解密 | 极高 | 开工最早阶段做三平台探针；不可兼容时安全要求重新录入 |
| Rust MCP SDK 能力不完整 | 极高 | 用现有 MCP 集成测试定义能力清单；SDK/自研方案通过 spike 决策 |
| 流事件乱序、丢终止事件或内存无界 | 高 | 单流有序 channel、序号、有限队列、取消与终态测试 |
| PTY/进程树跨平台差异 | 高 | Windows ConPTY 优先验证；平台集成测试和真实子进程回收测试 |
| 权限解析重写降低安全性 | 极高 | 移植危险命令语料和性质测试；未知/解析失败默认安全 |
| JSON 数据并发写和崩溃恢复差异 | 高 | 版本化 schema、原子写、单写者/事务、故障注入测试 |
| 一次切换缺少应用内回退 | 高 | 发布级回退到旧安装包；数据迁移非破坏、可重试、保留备份 |
| 过早删除 Electron 导致行为基线、测试或回退能力丢失 | 极高 | Electron 基线冻结保留；独立删除门禁、追踪矩阵、恢复 tag 和删除后全量验证 |
| Rust 重构同时改 UI/数据模型导致范围失控 | 高 | 冻结 UI 和外部行为；数据库/视觉重构另立项目 |

## 11. 开工前决策项

| ID | 决策 | 推荐默认值 | 影响 |
| --- | --- | --- | --- |
| D-01 | 是否保留 React + TypeScript UI | 保留 | 改为 Rust UI 会显著扩大范围且无法复用现有 19k 行渲染层 |
| D-02 | 首发平台顺序 | Windows x64 首验，随后 macOS/Linux | 当前开发环境和 Shell/编码风险集中在 Windows |
| D-03 | 是否继续使用 `com.codez.desktop` | 保留 | 影响安装升级、数据路径和系统权限 |
| D-04 | 初期持久化格式 | 保持 JSON/目录兼容 | 避免把框架迁移与数据库迁移耦合 |
| D-05 | Provider 密钥是否继续回传前端明文 | 建议改为仅替换、不回显 | 更安全，但需要小幅调整设置 UI 与契约 |
| D-06 | MCP Rust 实现策略 | `rmcp 2.2.0` 协议核心 + CodeZ 兼容/安全 adapters | spike 已验证 stdio、Streamable HTTP、OAuth、订阅和反向请求；legacy SSE 与严格 `-32001` 恢复由 CodeZ 补齐，见 ADR 0002 |
| D-07 | 搜索实现 | 保留 `@vscode/ripgrep` 平台包并映射到 `$RESOURCE/tools/rg(.exe)`，后评估纯 Rust | Windows x64 bundle 输入、固定路径和可执行性已验证，见 ADR 0006 |
| D-08 | Electron 旧数据保留期 | 至少跨一个稳定版本，默认不自动删 | 决定磁盘占用和回退窗口 |

这些决策未确认前可以进行只读盘点、契约提取和技术 spike，但不应开始大规模 Rust 业务迁移。
