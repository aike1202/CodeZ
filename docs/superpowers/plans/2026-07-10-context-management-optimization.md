# CodeZ 规范化模型账本与正式压缩实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CodeZ 的模型上下文所有权迁移到主进程持久化规范化账本，并提供可恢复、可观测、跨 Provider 一致的正式 Compaction，同时完整保留旧会话与 UI 展示历史。

**Architecture:** `SessionRuntimeCoordinator` 是会话运行时入口，使用 `ModelLedgerStore` 串行持久化各 scope 的模型事件；`ModelContextBuilder` 基于 Snapshot、增量账本、动态 System Prompt、统一 Token 预算和工具输出清理构建请求；`CompactionService` 以版本检查和逻辑提交事件替换已覆盖历史；Renderer 只发送当前输入并展示主进程预算快照。

**Tech Stack:** TypeScript 5.5、Electron 31、React 18、Zustand 5、Vitest 1.6、Node.js `fs/promises`、现有 OpenAI/Anthropic/Gemini Provider

## Global Constraints

- 主进程是规范化模型历史的唯一事实来源；Renderer 不得重建或发送完整模型历史与 System Prompt。
- `sessions.json` 继续保存完整 UI 展示历史；模型活动历史保存到 `session-runtime/<sessionId>/ledger.jsonl` 和 `snapshot.json`。
- 新会话直接创建 schema v2 运行时；旧会话仅在首次继续时惰性迁移，UI 消息不得修改、重排或丢失。
- 旧 UI 历史不能伪造 ToolCall 协议顺序；迁移只生成纯文本 transcript 摘要或有界的最近 User/Agent 文本。
- 每个会话只有一个短时物理写入队列；`sequence` 会话级严格递增，`historyVersion` 按 `contextScopeId` 独立递增。
- 主 Agent scope 固定为 `main`；子 Agent scope 使用 `subagent:<runId>`。
- 影响下一次模型请求的事件必须先持久化成功，再调用模型、执行下一协议步或通知 UI 完成。
- `compaction_completed` 是逻辑提交点；Snapshot 写入失败不得撤销逻辑提交，也不得轮转完整账本。
- Snapshot 必须使用同目录临时文件、刷新、原子替换，并以 `throughSequence` 忽略重复日志前缀。
- Token 预算必须包含 System Prompt、Tool Schema、Skills/Rules、协议开销、活动历史、当前输入、输出预留和安全边际。
- Token 数据来源优先级为 Provider usage、专用 tokenizer、统一 CJK 感知启发式估算。
- 压力默认阈值固定为 70% 提醒、80% 工具输出清理、90% 或预测溢出时压缩。
- 最近尾部按 Token 和完整协议组选择，不设置固定“最近三轮”保护。
- 当前尚未被模型处理的用户输入不得进入摘要；单条输入超过硬限制时返回 `CURRENT_INPUT_TOO_LARGE`。
- Pruning 只改变模型可见副本，保留结构化占位、哈希和错误信息；UI 完整工具输出不变。
- Compaction 默认将输入降到 `usableInputBudget` 的 55% 以下；单 Turn 最多 3 次，每次至少减少 20% 或达到目标。
- ResumeState 合并按覆盖序号和 `explicit_tool > compaction > framework` 证据优先级执行。
- OpenAI、Anthropic、Gemini 的格式转换位于 Provider adapter；adapter 不得改变 Compaction 边界。
- 功能按影子写入、主进程读路径、正式压缩三个开关分阶段启用，影子阶段不改变现有模型请求。
- 不引入数据库、长期记忆系统、新 tokenizer 依赖或与上下文管理无关的 UI 重构。
- PowerShell 读取或输出仓库中文文本前按 `AGENTS.md` 初始化 UTF-8；手工编辑使用 `apply_patch`。
- 实施者仅在获得用户提交授权后执行本文的 Git 提交命令；未授权时仍按提交检查点保持改动边界。

## File Structure

- `src/shared/types/context.ts`: 规范化消息、账本事件、Snapshot、预算、压缩和错误公共契约。
- `src/shared/types/provider.ts`: 模型输入/输出能力、Provider usage 和结构化流错误。
- `src/shared/types/session.ts`: 可选的 schema v2 运行时引用。
- `src/main/services/context/ContextFeatureFlags.ts`: 影子写、主读路径和正式压缩开关。
- `src/main/services/context/ModelHistoryNormalizer.ts`: 协议校验、中断修复和安全尾部边界选择。
- `src/main/services/context/ModelLedgerStore.ts`: JSONL 追加、重放、Snapshot 和安全轮转。
- `src/main/services/context/SessionRuntimeCoordinator.ts`: Turn/scope 生命周期和会话单写者协调。
- `src/main/services/context/LegacySessionMigrationService.ts`: 旧 UI 会话 transcript 摘要、降级与幂等迁移。
- `src/main/services/context/ContextBudgetService.ts`: 统一 Token 估算、能力计算和压力分级。
- `src/main/services/context/ToolOutputPruner.ts`: 模型可见工具输出结构化清理。
- `src/main/services/context/ResumeStateManager.ts`: ResumeState 导入、版本化合并和有界渲染。
- `src/main/services/context/CompactionSummary.ts`: 摘要提示、结构校验和确定性渲染。
- `src/main/services/context/CompactionService.ts`: 边界选择、摘要调用、版本检查和逻辑提交。
- `src/main/services/context/ModelContextBuilder.ts`: 动态 Prompt、摘要、尾部和当前输入的最终模型视图。
- `src/main/services/context/index.ts`: 进程级服务装配和测试可注入工厂。
- `src/main/agent/AgentRunner/index.ts`: 使用账本驱动的 Assistant/Tool/Turn 持久化循环。
- `src/main/agent/SubAgentManager.ts`: 独立 scope 与真实模型能力。
- `src/main/services/chat/*.ts`: usage 采集、Provider 错误分类和协议 adapter。
- `src/main/ipc/chat.handlers.ts`: Chat Stream V2、手动压缩和生命周期事件。
- `src/preload/index.ts`: V2 请求和预算/压缩订阅 API。
- `src/renderer/src/components/chat/hooks/useSendMessage.ts`: 只发送本次输入和命令元数据。
- `src/renderer/src/components/ContextTracker.tsx`: 只展示主进程 `ContextBudgetSnapshot`。
- `src/renderer/src/stores/chatStore/slices/contextSlice.ts`: 每会话预算和压缩 UI 状态。

---

### Task 1: 定义共享上下文、账本和模型能力契约

**Files:**
- Create: `src/shared/types/context.ts`
- Modify: `src/shared/types/provider.ts`
- Modify: `src/shared/types/session.ts`
- Modify: `src/shared/types/index.ts`
- Modify: `src/main/agent/ContextManager.ts`
- Test: `src/tests/context-contracts.test.ts`

**Interfaces:**
- Produces: `NormalizedModelMessage`、`ModelContextItem`、`LedgerEvent`、`SessionRuntimeSnapshot`、`ContextBudgetSnapshot`、`CompactionSummaryV1`、`ResumeState`、`VersionedResumeState`、`ModelContextCapabilities`、`ProviderTokenUsage`。
- Consumes: 现有 `ChatMessage`、`ToolCall` 和 Main 层 `ResumeState` 字段语义。

- [ ] **Step 1: 写失败的共享契约测试**

```typescript
import { describe, expect, it } from 'vitest'
import {
  MAIN_CONTEXT_SCOPE,
  contextScopeForSubAgent,
  eventChangesHistory,
  type ContextBudgetSnapshot,
  type SessionRuntimeSnapshot
} from '../shared/types/context'

describe('context contracts', () => {
  it('使用稳定的主/子代理 scope id', () => {
    expect(MAIN_CONTEXT_SCOPE).toBe('main')
    expect(contextScopeForSubAgent('run-7')).toBe('subagent:run-7')
  })

  it('只有模型视图事件推进 historyVersion', () => {
    expect(eventChangesHistory('user_message')).toBe(true)
    expect(eventChangesHistory('compaction_completed')).toBe(true)
    expect(eventChangesHistory('compaction_started')).toBe(false)
    expect(eventChangesHistory('turn_completed')).toBe(false)
  })

  it('预算与 snapshot 类型可由最小合法值构造', () => {
    const budget: ContextBudgetSnapshot = {
      hardInputLimit: 7000, usableInputBudget: 6744,
      systemPromptTokens: 10, toolSchemaTokens: 10, instructionTokens: 10,
      protocolTokens: 10, summaryTokens: 0, recentHistoryTokens: 10,
      currentInputTokens: 10, outputReserveTokens: 1000, safetyMarginTokens: 256,
      totalInputTokens: 60, pressureLevel: 'normal', estimateSource: 'heuristic', historyVersion: 1
    }
    const snapshot: SessionRuntimeSnapshot = {
      schemaVersion: 1, sessionId: 's1', throughSequence: 0,
      createdAt: '2026-07-10T00:00:00.000Z', scopes: {}
    }
    expect(budget.usableInputBudget).toBe(6744)
    expect(snapshot.schemaVersion).toBe(1)
  })
})
```

- [ ] **Step 2: 验证测试因模块不存在而失败**

Run: `npm test -- src/tests/context-contracts.test.ts`

Expected: FAIL，提示无法解析 `../shared/types/context`。

- [ ] **Step 3: 添加稳定公共类型和事件判定函数**

`context.ts` 至少包含以下可执行契约；事件 payload 使用判别联合，不能使用无约束 `any`：

```typescript
export const MAIN_CONTEXT_SCOPE = 'main'
export const CONTEXT_SCHEMA_VERSION = 1 as const

export type ContextScopeId = typeof MAIN_CONTEXT_SCOPE | `subagent:${string}`
export type LedgerEventType =
  | 'user_message' | 'assistant_message' | 'tool_result'
  | 'turn_completed' | 'turn_interrupted' | 'resume_state_updated'
  | 'compaction_started' | 'compaction_completed' | 'compaction_failed'
  | 'legacy_import_completed'

const HISTORY_EVENT_TYPES = new Set<LedgerEventType>([
  'user_message', 'assistant_message', 'tool_result', 'turn_interrupted',
  'resume_state_updated', 'compaction_completed', 'legacy_import_completed'
])

export function contextScopeForSubAgent(runId: string): ContextScopeId {
  if (!runId.trim()) throw new Error('runId is required')
  return `subagent:${runId}`
}

export function eventChangesHistory(type: LedgerEventType): boolean {
  return HISTORY_EVENT_TYPES.has(type)
}

export interface NormalizedToolCall {
  id: string
  name: string
  arguments: string
  thoughtSignature?: string
}

export interface NormalizedModelMessage {
  id: string
  turnId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: NormalizedToolCall[]
  toolCallId?: string
  name?: string
  status: 'complete' | 'interrupted'
  createdAt: string
}

export interface ModelContextItem {
  kind: 'system' | 'compaction_summary' | 'resume_state' | 'user' | 'assistant' | 'tool'
  message: NormalizedModelMessage | { role: 'system'; content: string }
}

export interface LedgerEvent<TType extends LedgerEventType = LedgerEventType, TPayload = unknown> {
  schemaVersion: 1
  eventId: string
  sessionId: string
  contextScopeId: ContextScopeId
  sequence: number
  historyVersion: number
  turnId?: string
  createdAt: string
  type: TType
  payload: TPayload
}
```

同文件加入设计文档中的 `SessionRuntimeSnapshot`、`ContextBudgetSnapshot`、`CompactionSummaryV1`、`VersionedResumeState`、Compaction trigger/error code。把当前 `ContextManager.ts` 中的 `GoalSnapshot`、`TaskPlan`、`ResumeState` 移到该共享文件，并给 `ResumeState` 增加可选 `validationResults: Array<{ commandOrCheck: string; status: 'passed' | 'failed'; result?: string }>`；`ContextManager.ts` 从共享层导入并重新导出这些类型，保持现有导入方兼容。`SessionData` 加入：

```typescript
export interface SessionRuntimeRef {
  schemaVersion: 2
  ledgerVersion: 1
  migratedAt?: string
  legacySourceHash?: string
  legacyImportMode?: 'summary' | 'recent-text-fallback'
}
```

`ModelConfig` 保留 `maxContextTokens` 兼容字段并新增可选 `maxInputTokens`、`maxOutputTokens`、`reasoningCountsAgainstContext`。统一 usage 使用 `inputTokens`、`outputTokens`、`reasoningTokens?`、`totalTokens?`，不要继续扩散 `promptTokens/completionTokens` 命名。

- [ ] **Step 4: 导出契约并完成类型验证**

Run: `npm test -- src/tests/context-contracts.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS；旧 Provider 和 Session 数据仍结构兼容。

- [ ] **Step 5: 提交检查点**

Run: `git add src/shared/types/context.ts src/shared/types/provider.ts src/shared/types/session.ts src/shared/types/index.ts src/main/agent/ContextManager.ts src/tests/context-contracts.test.ts`

Run: `git commit -m "feat(context): define ledger and budget contracts"`

---

### Task 2: 实现协议规范化和安全边界选择

**Files:**
- Create: `src/main/services/context/ModelHistoryNormalizer.ts`
- Test: `src/tests/model-history-normalizer.test.ts`

**Interfaces:**
- Consumes: `NormalizedModelMessage`。
- Produces: `normalizeRecoveredHistory()`、`assertProtocolInvariant()`、`selectProtocolSafeTail()`、`toProviderNeutralMessages()`。

- [ ] **Step 1: 写协议不变量失败测试**

```typescript
import { describe, expect, it } from 'vitest'
import { ModelHistoryNormalizer } from '../main/services/context/ModelHistoryNormalizer'
import type { NormalizedModelMessage } from '../shared/types/context'

const msg = (value: Partial<NormalizedModelMessage>): NormalizedModelMessage => ({
  id: value.id || crypto.randomUUID(), turnId: value.turnId || 't1',
  role: value.role || 'user', content: value.content || '', status: value.status || 'complete',
  createdAt: '2026-07-10T00:00:00.000Z', ...value
})

describe('ModelHistoryNormalizer', () => {
  it('为崩溃时未完成的 tool call 生成明确中断结果', () => {
    const history = [msg({ role: 'user', content: 'read' }), msg({
      role: 'assistant', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }]
    })]
    const normalized = ModelHistoryNormalizer.normalizeRecoveredHistory(history)
    expect(normalized.at(-1)).toMatchObject({
      role: 'tool', toolCallId: 'c1', name: 'Read', status: 'interrupted'
    })
    expect(() => ModelHistoryNormalizer.assertProtocolInvariant(normalized)).not.toThrow()
  })

  it('尾部边界不拆分 assistant tool_calls 与 tool results', () => {
    const history = [
      msg({ id: 'u1', role: 'user', content: 'old', turnId: 't1' }),
      msg({ id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }], turnId: 't1' }),
      msg({ id: 'r1', role: 'tool', toolCallId: 'c1', name: 'Read', content: 'ok', turnId: 't1' }),
      msg({ id: 'a2', role: 'assistant', content: 'done', turnId: 't1' })
    ]
    const tail = ModelHistoryNormalizer.selectProtocolSafeTail(history, 2, () => 1)
    expect(tail.map((item) => item.id)).toEqual(['a1', 'r1', 'a2'])
  })
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/model-history-normalizer.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现分组、校验和恢复规范化**

实现时先把历史解析为 `user turn` 与 `assistant + all tool results` 协议组，再按组选择尾部。中断结果使用稳定 JSON：

```typescript
const INTERRUPTED_RESULT = JSON.stringify({
  ok: false,
  error: { code: 'EXECUTION_INTERRUPTED', message: 'Tool execution was interrupted before a durable result was recorded.' }
})
```

校验必须拒绝以下情况：重复 callId、Tool result 无对应 call、同一 call 多个 result、未结束协议组后出现新 User。恢复函数只允许为账本中真实存在但未完成的 call 添加 `interrupted` result，不得猜测旧 UI 聚合历史。

- [ ] **Step 4: 运行聚焦测试和类型检查**

Run: `npm test -- src/tests/model-history-normalizer.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/ModelHistoryNormalizer.ts src/tests/model-history-normalizer.test.ts`

Run: `git commit -m "feat(context): normalize model protocol history"`

---

### Task 3: 实现持久化 JSONL 账本与 Snapshot 恢复

**Files:**
- Create: `src/main/services/context/atomicFile.ts`
- Create: `src/main/services/context/ModelLedgerStore.ts`
- Test: `src/tests/model-ledger-store.test.ts`

**Interfaces:**
- Consumes: `LedgerEvent`、`SessionRuntimeSnapshot`、`eventChangesHistory()`。
- Produces: `append()`、`load()`、`writeSnapshot()`、`compactPhysicalLog()`、`getScopeState()`。

- [ ] **Step 1: 写存储、并发和崩溃恢复失败测试**

```typescript
import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { ModelLedgerStore } from '../main/services/context/ModelLedgerStore'

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

describe('ModelLedgerStore', () => {
  it('并发 scope 共用严格递增 sequence，但独立推进 historyVersion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-ledger-')); dirs.push(root)
    const store = new ModelLedgerStore(root)
    const [main, sub] = await Promise.all([
      store.append('s1', 'main', 'user_message', { message: { id: 'u1' } }, 't1'),
      store.append('s1', 'subagent:r1', 'user_message', { message: { id: 'u2' } }, 't2')
    ])
    expect([main.sequence, sub.sequence].sort()).toEqual([1, 2])
    expect(main.historyVersion).toBe(1)
    expect(sub.historyVersion).toBe(1)
  })

  it('忽略日志末尾半条 JSON，但拒绝中间损坏', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-ledger-')); dirs.push(root)
    const store = new ModelLedgerStore(root)
    await store.append('s1', 'main', 'user_message', { message: { id: 'u1' } }, 't1')
    await appendFile(store.ledgerPath('s1'), '{"schemaVersion":1', 'utf8')
    const loaded = await new ModelLedgerStore(root).load('s1')
    expect(loaded.throughSequence).toBe(1)
    expect(loaded.warnings).toContain('TRUNCATED_FINAL_RECORD')
    expect(JSON.parse((await readFile(store.ledgerPath('s1'), 'utf8')).split('\n')[0]).sequence).toBe(1)
  })
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/model-ledger-store.test.ts`

Expected: FAIL，存储类尚不存在。

- [ ] **Step 3: 实现会话单写者、重放和原子 Snapshot**

核心类保持短锁，Promise 队列不得覆盖失败：

```typescript
export class ModelLedgerStore {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly states = new Map<string, LoadedSessionRuntime>()

  constructor(private readonly runtimeRoot: string) {}

  append<T extends LedgerEventType>(
    sessionId: string,
    scopeId: ContextScopeId,
    type: T,
    payload: LedgerPayloadByType[T],
    turnId?: string
  ): Promise<LedgerEvent<T, LedgerPayloadByType[T]>> {
    return this.enqueue(sessionId, async () => {
      const state = await this.ensureLoaded(sessionId)
      const scope = state.ensureScope(scopeId)
      const event = createLedgerEvent(state, scope, type, payload, turnId)
      await appendFile(this.ledgerPath(sessionId), `${JSON.stringify(event)}\n`, 'utf8')
      applyLedgerEvent(state, event)
      return event
    })
  }
}
```

`atomicWriteJson()` 写入同目录唯一临时文件，打开文件句柄后 `sync()`，关闭后用单次 `rename(temp, target)` 原子替换；替换失败时保留原目标并清理临时文件，不执行“先删除目标”的降级。Snapshot 物化后从旧 Snapshot 重放验证，再允许按 `throughSequence` 轮转日志。

- [ ] **Step 4: 增加 Snapshot 失败测试并验证不轮转**

为 `ModelLedgerStore` 注入 `AtomicFileOps`，令 `rename` 抛错；断言 `writeSnapshot()` 失败后 `ledger.jsonl` 仍包含所有事件，重新实例化可恢复到最新 `compaction_completed`。

Run: `npm test -- src/tests/model-ledger-store.test.ts`

Expected: PASS，包括尾部损坏、Snapshot 水位去重、多 scope 和写入失败用例。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/atomicFile.ts src/main/services/context/ModelLedgerStore.ts src/tests/model-ledger-store.test.ts`

Run: `git commit -m "feat(context): persist model event ledger"`

---

### Task 4: 原子化 SessionStore 并接入运行时引用

**Files:**
- Modify: `src/main/services/SessionStore.ts`
- Modify: `src/main/ipc/session.handlers.ts`
- Modify: `src/main/index.ts`
- Test: `src/tests/session-store-runtime.test.ts`

**Interfaces:**
- Consumes: `SessionRuntimeRef`、`atomicWriteJson()`。
- Produces: 可测试构造器、`setRuntimeRef()`、`findRuntimeRef()`、原子 `sessions.json` 保存。

- [ ] **Step 1: 写 UI 历史零损失和运行时引用测试**

```typescript
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { SessionStore } from '../main/services/SessionStore'

describe('SessionStore runtime schema', () => {
  let root = ''
  afterEach(async () => root && rm(root, { recursive: true, force: true }))

  it('更新 runtime 引用时原样保留 UI messages', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'codez-session-'))
    const file = path.join(root, 'sessions.json')
    const store = new SessionStore(file)
    await store.save({ id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages: [{ id: 'm1', role: 'agent', content: '完整 UI 输出' }] })
    await store.setRuntimeRef('s1', { schemaVersion: 2, ledgerVersion: 1, migratedAt: '2026-07-10T00:00:00.000Z' })
    const reloaded = new SessionStore(file); await reloaded.load()
    expect(reloaded.get('s1')?.messages).toEqual([{ id: 'm1', role: 'agent', content: '完整 UI 输出' }])
    expect(reloaded.get('s1')?.runtime?.schemaVersion).toBe(2)
    expect(JSON.parse(await readFile(file, 'utf8')).sessions).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/session-store-runtime.test.ts`

Expected: FAIL，因为构造器不接受路径且没有 `setRuntimeRef()`。

- [ ] **Step 3: 修改 SessionStore**

构造器使用 `constructor(filePath = path.join(app.getPath('userData'), SESSIONS_FILE))`；所有写入经过类内串行队列和 `atomicWriteJson`。`setRuntimeRef()` 必须先验证会话存在，生成不可变副本，再持久化；写失败时恢复旧 cache 并向调用方抛错，不能只 `console.error` 后吞掉失败。

新增 `initializeSessionStore()` 并在 `app.whenReady()` 的异步初始化中、注册 Session/Chat IPC 之前等待完成；初始化完成后 `getSessionStore()` 保持同步读取，初始化前调用则抛出明确错误。这样 AgentRunner 和迁移服务不会观察到尚未加载的空 cache。

- [ ] **Step 4: 运行 Session 相关回归测试**

Run: `npm test -- src/tests/session-store-runtime.test.ts src/tests/task-session-restore.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/SessionStore.ts src/main/ipc/session.handlers.ts src/main/index.ts src/tests/session-store-runtime.test.ts`

Run: `git commit -m "feat(context): persist session runtime references atomically"`

---

### Task 5: 建立 SessionRuntimeCoordinator 和影子账本开关

**Files:**
- Create: `src/main/services/context/ContextFeatureFlags.ts`
- Create: `src/main/services/context/SessionRuntimeCoordinator.ts`
- Create: `src/main/services/context/index.ts`
- Modify: `src/main/agent/AgentRunner/types.ts`
- Modify: `src/main/agent/AgentRunner/index.ts`
- Test: `src/tests/session-runtime-coordinator.test.ts`
- Test: `src/tests/agent-runner-ledger-shadow.test.ts`

**Interfaces:**
- Consumes: `ModelLedgerStore`、Normalizer、现有 AgentRunner tool loop。
- Produces: `beginTurn()`、`recordAssistant()`、`recordToolResult()`、`completeTurn()`、`interruptTurn()`、`getScopeView()`。

- [ ] **Step 1: 写生命周期顺序测试**

```typescript
it('先持久化 assistant/tool 事件再发布观察回调', async () => {
  const calls: string[] = []
  const ledger = fakeLedger({ onAppend: (type) => calls.push(`persist:${type}`) })
  const runtime = new SessionRuntimeCoordinator(ledger)
  const turn = await runtime.beginTurn({ sessionId: 's1', contextScopeId: 'main', text: 'read', providerId: 'p1', model: 'm1' })
  await runtime.recordAssistant(turn, { content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }] })
  calls.push('ui:tool-start')
  await runtime.recordToolResult(turn, { callId: 'c1', name: 'Read', content: 'ok', status: 'success' })
  calls.push('ui:tool-end')
  expect(calls).toEqual([
    'persist:user_message', 'persist:assistant_message', 'ui:tool-start',
    'persist:tool_result', 'ui:tool-end'
  ])
})
```

另加测试：同一 `sessionId + scope` 第二个活动 Turn 被拒绝；不同子 scope 可并发；`interruptTurn()` 为未完成 call 写入明确中断事件。

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/session-runtime-coordinator.test.ts`

Expected: FAIL，Coordinator 尚不存在。

- [ ] **Step 3: 实现 Coordinator 和三段开关**

```typescript
export interface ContextFeatureFlags {
  shadowLedger: boolean
  authoritativeLedger: boolean
  compaction: boolean
}

export function readContextFeatureFlags(env = process.env): ContextFeatureFlags {
  return {
    shadowLedger: env.CODEZ_CONTEXT_SHADOW_LEDGER !== '0',
    authoritativeLedger: env.CODEZ_CONTEXT_AUTHORITATIVE_LEDGER === '1',
    compaction: env.CODEZ_CONTEXT_COMPACTION === '1'
  }
}
```

影子模式下 AgentRunner 仍使用现有 `allMessages` 请求模型，但把本轮真实 User、Assistant tool calls、Tool result 和最终 Assistant 按发生顺序写账本。影子写失败只记录结构化诊断并继续旧路径；权威模式在 Task 14 切换为 fail-closed。

每轮结束比较“本轮 AgentRunner 后缀”与账本物化后缀，记录 role、callId、tool name、内容哈希差异，不记录完整敏感正文。

- [ ] **Step 4: 验证影子模式不改变模型请求**

`agent-runner-ledger-shadow.test.ts` 注入 fake ChatService 和 fake Coordinator，断言传给 ChatService 的 `messages` 与开关关闭时完全一致，同时账本收到正确事件顺序。

Run: `npm test -- src/tests/session-runtime-coordinator.test.ts src/tests/agent-runner-ledger-shadow.test.ts src/tests/agent-runner-tool-result.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/ContextFeatureFlags.ts src/main/services/context/SessionRuntimeCoordinator.ts src/main/services/context/index.ts src/main/agent/AgentRunner/types.ts src/main/agent/AgentRunner/index.ts src/tests/session-runtime-coordinator.test.ts src/tests/agent-runner-ledger-shadow.test.ts`

Run: `git commit -m "feat(context): shadow model turns into durable ledger"`

---

### Task 6: 实现旧会话惰性迁移和安全降级

**Files:**
- Create: `src/main/services/context/LegacySessionMigrationService.ts`
- Create: `src/main/services/context/LegacyTranscript.ts`
- Test: `src/tests/legacy-session-migration.test.ts`

**Interfaces:**
- Consumes: `SessionStore`、`ModelLedgerStore`、旧 `SessionData.messages`、可注入 `LegacySummaryClient`。
- Produces: `ensureMigrated(sessionId)`，写入 `legacy_import_completed`、初始 Snapshot 和 `SessionData.runtime`。

- [ ] **Step 1: 写迁移幂等与降级失败测试**

```typescript
describe('LegacySessionMigrationService', () => {
  it('把旧 UI 卡片序列化为纯文本而不伪造 tool 协议', async () => {
    const session = legacySession([
      { id: 'u1', role: 'user', content: '检查文件' },
      { id: 'a1', role: 'agent', content: '已检查', toolCalls: [{ id: 'c1', name: 'Read', result: 'full output' }] }
    ])
    const client = { summarize: vi.fn().mockResolvedValue(validSummary(2)) }
    const result = await createMigration({ session, client }).ensureMigrated('s1')
    expect(client.summarize.mock.calls[0][0].transcript).toContain('User: 检查文件')
    expect(client.summarize.mock.calls[0][0].transcript).toContain('Agent: 已检查')
    expect(client.summarize.mock.calls[0][0].transcript).not.toContain('tool_call_id')
    expect(result.mode).toBe('summary')
  })

  it('摘要失败时只保留有界最近纯文本且重复调用不重复导入', async () => {
    const fixture = createMigration({ client: { summarize: vi.fn().mockRejectedValue(new Error('offline')) } })
    const first = await fixture.service.ensureMigrated('s1')
    const second = await fixture.service.ensureMigrated('s1')
    expect(first.mode).toBe('recent-text-fallback')
    expect(second.eventId).toBe(first.eventId)
    expect(fixture.ledger.eventsOfType('legacy_import_completed')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/legacy-session-migration.test.ts`

Expected: FAIL，迁移服务尚不存在。

- [ ] **Step 3: 实现源哈希、摘要和引用提交顺序**

源哈希使用稳定 JSON 序列化后的 `sha256(session.id + projectId + messages)`；transcript 只包含 `User:`、`Agent:`、`System note:` 文本和工具名称/状态概述，不包含工具协议字段或完整长输出。

提交顺序必须是：创建运行目录 → 写 `legacy_import_completed` → 写并重放验证 Snapshot → `SessionStore.setRuntimeRef()`。如果最后一步失败，运行目录保留；下一次调用按 `sessionId + legacySourceHash` 修复引用，不重复摘要。

降级尾部使用统一估算器限制到迁移预算，从最新向前保留 User/Agent 文本；以普通 `user`/`assistant` 消息保存，不生成 Tool role。

- [ ] **Step 4: 验证损坏、引用修复与 UI 零损失**

加入 `sessions.json` 引用写失败后重试修复、源哈希变化后重新迁移、已有 schema v2 直接返回的用例。

Run: `npm test -- src/tests/legacy-session-migration.test.ts src/tests/session-store-runtime.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/LegacySessionMigrationService.ts src/main/services/context/LegacyTranscript.ts src/tests/legacy-session-migration.test.ts`

Run: `git commit -m "feat(context): migrate legacy sessions safely"`

---

### Task 7: 采集 Provider usage 并分类上下文溢出

**Files:**
- Modify: `src/main/services/chat/types.ts`
- Create: `src/main/services/chat/errors.ts`
- Modify: `src/main/services/chat/retry.ts`
- Modify: `src/main/services/chat/OpenAIProvider.ts`
- Modify: `src/main/services/chat/AnthropicProvider.ts`
- Modify: `src/main/services/chat/GeminiProvider.ts`
- Test: `src/tests/chat-provider-usage.test.ts`
- Modify: `src/tests/chat-retry.test.ts`

**Interfaces:**
- Consumes: `ProviderTokenUsage`、`ChatProviderErrorCode`。
- Produces: `StreamCallbacks.onUsage()` 和 `onError(message, code?)`。

- [ ] **Step 1: 写三 Provider usage 映射测试**

```typescript
import { extractOpenAIUsage } from '../main/services/chat/OpenAIProvider'
import { extractAnthropicUsage } from '../main/services/chat/AnthropicProvider'
import { extractGeminiUsage } from '../main/services/chat/GeminiProvider'
import { classifyProviderError } from '../main/services/chat/errors'

it('统一三种 usage 字段', () => {
  expect(extractOpenAIUsage({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })).toMatchObject({ inputTokens: 10, outputTokens: 3 })
  expect(extractAnthropicUsage({ input_tokens: 11, output_tokens: 4 })).toMatchObject({ inputTokens: 11, outputTokens: 4 })
  expect(extractGeminiUsage({ promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 2 })).toMatchObject({ inputTokens: 12, outputTokens: 5, reasoningTokens: 2 })
})

it('识别上下文溢出而不依赖单一英文文案', () => {
  expect(classifyProviderError(400, '{"error":{"code":"context_length_exceeded"}}')).toBe('CONTEXT_OVERFLOW')
  expect(classifyProviderError(400, 'maximum context length is 8192 tokens')).toBe('CONTEXT_OVERFLOW')
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/chat-provider-usage.test.ts`

Expected: FAIL，usage helper 和错误分类模块不存在。

- [ ] **Step 3: 接入流式 usage**

OpenAI 请求在兼容端点支持时发送 `stream_options: { include_usage: true }` 并读取任意 usage-only chunk；Anthropic 合并 `message_start.message.usage` 与 `message_delta.usage`；Gemini 读取任意 SSE chunk 的 `usageMetadata`，保留最后一份单调最大值。

`streamWithTimeoutRetry()` 转发 `onUsage`，只接受完成尝试的数据；被首字节超时取消的尝试不得覆盖成功重试的 usage。`onError` 增加可选 code，现有只接收一个参数的回调保持类型兼容。

- [ ] **Step 4: 运行聊天回归测试**

Run: `npm test -- src/tests/chat-provider-usage.test.ts src/tests/chat-service.test.ts src/tests/chat-retry.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/chat/types.ts src/main/services/chat/retry.ts src/main/services/chat/errors.ts src/main/services/chat/OpenAIProvider.ts src/main/services/chat/AnthropicProvider.ts src/main/services/chat/GeminiProvider.ts src/tests/chat-provider-usage.test.ts src/tests/chat-retry.test.ts`

Run: `git commit -m "feat(context): collect provider token usage"`

---

### Task 8: 实现统一 ContextBudgetService

**Files:**
- Create: `src/main/services/context/ContextBudgetService.ts`
- Test: `src/tests/context-budget-service.test.ts`
- Modify: `src/tests/context-manager-truncation.test.ts`

**Interfaces:**
- Consumes: `ModelContextCapabilities`、Provider usage、System/Tools/Instructions/History/Input 文本。
- Produces: `measureRequest()`、`resolveLimits()`、`recentTailBudget()`、`ContextBudgetSnapshot`。

- [ ] **Step 1: 写预算公式和压力阈值失败测试**

```typescript
describe('ContextBudgetService', () => {
  const service = new ContextBudgetService()

  it('扣除输出预留与 3% 安全边际', () => {
    const limits = service.resolveLimits({ contextWindowTokens: 10_000, maxOutputTokens: 2_000 })
    expect(limits.hardInputLimit).toBe(8_000)
    expect(limits.safetyMarginTokens).toBe(256)
    expect(limits.usableInputBudget).toBe(7_744)
  })

  it('独立 maxInputTokens 不重复扣输出', () => {
    expect(service.resolveLimits({ contextWindowTokens: 10_000, maxInputTokens: 9_000, maxOutputTokens: 2_000 }).hardInputLimit).toBe(9_000)
  })

  it.each([[0.69, 'normal'], [0.70, 'warning'], [0.80, 'prune'], [0.90, 'compact']] as const)(
    '占用 %s 时压力为 %s', (ratio, level) => expect(service.pressureLevel(ratio)).toBe(level)
  )

  it('按公式限制最近尾部', () => {
    expect(service.recentTailBudget(20_000)).toBe(5_000)
    expect(service.recentTailBudget(100_000)).toBe(8_000)
  })
})
```

- [ ] **Step 2: 验证旧 45,000 字符红线测试与新策略冲突**

Run: `npm test -- src/tests/context-budget-service.test.ts src/tests/context-manager-truncation.test.ts`

Expected: 新测试 FAIL；旧测试仍表达待移除的固定 45,000 字符下限。

- [ ] **Step 3: 实现能力解析和 CJK 感知估算器**

默认 `outputReserve` 为 `maxOutputTokens ?? clamp(contextWindowTokens * 0.2, 1024, 8192)`；启用固定 reasoning budget 且计入上下文时，加上 reasoning budget 与至少 512 final-answer tokens，但不得使 hard input 小于 1。

估算器固定规则：CJK 字符每 1.5 字一个 token，其他字符每 4 字符一个 token；消息、Tool Schema 和协议包装分别计数。收到 Provider usage 后，以已发生请求的 `inputTokens` 为基线，只对新增部分使用估算。

删除 `context-manager-truncation.test.ts` 中 45,000 字符下限断言，替换为“小窗口下工具输出上限随 usable budget 缩小”的断言；在最终清理前 `ContextManager` 可委托新服务。

- [ ] **Step 4: 验证预算边界**

加入 1K 小窗口、200K 大窗口、零/负配置归一化、预测下一步溢出、Provider usage 优先级测试。

Run: `npm test -- src/tests/context-budget-service.test.ts src/tests/context-manager-truncation.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/ContextBudgetService.ts src/tests/context-budget-service.test.ts src/tests/context-manager-truncation.test.ts`

Run: `git commit -m "feat(context): unify model context budgeting"`

---

### Task 9: 实现 ToolOutputPruner

**Files:**
- Create: `src/main/services/context/ToolOutputPruner.ts`
- Test: `src/tests/tool-output-pruner.test.ts`

**Interfaces:**
- Consumes: 规范化历史、`usableInputBudget`、完整协议组和工具结果状态。
- Produces: 模型可见历史副本、清理记录和重新预算所需元数据。

- [ ] **Step 1: 写结构化清理失败测试**

```typescript
it('只清理旧成功结果并保留错误、近期结果和 UI 原文', () => {
  const original = historyWithToolResults({ old: 'A'.repeat(20_000), recent: 'B'.repeat(20_000), error: 'fatal details' })
  const result = new ToolOutputPruner().prune(original, { targetTokens: 2_000, protectedTailStart: 4 })
  expect(result.messages[1].content).toContain('TOOL_OUTPUT_PRUNED')
  expect(JSON.parse(result.messages[1].content)).toMatchObject({
    code: 'TOOL_OUTPUT_PRUNED', toolName: 'Read', originalChars: 20_000
  })
  expect(result.messages[3].content).toBe('fatal details')
  expect(result.messages.at(-1)?.content).toBe('B'.repeat(20_000))
  expect(original[1].content).toBe('A'.repeat(20_000))
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/tool-output-pruner.test.ts`

Expected: FAIL，Pruner 尚不存在。

- [ ] **Step 3: 实现按收益排序的模型副本清理**

保护顺序：活动协议组 → 最近尾部 → 错误结果 → Skill/规则加载结果 → 其他成功结果。候选按“预计可释放 token / 语义重要性”降序清理，达到目标立即停止。

占位 JSON 固定包含 `code`、`toolName`、`originalChars`、`originalTokensEstimate`、`sha256`、`head`、`tail`；`head`/`tail` 总量受预算限制。Pruner 返回新数组，不修改账本事件和 UI Session 消息。

- [ ] **Step 4: 验证协议与预算回归**

Run: `npm test -- src/tests/tool-output-pruner.test.ts src/tests/model-history-normalizer.test.ts src/tests/context-budget-service.test.ts`

Expected: PASS；Pruning 前后 callId 配对一致。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/ToolOutputPruner.ts src/tests/tool-output-pruner.test.ts`

Run: `git commit -m "feat(context): prune stale model-visible tool outputs"`

---

### Task 10: 版本化 ResumeState 并迁移旧独立文件

**Files:**
- Create: `src/main/services/context/ResumeStateManager.ts`
- Modify: `src/main/tools/builtin/UpdateResumeStateTool.ts`
- Modify: `src/main/tools/Tool.ts`
- Modify: `src/main/agent/ContextManager.ts`
- Modify: `src/tests/context-manager-resume-state.test.ts`
- Test: `src/tests/resume-state-manager.test.ts`

**Interfaces:**
- Consumes: `VersionedResumeState`、Coordinator、旧 `agent-sessions/*.json`。
- Produces: `merge()`、`importLegacy()`、`renderBounded()`、账本 `resume_state_updated`。

- [ ] **Step 1: 写证据优先级和防覆盖测试**

```typescript
it('覆盖序号优先，同序号 explicit_tool 优先', () => {
  const manager = new ResumeStateManager()
  const framework = versioned('framework', 10, { currentPhase: 'auto-save', nextAction: 'old' })
  const explicit = versioned('explicit_tool', 10, { currentPhase: 'implementation', nextAction: 'test' })
  expect(manager.merge(framework, explicit).source).toBe('explicit_tool')
  expect(manager.merge(explicit, versioned('framework', 11, { currentPhase: '', nextAction: '' })).state.currentPhase).toBe('implementation')
})

it('validationPending 不覆盖已有验证结论', () => {
  const merged = new ResumeStateManager().merge(
    versioned('explicit_tool', 5, { validationResults: [{ commandOrCheck: 'npm test', status: 'passed', result: 'PASS' }] }),
    versioned('compaction', 6, { validationPending: ['npm test'] })
  )
  expect(merged.state.validationResults).toContainEqual({ commandOrCheck: 'npm test', status: 'passed', result: 'PASS' })
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/resume-state-manager.test.ts`

Expected: FAIL，Manager 尚不存在。

- [ ] **Step 3: 实现版本合并、导入和工具写账本**

旧状态 `currentGoalId === 'auto-save'` 或 `currentPhase === 'auto-save-before-limit'` 映射为 `framework`，其余旧工具状态映射为 `explicit_tool`。成功追加账本后不再写旧文件；旧文件保留只读兼容。

`UpdateResumeStateTool.execute()` 从 `ToolExecutionContext` 获取 `runtimeCoordinator`、`sessionId`、`turnId`、`contextScopeId`，调用 `recordResumeState()`。缺少运行时上下文时仅在影子迁移阶段使用旧保存函数，权威模式必须返回明确错误。

`renderBounded()` 使用固定字段顺序输出 `<resume_state revision="N" covered_through_sequence="N">`；超过 token 上限时依次保留目标、下一步、阻塞、修改文件、待验证项。

- [ ] **Step 4: 运行 ResumeState 和 AgentRunner 回归测试**

Run: `npm test -- src/tests/resume-state-manager.test.ts src/tests/context-manager-resume-state.test.ts src/tests/agent-runner-transition.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/ResumeStateManager.ts src/main/tools/builtin/UpdateResumeStateTool.ts src/main/tools/Tool.ts src/main/agent/ContextManager.ts src/tests/resume-state-manager.test.ts src/tests/context-manager-resume-state.test.ts`

Run: `git commit -m "feat(context): version resume state in ledger"`

---

### Task 11: 实现 Compaction 摘要 Schema、校验和确定性渲染

**Files:**
- Create: `src/main/services/context/CompactionSummary.ts`
- Create: `src/main/services/context/CompactionModelClient.ts`
- Test: `src/tests/compaction-summary.test.ts`

**Interfaces:**
- Consumes: `CompactionSummaryV1`、旧摘要、待压缩消息、ResumeState、手动保留说明。
- Produces: `buildCompactionPrompt()`、`parseAndValidateSummary()`、`renderCompactionSummary()`、`ChatCompactionModelClient`。

- [ ] **Step 1: 写严格校验和稳定渲染测试**

```typescript
it('拒绝覆盖序号错误和缺失必需数组的摘要', () => {
  expect(() => parseAndValidateSummary(JSON.stringify({ version: 1, coveredThroughSequence: 8 }), 9)).toThrow('COMPACTION_SCHEMA_INVALID')
  expect(() => parseAndValidateSummary(JSON.stringify(validSummary(8)), 9)).toThrow('coveredThroughSequence')
})

it('相同摘要始终渲染为相同文本并包含关键字段', () => {
  const summary = validSummary(9)
  const first = renderCompactionSummary(summary)
  expect(renderCompactionSummary(summary)).toBe(first)
  expect(first).toContain('Current objective')
  expect(first).toContain('Covered through sequence: 9')
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/compaction-summary.test.ts`

Expected: FAIL，摘要模块尚不存在。

- [ ] **Step 3: 实现无第三方依赖的严格运行时校验**

校验全部必需对象/数组、枚举、字符串长度、数组项目数量和 `coveredThroughSequence` 精确相等；拒绝代码围栏外附加文本。摘要最大字符数由 `maxSummaryTokens * 4` 约束，错误返回设计中的分类码。

Prompt 固定包含：摘要职责、已有摘要、待压缩协议 transcript、最新 ResumeState、一次性保留说明、完整 JSON shape 和禁止无证据完成声明。`ChatCompactionModelClient` 使用当前 Provider/模型、禁用 tools、独立输出上限，并把原始文本交给校验器。

- [ ] **Step 4: 运行摘要测试与类型检查**

Run: `npm test -- src/tests/compaction-summary.test.ts`

Expected: PASS，包括非法 JSON、额外字段容忍策略、过大摘要和确定性顺序测试。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/CompactionSummary.ts src/main/services/context/CompactionModelClient.ts src/tests/compaction-summary.test.ts`

Run: `git commit -m "feat(context): validate structured compaction summaries"`

---

### Task 12: 实现正式 CompactionService 与逻辑提交协议

**Files:**
- Create: `src/main/services/context/CompactionService.ts`
- Test: `src/tests/compaction-service.test.ts`

**Interfaces:**
- Consumes: Ledger、Normalizer、Budget、Pruner、ResumeState、CompactionModelClient。
- Produces: `compact()`、`selectBoundary()`、`CompactionResult` 和生命周期事件。

- [ ] **Step 1: 写成功、陈旧版本和失败原子性测试**

```typescript
it('只有候选达到 55% 目标后才提交 completed', async () => {
  const fixture = compactionFixture({ beforeTokens: 9_500, afterTokens: 5_000, usableBudget: 10_000 })
  const result = await fixture.service.compact(request('auto_threshold'))
  expect(result.status).toBe('completed')
  expect(fixture.ledger.types()).toEqual(['compaction_started', 'compaction_completed'])
  expect(fixture.ledger.completedPayload()).toMatchObject({ tokensBefore: 9500, tokensAfter: 5000 })
})

it('historyVersion 变化时不提交陈旧候选', async () => {
  const fixture = compactionFixture({ mutateVersionDuringSummary: true })
  const result = await fixture.service.compact(request('manual'))
  expect(result.errorCode).toBe('COMPACTION_STALE_VERSION')
  expect(fixture.ledger.types()).not.toContain('compaction_completed')
})

it('Snapshot 失败不撤销逻辑提交且不轮转日志', async () => {
  const fixture = compactionFixture({ snapshotFailure: true })
  const result = await fixture.service.compact(request('manual'))
  expect(result.status).toBe('completed')
  expect(result.snapshotStatus).toBe('deferred')
  expect(fixture.ledger.fullLogRetained()).toBe(true)
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/compaction-service.test.ts`

Expected: FAIL，Service 尚不存在。

- [ ] **Step 3: 实现边界、版本检查和熔断**

`selectBoundary()` 从最新向前按 `recentTailBudget` 保留完整组，当前未处理 User 和活动工具组强制留在尾部。没有可压缩头部时返回 `COMPACTION_INSUFFICIENT_REDUCTION`，不调用摘要模型。

提交严格执行：追加 started → 生成/校验候选 → 计算源事件哈希 → 在会话写队列内比较 scope `historyVersion` → 物化新视图并重新预算 → 追加 completed → 尝试 Snapshot/重放验证/轮转 → 发布结果。

并发版本冲突最多重新生成一次；单 Turn 最多 3 次压缩。每次必须达到 55% 目标或至少减少 20%，否则追加 failed 并熔断。`compaction_failed` 不推进 `historyVersion`。

- [ ] **Step 4: 验证所有失败语义**

加入摘要网络失败、Schema 非法、单个近期内容过大、源哈希不匹配、三次不足减少、跨 scope 事件不使主 scope 候选失效的测试。

Run: `npm test -- src/tests/compaction-service.test.ts src/tests/model-ledger-store.test.ts src/tests/model-history-normalizer.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/CompactionService.ts src/tests/compaction-service.test.ts`

Run: `git commit -m "feat(context): commit durable conversation compactions"`

---

### Task 13: 实现 ModelContextBuilder 和 Provider-neutral 请求视图

**Files:**
- Create: `src/main/services/context/ModelContextBuilder.ts`
- Create: `src/main/services/chat/ProviderMessageAdapter.ts`
- Test: `src/tests/model-context-builder.test.ts`
- Test: `src/tests/provider-message-adapter.test.ts`

**Interfaces:**
- Consumes: 动态 System Prompt、scope 物化历史、摘要、ResumeState、工具定义、预算与 Pruner/Compaction。
- Produces: `BuiltModelContext { messages, budget, historyVersion }` 和 OpenAI/Anthropic/Gemini adapter 输入。

- [ ] **Step 1: 写最终视图顺序测试**

```typescript
it('按 system + summary + resume + recent + current 顺序构建且不重复覆盖状态', async () => {
  const built = await fixture().builder.build(buildRequest())
  expect(built.messages.map((message) => message.kind)).toEqual([
    'system', 'compaction_summary', 'resume_state', 'user', 'assistant', 'user'
  ])
  expect(built.messages.filter((message) => message.kind === 'resume_state')).toHaveLength(1)
  expect(built.budget.totalInputTokens).toBeLessThanOrEqual(built.budget.usableInputBudget)
})

it('当前输入自身超过硬限制时不压缩历史', async () => {
  const oversized = fixture({ currentInputTokens: 9_001, hardInputLimit: 9_000 })
  await expect(oversized.builder.build(buildRequest()))
    .rejects.toMatchObject({ code: 'CURRENT_INPUT_TOO_LARGE' })
  expect(oversized.compactor.compact).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/model-context-builder.test.ts src/tests/provider-message-adapter.test.ts`

Expected: FAIL，Builder/adapter 尚不存在。

- [ ] **Step 3: 实现构建管线**

固定顺序：加载并规范化 scope → 构建当前 System Prompt/Reminder → 合并有效摘要和 ResumeState → 初次预算 → 80% 时对副本 Prune → 重新预算 → 90%/预测溢出且开关启用时 Compaction → 重新加载 scope 并最终预算 → adapter 转换。

Provider adapter 必须满足：OpenAI 保持 assistant tool_calls 后跟 tool；Anthropic 把 System 分离并将 tool result 放到 user content block；Gemini 使用 model functionCall 后跟 user functionResponse，不能用 UI 文本重新排序。adapter 测试只接受 Builder 的 Provider-neutral 消息。

- [ ] **Step 4: 验证跨 Provider 协议和预算组成**

Run: `npm test -- src/tests/model-context-builder.test.ts src/tests/provider-message-adapter.test.ts src/tests/context-budget-service.test.ts src/tests/tool-output-pruner.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/ModelContextBuilder.ts src/main/services/chat/ProviderMessageAdapter.ts src/tests/model-context-builder.test.ts src/tests/provider-message-adapter.test.ts`

Run: `git commit -m "feat(context): build provider-neutral model contexts"`

---

### Task 14: 将 AgentRunner 切换为权威账本读写路径

**Files:**
- Modify: `src/main/agent/AgentRunner/types.ts`
- Modify: `src/main/agent/AgentRunner/index.ts`
- Modify: `src/main/tools/Tool.ts`
- Test: `src/tests/agent-runner-ledger-authoritative.test.ts`
- Modify: `src/tests/agent-runner-tool-result.test.ts`
- Modify: `src/tests/agent-runner-transition.test.ts`

**Interfaces:**
- Consumes: 已创建的 `RuntimeTurnHandle`、Coordinator、ModelContextBuilder、Provider adapter、usage callbacks。
- Produces: 每次采样前从账本构建上下文，所有协议完成消息先落盘。

- [ ] **Step 1: 写权威顺序和 fail-closed 测试**

```typescript
it('每次工具循环从账本重建上下文而不是复用 Renderer messages', async () => {
  const fixture = authoritativeRunnerFixture()
  await fixture.runner.run(fixture.config({ input: { text: 'read file' } }), fixture.callbacks)
  expect(fixture.builder.build).toHaveBeenCalledTimes(2)
  expect(fixture.chat.requests[0].messages).toBe(fixture.builder.results[0].messages)
  expect(fixture.ledger.types()).toEqual([
    'user_message', 'assistant_message', 'tool_result', 'assistant_message', 'turn_completed'
  ])
})

it('权威模式账本写失败时不调用模型', async () => {
  const fixture = authoritativeRunnerFixture({ failAppend: 'user_message' })
  await expect(fixture.runner.run(fixture.config(), fixture.callbacks)).rejects.toMatchObject({ code: 'LEDGER_WRITE_FAILED' })
  expect(fixture.chat.requests).toHaveLength(0)
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/agent-runner-ledger-authoritative.test.ts`

Expected: FAIL，Runner 仍要求 `messages` 并维护 `allMessages`。

- [ ] **Step 3: 重构 Runner 配置和循环**

`AgentRunConfig` 新增必需 `runtimeTurn: RuntimeTurnHandle`、`providerId`、`contextCapabilities`、`runtimeCoordinator`、`contextBuilder`；`sessionId/contextScopeId/turnId` 从 handle 读取。`messages` 仅保留 `legacyMessages?` 过渡字段且权威路径拒绝读取。Chat handler 在 Task 15 负责迁移、模型下调预检和 `beginTurn()`；Runner 只消费已经持久化 User 的 handle，不能再次创建 Turn。

每轮模型调用前 Builder 读取账本。流完成后先 `recordAssistant()`，并把本次 Provider usage 保存到 Assistant 事件；有工具时再发布 ToolStart。每个工具完成后先 `recordToolResult()` 再发布 ToolEnd。无工具最终响应落盘后追加包含最终 usage/stop reason 的 `turn_completed`。abort、Provider error、进程内异常统一调用 `interruptTurn()`，Normalizer 在恢复时补齐未完成结果。

删除 Runner 中 `ContextManager.trimMessages()`、65% 裁剪提醒、循环上限直接覆盖 ResumeState 的路径；循环上限改为 `framework` 候选交给 ResumeStateManager 合并。

- [ ] **Step 4: 运行 AgentRunner 回归测试**

Run: `npm test -- src/tests/agent-runner-ledger-authoritative.test.ts src/tests/agent-runner-tool-result.test.ts src/tests/agent-runner-transition.test.ts src/tests/agent-runner-plan-mode.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/agent/AgentRunner/types.ts src/main/agent/AgentRunner/index.ts src/main/tools/Tool.ts src/tests/agent-runner-ledger-authoritative.test.ts src/tests/agent-runner-tool-result.test.ts src/tests/agent-runner-transition.test.ts`

Run: `git commit -m "feat(context): drive agent runs from canonical ledger"`

---

### Task 15: 切换 Chat Stream V2 并移除 Renderer 历史重建

**Files:**
- Modify: `src/main/ipc/chat.handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/components/chat/hooks/useSendMessage.ts`
- Test: `src/tests/chat-stream-v2.test.ts`
- Test: `src/tests/send-message-payload.test.ts`

**Interfaces:**
- Consumes: `StreamRequestV2`、MigrationService、Coordinator、Provider 模型能力。
- Produces: `chat.stream(providerId, model, sessionId, input, callbacks)`；正常请求不含 `messages`。

- [ ] **Step 1: 写请求契约和 Renderer payload 测试**

```typescript
it('V2 请求只允许当前输入，不接受完整 messages', () => {
  const request = createStreamRequestV2('p1', 'm1', 's1', { text: '继续', commandMetadata: { commandName: 'goal' } })
  expect(request).toEqual({ providerId: 'p1', model: 'm1', sessionId: 's1', input: { text: '继续', commandMetadata: { commandName: 'goal' } } })
  expect(request).not.toHaveProperty('messages')
})

it('Renderer 发送原始 UI 消息后只提交处理后的本次输入', async () => {
  const payload = buildChatStreamInput('/goal inspect', [])
  expect(payload.input.text).toBe('/goal inspect')
  expect(payload).not.toHaveProperty('history')
  expect(payload).not.toHaveProperty('systemPrompt')
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/chat-stream-v2.test.ts src/tests/send-message-payload.test.ts`

Expected: FAIL，当前 preload 签名仍要求 `messages`。

- [ ] **Step 3: 实现 V2 handler 和旧会话准备流程**

`StreamRequestV2` 精确字段为 `providerId`、`model`、非空 `sessionId`、`input.text`、可选 `isSystem/commandMetadata`。Handler 顺序：验证 Provider/Workspace/Session → `ensureMigrated()` → 解析真实模型能力 → `prepareModelDownshift()` → `beginTurn()` 持久化 User 并获得 handle → 启动 AgentRunner。

Renderer 保留 UI `addUserMessage()`、文件引用识别和 Slash skill 展开，但只把当前处理后文本/引用元数据交给 preload。删除硬编码中文 System Prompt、`currentMsgs.flatMap()`、mock interrupted tool result 和 provider-specific signature 重建。

过渡兼容仅在 feature flag 回退时接受 `legacyMessages`；权威开关启用后收到 `messages` 字段应记录告警并拒绝，避免静默双写。

- [ ] **Step 4: 运行 IPC、Slash 和会话回归测试**

Run: `npm test -- src/tests/chat-stream-v2.test.ts src/tests/send-message-payload.test.ts src/tests/slash-command-skill.test.ts src/tests/task-session-restore.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/ipc/chat.handlers.ts src/preload/index.ts src/renderer/src/env.d.ts src/renderer/src/components/chat/hooks/useSendMessage.ts src/tests/chat-stream-v2.test.ts src/tests/send-message-payload.test.ts`

Run: `git commit -m "feat(context): send only current input over chat ipc"`

---

### Task 16: 接入预算/压缩生命周期 IPC、ContextTracker 和手动 `/compact`

**Files:**
- Modify: `src/shared/ipc/channels.ts`
- Modify: `src/main/ipc/chat.handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/commands/SlashCommandParser.ts`
- Create: `src/renderer/src/stores/chatStore/slices/contextSlice.ts`
- Modify: `src/renderer/src/stores/chatStore/index.ts`
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/renderer/src/components/chat/hooks/useSendMessage.ts`
- Modify: `src/renderer/src/components/ContextTracker.tsx`
- Modify: `src/renderer/src/components/PromptArea/index.tsx`
- Test: `src/tests/context-ipc-events.test.ts`
- Modify: `src/tests/slash-command-skill.test.ts`

**Interfaces:**
- Produces: `CHAT_CONTEXT_BUDGET_UPDATED`、`CHAT_COMPACTION_START/STARTED/COMPLETED/FAILED`、`CHAT_HISTORY_RECOVERED`。
- Consumes: `ContextBudgetSnapshot` 和 `CompactionResult`。

- [ ] **Step 1: 写 `/compact` 客户端动作测试**

```typescript
it('/compact 解析为本地压缩动作而不是模型消息', () => {
  expect(parseSlashCommand('/compact 保留数据库迁移决定')).toEqual({
    isCommand: true,
    commandName: 'compact',
    processedMessage: '',
    clientAction: { type: 'context:compact', payload: { instructions: '保留数据库迁移决定' } }
  })
})
```

预算事件测试按 `streamId + sessionId + historyVersion` 去重，Compaction completed 后必须以事件附带的新预算覆盖旧快照。

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/context-ipc-events.test.ts src/tests/slash-command-skill.test.ts`

Expected: FAIL，`/compact` 当前仍被发送给模型。

- [ ] **Step 3: 实现主进程事件与手动压缩 IPC**

手动调用只提交 `sessionId` 和一次性 `instructions`。若 scope 正在执行不可分割协议组，返回 `{ accepted: false, reason: 'TURN_BUSY' }`；空闲时调用 `CompactionService.compact(trigger: 'manual')`。instructions 只进入本次摘要 prompt，不写 System Prompt 或 ResumeState。

每次 Builder 完成发送预算快照；started/completed/failed 事件携带 `sessionId`、`scopeId`、`eventId`、触发原因和安全的 token 前后值，不携带摘要正文。

- [ ] **Step 4: 替换 ContextTracker 自估算**

`ContextTracker` props 改为 `snapshot?: ContextBudgetSnapshot` 和 `compactionState`；删除 `estimate()`、固定 2000/1000/500 token 假设和从 UI messages 计算逻辑。未收到快照时显示不可用状态；明确展示 `estimateSource`，不得把 heuristic 标为精确。

Run: `npm test -- src/tests/context-ipc-events.test.ts src/tests/slash-command-skill.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/shared/ipc/channels.ts src/main/ipc/chat.handlers.ts src/preload/index.ts src/renderer/src/env.d.ts src/renderer/src/commands/SlashCommandParser.ts src/renderer/src/stores/chatStore/slices/contextSlice.ts src/renderer/src/stores/chatStore/index.ts src/renderer/src/stores/chatStore/types.ts src/renderer/src/components/ContextTracker.tsx src/renderer/src/components/PromptArea/index.tsx src/renderer/src/components/chat/hooks/useSendMessage.ts src/tests/context-ipc-events.test.ts src/tests/slash-command-skill.test.ts`

Run: `git commit -m "feat(context): expose compaction and budget lifecycle"`

---

### Task 17: 接入自动压缩、Provider 溢出恢复和模型下调

**Files:**
- Modify: `src/main/services/context/ModelContextBuilder.ts`
- Modify: `src/main/services/context/SessionRuntimeCoordinator.ts`
- Modify: `src/main/agent/AgentRunner/index.ts`
- Modify: `src/main/ipc/chat.handlers.ts`
- Test: `src/tests/context-trigger-policy.test.ts`
- Test: `src/tests/provider-overflow-recovery.test.ts`

**Interfaces:**
- Consumes: pressure level、Provider error code、上一模型能力、CompactionService。
- Produces: `auto_threshold`、`provider_overflow`、`model_downshift` 触发和有限重试。

- [ ] **Step 1: 写触发与熔断失败测试**

```typescript
it('80% 先 prune，90% 或预测溢出才 compact', async () => {
  const fixture = triggerFixture()
  await fixture.buildAt(0.81)
  expect(fixture.pruner.prune).toHaveBeenCalledOnce()
  expect(fixture.compactor.compact).not.toHaveBeenCalled()
  await fixture.buildAt(0.91)
  expect(fixture.compactor.compact).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'auto_threshold' }))
})

it('Provider overflow 只压缩后重试一次同一采样', async () => {
  const fixture = overflowFixture(['CONTEXT_OVERFLOW', 'CONTEXT_OVERFLOW'])
  await fixture.run()
  expect(fixture.compactor.compact).toHaveBeenCalledTimes(1)
  expect(fixture.chat.requests).toHaveLength(2)
  expect(fixture.error.code).toBe('PROVIDER_CONTEXT_OVERFLOW')
})

it('切换到更小模型先压缩再开始 Turn', async () => {
  const fixture = downshiftFixture({ previous: 128_000, next: 16_000 })
  await fixture.prepare()
  expect(fixture.order).toEqual(['compact:model_downshift', 'begin-turn'])
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/context-trigger-policy.test.ts src/tests/provider-overflow-recovery.test.ts`

Expected: FAIL，触发策略尚未连接运行链路。

- [ ] **Step 3: 实现统一触发控制器**

自动策略由 Builder 唯一决定，Runner 不再添加独立阈值。Provider overflow 仅在收到结构化 `CONTEXT_OVERFLOW` 时触发一次响应式 Compaction；成功且 `historyVersion` 改变后重试同一采样一次，第二次溢出直接返回错误。

Coordinator 记录最近成功模型能力；新模型 `usableInputBudget` 小于当前活动视图时，在持久化新 User 前执行 `model_downshift` Compaction，避免把未处理输入纳入摘要。若无法达到新预算，拒绝切换并保留旧活动视图。

- [ ] **Step 4: 运行触发和 Compaction 回归测试**

Run: `npm test -- src/tests/context-trigger-policy.test.ts src/tests/provider-overflow-recovery.test.ts src/tests/compaction-service.test.ts src/tests/model-context-builder.test.ts`

Expected: PASS，无无限重试或重复摘要。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/services/context/ModelContextBuilder.ts src/main/services/context/SessionRuntimeCoordinator.ts src/main/agent/AgentRunner/index.ts src/main/ipc/chat.handlers.ts src/tests/context-trigger-policy.test.ts src/tests/provider-overflow-recovery.test.ts`

Run: `git commit -m "feat(context): compact on pressure overflow and model downshift"`

---

### Task 18: 将子 Agent 迁移到独立 scope 和真实模型预算

**Files:**
- Modify: `src/main/agent/SubAgentManager.ts`
- Modify: `src/main/agent/definitions/WorkerSubAgent.ts`
- Modify: `src/main/agent/AgentRunner/subAgentRunnerHelper.ts`
- Modify: `src/main/agent/AgentRunner/delegateTasksHelper.ts`
- Modify: `src/main/agent/AgentRunner/parallelOrchestrator.ts`
- Modify: `src/shared/types/subagent.ts`
- Test: `src/tests/subagent-context-scope.test.ts`
- Modify: `src/tests/subagent-manager-recovery.test.ts`
- Modify: `src/tests/subagent-session-restore.test.ts`

**Interfaces:**
- Consumes: `contextScopeForSubAgent()`、真实 `ModelContextCapabilities`、共享 Builder/Compaction。
- Produces: 每次子 Agent run 的隔离账本 scope 和有界父级结果。

- [ ] **Step 1: 写 scope 隔离和真实窗口测试**

```typescript
it('每个子代理运行使用独立 scope 和所选模型能力', async () => {
  const fixture = subAgentFixture({ maxContextTokens: 65_536, maxOutputTokens: 4_096 })
  await fixture.manager.spawn(fixture.context)
  expect(fixture.coordinator.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
    contextScopeId: expect.stringMatching(/^subagent:/),
    contextCapabilities: expect.objectContaining({ contextWindowTokens: 65_536, maxOutputTokens: 4_096 })
  }))
  expect(fixture.trimMessages).not.toHaveBeenCalled()
})

it('子 scope 写入不使 main scope compaction 候选失效', async () => {
  const fixture = concurrentScopeFixture()
  const mainVersion = fixture.main.historyVersion
  await fixture.appendSubAgentResult()
  expect(fixture.main.historyVersion).toBe(mainVersion)
})
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- src/tests/subagent-context-scope.test.ts`

Expected: FAIL，SubAgentManager 仍固定使用 32K 和本地 `messages`。

- [ ] **Step 3: 迁移子 Agent 运行链路**

`SubAgentContext.apiConfig` 加入实际能力；模型 override 必须通过 ProviderService 查找对应 ModelConfig。每次 spawn 生成稳定 runId/scope，使用 Coordinator + Builder 驱动工具循环，删除 `ContextManager.trimMessages(messages, 32000)` 和 Worker Prompt 的固定 32K。

子 Agent 完成后只把 output spec 校验后的结构化结果或有界文本结果写回父 Agent tool result；内部摘要、历史和 ResumeState 不复制到 `main` scope。后台/并行子 scope 仍通过同一会话物理写队列获得全局 sequence。

- [ ] **Step 4: 运行子 Agent 全组回归测试**

Run: `npm test -- src/tests/subagent-context-scope.test.ts src/tests/subagent-manager-recovery.test.ts src/tests/subagent-session-restore.test.ts src/tests/executor-subagent-prompt.test.ts src/tests/parallel-orchestrator.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交检查点**

Run: `git add src/main/agent/SubAgentManager.ts src/main/agent/definitions/WorkerSubAgent.ts src/main/agent/AgentRunner/subAgentRunnerHelper.ts src/main/agent/AgentRunner/delegateTasksHelper.ts src/main/agent/AgentRunner/parallelOrchestrator.ts src/shared/types/subagent.ts src/tests/subagent-context-scope.test.ts src/tests/subagent-manager-recovery.test.ts src/tests/subagent-session-restore.test.ts`

Run: `git commit -m "feat(context): isolate subagent context scopes"`

---

### Task 19: 完成崩溃恢复、影子比对门槛、旧代码清理和全量验收

**Files:**
- Modify: `src/main/services/context/ModelLedgerStore.ts`
- Modify: `src/main/services/context/SessionRuntimeCoordinator.ts`
- Modify: `src/main/services/context/ContextFeatureFlags.ts`
- Modify: `src/main/agent/ContextManager.ts`
- Modify: `src/main/index.ts`
- Test: `src/tests/context-crash-recovery.test.ts`
- Test: `src/tests/context-management-integration.test.ts`
- Modify: `src/tests/context-manager-truncation.test.ts`

**Interfaces:**
- Consumes: 全部新运行时服务和 feature flags。
- Produces: 启动扫描、Turn 恢复、可量化影子一致性门槛和默认权威模式。

- [ ] **Step 1: 写崩溃点恢复矩阵测试**

```typescript
it.each([
  'after-user', 'after-assistant-tool-call', 'after-one-of-two-tool-results',
  'after-compaction-completed', 'after-snapshot-before-rotation'
])('在 %s 崩溃后恢复为合法且幂等的模型历史', async (point) => {
  const fixture = await crashFixture(point)
  const first = await fixture.restartAndRecover()
  const second = await fixture.restartAndRecover()
  expect(() => fixture.normalizer.assertProtocolInvariant(first.messages)).not.toThrow()
  expect(second.messages).toEqual(first.messages)
  expect(second.historyVersion).toBe(first.historyVersion)
})
```

集成测试覆盖：新会话多轮工具调用、旧会话迁移、自动压缩继续任务、手动保留说明、Provider overflow 一次重试、模型下调、子 Agent 独立 scope、UI Session messages 原样保留。

- [ ] **Step 2: 运行测试并记录当前失败点**

Run: `npm test -- src/tests/context-crash-recovery.test.ts src/tests/context-management-integration.test.ts`

Expected: 首次运行暴露尚未连接的启动恢复或清理路径；逐项修复后才进入下一步。

- [ ] **Step 3: 实现启动恢复和可观测门槛**

应用启动时扫描 schema v2 Session 引用，加载 Snapshot + 增量日志，修复尾部半条记录，检测无 `turn_completed` 的活动 Turn 并追加一次 `turn_interrupted`。扫描无引用运行目录时，仅在 `sessionId + legacySourceHash` 与 Session 匹配时修复引用，其他目录只记录孤立告警。

影子比对结构化指标至少包含：总 Turn、role 序列差异、callId 配对差异、内容哈希差异、恢复差异、写入失败。默认启用权威读路径前，测试 fixture 的一致率必须为 100%，人工试运行不得出现协议差异；feature flag 保留一个发布周期。

- [ ] **Step 4: 移除被替代的旧行为**

从 `ContextManager` 删除消息数量 40 条限制、45,000 字符工具输出下限、`trimMessages()` 主/子调用和独立 ResumeState 权威写入；如仍有非 Agent 调用方，只保留 `estimateStringTokens` 兼容 facade 并委托 `ContextBudgetService`。验收通过后把默认开关改为 `authoritativeLedger: env.CODEZ_CONTEXT_AUTHORITATIVE_LEDGER !== '0'`、`compaction: env.CODEZ_CONTEXT_COMPACTION !== '0'`，影子比对默认关闭但保留显式开启能力一个发布周期。

- [ ] **Step 5: 执行全量验证**

Run: `npm test`

Expected: 全部 Vitest 测试 PASS。

Run: `npm run typecheck`

Expected: PASS，无 Renderer `messages` Chat payload、固定 32K 子 Agent 或 `ContextManager.trimMessages` 调用。

Run: `npm run build`

Expected: Electron main/preload/renderer 均成功构建。

Run: `rg -n "chatMessages|trimMessages\(|45000|maxTotal = 40|contextWindowTokens: 32000" src/main src/renderer`

Expected: 无旧上下文所有权/固定窗口命中；若 `32000` 作为 Provider 缺省配置仍存在，必须只位于能力解析 fallback，不得位于主/子 Agent 裁剪逻辑。

Run: `rg -n "messages: chatMessages|CHAT_STREAM_START.*messages|role: 'system'.*Codez" src/renderer src/preload`

Expected: 无命中。

- [ ] **Step 6: 最终提交检查点**

Run: `git add src/main/services/context/ModelLedgerStore.ts src/main/services/context/SessionRuntimeCoordinator.ts src/main/services/context/ContextFeatureFlags.ts src/main/agent/ContextManager.ts src/main/index.ts src/tests/context-crash-recovery.test.ts src/tests/context-management-integration.test.ts src/tests/context-manager-truncation.test.ts`

Run: `git commit -m "feat(context): complete durable context management rollout"`

---

## Final Acceptance Checklist

- [ ] 新会话的每个模型请求都可由 Snapshot + Ledger + 当前动态配置确定性重建。
- [ ] Renderer Chat 请求不包含完整历史或 System Prompt。
- [ ] 所有 Assistant tool calls 都有匹配结果或持久化中断结果。
- [ ] Snapshot、日志轮转和进程崩溃不会丢失已提交 Compaction。
- [ ] 旧会话迁移幂等，失败降级不伪造工具协议，UI 历史字节级保持。
- [ ] 预算包含所有输入组成，并明确标记 provider/tokenizer/heuristic 来源。
- [ ] 70/80/90% 策略、55% 压缩目标、20% 最小收益和 3 次熔断均有自动化测试。
- [ ] `/compact [说明]` 是本地动作，保留说明仅影响一次摘要。
- [ ] Provider overflow 最多触发一次压缩重试，模型下调在新输入持久化前处理。
- [ ] ResumeState 不会被覆盖序号更旧或证据更弱的自动状态替换。
- [ ] 主 Agent 与子 Agent 使用统一服务、真实模型能力和隔离 scope。
- [ ] OpenAI、Anthropic、Gemini adapter 均通过协议不变量测试。
- [ ] `npm test`、`npm run typecheck`、`npm run build` 全部通过。

## Implementation Handoff

按 Task 1 到 Task 19 顺序执行，不跨越未通过的测试检查点。Task 5 的影子账本、Task 14 的权威读路径、Task 12/17 的正式压缩分别是三个发布门槛；任一门槛失败时回退对应 feature flag，不删除账本或迁移后的运行目录。所有数据格式变更先保持向后读取能力，只有最终验收完成后才停止旧路径写入。
