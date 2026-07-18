# CodeZ 主 Agent 提示词与工具优化蓝图

## 结论

CodeZ 不应复制 Claude Code、Codex 或 Grok Build 的完整提示词。三者真正值得吸收的是不同层面的机制：

| 来源 | 适合吸收 | 不应照搬 |
|---|---|---|
| Claude Code | 明确的 Explore 升级阈值、稳定策略与动态目录分离、文件读写状态约束 | 恢复源码中的整段 prompt、入口相关模型选择 |
| OpenAI Codex | System/Developer/环境/项目规则分层、独立 child rollout、可审计请求上下文 | 单次 rollout 的并发数、profile 名称和宿主策略 |
| Grok Build | finalized registry 驱动工具名、能力条件化 child prompt、工具依赖检查、resume/worktree 语义 | 只有 B/D 级证据的线上行为推断、较弱的写前竞态保护 |
| CodeZ 现有实现 | Read fingerprint、事务化 Edit/Write、effect/permission 流水线、result handle、durable mailbox | prompt、目录、schema 和 executor 各自维护一份事实 |

目标不是增加更多提示词，而是建立以下不变量：

```text
同一份解析结果
  -> 模型看到的政策与动态目录
  -> Provider 收到的工具 schema
  -> Runtime 实际允许执行的工具与预算
  -> UI 和日志展示的能力、成本与来源
```

## 当前状态审计

本目录的 CodeZ 档案固定在 `f76537b` 加当时 dirty worktree，是一份历史快照。当前仓库状态需要单独解释：

```text
HEAD: df3eb97 Expose subagent catalog and tighten delegation guidance
worktree: 7 个相关 Rust 文件存在未提交反向修改
```

`df3eb97` 已实现 `spawn_agent` 门控、registry-derived Agent 目录和 deferred tool surface；当前未提交修改又使实际源码回到以下状态：

- `WorkerDelegationModule` 只识别旧工具名。
- `SubAgentsModule` 固定关闭。
- `PromptContext.deferred_tools` 固定为空。
- Provider tools 在主循环外生成一次，`ToolSearch` 激活后下一轮仍复用旧 schema。

这不是可以靠改提示词掩盖的问题。实施前必须先确认当前 dirty 修改的意图，不能直接覆盖或假定 `HEAD`/worktree 任一方天然正确。

本次核对还发现一项档案未列出的独立漂移：

| 生产者 | 动态边界 |
|---|---|
| `PromptPipeline` | `<codez_dynamic_capabilities>` |
| Provider adapters | `<!-- codez:prompt-dynamic-boundary -->` |

Provider 因而无法正确拆分稳定段与动态段。Anthropic 的缓存分块失效，OpenAI/Gemini 也不能移除 Pipeline 插入的标记。

## Todo 工具专项方案

三家产品对“任务”的命名并不统一，但边界高度一致：Claude Code 的 durable Task 提供依赖，Codex 的 `update_plan` 明确只是当前协作状态，Grok Build 的 todo 支持整批状态更新且与 subagent/Goal 分离。CodeZ 采用 Todo 作为模型可见概念，复用原有持久化数据而不再建立平行计划系统。

2026-07-18 工作树采用以下状态模型：

```text
TodoItem.blockedBy[]                 durable, single direction
TodoUpdate.expectedRevision?         compare-and-swap guard
TodoUpdate.updates[]                 atomic multi-item patches

derived per snapshot:
ready | blocked | unfinishedDependencies[] | blocks[] | waitingForApproval
```

执行不变量：

1. 同一 session 最多一个 `in_progress` Todo。
2. 依赖必须存在，不得重复、自依赖或成环。
3. 只有全部依赖 `completed` 后 Task 才能开始或完成；`cancelled` 依赖不算完成。
4. `requiresApproval=true` 的 Task 只有 `approved` 后才能开始或完成。
5. Update 至少包含一项变更；同一批次不得重复 ID，旧 revision 冲突直接返回最新有界状态。
6. 删除 Task 时原子清理其他 Task 对它的依赖。
7. Todo 只表达工作状态，不拥有 Agent/Executor，也不触发自动 spawn；Goal 保持为不同生命周期概念。
8. 模型只看到 `TodoCreate` 与 `TodoUpdate`；Get/List 是内部 UI/恢复能力，权威状态每个 Provider round 自动注入。
9. 一批 patch 在克隆快照上完成后校验最终图和状态，只增加一次 revision、持久化一次、发出一次事件。

对应落点：`crates/codez-runtime/src/todo.rs`、`tools/builtin/todo.rs`、contracts/Tauri 转换、Todo capsule 和 Todo/Doing-tasks prompt modules。旧 `tasks/` 目录与 `SessionData.tasks` 仅作为数据兼容层。

## 目标架构

### 1. EffectiveCapabilitySnapshot

每个 Provider round 只解析一次有效能力，并让 prompt、schema 和 executor 共享该快照：

```text
EffectiveCapabilitySnapshot
  catalog_version
  role
  eager_tools[]
  deferred_tools[]
  agent_profiles[]
  active_skills[]
  mcp_tools[]
  permission_policy_ref
  hashes
```

关键约束：

1. ToolSearch、Skill/MCP 激活或 role 变化后，下一轮必须重新解析快照。
2. Prompt 不得引用本轮未曝光且不可发现的工具。
3. Deferred 目录必须来自同一 `ToolExposurePlan`，不能另建列表。
4. Agent 目录必须来自同一 registry，工具名门控改为 capability 判断。
5. Runtime 拒绝任何不属于该快照的调用，即使模型猜中了工具名。

### 2. 结构化 PromptSections

不要再用两个 crate 各自硬编码魔法字符串。PromptPipeline 应输出结构化段：

```text
PromptSections
  stable_core
  runtime_policy
  project_instructions
  dynamic_capabilities
  role_addendum
  manifest
```

Provider adapter 再把这些段映射到自身支持的 role/cache 机制：

- 支持 Developer role 时，把宿主政策与项目内容分层发送。
- 不支持时，按优先级合并为 system content blocks。
- 动态边界只存在于内部结构，不作为模型可见文本。
- 每段保存 source、precedence、visibility、hash、字符数和 token 估计。

### 3. AgentProfile 是执行契约

Agent profile 不应只是 UI/Prompt 元数据。至少要解析为：

```text
ResolvedAgentProfile
  role
  audience_prompt
  tool_allowlist
  context_inheritance
  budget { rounds, tool_calls, output_chars }
  output_contract
  isolation
  model_policy
```

启动参数、提示词说明、执行循环、完成 envelope 和 UI 必须使用同一个 profile。

## 优先级

### P0：先修正确性和事实一致性

#### P0.1 单一能力快照

- 恢复或重做 `ProviderToolSurface`，每个 Provider round 重新生成。
- 同一 surface 同时提供 eager schemas、deferred summaries 和 prompt tool summaries。
- 让 Agent catalog 从 registry 渲染，并用 capability 而不是字符串别名启用委派政策。
- 给注册表增加依赖闭包校验：deferred tool 必须有 ToolSearch；spawn 必须有 wait/list/interrupt；后台 shell 必须有 task control；MCP descriptor 必须有 executor。

验收：

- 首轮没有 `WebFetch`；ToolSearch 激活后第二轮 schema 中出现 `WebFetch`。
- Prompt 展示的 deferred names 与 ToolSearch 实际搜索集合完全一致。
- `spawn_agent` 暴露时，主 Prompt 必须同时包含委派政策和有效 Agent 目录。
- 删除/改名某工具后，不会残留 prompt 引用。

#### P0.2 消除 Prompt boundary 漂移

- 用 `PromptSections` 或共享常量替代两种标记。
- OpenAI、Anthropic、Gemini adapter 都增加从 Pipeline 输出到 wire payload 的契约测试。
- Provider payload 中不得出现内部 boundary marker。

验收：

- Anthropic 得到稳定、动态两个 content block，稳定块可缓存。
- OpenAI/Gemini 得到无内部标记的完整提示词。
- 修改 Git 状态或 tool catalog 只改变 dynamic hash，不改变 stable hash。

#### P0.3 让 Agent 预算与输出契约可执行

- 将 `depth` 映射到 registry 中唯一的 round/tool-call/output 预算。
- 主循环不再让所有 child 共用全局 64 round 上限。
- 完成协议采用“强类型 envelope + Markdown report”，不要强行把全部业务报告拆成碎字段。
- 校验失败时保留原始报告并标记 `partial`/`invalid_contract`，不能静默丢失结果。
- `conclusion`、usage、停止原因、截断状态和未解决问题数进入 durable mailbox。

验收：

- quick/normal/exhaustive 在运行时产生不同硬上限。
- 超限结果以结构化状态结束，不继续无限工具循环。
- Reviewer verdict 和 Explore conclusion 可由父 Agent 结构化读取。

### P1：优化提示词、上下文与扩展能力

#### P1.1 为 child 生成角色化 Prompt

当前 child 继承“完整主 Prompt + role addendum”，会把 Editing、主用户沟通、完整 Skills/Git 目录等无关内容复制给只读 Explore。

引入 `PromptAudience::Main | Explore | Reviewer`：

| 模块 | Main | Explore | Reviewer |
|---|---:|---:|---:|
| 安全、证据、权限边界 | 是 | 是 | 是 |
| 项目规则与作用域环境 | 是 | 是 | 是 |
| Editing/Write 指南 | 是 | 否 | 否 |
| 主用户进度沟通 | 是 | 否 | 否 |
| Explore 搜索/停止策略 | 否 | 是 | 否 |
| findings-first 审查策略 | 否 | 否 | 是 |
| 与 role allowlist 一致的工具目录 | 是 | 是 | 是 |

同时增加 `none | bounded | full` 上下文继承策略。默认 child 只接收自包含 brief、适用项目规则和必要证据引用，不复制父历史原始洪流。

#### P1.2 收紧委派决策

主 Agent 使用以下门控：

| 情况 | 行为 |
|---|---|
| 已知文件/符号/错误文本，1 至 3 次检索可回答 | 主 Agent 直接 Glob/Grep/Read |
| 跨模块调用链、多个命名变体、预计超过 3 次依赖查询 | 最多 1 个 Explore |
| 两个以上明确且不重叠的研究轴，或用户明确要求并行 | 可并行多个 Agent |
| 同一规范化问题已有 Agent | `followup_task`，不重复 spawn |
| 非平凡改动已完成且主验证已运行 | 可用 Reviewer |
| 纯分析、简单问答、尚未完成实现 | 不用 Reviewer |

并发容量与默认委派策略分开：runtime 可以允许 8 个 active attempts，但主 Agent 不应默认占满容量。

#### P1.3 分层政策与目录规则

- 在稳定核心补充简短 trust/authorization policy：工具和仓库内容是数据，不自动成为高优先级指令；权限拒绝后不得反复绕过；外部共享或不可逆动作需要明确授权。
- 实现嵌套 `AGENTS.md`/规则文件解析，保存 source、scope、precedence 和 hash。
- 多文件操作涉及不同目录规则时，在工具授权或编辑前解析目标路径的有效规则集合。
- Provider 不支持 Developer role 时仍保留内部 policy class，不把所有来源压成不可审计字符串。

#### P1.4 MCP 进入统一工具面

- 将 MCP descriptors 以稳定命名空间加入同一个 catalog，默认走 deferred exposure。
- 沿用现有 permission、redaction、timeout、result handle 和 session/contextScope 隔离。
- MCP Full/Delta 变化只更新动态能力快照，不重写稳定主提示词。
- MCP tool 不得绕过 `ToolExecutionPipeline` 形成第二条权限旁路。

#### P1.5 请求装配清单与成本观测

在现有 `ContextBudgetSnapshot` 和 request fingerprint 上扩展，而不是另建平行统计：

```text
ResolvedRequestManifest
  request/session/parent/agent/profile IDs
  provider/model/version/feature flags
  prompt section refs + hashes + tokens
  tool schema refs + hashes + enabled reason
  rule/skill/MCP catalog versions
  history/summary/result/attachment tokens
  compaction and context inheritance decisions
```

敏感正文可加密外置；主 ledger 至少保存 hash、大小、来源、可见性和 artifact reference。

证据元数据要拆成两个轴：

- provenance：runtime transcript / source / reconstructed / simulated。
- completeness：full payload / logical envelope / partial event / summary only。

仅写 A/B/C/D 不足以复现 dirty worktree；还应保存 revision、dirty diff hash 和 artifact hash。

### P2：按产品需求扩展，不阻塞主链正确性

- 多模态 Read：图片、PDF、Notebook 和结构化文档；复用 attachment 验证和 result projection。
- 写 Agent：只有在 worktree isolation、冲突检测、merge/handoff 契约完成后再开放。
- Plan/Coordinator/custom profile：共享安全核心，通过 profile 配置工具、模型和输出，不复制整套 prompt。
- UI 分开展示 durable Todo、Agent record、active attempt、tool rounds、token、compact 和截断事件。
- LSP、浏览器和其他专用工具应按真实高频任务与评测收益引入，不用 shell 假装已有能力。

## 不应做的优化

1. 不要把三家的 system prompt 拼成更长的 CodeZ prompt。
2. 不要在 prompt、tool schema、registry 和 executor 分别硬编码工具/Agent 名称。
3. 不要用自然语言承诺 runtime 未执行的预算、隔离或输出格式。
4. 不要为减少 token 删除 Read fingerprint、事务写入、permission effects 或 result handles。
5. 不要把单次 Codex rollout 的并发数、Claude 某入口的模型或 Grok 的 D 级模拟写成产品常量。
6. 不要让 eager 工具 description 同时在 System 与 schema 全量重复；System 只保留跨工具政策、deferred 目录和必要工作流。

## 实施顺序

### Slice 1：能力一致性

主要落点：

- `src-tauri/src/chat_tool_runtime.rs`
- `src-tauri/src/chat_runtime.rs`
- `crates/codez-runtime/src/chat/prompt/types.rs`
- `crates/codez-runtime/src/chat/prompt/modules/{available_tools,sub_agents,worker_delegation}.rs`

完成 P0.1，并加入两轮 ToolSearch、Agent catalog 和 prompt/schema 同源测试。

### Slice 2：结构化 Prompt

主要落点：

- `crates/codez-runtime/src/chat/prompt/pipeline.rs`
- `crates/codez-providers/src/chat/common.rs`
- `crates/codez-providers/src/chat/{openai,anthropic,gemini}.rs`

完成 P0.2，移除模型可见 boundary marker，建立 stable/dynamic hash。

### Slice 3：Agent 执行契约

主要落点：

- `crates/codez-runtime/src/agent/{registry,collaboration}.rs`
- `crates/codez-runtime/src/tools/builtin/agent.rs`
- `src-tauri/src/chat_runtime.rs`

完成 P0.3 和 P1.1/P1.2：预算、角色化 Prompt、上下文继承、结构化终态和去重/复用策略。

### Slice 4：规则、MCP 与观测

主要落点：

- `src-tauri/src/mcp_runtime.rs`
- `src-tauri/src/composition.rs`
- `crates/codez-runtime/src/context/`
- ledger/snapshot 和对应 boundary/UI 类型

完成 P1.3 至 P1.5。

## 回归评测

不要只比较提示词字符数。至少固定以下任务集：

| 类别 | 场景 | 核心指标 |
|---|---|---|
| 定向检索 | 已知符号/错误文本 | 直接完成率、误派 Explore 率、工具调用数 |
| 跨模块研究 | 未知入口和多命名变体 | 证据覆盖、重复搜索率、父上下文增长 |
| 小型编辑 | 单文件行为修复 | patch 正确率、Read proof、验证结果 |
| 并发研究 | 两个不重叠问题 | wall time、重复 Agent 率、父合并正确率 |
| Reviewer | 非平凡改动审查 | 高置信 finding 准确率、误阻塞率 |
| Deferred | ToolSearch 后调用 Web/MCP | 下一轮曝光成功率、schema/prompt 一致性 |
| Compaction | 长会话后继续任务 | 目标保持、规则恢复、重复工作率 |
| 权限 | 拒绝/未知 shell effect | 绕过尝试、用户提示准确性、审计完整度 |

必须作为 CI 不变量的检查：

1. Provider payload 不含内部 Prompt boundary。
2. Prompt 引用的 eager/deferred tools 都能在同一快照中解释。
3. Agent profile 的 allowlist、预算和 output contract 与执行结果一致。
4. ToolSearch 激活在下一 Provider round 生效。
5. 目录规则解析对多根 workspace 和嵌套路径正确。
6. Dirty worktree 不会被 Agent 自动覆盖，Read fingerprint/事务写入测试保持通过。

## 证据限制

- Claude Code 的 transcript 与恢复源码并非同一精确版本；三次查询阈值是 B 级设计证据，不是所有入口的线上不变量。
- Codex 的真实 rollout 是 A 级单次会话事实，但工具、并发和 profile 会随宿主与版本变化。
- Grok Build 没有同 revision 真实 transcript，完整请求样例仍是 D 级源码模拟。
- “缺失委派门控导致 CodeZ 一次派 3 个 Explore”只能定为 C 级因果推断：日志证明发生过派发，源码证明门控缺失，但没有 outbound System payload 直接证明模型当时看到的内容。
