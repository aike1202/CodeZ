# CodeZ 上下文管理优化设计

> 日期：2026-07-10
> 状态：已确认目标架构，待设计评审
> 选定方案：规范化模型消息账本 + 正式 Compaction + 旧会话惰性迁移

## 1. 决策摘要

CodeZ 将不再由 Renderer 根据 UI 聚合消息重建下一轮模型历史。主进程成为模型消息历史的唯一事实来源，按真实发生顺序持久化 `user -> assistant(tool_calls) -> tool -> assistant` 等协议消息，并从该账本构建每次模型请求。

上下文超限时不再直接删除旧消息。系统先按统一 Token 预算清理旧工具输出；仍无法满足预算时，生成经过结构校验的摘要并持久化 `compaction_completed` 事件。后续请求使用“当前 System Prompt + 压缩摘要 + 最近原始历史”作为模型视图，而 UI 仍保留完整展示历史。

旧会话不尝试伪造已经丢失的 Agent 内部调用顺序。首次继续旧会话时，将可见历史转换为安全的旧历史导入摘要，再从该边界开始记录规范化账本。迁移必须幂等，且不得修改或删除旧 UI 历史。

## 2. 目标

- 持久化模型真实看到的消息顺序，消除 UI 聚合历史造成的跨轮协议失真。
- 将 Compaction 建模为可持久化、可恢复、可观测的正式生命周期。
- 主 Agent、子 Agent 和 UI 使用同一个 Token 预算服务。
- 预算包含 System Prompt、Tool Schema、Skills、协议开销、输出预留和安全边际。
- 对 8K、32K、200K 等不同上下文窗口采用同一套动态策略。
- 在压缩前保存可恢复状态，防止任务目标、决策、文件和验证状态丢失。
- 保留完整 UI 展示历史，同时为模型生成独立的预算化视图。
- 兼容 OpenAI、Anthropic、Gemini 等现有 Provider 适配器。
- 旧会话迁移失败时安全降级，不损坏现有 `sessions.json`。
- 为崩溃恢复、模型切换、上下文溢出和重复压缩提供明确行为。

## 3. 非目标

- 第一阶段不实现 MiMo Code 式跨会话项目记忆、全文检索、Dream/Distill 或后台记忆 Agent。
- 不将所有 UI 状态改造成完整事件溯源系统；规范化账本只负责模型上下文和压缩恢复。
- 不保证从旧 UI 数据还原历史上从未持久化的中间 Assistant 响应。
- 不在第一阶段引入 SQLite、向量数据库或新的原生依赖。
- 不要求所有 Provider 使用完全相同的 tokenizer；真实 usage 优先，统一估算器负责发送前预算和回退。
- 不持久化流式 Token 增量和原始思维内容；只保存构建合法模型历史所需的数据。
- 不在本设计中重做聊天界面、输入区或设置页视觉设计。
- 不移除工具自身的分页和局部输出限制；全局预算不能替代工具级约束。

## 4. 当前实现与根因

### 4.1 当前链路

- `src/renderer/src/components/chat/hooks/useSendMessage.ts` 从 UI `ChatMessage` 重建 OpenAI 风格消息。
- `src/main/ipc/chat.handlers.ts` 再添加主进程构建的 System Prompt 并启动 `AgentRunner`。
- `src/main/agent/AgentRunner/index.ts` 在单次运行内维护真实的多步消息数组。
- `src/main/agent/ContextManager.ts` 在每轮采样前截断工具结果并删除旧消息。
- `src/main/services/SessionStore.ts` 将 UI 会话整体保存到 `sessions.json`。
- `src/main/tools/builtin/UpdateResumeStateTool.ts` 将 ResumeState 单独保存到 `agent-sessions/*.json`。
- `src/renderer/src/components/ContextTracker.tsx` 在 Renderer 内独立估算容量。
- `src/main/agent/SubAgentManager.ts` 按固定 32K 窗口裁剪子 Agent 上下文。

### 4.2 根因

一次 Agent 运行可能产生：

```text
user
assistant(tool_calls A)
tool(A)
assistant(tool_calls B)
tool(B)
assistant(final)
```

UI 为了展示会将这些步骤聚合进一条 Agent 消息。下一轮发送时，Renderer 只能把聚合卡片还原为：

```text
user
assistant(final + tool_calls A/B)
tool(A)
tool(B)
```

这两个序列语义不同。继续在该重建结果上增加摘要，只会把错误顺序写进摘要输入，无法形成可靠 Compaction。

### 4.3 当前裁剪的结构性问题

- 最近三轮绝对保护，单个近期大消息可能让裁剪无法达到目标。
- 工具输出至少允许 45,000 字符，小窗口模型可能在全局裁剪前已经溢出。
- 固定 40 条消息兜底与模型窗口无关。
- Token 预算不计算 Tool Schema、协议开销和输出预留。
- UI 与后端使用不同估算公式。
- 删除历史前不保证 ResumeState 已经成功保存。
- 循环上限框架快照可能覆盖更有价值的 ResumeState。
- 压缩结果没有持久化边界，重启后无法重建相同模型视图。
- Renderer 和主进程均构造 System Prompt，存在重复和漂移风险。

## 5. 对标研究结论

研究快照：

| 项目 | 快照 | 可验证机制 | CodeZ 采用内容 |
| --- | --- | --- | --- |
| OpenAI Codex | `54c44b9ed4c7d6d1ec9bf7897bb76f6411d8e033` | 版本化历史、真实 usage 与增量估算、Compaction 事件、持久化 replacement history、手动 `thread/compact/start` | 正式事件、历史版本、替换视图、压缩生命周期 |
| OpenCode | `0340a4ff7755b04c5ea0f2e55609e9e03b197ffe` | Message/Part 持久化、工具输出 pruning、摘要消息、`tail_start_id`、按 Token 保留尾部 | 工具输出先清理、摘要加原始尾部、动态预算 |
| Xiaomi MiMo Code | `521211f90d6c088bab36551fb45ca82ddb392f34` | Agent 范围隔离、压力分级、Checkpoint Writer、结构化会话检查点、重建上下文 | 结构化摘要字段、压缩前保存进度、Agent 范围隔离 |
| Claude Code | `15a21e1b4e240e2da6a4953d5f148a806c9c9bb2` 和官方文档 | `/compact`、自动压缩、自定义压缩说明、`PreCompact`/`PostCompact`、SubAgent 隔离 | 手动/自动触发、生命周期事件、可定制保留重点 |
| Aider | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | 后台异步摘要、递归压缩旧头部、保留最近尾部、摘要失败保留原历史 | 简单可靠的失败语义、摘要头部加原始尾部 |

关键资料：

- Codex：<https://github.com/openai/codex/tree/main/codex-rs/core/src>
- Codex App Server：<https://developers.openai.com/codex/app-server/>
- OpenCode：<https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts>
- MiMo Code：<https://github.com/XiaomiMiMo/MiMo-Code/tree/main/packages/opencode/src/session>
- Claude Code 成本与上下文：<https://code.claude.com/docs/en/costs>
- Claude Code Hooks：<https://code.claude.com/docs/en/hooks#precompact>
- Aider：<https://github.com/Aider-AI/aider/blob/main/aider/history.py>

### 5.1 结论边界

- Codex、OpenCode、MiMo Code 和 Aider 的结论来自公开源码。
- Claude Code 核心运行时没有在公开仓库中提供等价源码，因此只陈述官方文档和公开 Changelog 可验证的行为，不推断内部实现。
- MiMo Code 的 Checkpoint/Memory 系统明显超出 CodeZ v1 所需范围，本设计只采用其结构化恢复思想。

## 6. 设计原则

1. **主进程唯一所有权**：模型账本只能由主进程写入；Renderer 不能提交完整历史覆盖它。
2. **展示与推理分离**：UI 保存完整展示历史，模型使用独立的规范化和压缩视图。
3. **先持久化再推进**：影响后续模型上下文的消息和 Compaction 结果，必须先落盘再进入下一步。
4. **压缩成功后才切边界**：摘要生成、结构校验或落盘失败时，旧历史仍是有效历史。
5. **真实 usage 优先**：Provider usage 是已发生请求的权威值，估算器只用于预检和缺失数据回退。
6. **按 Token 保护，不按轮次绝对保护**：最近历史保留受预算约束，协议组不可拆分。
7. **协议不变量优先**：任何裁剪、迁移或恢复都不能产生孤立工具调用或工具结果。
8. **失败可解释**：溢出、摘要失败、迁移失败和账本损坏均有明确状态与用户可见结果。
9. **渐进迁移**：旧 UI 历史不做破坏性重写，新账本按会话惰性建立。
10. **范围隔离**：主 Agent 与每个子 Agent 使用独立上下文范围，不相互泄漏内部历史。

## 7. 总体架构

```text
Renderer user input
  -> Chat IPC (sessionId + new input only)
  -> SessionRuntimeCoordinator
  -> ModelLedgerStore.append(user_message)
  -> ModelContextBuilder
       -> SystemPromptService
       -> ContextBudgetService
       -> ModelHistoryNormalizer
       -> ToolOutputPruner
       -> CompactionService (when required)
  -> Provider adapter
  -> AgentRunner tool loop
       -> append assistant_message
       -> append tool_result
       -> emit UI runtime events
  -> append turn_completed / turn_interrupted
  -> Renderer updates display projection
```

### 7.1 SessionRuntimeCoordinator

职责：

- 按 `sessionId` 串行化物理账本追加；主 Agent 与多个子 Agent 可以并行执行，但它们产生的事件通过同一个短时写入队列排序。
- 接收新用户输入并创建 Turn。
- 调用 ContextBuilder 构建模型请求。
- 在 AgentRunner 与 ModelLedgerStore 之间协调持久化顺序。
- 将已经持久化的运行事件发送给 Renderer。
- 维护当前 Turn、历史版本和 Compaction 状态。

它不负责 Provider 格式转换、Token 估算或摘要内容生成。

### 7.2 ModelLedgerStore

职责：

- 追加和读取规范化账本事件。
- 校验事件序号、Schema 版本和单会话写入顺序。
- 从 Snapshot 基线加增量事件恢复各 scope 的活动模型历史。
- 在 Compaction 后安全生成 Snapshot 并轮转已消费日志前缀。
- 暴露 `historyVersion` 供 Compaction 做乐观并发检查。

### 7.3 ModelHistoryNormalizer

职责：

- 验证角色顺序。
- 保证 Assistant 工具调用与 Tool 结果一一配对。
- 合并 Provider 允许合并的连续消息。
- 对中断工具批次插入明确的合成错误结果，或丢弃未对模型生效的未完成调用。
- 生成 Provider 中立的合法模型消息序列。

Normalizer 不决定哪些历史需要压缩。

### 7.4 ContextBudgetService

职责：

- 读取模型上下文、输入和输出限制。
- 计算 System Prompt、Tool Schema、Skills、消息和协议开销。
- 预留普通输出、Thinking 和安全边际。
- 结合 Provider usage 与本地估算返回统一预算快照。
- 为主 Agent、子 Agent 和 Renderer 提供同一个结果。

### 7.5 ModelContextBuilder

职责：

- 动态构建唯一 System Prompt。
- 从账本物化活动模型历史。
- 调用 Normalizer、BudgetService、Pruner 和 CompactionService。
- 生成最终 Provider 中立请求。
- 返回预算明细和使用的历史版本。

Renderer 中现有的硬编码 System Prompt 将退出模型请求链路。

### 7.6 ToolOutputPruner

职责：

- 在正式 Compaction 前清理已完成用途的旧工具输出。
- 保护最近使用的工具结果、错误结果和明确标记为不可清理的工具。
- 保留工具名、调用参数摘要、结果状态、原长度和内容哈希。
- 只改变模型视图及账本 Snapshot，不删除 UI 展示中的完整输出。

### 7.7 CompactionService

职责：

- 判定压缩边界和最近尾部预算。
- 生成并验证结构化摘要。
- 合并已有摘要、ResumeState 和新增历史。
- 持久化 Compaction 生命周期事件。
- 对并发变化、Provider 溢出和无效摘要实施有限重试。

### 7.8 LegacySessionMigrationService

职责：

- 识别没有运行账本的旧会话。
- 根据 `sessions.json` 计算稳定源哈希。
- 将旧展示历史转换成安全的摘要输入，而不是伪造工具协议顺序。
- 创建一次性 `legacy_import_completed` 事件和初始 Snapshot。
- 保证重复执行得到相同结果。

## 8. 持久化设计

### 8.1 目录布局

```text
<userData>/
  sessions.json
  session-runtime/
    <sessionId>/
      ledger.jsonl
      snapshot.json
```

- `sessions.json` 继续保存 UI 展示历史、归档、删除、任务和计划关联。
- `ledger.jsonl` 保存 Snapshot 之后的增量模型事件。
- `snapshot.json` 保存最近一次已验证的多 scope 物化基线和 Compaction 边界。
- 不在 v1 新增数据库依赖。
- `SessionStore` 更新运行账本引用时必须将 `sessions.json` 改为同目录临时文件加原子替换，避免迁移引用只写入一部分。

### 8.2 SessionData 扩展

```ts
interface SessionRuntimeRef {
  schemaVersion: 2
  ledgerVersion: 1
  migratedAt?: string
  legacySourceHash?: string
  legacyImportMode?: 'summary' | 'recent-text-fallback'
}
```

`SessionData` 增加可选 `runtime?: SessionRuntimeRef`。没有该字段的会话仍按旧格式读取，直到首次继续对话时惰性迁移。

### 8.3 LedgerEvent 公共头

```ts
interface LedgerEvent<TType extends string, TPayload> {
  schemaVersion: 1
  eventId: string
  sessionId: string
  contextScopeId: string
  sequence: number
  historyVersion: number
  turnId?: string
  createdAt: string
  type: TType
  payload: TPayload
}
```

`contextScopeId` 对主 Agent 使用 `main`，对子 Agent 使用 `subagent:<runId>`。

`sequence` 在整个会话账本内对每一条事件严格递增。`historyVersion` 按 `contextScopeId` 独立维护，只在会改变该 scope 活动模型视图的事件上递增，包括用户消息、Assistant 消息、Tool 结果、中断规范化、有效 ResumeState 更新、旧会话导入和 Compaction 完成；`compaction_started`、`compaction_failed`、纯 usage 更新等生命周期事件沿用该 scope 当前版本。这样子 Agent 事件不会使主 Agent 的摘要候选失效，记录 Compaction 开始事件也不会使它自己的源版本立即失效。

### 8.4 Snapshot 结构

```ts
interface SessionRuntimeSnapshot {
  schemaVersion: 1
  sessionId: string
  throughSequence: number
  createdAt: string
  scopes: Record<string, {
    historyVersion: number
    activeMessages: NormalizedModelMessage[]
    latestCompaction?: CompactionSummaryV1
    resumeState?: VersionedResumeState
    lastCompletedTurnId?: string
  }>
}
```

Snapshot 的 `throughSequence` 是会话级事件水位。恢复时只重放序号更大的事件；即使崩溃发生在 Snapshot 替换之后、日志轮转之前，旧日志前缀也会因序号不大于水位而被安全忽略。

### 8.5 事件类型

| 事件 | 关键内容 |
| --- | --- |
| `user_message` | 用户文本、模型、Provider、附件引用、命令元数据 |
| `assistant_message` | 文本、工具调用、Provider 元数据、usage、完成状态 |
| `tool_result` | callId、工具名、模型可见结果、状态、完整结果引用或哈希 |
| `turn_completed` | stop reason、最终 usage、完成时间 |
| `turn_interrupted` | 中断原因、未完成 callId、恢复策略 |
| `resume_state_updated` | 版本化 ResumeState、覆盖序号、来源 |
| `compaction_started` | trigger、源版本、候选边界、预算 |
| `compaction_completed` | 摘要、合并后的 ResumeState、压缩边界、尾部起点、前后 Token、源哈希 |
| `compaction_failed` | 阶段、错误类别、是否可重试、保留的旧版本 |
| `legacy_import_completed` | 源哈希、导入模式、初始摘要和最近文本边界 |

### 8.6 写入和恢复规则

- 每个会话使用一个物理单写者队列，`sequence` 严格递增；各 scope 的 `historyVersion` 按各自模型视图变化单调递增。
- 影响下一次模型请求的事件必须先追加成功，再通知 UI 或进入下一采样步。
- 启动时忽略 JSONL 最后一条不完整记录，并记录恢复告警；中间损坏视为账本损坏。
- `compaction_completed` 或 `legacy_import_completed` 是活动模型边界的逻辑提交点；Snapshot 是可提升为新恢复基线的物化结果。
- Snapshot 使用同目录临时文件、刷新并原子替换。
- Snapshot 成功、覆盖所有持久化 scope 且通过重放验证后，才提升为新基线并轮转 `ledger.jsonl` 中已消费前缀。
- Snapshot 写入失败时保留完整账本且禁止日志轮转；恢复时从上一个 Snapshot 重放到最新逻辑提交点。
- 日志轮转只改变物理保存方式，不改变逻辑事件序号和历史版本。
- 账本写入失败时不调用模型，避免模型已经执行但历史无法恢复。

### 8.7 模型可见工具输出

账本持久化“模型实际看到的规范化结果”，而不是无限复制 UI 中的完整输出：

- 工具负责分页、结构化错误和首轮局部限制。
- ModelLedgerStore 保存经过工具级限制后的模型可见结果。
- UI 仍可保存完整展示结果或文件引用。
- ToolOutputPruner 在后续请求中将旧结果替换成带哈希和长度的摘要占位。

## 9. 请求和事件数据流

### 9.1 新用户消息

1. Renderer 创建或选择 `sessionId`。
2. Renderer 调用 Chat IPC，只发送 Provider、模型、`sessionId` 和本次用户输入。
3. 主进程完成旧会话迁移检查。
4. Coordinator 持久化 `user_message`。
5. ContextBuilder 从主进程账本构建请求。
6. Provider 开始采样。

过渡期 IPC 可以保留可选 `legacyMessages`，但只允许 LegacyMigrationService 消费一次；主链路不得继续依赖 Renderer 历史。

### 9.2 Assistant 与工具循环

1. Provider 完成一个 Assistant 步骤。
2. Coordinator 先持久化包含完整 tool calls 的 `assistant_message`。
3. 再向 UI 发出 Assistant/ToolStart 运行事件。
4. 每个工具执行结束后先持久化 `tool_result`，再发送 ToolEnd。
5. 下一轮采样从账本重新物化，不能只依赖 AgentRunner 的临时数组。
6. 最终响应持久化后追加 `turn_completed`。

流式文本增量仍可直接用于 UI。只有完成的 Assistant 协议消息进入模型账本；崩溃时通过 `turn_interrupted` 和 Normalizer 恢复合法边界。

### 9.3 重启恢复

1. 读取最新 Snapshot。
2. 重放 Snapshot 之后的合法事件。
3. 检测没有 `turn_completed` 的最后一个 Turn。
4. 将已落盘但未完成的工具批次标记为中断。
5. Normalizer 插入必要的合成错误结果，确保 Provider 序列合法。
6. UI 使用现有愈合逻辑显示中断状态；未来可从账本补建缺失的执行卡片。

## 10. 统一 Token 预算

### 10.1 模型能力输入

Provider/模型配置需要提供：

```ts
interface ModelContextCapabilities {
  contextWindowTokens: number
  maxInputTokens?: number
  maxOutputTokens?: number
  reasoningCountsAgainstContext?: boolean
}
```

### 10.2 预算公式

```text
hardInputLimit = maxInputTokens
              ?? contextWindowTokens - outputReserve

safetyMargin = clamp(hardInputLimit * 3%, 256, 2048)

usableInputBudget = hardInputLimit - safetyMargin

requestInput = systemPrompt
             + toolSchemas
             + skillsAndInstructions
             + protocolOverhead
             + activeHistory
             + currentInput
```

`outputReserve` 至少覆盖模型最大普通输出；启用固定 Thinking budget 时，还要覆盖 Thinking 与最小最终回答空间。Provider 若声明独立 input limit，则以该 limit 为准，不能重复扣除输出窗口。

### 10.3 数据来源优先级

1. Provider 返回的请求 usage。
2. Provider/模型专用 tokenizer 或计数接口。
3. CodeZ 统一的 CJK 感知估算器。

真实 usage 只描述已经发生的请求；新追加消息、Tool Schema 或动态 Prompt 使用估算值补齐。

### 10.4 默认压力等级

| 等级 | 条件 | 行为 |
| --- | --- | --- |
| 正常 | `< 70% usableInputBudget` | 正常构建 |
| 提醒 | `>= 70%` | UI 显示接近上限，不改变历史 |
| 清理 | `>= 80%` | 清理旧工具输出并重新预算 |
| 压缩 | `>= 90%`，或预测下一步超过硬限制 | 启动主动 Compaction |
| 溢出恢复 | Provider 返回 context overflow | 响应式 Compaction 后有限重试 |

阈值是默认策略，可按模型能力配置；硬输入限制始终不可超过。

### 10.5 最近历史预算

最近原始历史按 Token 保留：

```text
recentTailBudget = min(
  usableInputBudget * 35%,
  clamp(usableInputBudget * 25%, 1000, 8000)
)
```

- 优先从最新向前保留完整协议组。
- 不设置“最近三轮绝对保护”。
- Assistant tool calls 和对应 Tool results 必须成组保留或成组进入摘要区。
- 单个最新工具结果超限时先执行结构化 pruning。
- 当前尚未被模型处理的用户输入不得被摘要；如果它本身超过硬输入限制，直接返回可操作错误。

### 10.6 UI 预算快照

主进程返回：

```ts
interface ContextBudgetSnapshot {
  hardInputLimit: number
  usableInputBudget: number
  systemPromptTokens: number
  toolSchemaTokens: number
  instructionTokens: number
  protocolTokens: number
  summaryTokens: number
  recentHistoryTokens: number
  currentInputTokens: number
  outputReserveTokens: number
  safetyMarginTokens: number
  totalInputTokens: number
  pressureLevel: 'normal' | 'warning' | 'prune' | 'compact' | 'overflow'
  estimateSource: 'provider' | 'tokenizer' | 'heuristic'
  historyVersion: number
}
```

Renderer 的 ContextTracker 只展示该快照，不再自行估算 System Prompt、Skills 或消息 Token。

## 11. Tool Output Pruning

### 11.1 触发顺序

Pruning 始终早于正式 Compaction：

1. 工具自身分页和局部截断。
2. ContextBuilder 发现压力达到清理级别。
3. 从旧到新选择已完成用途的工具结果。
4. 保留最近工具结果、错误结果、Skill 内容和显式保护结果。
5. 将其模型视图替换为结构化占位。
6. 重新计算预算，仍超限才进入 Compaction。

### 11.2 占位格式

```json
{
  "status": "pruned",
  "tool": "Read",
  "originalTokens": 12400,
  "contentHash": "sha256:...",
  "note": "Older tool result removed from active model context; use the tool again with narrower arguments if needed."
}
```

错误结果默认不清理，因为错误通常较小且可能决定后续修复方向。

## 12. Compaction 设计

### 12.1 触发类型

- `auto_threshold`：主动达到压缩阈值。
- `provider_overflow`：Provider 已返回上下文超限。
- `manual`：用户显式执行 `/compact`，可附带保留重点。
- `model_downshift`：切换到更小上下文模型。
- `migration`：旧会话首次建立规范化边界。

### 12.2 状态机

```text
idle
  -> selecting_boundary
  -> summarizing
  -> validating
  -> committing
  -> completed

selecting_boundary / summarizing / validating / committing
  -> failed (old active history remains authoritative)
```

### 12.3 边界选择

- 记录开始时的 `historyVersion`。
- 当前用户输入和活动中的协议组位于保留区。
- 从最新历史向前填充 `recentTailBudget`。
- 边界必须位于完整用户 Turn 或完整工具协议组之前。
- 已有 Compaction 摘要作为旧摘要输入，不展开已经消费的原始历史。
- 如果没有足够可压缩头部，Compaction 不运行，返回“单个近期内容过大”等明确原因。

### 12.4 摘要 Schema

摘要由模型输出结构化 JSON，经 Schema 校验后再渲染为模型可见文本：

```ts
interface CompactionSummaryV1 {
  version: 1
  goal: {
    originalRequest?: string
    currentObjective: string
    requirements: string[]
    successCriteria: string[]
  }
  status: {
    phase: string
    completed: string[]
    inProgress: string[]
    nextActions: string[]
  }
  decisions: Array<{ decision: string; rationale?: string }>
  facts: Array<{ fact: string; evidence?: string }>
  files: Array<{
    path: string
    relevance: string
    state: 'read' | 'modified' | 'created' | 'deleted' | 'unknown'
  }>
  validation: Array<{
    commandOrCheck: string
    result: string
    status: 'passed' | 'failed' | 'pending'
  }>
  errors: Array<{ symptom: string; cause?: string; resolution?: string }>
  openQuestions: string[]
  userInstructions: string[]
  coveredThroughSequence: number
}
```

摘要不得包含：

- 无关闲聊和重复探索。
- 已经解决且不影响后续工作的原始长日志。
- 未经证据支持的完成声明。
- 大段文件正文或代码块；应保存路径、符号和必要事实。

### 12.5 生成输入

Compaction 模型输入包括：

- 固定的摘要系统指令。
- 上一次有效摘要。
- 本次被压缩的新增原始历史。
- 最新有效 ResumeState。
- 用户通过 `/compact` 提供的保留说明。
- 摘要 Schema 和输出上限。

摘要调用默认使用当前 Turn 模型、禁用工具，并设置独立输出上限。专用摘要模型属于后续可配置项，不是 v1 前置条件。

### 12.6 提交协议

1. 生成摘要候选。
2. 校验 JSON Schema、`coveredThroughSequence`、必需字段和大小。
3. 计算源事件范围哈希。
4. 获取会话写锁并比较 `historyVersion`。
5. 版本不一致时放弃候选，基于新历史重新选择边界；最多重试一次并发冲突。
6. 在内存中物化候选新视图并重新计算预算，必须达到压缩目标。
7. 追加 `compaction_completed`；该事件成功落盘即提交逻辑边界。
8. 生成并验证新 Snapshot；失败时保留完整账本并跳过日志轮转。
9. 发布 UI Compaction 完成事件和最新预算快照。
10. 自动触发时继续原 Turn；手动触发时回到空闲状态。

新模型视图为：

```text
current system prompt
+ deterministic summary rendering
+ retained recent original messages
+ current input / pending tool continuation
```

### 12.7 压缩目标与熔断

- 默认目标是压缩后输入不超过 `usableInputBudget` 的 55%。
- Provider overflow 恢复允许更激进地缩小最近尾部，但仍不拆协议组。
- 每个 Turn 最多执行 3 次 Compaction 尝试。
- 每次成功必须至少减少 20% 活动模型 Token，或直接降到目标值以下。
- 连续未达到最小收益时停止，返回可操作错误，防止压缩抖动和 API 消耗循环。

### 12.8 失败语义

- 摘要调用失败：追加 `compaction_failed`，旧历史保持有效。
- 摘要格式无效：允许一次结构修复重试，仍失败则保持旧历史。
- Snapshot 写入失败：逻辑边界仍可由已落盘完成事件恢复；记录缓存失败告警，保留完整旧日志并禁止轮转。
- Provider overflow 且没有可压缩头部：提示当前输入、附件或最新工具输出本身过大。
- 手动 Compaction 失败：向用户显示失败阶段，不删除任何历史。

## 13. ResumeState 版本化合并

### 13.1 状态元数据

```ts
interface VersionedResumeState {
  revision: number
  coveredThroughSequence: number
  source: 'explicit_tool' | 'compaction' | 'framework'
  updatedAt: string
  state: ResumeState
}
```

### 13.2 合并规则

- `coveredThroughSequence` 较新的候选优先。
- 覆盖序号相同时，优先级为 `explicit_tool > compaction > framework`。
- 数组字段按稳定顺序去重合并。
- `validationPending` 不能覆盖已经记录为通过或失败的验证结果。
- 没有新增证据的框架自动快照不能覆盖现有非空目标、阶段或下一步。
- Compaction 提交前生成最终合并状态，并与 `compaction_completed` 同一逻辑提交。
- `update_resume_state` 工具不再直接覆盖独立 JSON 文件，而是追加 `resume_state_updated`。

### 13.3 兼容现有文件

首次加载新账本时可以读取现有 `agent-sessions/*.json` 作为初始 `framework` 或 `explicit_tool` 状态。成功写入账本后，该文件只保留兼容读取，不再作为权威写入目标；最终移除将在单独迁移版本中完成。

现有状态中 `currentGoalId: 'auto-save'` 或 `currentPhase: 'auto-save-before-limit'` 按 `framework` 导入，其余由 `update_resume_state` 生成的状态按 `explicit_tool` 导入。

### 13.4 模型可见性

- ContextBuilder 将最新合并 ResumeState 渲染为有界的 `<resume_state>` 动态上下文块，而不是普通聊天消息。
- 如果当前 Compaction 摘要已经覆盖同一或更新的 ResumeState revision，ContextBuilder 不重复注入等价内容。
- Compaction 之后新产生的有效 ResumeState 会重新进入动态上下文，并使 `historyVersion` 递增。
- ResumeState 渲染使用固定字段顺序和 Token 上限；超出时优先保留目标、下一步、阻塞、修改文件和待验证项。

## 14. 旧会话迁移

### 14.1 为什么不能直接还原

旧 `ChatMessage` 只保存聚合后的 Agent 文本、ToolCall 列表和执行时间线，无法证明每个 ToolCall 属于哪一个 Assistant 模型响应。任何“猜测还原”都可能生成 Provider 不合法或语义错误的历史。

### 14.2 惰性迁移流程

1. 用户查看旧会话时不迁移，UI 行为不变。
2. 用户首次继续旧会话时计算展示历史源哈希。
3. 将旧历史序列化为纯文本迁移转录，工具调用以普通记录表示，不构造 tool protocol。
4. 在预算允许时调用 Compaction 摘要流程生成 `CompactionSummaryV1`。
5. 保留最近若干条纯 User/Agent 文本作为原始尾部，不携带不可信工具协议。
6. 写入 `legacy_import_completed` 和初始 Snapshot。
7. 更新 `SessionData.runtime`。
8. 从下一条用户消息开始记录完整规范化事件。

### 14.3 降级路径

如果迁移摘要调用不可用或失败：

- 生成有界的最近纯文本上下文。
- 不附加历史 tool calls 和 tool results。
- 标记 `legacyImportMode: 'recent-text-fallback'`。
- 保留 UI 全量历史，并提示模型上下文只恢复了最近可见内容。

### 14.4 幂等和安全

- `legacySourceHash` 相同且已有完成事件时不得重复迁移。
- 写入运行目录成功后才更新 `sessions.json` 引用。
- 更新引用失败时，下次通过相同源哈希识别已有运行数据并修复引用。
- 启动时扫描没有 SessionData 引用的运行目录；仅在 `sessionId` 和源哈希均匹配时修复引用，其他目录记录为孤立数据而不自动关联。
- 迁移流程不修改旧消息内容、ID、归档状态、任务或计划关联。

## 15. 主 Agent 与子 Agent

### 15.1 范围隔离

- 主 Agent 使用 `contextScopeId = 'main'`。
- 每个子 Agent 使用 `contextScopeId = 'subagent:<runId>'`。
- 子 Agent 初始任务、父级必要摘要和权限范围只注入一次。
- 子 Agent 内部工具历史不得自动进入主 Agent 模型历史。
- 子 Agent 完成后，父 Agent 只收到有界的结构化结果 Tool result。

### 15.2 统一服务

子 Agent 使用与主 Agent 相同的：

- ContextBudgetService。
- ModelHistoryNormalizer。
- ToolOutputPruner。
- CompactionService。

子 Agent 的模型窗口来自实际模型配置，不再固定为 32K。短生命周期子 Agent 可以只保留内存账本；需要跨重启恢复的后台子 Agent 使用同一运行目录中的独立 scope。具体持久化选择由子 Agent 定义声明，默认前台子 Agent不承诺跨重启继续。

## 16. IPC 与现有模块迁移

### 16.1 Chat Stream 请求

目标请求：

```ts
interface StreamRequestV2 {
  providerId: string
  model: string
  sessionId: string
  input: {
    text: string
    isSystem?: boolean
    commandMetadata?: unknown
  }
}
```

`messages` 从正常请求中移除。兼容期间只允许 LegacyMigrationService 接收旧格式。

### 16.2 新增主进程事件

- `chat:context-budget-updated`
- `chat:compaction-started`
- `chat:compaction-completed`
- `chat:compaction-failed`
- `chat:history-recovered`

### 16.3 ContextTracker

- 数据来源改为 `ContextBudgetSnapshot`。
- 显示硬输入限制、当前输入、输出预留、摘要和最近历史。
- 显示估算来源，避免把启发式值描述成精确 usage。
- Compaction 后立即使用主进程新快照刷新。

### 16.4 手动 Compaction

v1 提供 `/compact [保留说明]`：

- 解析后调用主进程 Compaction API。
- 运行中会话先等待当前不可分割协议步完成，或明确拒绝并提示稍后重试。
- 保留说明只影响本次摘要，不写入全局 System Prompt。
- UI 展示折叠的 Compaction 边界记录，不展开内部摘要调用过程。

## 17. Provider 适配

### 17.1 Provider 中立账本

账本继续使用接近现有 `ChatMessage` 的内部结构，但增加稳定 ID、状态、usage 和 Provider 元数据。Provider adapter 负责：

- OpenAI tool calls/results。
- Anthropic `tool_use`/`tool_result` 和 System Prompt 分离。
- Gemini functionCall/functionResponse、连续角色和 thought signature。

### 17.2 不变量

- ModelHistoryNormalizer 先产生内部合法序列。
- Provider adapter 只能做格式转换，不得重新解释 Compaction 边界。
- Provider 特有签名、缓存键和消息 ID 按模型兼容性保存。
- 切换模型或 Provider 时，如果旧 Provider 元数据不可复用，则在 Compaction 边界后重建兼容视图。

### 17.3 模型下调

切换到更小上下文模型时，在第一次新模型请求前：

1. 使用旧模型或当前可用模型生成摘要。
2. 按新模型限制重新计算预算。
3. 成功提交 Compaction 后再发送新模型请求。
4. 摘要失败且旧历史不适配新窗口时，阻止切换请求并保留原会话状态。

## 18. 并发与一致性

- 同一 `sessionId` 的物理日志追加通过一个短时写队列串行化；该队列不持有模型调用或工具执行期间的长锁。
- 同一 `sessionId + contextScopeId` 同时只允许一个活动模型 Turn；不同子 Agent scope 可以并行运行。
- Renderer 快速连续发送的输入进入会话队列，不得并行覆盖账本。
- Compaction 捕获目标 scope 的 `historyVersion`，提交前再次比较；其他 scope 的事件不使候选失效。
- 新用户输入到达正在摘要的会话时，摘要候选作废并重新选择边界。
- Tool 执行结束与用户取消竞争时，以先持久化的最终状态为准，后续事件必须引用它。
- UI 使用 `eventId` 去重，不能用“最后一条消息”推断对应关系。
- `sessionId + turnId + callId` 是工具生命周期的最小关联键。

## 19. 错误处理与可观测性

### 19.1 错误分类

- `LEDGER_WRITE_FAILED`
- `LEDGER_CORRUPTED`
- `SNAPSHOT_COMMIT_FAILED`
- `BUDGET_UNAVAILABLE`
- `CURRENT_INPUT_TOO_LARGE`
- `COMPACTION_SUMMARY_FAILED`
- `COMPACTION_SCHEMA_INVALID`
- `COMPACTION_STALE_VERSION`
- `COMPACTION_INSUFFICIENT_REDUCTION`
- `PROVIDER_CONTEXT_OVERFLOW`
- `LEGACY_MIGRATION_FAILED`

### 19.2 记录内容

日志记录：

- session/turn/scope/event ID。
- historyVersion 和事件序号。
- 预算分项和估算来源。
- Compaction trigger、边界、Token 前后值和耗时。
- 重试次数和熔断原因。

日志不得记录 API Key、完整敏感 Tool output、授权头或原始思维内容。

### 19.3 用户可见行为

- 自动 Compaction 成功：显示轻量边界记录，不打断当前任务。
- 手动 Compaction 成功：显示压缩前后容量。
- 可恢复失败：保留历史并继续或等待下一次触发。
- 无法继续：说明是当前输入过大、摘要失败、账本损坏还是 Provider 限制，给出对应操作。

## 20. 安全与隐私

- 运行账本位于 Electron `userData`，与现有会话数据采用相同本地信任边界。
- 模型账本只保存模型可见内容，不额外复制无关环境变量和凭据。
- 摘要生成使用当前 Provider，不引入新的第三方数据流。
- 调试日志只记录长度、哈希、类别和 ID，不输出完整工具结果。
- 物理删除会话时，同时删除对应运行目录；软删除期间保持可恢复。
- 路径和文件写入使用显式 UTF-8、平台安全路径 API 和原子替换。

## 21. 测试策略

### 21.1 ModelLedgerStore

- 会话事件 `sequence` 严格递增；各 scope 的 `historyVersion` 单调不减，且只随该 scope 活动模型视图变化递增。
- 并发追加按会话范围串行化。
- 最后一行部分写入可以恢复。
- 中间损坏不会静默跳过。
- Snapshot 原子提交和日志轮转在各崩溃点可恢复。
- 主 Agent 与子 Agent scope 隔离。

### 21.2 ModelHistoryNormalizer

- 单个和并行 tool calls。
- Assistant/Tool 成组关系。
- 中断工具批次。
- 孤立 Tool result。
- OpenAI、Anthropic、Gemini 序列约束。
- Compaction 边界不能拆分协议组。

### 21.3 ContextBudgetService

- 8K、32K、200K 模型。
- 独立 input/output limit。
- Thinking 开关和固定预算。
- Tool Schema、Skills 和协议开销计入。
- Provider usage 加新消息估算。
- UI Snapshot 与发送前预算完全相同。

### 21.4 ToolOutputPruner

- 最近结果、错误结果和保护工具不被错误清理。
- 旧大结果被替换为结构化占位。
- UI 原结果保持不变。
- 清理后仍超限时正确进入 Compaction。

### 21.5 CompactionService

- 自动、手动、Provider overflow、模型下调和迁移触发。
- 摘要 Schema 校验和一次修复重试。
- 旧摘要加新增头部的递归压缩。
- 最近尾部预算和单个巨大近期消息。
- 并发 historyVersion 变化使旧摘要作废。
- Snapshot 失败时完成事件仍可重放，且不会轮转旧日志。
- 最小 Token 降幅和三次熔断。
- 重启后物化结果与压缩完成时一致。

### 21.6 ResumeState

- 覆盖序号优先。
- 同序号来源优先级。
- 数组稳定去重。
- 框架空快照不能覆盖有效状态。
- Compaction 与 ResumeState 同步提交。
- 旧 ResumeState 文件一次性导入。

### 21.7 旧会话迁移

- 无工具、单工具、多轮工具和中断会话。
- 相同源哈希幂等。
- 迁移失败使用最近纯文本回退。
- `sessions.json` 更新失败后可修复引用。
- UI 消息、任务、计划和归档状态不变。

### 21.8 集成与端到端

- Renderer 不再发送完整历史。
- 一次多工具 Agent 运行重启后顺序不变。
- 自动 Compaction 后 Agent 能继续当前任务。
- 手动 `/compact` 保留用户指定重点。
- Provider context overflow 不形成无限重试。
- 切换到小窗口模型先压缩。
- 子 Agent 使用真实模型窗口且不泄漏内部历史。
- 应用崩溃后恢复活动 Turn 为合法协议序列。

## 22. 验收标准

- 新会话的模型历史完全来自主进程规范化账本。
- Renderer 不再构造或提交完整模型历史和 System Prompt。
- 任意 Assistant tool call 都有匹配结果或明确中断结果。
- 同一会话重启前后构建出的活动模型历史一致。
- Compaction 是持久化事件，失败不会删除或替换旧有效历史。
- 压缩后达到目标预算，或以明确错误和熔断停止。
- 最近历史按 Token 和协议组保护，不存在固定三轮绝对保护。
- 工具输出上限适配小窗口，不存在 45,000 字符硬下限。
- 固定 40 条消息限制被移除。
- UI、主 Agent 和子 Agent 的预算来自同一服务。
- 预算包含 System Prompt、Tool Schema、Skills、协议开销、输出预留和安全边际。
- 子 Agent 使用实际模型窗口，不再固定 32K。
- 旧会话迁移幂等且 UI 历史零损失。
- ResumeState 自动更新不会覆盖更新、更有证据的状态。
- OpenAI、Anthropic、Gemini 集成测试均满足消息协议约束。
- 现有会话、任务、计划、归档和删除功能无行为回归。

## 23. 实施分段原则

详细任务将在本设计确认后单独生成。实施必须按以下依赖顺序拆分：

1. 建立账本类型、存储和协议不变量测试。
2. 以影子模式记录新 Turn，对比当前 AgentRunner 临时历史。
3. 切换为主进程账本所有权和 Renderer V2 IPC。
4. 接入旧会话惰性迁移。
5. 建立统一 Token 预算和 UI Snapshot。
6. 接入 ToolOutputPruner。
7. 接入正式 Compaction 和版本化 ResumeState。
8. 接入模型下调、Provider overflow 恢复和手动 `/compact`。
9. 将子 Agent 切换到统一预算与独立 scope。
10. 完成崩溃恢复、打包和跨 Provider 回归测试。

每个阶段必须能独立运行测试，并保留 feature flag 回退到上一个稳定阶段。影子账本只比较历史，不改变模型请求；比较通过后才切换读路径。

## 24. 设计自检

- 文档没有待定占位符；v1 范围与非目标明确。
- 根因、架构和迁移方案一致：不再依赖 Renderer 重建模型历史。
- Compaction 在成功提交前不改变权威历史。
- 存储、预算、摘要、ResumeState 和子 Agent 的所有权边界明确。
- 旧会话无法恢复的信息被明确降级，没有伪造协议顺序。
- 小窗口、巨大近期消息、Provider overflow 和压缩抖动均有处理规则。
- UI 完整历史与模型压缩视图的职责没有混淆。
- 没有引入长期记忆、数据库或无关 UI 重构。
- 测试与验收标准覆盖主要风险和跨模块契约。
