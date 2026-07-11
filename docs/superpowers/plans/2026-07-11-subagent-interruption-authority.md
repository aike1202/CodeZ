# Subagent Interruption Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the main process authoritative for subagent interruption, return real interruptions to the main agent as tool errors, and remove user-facing continuation prompts.

**Architecture:** Add a session-aware main-runner registry and expose a read-only runtime-status IPC. Propagate the parent abort signal into subagents, represent `interrupted` across the shared result contract, reconcile persisted renderer state only after the authority query, and use a hidden internal turn only for crash-recovered interruptions.

**Tech Stack:** Electron IPC, TypeScript, React, Zustand, Vitest

## Global Constraints

- PowerShell commands that may print Chinese text must initialize UTF-8 and file reads must specify `-Encoding UTF8`.
- Absence of output or elapsed time must never be used to infer interruption.
- User-initiated stop cancels the parent and children and must never trigger automatic continuation.
- Crash-recovered interruption must not create a user message or populate the prompt editor.
- Do not add dependencies or refactor unrelated chat, provider, permission, or task behavior.

---

## File Map

- Create `src/main/services/ChatRuntimeRegistry.ts`: authoritative stream-to-session registry and session status projection.
- Modify `src/shared/types/subagent.ts`: shared runtime status and unified subagent terminal status.
- Modify `src/shared/ipc/channels.ts`: runtime-status IPC channel.
- Modify `src/main/ipc/chat.handlers.ts`: register/unregister runners, expose status, and ensure cleanup on every terminal path.
- Modify `src/preload/index.ts` and `src/renderer/src/env.d.ts`: renderer API for the status query.
- Modify `src/main/agent/SubAgentManager.ts`: session-aware active handles, parent abort propagation, and interrupted result.
- Modify `src/main/agent/AgentRunner/types.ts`, `src/main/agent/AgentRunner/index.ts`, and `src/main/agent/AgentRunner/subAgentRunnerHelper.ts`: interrupted result contract and parent signal handoff.
- Modify `src/renderer/src/stores/chatStore/types.ts`, `slices/sessionSlice.ts`, and `slices/messageSlice.ts`: authoritative reconciliation, internal continuation queue, and explicit user-abort persistence.
- Modify `src/renderer/src/components/chat/hooks/useSendMessage.ts` and `ChatArea/index.tsx`: hidden internal continuation without a user/system prompt message.
- Modify `src/renderer/src/components/chat/AgentMessageContent.tsx`, `ExecutionLog/types.ts`, `ExecutionLog/index.tsx`, `ExecutionLog/utils/summaryFormatter.ts`, and `SubAgentCard.tsx`: consistent interrupted presentation.
- Add/modify focused Vitest files under `src/tests/` for each behavior.

---

### Task 1: Authoritative Runtime Registry and IPC

**Files:**
- Create: `src/main/services/ChatRuntimeRegistry.ts`
- Modify: `src/shared/types/subagent.ts`
- Modify: `src/shared/ipc/channels.ts`
- Modify: `src/main/ipc/chat.handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Test: `src/tests/chat-runtime-registry.test.ts`

**Interfaces:**
- Produces: `SessionRuntimeStatus`, `ChatRuntimeRegistry.register(streamId, sessionId, runner)`, `unregister(streamId)`, `getStatus(sessionId, activeSubAgentIds)`.
- Consumes later: `window.api.chat.getRuntimeStatus(sessionId)` in session reconciliation.

- [ ] **Step 1: Write the failing registry test**

```ts
import { describe, expect, it } from 'vitest'
import { ChatRuntimeRegistry } from '../main/services/ChatRuntimeRegistry'

describe('ChatRuntimeRegistry', () => {
  it('reports only runners and subagents belonging to the requested session', () => {
    const registry = new ChatRuntimeRegistry<{ abort(): void }>()
    registry.register('stream-1', 's1', { abort() {} })
    registry.register('stream-2', 's2', { abort() {} })

    expect(registry.getStatus('s1', ['subagent-a'])).toEqual({
      sessionId: 's1',
      mainRunnerActive: true,
      activeSubAgentIds: ['subagent-a']
    })
    expect(registry.getStatus('missing', [])).toEqual({
      sessionId: 'missing',
      mainRunnerActive: false,
      activeSubAgentIds: []
    })
  })

  it('removes terminal streams exactly once', () => {
    const registry = new ChatRuntimeRegistry<{ abort(): void }>()
    registry.register('stream-1', 's1', { abort() {} })
    registry.unregister('stream-1')
    registry.unregister('stream-1')
    expect(registry.getStatus('s1', []).mainRunnerActive).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm.cmd test -- --run src/tests/chat-runtime-registry.test.ts`

Expected: FAIL because `ChatRuntimeRegistry` does not exist.

- [ ] **Step 3: Implement the registry and shared status type**

```ts
// src/shared/types/subagent.ts
export interface SessionRuntimeStatus {
  sessionId: string
  mainRunnerActive: boolean
  activeSubAgentIds: string[]
}

// src/main/services/ChatRuntimeRegistry.ts
import type { SessionRuntimeStatus } from '../../shared/types/subagent'

interface ActiveRunner<T> {
  sessionId: string
  runner: T
}

export class ChatRuntimeRegistry<T extends { abort(): void }> {
  private readonly entries = new Map<string, ActiveRunner<T>>()

  register(streamId: string, sessionId: string, runner: T): void {
    this.entries.set(streamId, { sessionId, runner })
  }

  getRunner(streamId: string): T | undefined {
    return this.entries.get(streamId)?.runner
  }

  unregister(streamId: string): void {
    this.entries.delete(streamId)
  }

  getStatus(sessionId: string, activeSubAgentIds: string[]): SessionRuntimeStatus {
    return {
      sessionId,
      mainRunnerActive: [...this.entries.values()].some((entry) => entry.sessionId === sessionId),
      activeSubAgentIds
    }
  }
}
```

Add `CHAT_RUNTIME_STATUS: 'chat:runtime:status'`, register an IPC handler backed by the runner registry, and expose:

```ts
getRuntimeStatus: (sessionId: string): Promise<SessionRuntimeStatus> =>
  ipcRenderer.invoke(IPC_CHANNELS.CHAT_RUNTIME_STATUS, sessionId)
```

For this independently type-safe task, return `activeSubAgentIds: []`. Task 2 adds the
session-aware subagent handles and replaces that placeholder value with
`SubAgentManager.listActiveForSession(sessionId)`.

Replace every `activeRunners.set/get/delete` call with registry operations. Put unregister calls in one idempotent `finishStream(streamId)` helper used by `onDone`, `onError`, promise rejection, and stop.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm.cmd test -- --run src/tests/chat-runtime-registry.test.ts src/tests/chat-stream-v2.test.ts`

Expected: PASS.

Run: `npm.cmd run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/main/services/ChatRuntimeRegistry.ts src/shared/types/subagent.ts src/shared/ipc/channels.ts src/main/ipc/chat.handlers.ts src/preload/index.ts src/renderer/src/env.d.ts src/tests/chat-runtime-registry.test.ts
git commit -m "feat: expose authoritative chat runtime status"
```

---

### Task 2: Propagate Cancellation and Return Interrupted Tool Results

**Files:**
- Modify: `src/main/agent/SubAgentManager.ts`
- Modify: `src/main/agent/AgentRunner/types.ts`
- Modify: `src/main/agent/AgentRunner/index.ts`
- Modify: `src/main/agent/AgentRunner/subAgentRunnerHelper.ts`
- Modify: `src/main/ipc/chat.handlers.ts`
- Test: `src/tests/subagent-parent-abort.test.ts`
- Test: `src/tests/subagent-runner-helper.test.ts`

**Interfaces:**
- Consumes: runtime status reads `SubAgentManager.listActiveForSession(sessionId)`.
- Produces: `SubAgentResult.status: 'completed' | 'failed' | 'interrupted'` and `parentSignal?: AbortSignal` on `SubAgentContext`.

- [ ] **Step 1: Write the failing parent-abort test**

Create a registered test subagent whose mocked `streamChat` waits for `signal.abort`. Start `SubAgentManager.spawn()` with a parent signal, abort it, and assert:

```ts
expect(result.status).toBe('interrupted')
expect(result.output).toContain('interrupted')
expect(SubAgentManager.listActiveForSession('s1')).toEqual([])
```

Also assert the handle is visible before abort with the caller-facing `subAgentId`, not the internal random handle id.

- [ ] **Step 2: Run the test and verify the status/type failure**

Run: `npm.cmd test -- --run src/tests/subagent-parent-abort.test.ts`

Expected: FAIL because parent abort is not linked and `interrupted` is not a valid result status.

- [ ] **Step 3: Implement the unified interrupted contract**

Extend the handle and context:

```ts
export interface SubAgentContext {
  // existing fields
  parentSignal?: AbortSignal
}

export interface SubAgentHandle {
  id: string
  subAgentId: string
  sessionId: string
  type: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  result?: SubAgentResult
  cancel(): void
}

export interface SubAgentResult {
  status: 'completed' | 'failed' | 'interrupted'
  // existing fields
}
```

Link signals immediately after handle creation:

```ts
const abortFromParent = () => handle.cancel()
ctx.parentSignal?.addEventListener('abort', abortFromParent, { once: true })
```

When the local controller is aborted, construct an interrupted result rather than allowing the generic protocol-failure branch to overwrite it. Remove the parent listener in `finally`, and add:

```ts
static listActiveForSession(sessionId: string): string[] {
  return [...this.activeHandles.values()]
    .filter((handle) => handle.sessionId === sessionId && handle.status === 'running')
    .map((handle) => handle.subAgentId)
}
```

Pass `this.abortController.signal` from `AgentRunner` to `handleSubAgentRunnerSpawn`, and then to `SubAgentManager.spawn` as `parentSignal`.
Update the runtime-status IPC handler from Task 1 to pass
`SubAgentManager.listActiveForSession(sessionId)` instead of an empty array.

- [ ] **Step 4: Map interruption to a structured tool error**

In `subAgentRunnerHelper`, preserve the returned status and emit:

```ts
const interrupted = result.status === 'interrupted'
const resultMsg = interrupted
  ? JSON.stringify({
      ok: false,
      error: {
        code: 'EXECUTION_INTERRUPTED',
        message: result.output || `SubAgent '${subagent_type}' was interrupted.`
      },
      data: resultData
    })
  : /* existing completed/failed branches */
```

Call `onSubAgentEnd` with `interrupted`. When the parent was not aborted, the ordinary AgentRunner tool loop records this error and continues. When the parent signal was aborted, the parent turn exits without `onDone`, so user stop cannot auto-resume.

- [ ] **Step 5: Run protocol and abort regressions**

Run: `npm.cmd test -- --run src/tests/subagent-parent-abort.test.ts src/tests/subagent-runner-helper.test.ts src/tests/subagent-manager-protocol.test.ts src/tests/subagent-manager-recovery.test.ts`

Expected: PASS.

Run: `npm.cmd run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/main/agent/SubAgentManager.ts src/main/agent/AgentRunner/types.ts src/main/agent/AgentRunner/index.ts src/main/agent/AgentRunner/subAgentRunnerHelper.ts src/main/ipc/chat.handlers.ts src/tests/subagent-parent-abort.test.ts src/tests/subagent-runner-helper.test.ts
git commit -m "fix: propagate subagent interruption to the parent runner"
```

---

### Task 3: Reconcile Sessions Without User Prompt Injection

**Files:**
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/sessionSlice.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/messageSlice.ts`
- Test: `src/tests/subagent-session-restore.test.ts`
- Test: `src/tests/task-capsule-session-state.test.ts`

**Interfaces:**
- Consumes: `window.api.chat.getRuntimeStatus(sessionId)`.
- Produces: `pendingInternalContinuation` and `markActiveRunUserAborted(sessionId)`.

- [ ] **Step 1: Replace the old restore test with authority cases**

Add two tests using the same persisted `running` fixture:

```ts
it('keeps a running subagent when the main process confirms the session is active', async () => {
  window.api.chat.getRuntimeStatus.mockResolvedValue({
    sessionId: 's1', mainRunnerActive: true, activeSubAgentIds: ['subagent_tool_1']
  })
  await useChatStore.getState().selectSession('s1')
  expect(useChatStore.getState().messages[0].subAgents![0].status).toBe('running')
  expect(useChatStore.getState().pendingPrompt).toBeNull()
  expect(useChatStore.getState().pendingInternalContinuation).toBeNull()
})

it('interrupts stale running state and queues an internal continuation', async () => {
  window.api.chat.getRuntimeStatus.mockResolvedValue({
    sessionId: 's1', mainRunnerActive: false, activeSubAgentIds: []
  })
  await useChatStore.getState().selectSession('s1')
  expect(useChatStore.getState().messages[0].subAgents![0].status).toBe('interrupted')
  expect(useChatStore.getState().pendingPrompt).toBeNull()
  expect(useChatStore.getState().pendingInternalContinuation?.sessionId).toBe('s1')
})
```

Add a third test with two running subagents and assert both are interrupted but only one session-level continuation is queued.

- [ ] **Step 2: Run the restore tests and verify failure**

Run: `npm.cmd test -- --run src/tests/subagent-session-restore.test.ts`

Expected: FAIL because session selection does not query runtime authority and still writes `pendingPrompt`.

- [ ] **Step 3: Implement authoritative reconciliation**

Replace `buildInterruptedSubAgentPrompt` with a hidden continuation constant:

```ts
const SUBAGENT_INTERRUPTED_CONTINUATION = [
  'A previously running SubAgentRunner call ended with EXECUTION_INTERRUPTED.',
  'Treat it as a tool failure. Continue the existing user request autonomously using another method.',
  'Do not ask the user to resend or confirm the task.'
].join(' ')
```

Change the healing return value to `{ messages, changed }`; never return a prompt. Remove eager healing from `loadSessions`. In `selectSession`:

```ts
const [freshSession, runtimeStatus] = await Promise.all([
  window.api.session.get(sessionId),
  window.api.chat.getRuntimeStatus(sessionId)
])

const cached = get().sessions.find((session) => session.id === sessionId)
const sourceMessages = runtimeStatus.mainRunnerActive && cached
  ? cached.messages
  : freshSession.messages
const healed = runtimeStatus.mainRunnerActive
  ? { messages: sourceMessages, changed: false }
  : healInterruptedSubAgents(sourceMessages)
```

When `healed.changed`, save the interrupted state and set:

```ts
pendingPrompt: null,
pendingInternalContinuation: {
  sessionId,
  text: SUBAGENT_INTERRUPTED_CONTINUATION
}
```

Do not queue it when records were already `interrupted`, which makes repeated session selection idempotent.

- [ ] **Step 4: Persist explicit user-abort reason before cleanup**

Add `markActiveRunUserAborted(sessionId)` to update any running subagent to `interrupted` with `interruptionReason: 'user_aborted'`, set the message to non-streaming, and persist. Task 4 wires this action into the stream cleanup wrapper before `CHAT_STREAM_STOP` is sent.

The healing function must not queue internal continuation for records whose `interruptionReason` is `user_aborted`.

- [ ] **Step 5: Run session tests and typecheck**

Run: `npm.cmd test -- --run src/tests/subagent-session-restore.test.ts src/tests/task-capsule-session-state.test.ts`

Expected: PASS.

Run: `npm.cmd run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add src/renderer/src/stores/chatStore/types.ts src/renderer/src/stores/chatStore/slices/sessionSlice.ts src/renderer/src/stores/chatStore/slices/messageSlice.ts src/tests/subagent-session-restore.test.ts src/tests/task-capsule-session-state.test.ts
git commit -m "fix: reconcile subagent state with runtime authority"
```

---

### Task 4: Execute One Hidden Internal Continuation

**Files:**
- Modify: `src/renderer/src/components/chat/hooks/useSendMessage.ts`
- Modify: `src/renderer/src/components/chat/ChatArea/index.tsx`
- Modify: `src/renderer/src/stores/chatStore/types.ts`
- Modify: `src/renderer/src/stores/chatStore/slices/messageSlice.ts`
- Test: `src/tests/subagent-internal-continuation.test.ts`

**Interfaces:**
- Consumes: `pendingInternalContinuation` from Task 3.
- Produces: `handleSendMessage(..., { visibility: 'internal' })` and `consumeInternalContinuation(sessionId)`.

- [ ] **Step 1: Write a failing input-builder/visibility test**

Test the pure request setup exported from `useSendMessage.ts`:

```ts
const input = buildChatStreamInput('continue after tool failure', [], 'internal-1', true)
expect(input.isSystem).toBe(true)
expect(input.text).toContain('continue after tool failure')
```

Render or exercise the store/hook boundary with `visibility: 'internal'` and assert no `role: 'user'` or `role: 'system'` prompt message is appended, while one agent streaming reply is created.

- [ ] **Step 2: Run the test and verify failure**

Run: `npm.cmd test -- --run src/tests/subagent-internal-continuation.test.ts`

Expected: FAIL because internal visibility and consumption do not exist.

- [ ] **Step 3: Add internal send visibility**

Extend the callback without changing existing call sites:

```ts
interface SendMessageOptions {
  visibility?: 'visible' | 'internal'
}

async function handleSendMessage(
  message: string,
  modelName: string,
  isSystem = false,
  options: SendMessageOptions = {}
) {
  const internal = options.visibility === 'internal'
  const uiMessageId = internal
    ? `internal_${genId()}`
    : isSystem
      ? useChatStore.getState().addSystemMessage(message).id
      : addUserMessage(message).id
  // existing stream path follows
}
```

Do not call `persistSession` for a nonexistent prompt message; the agent reply and subsequent stream events remain normally persisted.
In the user-facing cleanup wrapper, call
`markActiveRunUserAborted(sid)` before invoking the preload cleanup. This persists the
non-resumable cause before the main process unregisters the runner.

- [ ] **Step 4: Consume and dispatch once from ChatArea**

Use an effect keyed by active session and the queued item:

```ts
useEffect(() => {
  if (!pendingInternalContinuation) return
  if (pendingInternalContinuation.sessionId !== activeSessionId) return
  if (streamCleanups[activeSessionId]) return

  const continuation = consumeInternalContinuation(activeSessionId)
  if (!continuation) return
  void handleSendMessage(continuation.text, '', true, { visibility: 'internal' })
}, [activeSessionId, pendingInternalContinuation, streamCleanups, consumeInternalContinuation, handleSendMessage])
```

Consumption clears the item before starting the stream so React rerenders cannot send it twice. On startup failures, surface the normal agent error response; do not put text into the editor.

- [ ] **Step 5: Run continuation and chat tests**

Run: `npm.cmd test -- --run src/tests/subagent-internal-continuation.test.ts src/tests/chat-stream-v2.test.ts src/tests/subagent-session-restore.test.ts`

Expected: PASS.

Run: `npm.cmd run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add src/renderer/src/components/chat/hooks/useSendMessage.ts src/renderer/src/components/chat/ChatArea/index.tsx src/renderer/src/stores/chatStore/types.ts src/renderer/src/stores/chatStore/slices/messageSlice.ts src/tests/subagent-internal-continuation.test.ts
git commit -m "feat: resume interrupted subagent work internally"
```

---

### Task 5: Render Interrupted State Without Completion Contradiction

**Files:**
- Modify: `src/renderer/src/components/chat/AgentMessageContent.tsx`
- Modify: `src/renderer/src/components/chat/ExecutionLog/types.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLog/index.tsx`
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/summaryFormatter.ts`
- Modify: `src/renderer/src/components/chat/SubAgentCard.tsx`
- Test: `src/tests/subagent-interrupted-render.test.ts`

**Interfaces:**
- Consumes: `ChatMessage.interrupted` and `SubAgentRecord.status === 'interrupted'`.
- Produces: explicit interrupted header state and copy.

- [ ] **Step 1: Write the failing render test**

Render `ExecutionLog` with `streaming={false}`, `interrupted={true}`, and an interrupted subagent. Assert:

```ts
expect(html).toContain('执行已中断')
expect(html).not.toContain('已完成')
expect(html).not.toContain('已中断，可继续')
```

- [ ] **Step 2: Run the render test and verify the current contradiction**

Run: `npm.cmd test -- --run src/tests/subagent-interrupted-render.test.ts`

Expected: FAIL because the header derives success from `streaming === false`.

- [ ] **Step 3: Pass and render explicit interruption**

Add `interrupted?: boolean` to `ExecutionLogProps`, pass `msg.interrupted` from every `AgentMessageContent` call, and derive:

```ts
const running = !interrupted && (
  Boolean(streaming) || unifiedItems.some((item) => item.status === 'running')
)
const summary = interrupted
  ? '执行已中断'
  : buildSummaryText(unifiedItems, running)
```

Render `IconWarning` for interruption, `IconLoading` for running, and `IconCheck` only for completed display. Change the collapsed subagent copy from `已中断，可继续` to `已中断`.

- [ ] **Step 4: Run UI and full focused regressions**

Run: `npm.cmd test -- --run src/tests/subagent-interrupted-render.test.ts src/tests/execution-log-batch-builder.test.ts src/tests/subagent-session-restore.test.ts`

Expected: PASS.

Run: `npm.cmd test -- --run src/tests/subagent*.test.ts src/tests/chat-stream-v2.test.ts src/tests/session-runtime-recovery.test.ts src/tests/session-runtime-coordinator.test.ts`

Expected: all selected tests PASS. On PowerShell, replace the wildcard with the explicit test paths if Vitest does not expand it.

Run: `npm.cmd run typecheck`

Expected: PASS.

- [ ] **Step 5: Review the final diff against the acceptance criteria**

Run: `git diff --check`

Confirm manually from the diff:

- No session-select path writes a subagent recovery string into `pendingPrompt`.
- No timeout is used for interruption classification.
- User stop propagates abort and cannot enqueue `pendingInternalContinuation`.
- Runtime-active sessions preserve `running` records.
- Only explicit `completed` paths show the completion icon/copy.

- [ ] **Step 6: Commit Task 5**

```powershell
git add src/renderer/src/components/chat/AgentMessageContent.tsx src/renderer/src/components/chat/ExecutionLog/types.ts src/renderer/src/components/chat/ExecutionLog/index.tsx src/renderer/src/components/chat/ExecutionLog/utils/summaryFormatter.ts src/renderer/src/components/chat/SubAgentCard.tsx src/tests/subagent-interrupted-render.test.ts
git commit -m "fix: render authoritative subagent interruption state"
```

---

## Final Verification

Run:

```powershell
npm.cmd run typecheck
npm.cmd test -- --run
git status --short
```

Expected:

- TypeScript reports no errors.
- The complete Vitest suite passes.
- Only intended implementation/plan changes are present; pre-existing `.claude/settings.local.json` remains untouched.
