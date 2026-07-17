# CodeZ M5-M7 实施计划

> 建立日期：2026-07-17
>
> 本文是 `current-execution-scope.md` 的执行细化。若两者冲突，以
> `current-execution-scope.md` 的产品边界为准，以本文的实现和验收顺序为准。

## 目标

完成 Tauri/Rust 的 Tool、Task、Agent/SubAgent、renderer typed event 和发布级验收，
同时满足以下固定边界：

- 不迁移、读取、删除或转换 Electron 用户数据。
- Electron 源码、依赖、测试和安装链永久保留。
- 不实现产品 Plan、`ExecutionPlanner`、`Executor` 或 Parallel Plan events。
- MCP 在 M1-M7 完成前保持冻结。
- 不以编译通过替代行为等价、失败路径、取消和重启恢复测试。

## 已验证初始基线

2026-07-17 在当前混合 staged/unstaged 工作区实跑：

- `codez-runtime`：329/329 通过。
- `codez-platform` lib：40/40 通过。
- Windows PTY：10 passed，1 ignored fixture。
- Tauri stream integration：2/2 通过。
- `codez-desktop` lib test 直接启动稳定复现 `0xc0000139`；在该问题自动化修复前，
  不把历史手工注入 manifest 的结果当作可重复门禁。

## 依赖决策

### 复用

- 原子持久化：现有 `codez_storage::AtomicFileStore` / `AtomicPersistence`。
- 取消树：现有 `CancellationTree` 和 `tokio_util::sync::CancellationToken`。
- 后台任务监督：`tokio_util::task::TaskTracker`。
- 运行时通信：`tokio::sync::{Mutex, RwLock, watch, Notify}`，按实际语义选择。
- Tool catalog/exposure：现有 `ToolCatalogSnapshot`、`ToolExposurePlanner`、
  `ToolExposureState`。
- Skills frontmatter：现有 `serde_yaml`；仓库中只保留一个 bounded parser。
- Web HTTP：现有 `reqwest`。
- 正文抽取：`dom_smoothie`，使用 Readability 和 Markdown 输出。
- 搜索 HTML：`scraper`；JSON API 使用 `serde`。
- 桌面通知：Tauri 官方 `tauri-plugin-notification`。
- Windows app/test 共用 manifest：通过
  `tauri_build::WindowsAttributes::new_without_app_manifest()` 关闭 Tauri 默认 manifest，
  再复用 MSVC `/MANIFEST:EMBED` 与 `/MANIFESTINPUT` 作为唯一 manifest 来源；不增加
  `embed-resource` 直接依赖。
- PTY：保持 vendored `portable-pty 0.9.0` 最小 flags 补丁。

### 不采用

- 不引入 SQLite、sled、redb 或额外 journal 框架保存当前规模的 Task/Agent snapshot。
- 不引入 Rig、LangChain Rust 或 Actor framework；它们会重复 Provider、Tool、
  Permission、Context 和恢复边界。
- 不采用 GPL-3.0+ 的 `html2md`。
- 不为 ToolSearch 引入模糊搜索依赖；先保持 Electron 的确定性名称/摘要评分语义。

## 全局不变量

1. 所有持久身份先验证再参与路径构造。
2. 每个 session 领域只有一个内存 owner 和一个 mutation lock。
3. 所有 mutation 在返回成功前完成 durable atomic replace。
4. 后台任务必须由 supervisor 持有，禁止 detached fire-and-forget 失去 join 所有权。
5. 每次 Agent follow-up 使用新的 `attempt_id`；旧 attempt 不得覆盖新状态。
6. 父取消向子孙传播，子取消不得反向取消父或兄弟。
7. terminal state 与对应 `FINAL_ANSWER` mailbox 消息在同一原子 snapshot 中提交。
8. renderer event 使用 `version + sessionId + revision + snapshot`；revision 单调递增。
9. renderer 先监听再拉 snapshot；旧 revision 被忽略，检测到 gap 时重新拉 snapshot。
10. session 删除必须清理 Task、Agent、mailbox、工具后台任务和现有七类资源；任一步失败保留 tombstone。

## 实施阶段

### P0 可重复 Desktop 测试与 AgentLoop 正确性

状态：完成（2026-07-17）

交付物：

- Windows app 与 lib test executable 自动带同一份 Common Controls v6 manifest，不再修改
  临时 EXE，也不从 Tauri `resource.lib` 重复嵌入 manifest。
- `cargo test -p codez-desktop --lib --locked` 可直接运行。
- `AgentLoop` 的 active step 带 attempt generation。
- `stop` 只请求取消；旧 step 退出前不能 `resume`。
- late completion 只允许完成它所属的 generation。

门禁：

- stop 后立即 resume 返回 typed conflict/busy。
- executor 退出后 resume 成功。
- 旧 executor 晚到结果不能覆盖新 attempt。
- desktop lib 全量测试可重复运行两次且不产生临时 manifest/EXE。

验收记录：

- `cargo test -p codez-runtime agent::loop_impl::tests --locked`：7/7 通过。
- `cargo test -p codez-desktop --lib --locked`：最终源码连续两轮均为 191/191 通过。
- Windows app 与 test executable 由 `build.rs` 自动嵌入同一份 `test.exe.manifest`；
  `tauri-build` 仍生成图标/版本资源但不再生成第二份 app manifest。仓库根未产生临时
  测试 EXE 或伴生 manifest。
- test profile 使用 `debug = 1`，保留行号并避免 MSVC PDB 类型信息触发
  `LNK1318 LIMIT`。

### P1 Typed/Atomic Session TaskStore

状态：完成（2026-07-17）

持久化位置：

```text
~/.codez/tasks/<session_id>.json
```

文档结构：

```text
TaskSnapshot {
  version,
  session_id,
  revision,
  next_sequence,
  tasks[]
}
```

Task 模型只包含通用追踪语义，不引用 Parallel/Executor 类型：

- `id`、`subject`、`description`、`status`
- `files`、`active_form`
- `group_id`、`group_title`、`group_subtitle`
- `risk_level`、`requires_approval`、`approval_status`
- `acceptance_criteria`、`verification_command`、`context_bundle`

交付物：

- `codez-contracts` typed Task command/event types，并生成 TypeScript binding。
- `codez-runtime` TaskStore，session mutation lock、bounded load、atomic replace、revision。
- TaskCreate/TaskUpdate/TaskGet/TaskList handlers 进入生产 catalog。
- Tauri command 只调用 TaskStore，不直接读写 JSON。
- `task:updated` typed full-snapshot event。
- session deletion 新增 TaskStore cleanup step。

门禁：

- 损坏/过大/身份不匹配文档 typed failure，不静默返回空列表。
- 并发 create/update 不丢数据，revision 严格递增。
- 写入失败保留旧 snapshot，且不发送成功 event。
- 重启恢复、删除恢复、跨 session 访问、重复 ID 和非法状态测试通过。

兼容性决策：

- v1 保持 Electron 的 patch 表达力：optional string/context 字段支持替换但不提供显式
  `null` 清空语义。若产品需要清空，必须通过后续 contract version 引入 tri-state patch，
  不把缺失字段和 `null` 静默混为同一 mutation。
- group/risk/approval/context 字段属于每个 Task；不引入任何 Parallel/Executor runtime
  字段或旧 Electron 数据迁移。

验收记录：

- `cargo test -p codez-runtime --locked`：339/339 通过（282 单元、29 edit
  transaction、1 fingerprint、2 mutation coordinator、25 tools）。
- `cargo test -p codez-contracts --locked`：26/26 通过。
- `cargo test -p codez-desktop --lib --locked`：192/192 通过；包含真实 Chat pipeline
  下无 approval handler 的 `TaskCreate` 自动授权测试。
- `npm run contracts:generate`、`npm run typecheck`、`cargo fmt --all -- --check`、
  workspace all-target/all-feature 严格 Clippy 和 `git diff --check` 全部通过。

### P2 Durable Agent Runtime 与 Mailbox

状态：完成（2026-07-17）

持久化位置：

```text
~/.codez/agent-runtime/<session_id>.json
```

单文档结构：

```text
AgentRuntimeSnapshot {
  version,
  session_id,
  revision,
  agents[],
  messages[]
}
```

核心字段：

- Agent：`agent_id`、`parent_agent_id`、`path`、`role`、`context_scope_id`、
  `status`、`attempt_id`、`run_count`、timestamps、launch policy、terminal result。
- Message：`message_id`、`type`、`attempt_id`、`author`、`recipient`、payload、
  `delivery_state`、timestamps。

交付物：

- main Chat 工具：spawn/list/wait/interrupt/send/followup。
- 地址树和 session ownership 验证。
- `TaskTracker` 监督所有 Agent futures，并接应用 shutdown。
- session -> agent -> tool -> process cancellation tree。
- durable mailbox、无丢 wakeup 等待、stable message ID、late result 注入。
- 启动恢复将 queued/running attempt 原子转成 interrupted，并补唯一 FINAL_ANSWER。
- active IDs 和 typed Agent lifecycle event。

门禁：

- 并发上限在同一 admission 临界区内生效。
- cancel/followup、父子取消、祖孙取消、旧 attempt 晚到结果均有竞态测试。
- queued 后崩溃、running 后崩溃、terminal 与 mailbox 提交前后崩溃均可恢复。
- mailbox wait 不丢通知；跨 session/path 访问返回 not found。
- session 删除等待 supervisor 终止并清理 snapshot。

实现与兼容性决策：

- main Chat production catalog 已加入 `spawn_agent`、`followup_task`、`send_message`、
  `list_agents`、`wait_agent`、`interrupt_agent`；均复用现有 Tool pipeline、permission、
  session/context/cancellation authority。
- `AgentRuntime` 是 `~/.codez/agent-runtime/<session_id>.json` 的唯一内存 owner；
  terminal result 与 `FINAL_ANSWER` 在同一 atomic replace 中提交，历史 attempt mailbox
  在 follow-up 后仍可重启加载。
- 应用启动会安全枚举 Agent runtime 目录，将 queued/running attempt 原子恢复为
  interrupted；symlink/reparse、非法文件名、非 JSON entry 和损坏 snapshot 会阻断启动，
  不静默忽略。
- P2 executor 直接复用现有 `SubAgentRuntime` 的 bounded Provider completion 和 persisted
  Explore/Reviewer model selection，不复制 Provider streaming loop。它仍是无工具单步运行；
  P3 才替换为主 Chat Provider/tool multi-turn loop。
- Agent snapshot/event contract 已生成 TypeScript binding；Tauri 提供 `agent_snapshot`、
  `agent_active_ids` 与 full-snapshot `agent:updated`。renderer 的 listen-first、revision gap
  和 session switch 处理仍属于 P5。
- session 删除在 SubAgent cleanup step 内先取消并 join Agent supervisor，再删除 collaboration
  snapshot；shutdown coordinator 也持有同一个 `AgentRuntime` hook。

验收记录：

- `cargo test -p codez-runtime --locked`：353/353 通过（296 单元、29 edit
  transaction、1 fingerprint、2 mutation coordinator、25 tools）；其中 durable Agent
  collaboration 聚焦测试 12/12、Agent tool 聚焦测试 2/2。
- `cargo test -p codez-contracts --locked`：28/28 通过。
- `cargo test -p codez-desktop --lib --locked`：196/196 通过；包含 production catalog、
  typed conversion、Provider completion 复用和 cancellation forwarding。
- `npm run contracts:generate`、`npm run typecheck`、`cargo fmt --all -- --check`、workspace
  all-target/all-feature 严格 Clippy 和 `git diff --check` 全部通过。

### P3 Explore/Reviewer Multi-Turn Tool Loop

状态：完成（2026-07-17）

交付物：

- 复用主 Chat Provider adapter、Context ledger、prompt builder 和 tool pipeline。
- 每个 Agent 使用独立 `subagent:<agent_id>` context scope。
- Explore：只读 workspace/search 工具，加 `send_message`、`list_agents`。
- Reviewer：只读工具与明确 allowlist 的验证 shell policy。
- 不复制 Provider 请求循环，不创建第二套 Permission 或 ToolResult 处理器。
- 每轮消费 durable mailbox，并用 stable ledger event ID 幂等注入。

门禁：

- 成功、拒绝、工具错误、Provider 错误、超限、取消和重启恢复测试通过。
- Agent 不能调用角色未授权工具，也不能借 ToolSearch 激活隐藏工具。
- late FINAL_ANSWER 能进入父 Agent 的下一轮，且不会重复注入。

实现与兼容性决策：

- `DesktopAgentAttemptExecutor` 通过 `OnceLock<Weak<ChatRuntime>>` late binding 复用主 Chat
  的 `run_provider_conversation`，避免强引用环，也不保留第二条 Agent Provider 请求路径。
- 主 Chat 与 Agent 共用 Provider/tool loop、prompt builder、tool pipeline 和泛化后的
  `ConversationLedger`；Agent 使用独立 `subagent:<agent_id>` scope，并以稳定 mailbox
  message ID 幂等写入 ledger。
- Explore 只暴露 Read、Glob、Grep、list_files、ToolResultRead 及协作工具；Reviewer
  额外暴露 Bash/PowerShell，但 shell 命令在 permission 和进程创建前经过严格验证命令
  allowlist。角色隐藏工具继续由现有 `ToolExposurePlan` 拒绝。
- `WorkspaceRoot` 只作为已验证的 attempt authority 在内存中传递，不写入 durable
  Agent snapshot；父子取消和 Provider cancellation 继续落到同一 cancellation tree。

验收记录：

- `cargo test -p codez-runtime --locked`：353/353 通过。
- `cargo test -p codez-contracts --locked`：28/28 通过。
- `cargo test -p codez-desktop --lib --locked`：200/200 通过。
- 真实本地 Provider E2E 覆盖 Explore 的 Read 两轮循环与 stable mailbox replay、父 Agent
  `wait_agent` 接收子 Agent late `FINAL_ANSWER`、以及 Agent Provider cancellation 持久化。
- role schema、Explore 隐藏 Write、Reviewer 非 allowlist shell 拒绝均有回归测试；
  `cargo fmt --all -- --check`、`npm run typecheck`、workspace all-target/all-feature 严格
  Clippy 和 `git diff --check` 全部通过。

### P4 Skills、ToolSearch、通知与 Web

状态：完成（2026-07-17）

Skills：

- 抽取唯一 `SkillDocument` parser；限制 frontmatter/body/目录数量与深度。
- Skill/ActivateSkill/DeactivateSkill 复用 Context ledger 的 `SkillStateUpdated`。
- 不执行任意 skill 文件代码；Skill 激活只加载受信指令和声明资源。

ToolSearch：

- 在 immutable catalog snapshot 上搜索。
- 激活结果只影响同 session/context scope 的下一 model turn。
- hidden/denied/role-incompatible 工具不可被激活。

通知：

- 使用官方 Tauri notification plugin。
- 保留长度、单行、频率和 permission policy。
- Windows/macOS/Linux 验证显示、拒绝和点击聚焦；若插件不支持某平台点击回调，
  明确记录非等价并实现平台适配层，不伪造成功。

Web：

- 只允许 HTTP/HTTPS。
- 拒绝 loopback、private、link-local、multicast、unspecified、metadata endpoints。
- 每次 DNS 解析和每个 redirect hop 重新验证；限制 redirect 次数。
- 流式读取并在解压后按字节上限中止，限制 content type 和总时长。
- 域名 allow/block 使用 exact host 或 dot-boundary subdomain，不使用 substring。
- HTML 正文使用 `dom_smoothie`；搜索结果 HTML 使用 `scraper`。

门禁：

- Skill 重复激活/禁用/强制恢复、内容 hash 变化和 compaction 恢复测试。
- ToolSearch exact/prefix/keyword/role-deny/snapshot-stability 测试。
- 通知 unsupported/permission denied/send failure typed 返回。
- Web SSRF、DNS/redirect、压缩炸弹、超长 body、错误 charset、Unicode 和 fixture parser 测试。

实现与兼容性决策：

- Skills catalog、Chat prompt 和 Skill/ActivateSkill/DeactivateSkill 共用唯一 bounded
  `serde_yaml` parser；文档、frontmatter、字段长度、目录深度和条目数量均有上限。
- Skill 状态通过 `SkillStateUpdated` 写入 Context ledger，event ID 由稳定的
  `turn_id + call_id` 构成；重复激活幂等，内容 hash 变化会刷新，disabled 状态只有
  显式 `force` 才能恢复。compaction 继续携带 durable skill states。
- ToolSearch 只搜索当前 immutable exposure plan 已准入的 deferred summary；激活状态按
  `session + context scope` 隔离。同一批调用仍返回 `TOOL_NOT_EXPOSED`，下一次 Provider
  schema 生成才暴露 Web/通知等工具，不能借此绕过 role deny 或 hidden 工具。
- 通知复用官方 `tauri-plugin-notification 2.3.3`（Apache-2.0 OR MIT）。插件桌面端可查询
  permission 并同步提交，但不提供可靠的跨平台点击回调或投递确认，因此成功仅返回
  `delivery: submitted` 和 `clickFocusSupported: false`，不伪造点击聚焦。
- Web 复用 `reqwest 0.12.28`、`dom_smoothie 0.18.0`（MIT）和 `scraper 0.27.0`
  （ISC）。每个 redirect hop 重新解析并验证全部地址，再用 `resolve_to_addrs` 固定本次
  连接；自动 redirect 被禁用，解压后的响应流按 4 MiB 上限中止。
- Windows 本地 Provider 测试服务器的 accept 改为 5 秒有界等待，并在 accept 后显式把
  stream 恢复为 blocking，避免前置失败永久挂起和 Windows nonblocking 继承导致误报。

验收记录：

- `cargo test -p codez-runtime --locked`：359/359 通过。
- `cargo test -p codez-contracts --locked`：28/28 通过。
- `cargo test -p codez-desktop --lib --locked`：P4 主体为 218/218 通过；补齐通知
  unsupported 用例后聚焦通知测试为 5/5 通过，当前 Desktop 总数为 219。
- ToolSearch 聚焦 4/4、Web 聚焦 6/6、Agent 本地 Provider E2E 串行 6/6 通过。
- `cargo fmt --all -- --check`、`npm run typecheck`、workspace all-target/all-feature 严格
  Clippy 和 `git diff --check` 全部通过。
- Windows/macOS/Linux 的通知显示与点击、安装包真机投递 smoke 保留到 P6；当前插件
  不具备的点击回调不会以单元测试替代。

### P5 Renderer Typed Events 与 Desktop Facade

状态：完成（2026-07-17）

交付物：

- Task、Agent、SubAgent typed event listener 只存在于统一 desktop facade。
- store 按 session 保存 revision，后台 session event 不覆盖当前会话。
- hooks 先 listen 再 snapshot，并正确 unlisten。
- 已迁移领域在 facade 外的 Electron/兼容语义依赖为 0。
- Plan 和 Parallel Plan listener 不在 Tauri runtime 注册。

门禁：

- adapter/store/hook 的 subscribe gap、乱序、重复、unmount 和 session switch 测试。
- TypeScript typecheck、Vitest 全量、renderer production build 通过。

实现与兼容性决策：

- `desktopEvents` 是 Task、Agent 和 SubAgent listener 的唯一 renderer 边界；Tauri event
  envelope 会校验 version、session、revision 与 snapshot 一致性，畸形事件不会进入 store。
- `desktopLifecycleStore` 按 session 分别保存 Task/Agent full snapshot 和 revision；重复或旧
  revision 被忽略，event revision 跳号返回 `gap`，authoritative snapshot 可跨 gap 恢复。
- lifecycle hook 先并行注册 Task/Agent listener，再并行拉当前 session snapshot；gap 回源按
  session 去重。listener 尚未注册完成时 unmount 也会在 promise resolve 后立即 unlisten。
- 后台 session Task event 只更新所属 session；只有 event session 等于 active session 时才
  更新顶层 Task capsule。session switch 会释放上一组 listener 并重新执行 listen-first 流程。
- Tauri `tauriBridge` 中无调用者的 Task/SubAgent 兼容段已删除；冻结 Electron preload 和
  fallback 仅保留在统一 facade 内。Tauri Plan capability 固定为 false，未注册 Plan 或
  Parallel Plan event；Electron 源码与测试仍原样保留。
- React 实现遵循窄 effect dependency 和显式 cleanup；独立 listener/snapshot 使用并行异步，
  没有新增全局重复 listener 或基于陈旧闭包的状态更新。

验收记录：

- P5 facade/store/subscription 与既有 session restore 聚焦测试：22/22 通过。
- `npm test`：199 个 test files、1256/1256 tests 通过。
- `npm run typecheck`：通过。
- `npm run build:renderer:tauri`：通过，2646 modules transformed；只保留既有的
  dynamic/static import 和大 chunk 警告。
- `git diff --check`：通过；Task/Agent/SubAgent event name 和 `.task.subscribe` 在 renderer
  facade 外搜索结果为 0。

### P6 发布验收

状态：进行中（2026-07-17；Windows 自动化门禁完成，跨平台与人工真机项未完成）

门禁：

- workspace fmt、all-target/all-feature Clippy、Rust 全量测试、TS typecheck、Vitest、
  contract generation、renderer build 和 `git diff --check`。
- Tauri bundle 安装包在全新 `~/.codez` 启动，不访问 Electron 数据。
- OS credential store 真机 smoke。
- Windows 支持版本重复验证 PTY Ctrl+C、cursor、resize/reflow、reader shutdown 和 process tree。
- macOS/Linux 构建、安装、PTY、通知和资源打包 smoke。
- release build 启动时间、常驻内存、长会话 snapshot 大小和 tool schema token 开销记录。

Windows 验收记录：

- `cargo build -p codez-desktop --release --locked`：通过，正式 app 未再出现
  `CVT1100/LNK1123`；`cargo test -p codez-desktop --lib --locked` 为 219/219 通过。
- `npm run build:tauri`：通过，生成 24,821,760-byte MSI 和 16,130,669-byte NSIS；最终
  app 为 60,609,024 bytes。PE subsystem 为 `Windows GUI`，资源中只有一个
  `MANIFEST\1`，同时包含 Common Controls v6 与 `asInvoker`。
- MSI administrative image 与 NSIS payload 均包含 20 个 builtin Skill 文件（209,619
  bytes）和 `rg 15.0.0`（5,429,760 bytes，SHA-256
  `f9dde63498b3193f098355dbec97af99dc4f6b8fa0df5ed04114a03012c042cb`）。当前账户已有
  `C:\Users\asus\AppData\Local\Programs\CodeZ`，因此没有覆盖现有安装。
- `vendor/portable-pty-0.9.0` 的 18 个文件均已被 Git 跟踪，包含 `LICENSE.md` 与
  `CODEZ_PATCH.md`，干净 checkout 不依赖未跟踪的本地 vendor 内容。
- Windows Credential Manager 真机 smoke 显式运行 1/1 通过：唯一临时 service/account
  完成 set/get/delete，删除后读取返回 typed NotFound；该测试默认 ignored，普通测试不会
  修改 OS credential store。
- Windows `portable_pty_spike` 串行与 workspace 默认并发均为 10 passed、1 ignored fixture，
  覆盖 cmd/PowerShell Ctrl+C、resize、reader shutdown、中文 cwd、kill race 与 process tree。
  cursor/reflow 仍需在真实 renderer 中人工验证。
- 100 轮/200 条消息（每轮 1 KiB user + 4 KiB assistant）的真实 ledger 测量：snapshot
  599,561 bytes，JSONL ledger 619,924 bytes。
- 主 Chat 初始 Provider schema：24 tools、16,019 serialized bytes、4,009 estimated tokens；
  ToolSearch 激活 WebSearch/WebFetch/PushNotification 后：27 tools、17,677 bytes、4,424
  estimated tokens。估算复用生产 `ContextBudgetService`。

自动化门禁记录：

- workspace fmt 与 all-target/all-feature 严格 Clippy 通过；依赖方向检查覆盖 8 个 workspace
  packages，并只显式允许 `codez-runtime -> codez-storage` 的 test-only dev dependency。
- `cargo test --workspace --all-targets --locked` 通过：Runtime 359 passed/1 metrics ignored，
  Desktop 219 passed/1 metrics ignored，Contracts 28/28，Platform lib 40/40、PTY 10/1，
  Storage 59 passed/1 credential smoke ignored，其余 workspace tests 全部通过。
- `npm run typecheck` 通过；`npm test` 全量复跑为 199 files、1,256/1,256。冻结 MCP 的动态
  catalog 时序断言首轮出现一次已知偶发失败，单文件 2/2 与随后全量复跑均通过，未修改 MCP。
- contract generation 无 diff；资源分析为 20 files/209,619 bytes 与 `rg 15.0.0`；Tauri
  renderer production build 通过（2646 modules）；`git diff --check` 通过。

未完成项：

- Windows 的 Tauri `home_dir` 使用 `FOLDERID_Profile`，修改 `HOME/USERPROFILE` 不能隔离
  `~/.codez`。当前账户又已有 CodeZ 安装，因此未启动 release app 访问真实 profile；需在
  临时 Windows 用户、Sandbox 或 VM 中完成全新数据根与安装/升级 smoke。
- release app 启动时间、常驻内存、renderer cursor/reflow、通知显示/点击仍需隔离真机环境。
  插件不提供可靠点击回调，不能把 `submitted` 记作投递或点击成功。
- macOS/Linux 的构建、安装、PTY、通知、credential store 和资源打包尚未执行。P6 在这些
  项目完成前保持“进行中”，不得标记完成。

## 状态更新规则

- 每个阶段只有在全部门禁通过后才能改为“完成”。
- 临时跳过的 smoke 必须保持“未完成”，不得用本机单平台结果替代跨平台发布门禁。
- 每次状态更新记录测试命令与数字；不得只写“测试通过”。
- 发现 P0/P1 时停止依赖阶段，先修复根因和回归测试。
