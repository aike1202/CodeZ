# CodeZ 当前 Tauri/Rust 执行范围

> 更新：2026-07-17
>
> 本文覆盖较早计划中与当前产品决定冲突的数据迁移和 Electron 删除要求。

## 目标模式任务

持续完成 CodeZ 的 Tauri/Rust 重构，直到 Electron `main`/`preload` 承担的桌面后端行为均有经过测试的 Rust 等价实现，React/TypeScript renderer 只通过统一 desktop facade 使用 Tauri，且 Tauri 可独立构建、安装和运行。Tauri 只在全新的 `~/.codez` 中生成后续数据，不发现、不读取、不迁移 Electron 旧数据；Electron 工程和数据永久保留，不执行删除。MCP 暂停到 M1-M7 全部完成。按本文依赖顺序持续实施和验证；文件边界独立时合理使用子智能体，存在共享 runtime 文件或前置依赖时串行处理。不得覆盖现有用户/Gemini/MCP 脏改动，不得以编译通过代替行为等价与失败路径测试。

## 固定边界

- 目标仍是将 Electron `main`、`preload` 和桌面后端行为逐步迁移为 Rust/Tauri；React/TypeScript UI 保留。
- Tauri 运行时的全局数据根是 `~/.codez`。首次启动在此根创建新状态和日志；Provider/MCP 等新凭据只写入系统 credential store。
- 不读取、复制、转换、备份或删除 Electron `userData`、其密钥或已有的旧实验数据。旧 Electron 安装与数据保持不变。
- Electron 源码、测试、构建配置、依赖、安装包和行为基线无限期保留。没有 Phase 10，也不得以“迁移完成”为由删除它们。
- MCP 迁移暂停。除保持已有代码可编译外，不进行 MCP 功能、安全策略或 UI 改动，直到其他领域完成并明确恢复。
- Plan 功能不纳入 Tauri/Rust 迁移。这里明确包括产品 Plan、`ExecutionPlanner`/`Executor`、仅服务于 Plan 的 Parallel planning/execution 及其 typed events。Electron 中现有实现继续冻结保留；Tauri renderer 不新增对应 command/event，而是在 bridge 收口阶段移除或隔离 Plan UI、状态恢复和事件监听。通用 Agent/SubAgent 协作仍属于迁移目标，但不得借此重新引入 Plan 运行时。

## 执行顺序

1. 启动与数据根：Tauri 只构造 `~/.codez` 的 `AppState`，不注册旧迁移命令或恢复 UI。
2. 本地工作流：Workspace、文件、Git/worktree、编辑器、Terminal/PTY、附件和 Skills 逐项迁入 Tauri contract；每项关闭 renderer 的直接 Electron 调用。
3. 桌面宿主：窗口、主题、外链、通知、系统信息和全局快捷键转为 Tauri API。
4. 模型与会话：Provider、Keyring、Chat/Context、会话清理/撤回、流式 ACK 与 renderer bridge 完成功能等价。
5. 自动化能力：Tool、Permission、Agent、SubAgent、通用协作和 AskUserQuestion 与 Chat runtime 接通；不实现产品 Plan、`ExecutionPlanner`/`Executor` 或 Parallel Plan。
6. 验收：按功能域运行 Rust 单元/集成测试、TypeScript 类型检查、契约/adapter 测试、Tauri renderer 构建和桌面 smoke；Windows 原生命令 Ctrl+C 恢复 shell prompt 是发布阻断项。
7. MCP：仅在步骤 1-6 完成后，以独立计划恢复。

## 2026-07-17 当前完成状态

- 按发布门禁计算，M1-M4 已完成，M5、M6 部分完成，M7 正在积累 Windows 构建与原生行为证据但尚未达到发布门禁。Agent/SubAgent multi-turn tool loop 已完成；Web、Skills 执行、ToolSearch、通知、Task/Agent typed renderer listeners、跨平台安装和真实 credential-store smoke 仍未完成，因此不得用单一百分比宣称接近完成。Parallel Plan typed events 已明确排除，不计入剩余工作或完成门禁。
- Tauri 启动与 session 数据只使用新的 `~/.codez`；不读取或迁移 Electron 数据，Electron 源码与构建链仍完整保留。
- Workspace/Git、Terminal、Skills、Host/Settings、附件、Rules/Permission、Chat commands、Task/SubAgent settings 和 renderer logging 已通过统一 desktop facade 接入 Tauri。
- Plan 已在统一 `desktopApi.capabilities.plan` 边界隔离：Tauri 不显示 Plan modal/绑定入口、不解析 Plan client action、不恢复 Plan 状态，也不注册 Plan Electron listener；没有新增任何 Rust Plan command/event。旧 `window.api.plan` 和 Plan listener 仅在 capability 为 true 的 Electron renderer 可达，Electron 行为原样保留。Task runtime 已发出真实的 Tauri typed event，但 renderer subscription 仍需在统一 facade 中接线；Parallel Plan subscription、`ExecutionPlanner`/`Executor` 和产品 Plan 则随 Plan 一并隔离，不迁移、不计入 renderer bridge 剩余量。
- M1 Read/Write/Edit 已完成：Read 统一经过受信 `FileSystem`；Write/Edit 具备 fingerprint、授权后二次路径 identity 校验、per-path mutation lock、durable `prepare -> commit -> verified`、重启后 Reject、真实目录 identity、同步落盘、readonly 恢复、深层新文件和可发现 `txId`。
- M2 已完整接入 `SessionMaintenanceCoordinator`：Chat/Context/Attachment/EditTransaction/SubAgent 持 shared activity，Compaction 持 exclusive activity，History 与删除持 maintenance lease；冲突统一返回 retryable `RUN_ACTIVE`，持久 recovery marker 会阻断全部普通入口。
- session 删除使用 durable tombstone 和 detached owned worker，command future 取消不会中断清理；同一 session 删除串行化，八个清理步骤包括 SubAgent terminal state、durable Agent collaboration snapshot 和 typed Task snapshot。启动恢复、损坏 tombstone 分类、reparse/path 边界、list-generation ABA 和 Windows `\\?\C:\...`/`C:\...` identity 均有回归覆盖。
- SubAgent 终态使用 `~/.codez/subagent-runs/<session_id>/<run_id>.json`，get/cancel 显式校验 session 所有权并持 activity；session 删除会清理对应终态。renderer 已通过 `shared/desktopApi` 暴露 run/get/cancel/onState，Electron fallback 保留旧签名。
- M3 HistoryRevert 已使用 durable `Prepared -> WorkspaceApplied -> LedgerCommitted -> Finalized` journal、stable operation ID、history-version CAS 和真实 EditTransaction workspace adapter。启动会恢复 pending 操作并持久阻断 session；stale/recovery 返回 typed `HISTORY_REVERT_STALE`/`RECOVERY_REQUIRED`，session 物理删除只清理已终结 journal。
- EditTransaction 已支持重启后安全加载、4 MiB 元数据上限、session/transaction 身份校验、重复 ID 拒绝、路径/symlink/reparse 防护、稳定预览顺序和部分失败后的可重试回滚。每次 mutation 的 durable prepare 现在返回 CAS token；写前失败会恢复 previous intent，新 backup 清理失败会保留恢复证据，连续编辑不会把未提交内容误认成可回滚提交。
- M4 Context 已接入真实 Chat Provider 请求：每一轮重新构造 system prompt，计入 token budget、context items、request fingerprint、Provider usage baseline、prune/compact、overflow retry、图像 hydration 和后续工具轮。规则读取具有 bounded I/O、取消、authority、symlink/reparse 和 TOCTOU 防护；无 workspace 时不会把 `~/.codez` 当项目目录。正确的 Memory repository、完整 Skill catalog 和 enabled SubAgent definitions 仍属于 M5 缺口。
- 当前 Chat 工具循环已接入 Read、Write、Edit、Bash、PowerShell、Glob、Grep、list_files、NotebookEdit、ToolResultRead、TaskCreate、TaskUpdate、TaskGet、TaskList、spawn_agent、followup_task、send_message、list_agents、wait_agent、interrupt_agent 和 AskUserQuestion。Bash/PowerShell 共用 retained command registry，支持 wait-window、task ownership、interrupt、background artifacts、进程树终止、晚到取消、可信 executable/environment、稳定 workspace/cwd identity 和 session 删除清理。Agent collaboration 已具备 atomic snapshot、durable mailbox、stable attempt/message ID、父子取消、并发准入、启动恢复、late-result CAS、typed `agent:updated` event 和 supervisor-owned cleanup；Explore/Reviewer 已复用主 Chat Provider/tool multi-turn loop，使用独立 `subagent:<agent_id>` ledger scope、角色工具 allowlist、Reviewer 验证 shell policy 和 stable mailbox replay。Web、Skills 执行、通知与 ToolSearch 仍待实现。Parallel Plan 不属于这些剩余项。
- Rust Task 已使用 `~/.codez/tasks/<session_id>.json` 的 bounded typed snapshot、per-session mutation lock、atomic replace、revision 和 full-snapshot `task:updated` event；四个 Task 工具进入 immutable production catalog，并通过真实 Chat permission pipeline。renderer facade/listener 的 revision/gap 处理仍属于 M6/P5。
- 删除 session 时会清理 retained command process/artifacts、shell workspace state、EditTransaction、typed Task snapshot、durable Agent/mailbox snapshot、附件、ledger、fingerprint、SubAgent terminal state、session JSON 和 session 级 permission rules。

M1-M5 当前已接入部分的最近一次门禁结果：

- `cargo fmt --all -- --check`
- `cargo test -p codez-runtime --locked`：353/353（296 单元、29 edit transaction、1 fingerprint、2 mutation coordinator、25 tools）
- `cargo test -p codez-contracts --locked`：28/28
- `cargo test -p codez-desktop --lib --locked`：200/200
- workspace all-target/all-feature 严格 Clippy（`-D warnings`）
- TypeScript 类型检查通过；Vitest 196 个文件、1,248 项中仅冻结 MCP 的固定 500 ms 动态 catalog 时序断言首轮偶发失败，失败项单独重跑通过，未修改 MCP。
- Rust 依赖方向检查、契约重新生成、Tauri renderer 生产构建和 `tauri build --debug --no-bundle` 通过。
- `git diff --check`

`codez-desktop` 196 项 lib 测试在 Windows 上全部通过。`build.rs` 使用 MSVC `/MANIFEST:EMBED` 与 `/MANIFESTINPUT` 自动为 lib test executable 嵌入 Common Controls v6 manifest；P0 最终源码连续运行两轮均通过，不再修改或复制临时测试 EXE。正式应用 manifest 不受此测试专用输入影响。

`codez-platform` 的 Windows PTY 输入路线已收敛为单一 supervisor-owned ordered writer：输入字节保持顺序并原样写入，Ctrl+C 使用标准 ETX `0x03`。workspace 将 crates.io `portable-pty` 0.9.0 固定到本地最小补丁，唯一行为改动是把 `CreatePseudoConsole` flags 设为 `0`，关闭上游 `PSEUDOCONSOLE_WIN32_INPUT_MODE`，从而让 ConPTY 使用标准 VT 输入而不是编码后的 Win32 `INPUT_RECORD`。该补丁必须保持版本锁定，并由 raw ETX、PowerShell/cmd 重复 Ctrl+C、ordered write、进程树终止及串并行 `portable_pty_spike` 覆盖；稳定性证据和跨平台复验完成前 M7 仍为未完成。

Plan 隔离后，renderer 聚焦测试 16/16、Vitest 全量 195 个文件/1,243 项、TypeScript 类型检查和 Tauri renderer production build 均通过。

## 剩余目标与依赖顺序

| 顺序 | 状态 | 目标 | 关键交付物 | 完成门禁 |
| --- | --- | --- | --- | --- |
| M1 | 已完成 | 完成 Rust Read/Write/Edit 调用链 | delivery fingerprint、授权后路径 identity 复核、atomic write、mutation record、共享 `txId`、失败后可恢复事务 | stale-read、CRLF、连续 edit、并发备份、只读属性、部分失败和重启恢复测试通过；只有真实 mutation 的完成帧才携带 `txId` |
| M2 | 已完成 | 接入 session maintenance | coordinator、durable recovery block、detached session deletion、SubAgent session ownership/cleanup、Windows path identity | 运行中冲突返回 typed `RUN_ACTIVE`；lease 自动释放、poison/recovery、取消、重启和并发冲突测试通过 |
| M3 | 已完成 | 实现可恢复 HistoryRevertService | stable `operation_id`；durable `Prepared -> WorkspaceApplied -> LedgerCommitted -> Finalized` journal；Ledger 成功前保留 workspace 备份 | 崩溃恢复、幂等重试、typed stale/recovery、真实 workspace adapter 和删除清理测试通过 |
| M4 | 已完成 | Context 接入真实 Chat 请求 | `require_current_input_message -> measure_request -> prune/compact -> build items -> provider adapter -> hydrate images` | token budget、自动 prune/compact、usage fingerprint、overflow retry、真实 Provider payload 和 typed context/compaction frames 测试通过 |
| M5 | 部分完成，闭环未完成 | 完整 Tool/Permission/Agent/SubAgent loop | 文件、Search、Notebook、shell command-task、ToolResultRead、typed/atomic Task、durable Agent/mailbox lifecycle 及 Explore/Reviewer multi-turn tool loop 已接入；仍需 Web/Skills/ToolSearch/通知；不含任何 Plan/Parallel Plan 运行时 | Chat/Agent/SubAgent 的成功、拒绝、取消、重启恢复、并发上限和错误传播测试通过 |
| M6 | 部分完成，等待 M5 | 清除 renderer 剩余 Electron/兼容 bridge 语义依赖 | Plan Tauri 隔离和 Task runtime typed event 已完成；补齐 Task facade listener 及非 Plan Agent 生命周期 events，subscription hooks 改接统一 bridge；Parallel Plan typed events 明确不实现 | facade 外已迁移领域的 Electron/兼容 API 语义依赖为 0，renderer adapter/store 测试和类型检查通过；产品 Plan 不作为门禁 |
| M7 | 进行中 | 完成发布级验证 | debug no-bundle 已构建；仍需安装包、全新 `~/.codez` 启动、credential store、稳定 Windows Ctrl+C/process-tree、跨平台 smoke、性能与资源打包检查 | Tauri 可独立发布；不读取 Electron 数据；Electron 源码、依赖、配置、测试和安装包仍全部保留 |
| M8 | 冻结 | 恢复 MCP 独立计划 | 在 M1-M7 全部完成后重新审计现有 MCP Rust 代码，再决定补齐顺序 | 当前阶段禁止实施；恢复前不得把已有 MCP 脏改动误算为已验收功能 |

关键依赖链为 `M1 -> M2 -> M3`、`M2 -> M4 -> M5 -> M6` 和 `M1-M6 -> M7`。M3 与 M4 可在 M2 稳定后并行；M6 必须等 M5 的非 Plan typed events 稳定。MCP 不占用当前迁移资源，产品 Plan、`ExecutionPlanner`/`Executor` 和 Parallel Plan 也不进入该依赖链。

## 子智能体安排

最多同时运行 3 个子智能体，主智能体保留一个并发槽负责审查、集成和全量门禁。只把文件边界清晰、可独立验证的工作交给子智能体；共享 `chat_runtime.rs`、`state.rs`、`composition.rs` 的跨域接线由主智能体串行合并。

| 批次 | 负责人 | 状态与文件边界 | 前置条件与禁止触碰 |
| --- | --- | --- | --- |
| M2 公共接线 | 主智能体 | 已完成 coordinator、error conversion、state/composition、Chat/Compaction/History 接线与最终门禁 | 后续不得弱化 recovery block 或绕过统一删除 tombstone |
| M2 Session/Attachment/Context | 子智能体 A | 已完成 command activity/maintenance 门禁和聚焦测试 | 不再重复开发；回归由主智能体统一执行 |
| M2 删除与恢复 | 子智能体 B | 已完成 detached deletion、durable recovery、ABA/path/reparse 防护和测试 | 不再重复开发；M3 不得复用删除 journal 语义冒充 history transaction |
| M2 SubAgent | 主智能体/子智能体 | 已完成 session-scoped terminal persistence、get/cancel ownership、删除清理和 renderer facade | 后续 M5 只扩展 Agent loop，不改变该存储身份边界 |
| M3/M4 并行 | 子智能体 A/B | 已完成 HistoryRevert journal/recovery 和 Context/Prompt 真实 Provider 接线，主智能体已完成共享 Tauri composition 与全量门禁 | 后续回归不得绕过 durable journal、request fingerprint 或 rules authority |
| M5 Tool 批次 | 子智能体 A/B/C + 主智能体 | 已完成 Search、Notebook、Bash/PowerShell command lifecycle、spawned-process port、shell authority、ToolResultRead、typed Task、durable Agent/SubAgent collaboration 与 Explore/Reviewer multi-turn tool loop；下一批进入 Web、Skills、ToolSearch 和通知 | 不实现产品 Plan、`ExecutionPlanner`/`Executor` 或 Parallel Plan typed events；MCP 继续冻结；共享 registry/chat runtime 由主智能体串行集成 |
| M6/M7 | Renderer/验证子智能体 | typed events 冻结后，一名子智能体只改 facade/store/tests；其余子智能体只读执行构建、安装、Windows process-tree 与跨平台 smoke | 不删除 Electron，不新增或恢复数据迁移，不修改 MCP |

槽位释放后的补位优先级固定为：M2 公共接线 -> M2 Session/SubAgent 并行 -> M2 Compaction/History -> M3 HistoryRevert 与 M4 Context 并行 -> M5 Agent/SubAgent -> M6 renderer listener -> M7 发布验证。任何阶段出现 P0/P1 时暂停其依赖任务，先由主智能体确认根因、文件所有权和回归门禁。

每个子任务必须报告：修改文件、行为变化、未修改范围、剩余 Electron 调用、测试命令与结果、未解决阻断项。Rust 生产代码使用 typed `Result` 错误，禁止 `unwrap`/`expect`；验收至少包含 `cargo fmt --all -- --check`、相关 crate 测试以及 all-target/all-feature 严格 Clippy。不得用大范围搜索替换掩盖缺失的 Rust command，也不得把“可以编译”等同于行为迁移完成。

## 完成定义

- Tauri 正常启动不接触 Electron 用户数据，并在 `~/.codez` 正确创建新状态。
- 每个已迁移领域拥有 Rust command/domain 实现、typed renderer adapter 与针对关键失败路径的测试。
- renderer 不再直接依赖该领域的 Electron API；尚未迁移的调用按领域记录，而不是静默兼容。
- Electron 仍可作为冻结的源码和测试基线存在；其保留不等于 Tauri 双运行时支持。
- MCP、稳定的 Windows 原生 Ctrl+C 全套、完整 Chat/Tool/Agent loop 和跨平台安装验收未完成前，不得宣称全量迁移完成。
