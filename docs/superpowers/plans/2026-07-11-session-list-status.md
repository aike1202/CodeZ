# 会话列表状态显示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让会话列表在切换会话、后台执行和窗口重载后，准确显示需要用户操作、运行中、错误或空闲状态。

**Architecture:** 主进程以会话级 runtime 快照和变更事件提供运行态，renderer 使用只驻内存的 Zustand slice 接收事件并用查询补齐初始化状态。待确认和错误从持久化消息派生为一个互斥的 `SessionListStatus`，Sidebar 只负责展示该投影。

**Tech Stack:** Electron IPC、TypeScript、React、Zustand、Vitest、Lucide React

## Global Constraints

- 状态优先级固定为 `action-required > running > error > idle`。
- `streamCleanups` 只保留控制与监听清理职责，不再作为 Sidebar 的运行态来源。
- runtime 状态不写入会话持久化数据。
- 单个 TSX/TS 文件建议不超过 150 行，硬性上限 200 行；超过上限时按职责拆分。
- 一个 `className` 最多组合 2 个样式；新增状态样式使用语义 CSS 类。
- 文档注释使用中文。
- 不新增轮询，不新增跨主进程重启恢复 Runner，不新增 UI 测试依赖。

---

### Task 1: 定义带版本的 runtime IPC 契约

**Files:**
- Modify: `src/shared/ipc/channels.ts`
- Modify: `src/shared/types/subagent.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Create: `src/tests/chat-runtime-ipc.test.ts`

**Interfaces:**
- Produces: `IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED`
- Produces: `SessionRuntimeStatus.version: number`
- Produces: `window.api.chat.onRuntimeStatusChanged(callback): () => void`
- Consumes: existing `window.api.chat.getRuntimeStatus(sessionId)`

- [ ] **Step 1: Write the failing IPC contract test**

Create a Vitest test that mocks Electron's `contextBridge`, `ipcRenderer.invoke`, `ipcRenderer.on`, and `ipcRenderer.removeListener`. Assert that:

```ts
expect(IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED).toBe('chat:runtime:status-changed')
expect(api.chat.getRuntimeStatus('session-a')).resolves.toMatchObject({
  sessionId: 'session-a',
  version: 0,
})

const unsubscribe = api.chat.onRuntimeStatusChanged(listener)
expect(ipcRenderer.on).toHaveBeenCalledWith(
  IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED,
  expect.any(Function),
)
unsubscribe()
expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
  IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED,
  expect.any(Function),
)
```

The event wrapper must pass only the typed `SessionRuntimeStatus` payload to `listener`, not the Electron event object.

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `npm test -- src/tests/chat-runtime-ipc.test.ts`

Expected: FAIL because the changed channel, snapshot version, or preload subscription does not exist.

- [ ] **Step 3: Add the shared channel and versioned snapshot type**

Add:

```ts
CHAT_RUNTIME_STATUS_CHANGED: 'chat:runtime:status-changed',
```

Extend the existing type without creating a duplicate:

```ts
export interface SessionRuntimeStatus {
  sessionId: string
  mainRunnerActive: boolean
  activeSubAgentIds: string[]
  version: number
}
```

`version` is a per-session, monotonically increasing runtime revision. Query responses and pushed events use the same revision so renderer can reject stale query results.

- [ ] **Step 4: Expose the typed preload subscription**

Add beside `getRuntimeStatus`:

```ts
onRuntimeStatusChanged: (
  callback: (status: SessionRuntimeStatus) => void,
): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, status: SessionRuntimeStatus): void => {
    callback(status)
  }
  ipcRenderer.on(IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED, listener)
  return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED, listener)
},
```

Mirror the exact signature in `src/renderer/src/env.d.ts`.

- [ ] **Step 5: Run the contract test and typecheck**

Run: `npm test -- src/tests/chat-runtime-ipc.test.ts && npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit the contract**

```bash
git add src/shared/ipc/channels.ts src/shared/types/subagent.ts src/preload/index.ts src/renderer/src/env.d.ts src/tests/chat-runtime-ipc.test.ts
git commit -m "feat: add session runtime status events"
```

### Task 2: 发布主 Runner 和子智能体 runtime 变化

**Files:**
- Modify: `src/main/services/ChatRuntimeRegistry.ts`
- Modify: `src/main/ipc/chat.handlers.ts`
- Modify: `src/main/agent/SubAgentManager.ts`
- Modify: `src/tests/chat-runtime-registry.test.ts`
- Modify: `src/tests/subagent-parent-abort.test.ts`

**Interfaces:**
- Consumes: `SessionRuntimeStatus` and `IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED` from Task 1
- Produces: `ChatRuntimeRegistry.onChange(listener): () => void`
- Produces: versioned `ChatRuntimeRegistry.getStatus(sessionId)`
- Produces: `SubAgentManager.onActiveChange(listener): () => void` with affected `sessionId`

- [ ] **Step 1: Add failing registry lifecycle tests**

Extend the registry test to cover per-session revisions and notifications:

```ts
const changes: string[] = []
const unsubscribe = registry.onChange((sessionId) => changes.push(sessionId))

registry.register('stream-a', 'session-a', runner)
expect(registry.getStatus('session-a')).toMatchObject({
  mainRunnerActive: true,
  version: 1,
})
registry.unregister('stream-a')
expect(registry.getStatus('session-a')).toMatchObject({
  mainRunnerActive: false,
  version: 2,
})
expect(changes).toEqual(['session-a', 'session-a'])

unsubscribe()
```

Also assert that unregistering an unknown stream does not increment a revision or emit a change.

- [ ] **Step 2: Run the registry test and verify it fails**

Run: `npm test -- src/tests/chat-runtime-registry.test.ts`

Expected: FAIL because revisions and change listeners are absent.

- [ ] **Step 3: Implement registry revisions and listeners**

Keep the service Electron-independent:

```ts
type RuntimeChangeListener = (sessionId: string) => void

private readonly versions = new Map<string, number>()
private readonly listeners = new Set<RuntimeChangeListener>()

onChange(listener: RuntimeChangeListener): () => void {
  this.listeners.add(listener)
  return () => this.listeners.delete(listener)
}

private notify(sessionId: string): void {
  this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1)
  this.listeners.forEach((listener) => listener(sessionId))
}
```

Call `notify` after a successful register and after removal of a known stream. Include `version: this.versions.get(sessionId) ?? 0` in `getStatus`.

- [ ] **Step 4: Add failing SubAgent active-change tests**

Use the existing mocked manager setup and assert one notification when a handle becomes active and another when it leaves the active map after completion or parent abort:

```ts
const changedSessions: string[] = []
const unsubscribe = manager.onActiveChange((sessionId) => changedSessions.push(sessionId))

// Spawn the existing test execution and wait for active state.
expect(changedSessions).toContain('session-a')
// Resolve or abort it and wait for cleanup.
expect(changedSessions.filter((id) => id === 'session-a')).toHaveLength(2)
unsubscribe()
```

Cover both setup-failure deletion and the normal `finally` deletion path without expecting duplicate inactive notifications.

- [ ] **Step 5: Implement Electron-independent SubAgent active listeners**

Add a listener set and `onActiveChange` API to `SubAgentManager`. Notify immediately after `activeHandles.set(...)`, and only when `activeHandles.delete(...)` returns `true` in setup-failure and `finally` paths.

- [ ] **Step 6: Wire one IPC publisher in chat handlers**

Create a local snapshot builder that combines registry and active subagents and preserves the registry revision. Subscribe to both change sources when chat handlers register:

```ts
const publishRuntimeStatus = (sessionId: string): void => {
  const status = buildRuntimeStatus(sessionId)
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED, status)
  })
}
```

For subagent-only changes, increment the same session revision before building the snapshot. Prefer adding `registry.touch(sessionId)` for this purpose, with one notification and one revision increment, instead of maintaining a second counter.

The existing `CHAT_RUNTIME_STATUS` invoke handler must call the same `buildRuntimeStatus` function. Handler teardown must unsubscribe the two listeners if the repository has a registration cleanup path.

- [ ] **Step 7: Run focused main-process tests**

Run: `npm test -- src/tests/chat-runtime-registry.test.ts src/tests/subagent-parent-abort.test.ts src/tests/chat-runtime-ipc.test.ts`

Expected: PASS; active and inactive snapshots have increasing versions.

- [ ] **Step 8: Commit runtime publishing**

```bash
git add src/main/services/ChatRuntimeRegistry.ts src/main/ipc/chat.handlers.ts src/main/agent/SubAgentManager.ts src/tests/chat-runtime-registry.test.ts src/tests/subagent-parent-abort.test.ts
git commit -m "feat: publish session runtime changes"
```

### Task 3: Store runtime snapshots and reconcile initial queries

**Files:**
- Create: `src/renderer/src/stores/chatStore/slices/runtimeStatusSlice.ts`
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/renderer/src/stores/chatStore/index.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/sessionSlice.ts`
- Modify: `src/renderer/src/App/index.tsx`
- Create: `src/tests/chat-runtime-status-slice.test.ts`

**Interfaces:**
- Consumes: `SessionRuntimeStatus` and preload APIs from Tasks 1-2
- Produces: `runtimeStatuses: Record<string, SessionRuntimeStatus>`
- Produces: `applyRuntimeStatus(status): void`
- Produces: `refreshRuntimeStatuses(sessionIds): Promise<void>`
- Produces: `clearRuntimeStatus(sessionId): void`

- [ ] **Step 1: Write failing slice tests**

Build the slice in a small test Zustand store and cover:

```ts
store.getState().applyRuntimeStatus({
  sessionId: 'session-a',
  mainRunnerActive: true,
  activeSubAgentIds: [],
  version: 2,
})
store.getState().applyRuntimeStatus({
  sessionId: 'session-a',
  mainRunnerActive: false,
  activeSubAgentIds: [],
  version: 1,
})
expect(store.getState().runtimeStatuses['session-a']?.mainRunnerActive).toBe(true)
```

Mock `getRuntimeStatus` with deferred promises. Start `refreshRuntimeStatuses`, apply a newer event before resolving the query, then assert the older response is ignored. Also test independent background session entries and `clearRuntimeStatus`.

- [ ] **Step 2: Run the slice test and verify it fails**

Run: `npm test -- src/tests/chat-runtime-status-slice.test.ts`

Expected: FAIL because the slice does not exist.

- [ ] **Step 3: Implement the focused runtime slice**

Use version comparison in one action:

```ts
applyRuntimeStatus: (next) => set((state) => {
  const current = state.runtimeStatuses[next.sessionId]
  if (current && current.version > next.version) return state
  return {
    runtimeStatuses: {
      ...state.runtimeStatuses,
      [next.sessionId]: next,
    },
  }
})
```

`refreshRuntimeStatuses` uses `Promise.allSettled`, calls `window.api.chat.getRuntimeStatus` once per unique session ID, and passes fulfilled snapshots through `applyRuntimeStatus`. Failed queries log one diagnostic warning and retain the last event-derived value.

- [ ] **Step 4: Compose the slice and clean it on deletion**

Spread `createRuntimeStatusSlice` into `useChatStore`. Extend `ChatState` with exact fields/actions. In `deleteSession`, omit the deleted key from `runtimeStatuses` in the same state transition that removes the session.

- [ ] **Step 5: Attach listener before initial refresh**

In the smallest existing App initialization effect:

```ts
const unsubscribe = window.api.chat.onRuntimeStatusChanged(
  useChatStore.getState().applyRuntimeStatus,
)
void loadSessions().then(() => {
  const ids = useChatStore.getState().sessions.map((session) => session.id)
  return useChatStore.getState().refreshRuntimeStatuses(ids)
})
return unsubscribe
```

If `loadSessions` is already invoked elsewhere, preserve the single load and call refresh only after that promise resolves. Do not add polling.

- [ ] **Step 6: Run slice tests and renderer typecheck**

Run: `npm test -- src/tests/chat-runtime-status-slice.test.ts && npm run typecheck`

Expected: PASS; no state type or preload signature errors.

- [ ] **Step 7: Commit renderer runtime state**

```bash
git add src/renderer/src/stores/chatStore/slices/runtimeStatusSlice.ts src/renderer/src/stores/chatStore/types.ts src/renderer/src/stores/chatStore/index.ts src/renderer/src/stores/chatStore/slices/sessionSlice.ts src/renderer/src/App/index.tsx src/tests/chat-runtime-status-slice.test.ts
git commit -m "feat: reconcile session runtime snapshots"
```

### Task 4: Persist structured execution errors and expire orphaned requests

**Files:**
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/shared/types/session.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/messageSlice.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/sessionSlice.ts`
- Modify: `src/renderer/src/components/chat/hooks/useSendMessage.ts`
- Create: `src/tests/chat-message-terminal-status.test.ts`

**Interfaces:**
- Produces: `ChatMessage.executionStatus?: 'completed' | 'error' | 'interrupted'`
- Produces: pending request status support for `'interrupted'`
- Produces: `setMessageExecutionStatus(messageId, status): void`
- Consumes: selected session runtime snapshot during session normalization/recovery

- [ ] **Step 1: Write failing message terminal-state tests**

Test a pure exported helper or slice action with old-session compatibility:

```ts
expect(getLatestExecutionStatus(legacyMessages)).toBeUndefined()
setMessageExecutionStatus(agentMessageId, 'error')
expect(store.getState().messages.at(-1)?.executionStatus).toBe('error')
setMessageExecutionStatus(agentMessageId, 'completed')
expect(store.getState().messages.at(-1)?.executionStatus).toBe('completed')
```

Add a recovery test where runtime is inactive and a message has pending permission/ask-user requests. Assert both become `interrupted`; when runtime is active, they remain `pending`.

- [ ] **Step 2: Run the message test and verify it fails**

Run: `npm test -- src/tests/chat-message-terminal-status.test.ts`

Expected: FAIL because structured terminal state and orphan request recovery do not exist.

- [ ] **Step 3: Extend compatible message and request types**

Add optional terminal state to renderer and shared persisted message contracts:

```ts
executionStatus?: 'completed' | 'error' | 'interrupted'
```

Extend both permission and ask-user request status unions with `'interrupted'`. Existing sessions remain valid because all additions are optional or additive.

- [ ] **Step 4: Add one message-status action and request recovery helper**

`setMessageExecutionStatus` updates only the matching agent message. Add a pure helper that maps all `pending` requests to `interrupted` only when the authoritative runtime snapshot has neither an active main Runner nor active subagents. Invoke it in the existing session recovery path after the runtime query resolves, and persist only when at least one request changed.

Do not treat a missing/failed runtime query as inactive; only a fulfilled inactive snapshot may expire requests.

- [ ] **Step 5: Mark stream terminal callbacks**

In `useSendMessage`:

```ts
onDone: () => {
  setMessageExecutionStatus(agentMessageId, 'completed')
  // Preserve existing finish, persistence, and cleanup order.
},
onError: (error) => {
  setMessageExecutionStatus(agentMessageId, 'error')
  // Preserve existing visible error text, persistence, and cleanup.
},
```

User stop marks an already-created agent message `interrupted`. A stream that never started and whose optimistic messages are rolled back must not leave an error record.

- [ ] **Step 6: Run focused message and session tests**

Run: `npm test -- src/tests/chat-message-terminal-status.test.ts src/tests/session-store-runtime.test.ts src/tests/send-message-payload.test.ts`

Expected: PASS, including legacy messages without `executionStatus`.

- [ ] **Step 7: Commit structured terminal state**

```bash
git add src/renderer/src/stores/chatStore/types.ts src/shared/types/session.ts src/renderer/src/stores/chatStore/slices/messageSlice.ts src/renderer/src/stores/chatStore/slices/sessionSlice.ts src/renderer/src/components/chat/hooks/useSendMessage.ts src/tests/chat-message-terminal-status.test.ts
git commit -m "feat: persist chat execution status"
```

### Task 5: Derive one list status and render all four states

**Files:**
- Create: `src/renderer/src/App/hooks/sessionListStatus.ts`
- Modify: `src/renderer/src/App/hooks/useAppWorkspace.ts`
- Modify: `src/renderer/src/components/Sidebar/types.ts`
- Modify: `src/renderer/src/components/Sidebar/components/SessionItem.tsx`
- Create: `src/renderer/src/components/Sidebar/components/SessionItem.css`
- Create: `src/tests/session-list-status.test.ts`
- Create: `src/tests/sidebar-session-status.test.tsx`

**Interfaces:**
- Produces: `SessionListStatus = 'action-required' | 'running' | 'error' | 'idle'`
- Produces: `deriveSessionListStatus(messages, runtime): SessionListStatus`
- Consumes: `runtimeStatuses[session.id]` and structured message/request fields

- [ ] **Step 1: Write failing pure projection tests**

Cover the full precedence table:

```ts
expect(deriveSessionListStatus([], undefined)).toBe('idle')
expect(deriveSessionListStatus(errorMessages, inactive)).toBe('error')
expect(deriveSessionListStatus(errorMessages, active)).toBe('running')
expect(deriveSessionListStatus(pendingMessages, active)).toBe('action-required')
expect(deriveSessionListStatus(interruptedRequestMessages, inactive)).toBe('idle')
```

Also assert that ordinary content containing “错误” does not produce `error`, and that a later user message after an error clears the current error projection until its agent response fails.

- [ ] **Step 2: Run projection tests and verify they fail**

Run: `npm test -- src/tests/session-list-status.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the pure projection**

The helper must:

```ts
if (hasPendingRequest(messages)) return 'action-required'
if (runtime?.mainRunnerActive || runtime?.activeSubAgentIds.length) return 'running'
if (latestTurnAgentMessage?.executionStatus === 'error') return 'error'
return 'idle'
```

Define “latest turn” as messages after the final user message, so a new user send stops an old error from projecting even before a new agent terminal state arrives. Export the union from this small module and import it into Sidebar types to avoid duplicate unions.

- [ ] **Step 4: Replace the workspace mapping source**

In `useAppWorkspace`, select `runtimeStatuses` instead of `streamCleanups` for list display and map each session with:

```ts
status: deriveSessionListStatus(
  session.messages,
  runtimeStatuses[session.id],
),
```

Remove `isStreaming` from `SidebarSession`. Preserve `streamCleanups` wherever it is still needed for stop controls.

- [ ] **Step 5: Write failing static-render UI tests**

Use `react-dom/server` and render `SessionItem` once per status. Assert stable accessible labels:

```ts
expect(renderStatus('action-required')).toContain('aria-label="需要确认"')
expect(renderStatus('running')).toContain('aria-label="正在运行"')
expect(renderStatus('error')).toContain('aria-label="执行出错"')
```

Assert idle renders the normal message icon and none of the three status labels. Mock menu callbacks only; do not add Testing Library or jsdom.

- [ ] **Step 6: Render semantic status icons with focused CSS**

Use existing Lucide icons for action-required and error, retain the current pulse indicator for running, and preserve the idle message icon. Move repeated utility styles into `SessionItem.css` semantic classes so every `className` contains at most two styles. Keep the component below 200 lines; extract a `SessionStatusIcon` sibling component if necessary.

Each non-idle icon needs `aria-label` and `role="status"`; decorative inner SVG details use `aria-hidden`.

- [ ] **Step 7: Run projection and UI tests**

Run: `npm test -- src/tests/session-list-status.test.ts src/tests/sidebar-session-status.test.tsx`

Expected: PASS for all four statuses and precedence cases.

- [ ] **Step 8: Commit Sidebar projection**

```bash
git add src/renderer/src/App/hooks/sessionListStatus.ts src/renderer/src/App/hooks/useAppWorkspace.ts src/renderer/src/components/Sidebar/types.ts src/renderer/src/components/Sidebar/components/SessionItem.tsx src/renderer/src/components/Sidebar/components/SessionItem.css src/tests/session-list-status.test.ts src/tests/sidebar-session-status.test.tsx
git commit -m "feat: show session status in sidebar"
```

### Task 6: Verify the end-to-end state lifecycle

**Files:**
- Modify only files required to fix failures discovered by the commands below

**Interfaces:**
- Consumes: all Tasks 1-5
- Produces: verified behavior for runtime changes, switching sessions, pending requests, errors, and compatibility

- [ ] **Step 1: Run all focused regression tests**

Run:

```bash
npm test -- src/tests/chat-runtime-registry.test.ts src/tests/subagent-parent-abort.test.ts src/tests/chat-runtime-ipc.test.ts src/tests/chat-runtime-status-slice.test.ts src/tests/chat-message-terminal-status.test.ts src/tests/session-list-status.test.ts src/tests/sidebar-session-status.test.tsx src/tests/session-store-runtime.test.ts src/tests/send-message-payload.test.ts
```

Expected: all listed test files PASS. Fix only failures caused by this feature and rerun the exact command.

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`

Expected: all Vitest suites PASS.

- [ ] **Step 3: Run TypeScript validation**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Build the Electron application**

Run: `npm run build`

Expected: main, preload, and renderer builds complete successfully.

- [ ] **Step 5: Inspect the final diff and repository constraints**

Run:

```bash
git diff --check
git diff --stat HEAD~5..HEAD
```

Inspect every changed TS/TSX file for the 200-line hard limit and every changed `className` for the two-style maximum. Confirm no runtime map was added to persisted `ChatSession` and no polling timer exists.

- [ ] **Step 6: Commit verification-only fixes if any**

```bash
git add <only-files-changed-to-fix-verification>
git commit -m "test: verify session list status lifecycle"
```

Skip this commit when verification required no edits.
