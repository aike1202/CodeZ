# Session-Scoped Task Capsule Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate Task presentation by chat session, remove terminal Tasks from the capsule immediately, and preserve completed/cancelled Tasks as expandable `TaskUpdate` execution logs with structured details.

**Architecture:** Keep `SessionData.tasks` and `TaskStore` as the authoritative session-scoped state. Derive the capsule from active (`pending`/`in_progress`) Tasks only, while enriching the existing `TaskUpdate` tool result so the already-persisted execution timeline carries a complete terminal Task snapshot. Parse that snapshot through a small pure helper so current and legacy result shapes are independently testable.

**Tech Stack:** TypeScript 5.5, Zustand 5, React 18, Electron IPC, Vitest 1.6.

## Global Constraints

- Do not add a second Task history/event store or synthetic system messages.
- Keep terminal Tasks in `SessionData.tasks`; filtering is presentation-only.
- Reuse the existing `TaskUpdate` execution timeline entry as the only completion/cancellation log.
- Preserve legacy reduced `TaskUpdate` results without migration.
- Only `pending` and `in_progress` Tasks may appear in the capsule.
- Do not modify or stage unrelated dirty-worktree files.
- Initialize PowerShell UTF-8 and use explicit UTF-8 encoding for repository text reads.

---

## File Structure

- Modify `src/renderer/src/stores/chatStore/slices/sessionSlice.ts` to reset Task presentation state on session creation, invalidate stale selection requests, and derive expansion from the selected session.
- Modify `src/tests/task-session-restore.test.ts` to cover new-session isolation, stale selection races, and expansion reset.
- Modify `src/renderer/src/components/chat/TaskCapsule.order.ts` to expose the active-Task projection used by the capsule.
- Modify `src/renderer/src/components/chat/TaskCapsule.tsx` to calculate and render only active Tasks.
- Modify `src/tests/task-capsule-order.test.ts` to cover `completed`/`cancelled` filtering while preserving active order.
- Modify `src/main/tools/builtin/TaskUpdateTool.ts` to return the complete updated `TaskItem` snapshot.
- Modify `src/renderer/src/components/chat/ExecutionLog/utils/timelineBuilder.ts` to use the approved Chinese completion/cancellation summary punctuation.
- Create `src/renderer/src/components/chat/ExecutionLogDetail/taskUpdateDetail.ts` as a pure compatibility parser for `TaskUpdate` result details.
- Modify `src/renderer/src/components/chat/ExecutionLogDetail/index.tsx` to render structured terminal Task details.
- Modify `src/renderer/src/components/chat/ExecutionLogDetail/ExecutionLogDetail.css` to style the compact structured Task detail.
- Modify `src/tests/task-store-persistence.test.ts` to assert complete `TaskUpdate` snapshots.
- Modify `src/tests/execution-log-batch-builder.test.ts` to assert completion/cancellation summaries and detail parsing compatibility.

---

### Task 1: Isolate Task Presentation During Session Creation and Selection

**Files:**
- Modify: `src/renderer/src/stores/chatStore/slices/sessionSlice.ts`
- Test: `src/tests/task-session-restore.test.ts`

**Interfaces:**
- Consumes: `ChatState.tasks`, `ChatState.expandedCapsule`, `ChatSession.tasks`, and the existing `_selectSessionSeq` request guard.
- Produces: `createSession(projectId: string): string` that starts with an empty Task presentation, and `selectSession(sessionId: string): Promise<void>` that cannot leak Task state or be overwritten by an older selection request.

- [ ] **Step 1: Write failing new-session and selection regression tests**

Add these cases to `src/tests/task-session-restore.test.ts`:

```ts
it('createSession clears task presentation state and invalidates a pending selection', async () => {
  const { useChatStore } = await import('../renderer/src/stores/chatStore')
  let resolveSelection: ((session: any) => void) | undefined
  ;(window as any).api.session.get.mockReturnValue(new Promise((resolve) => {
    resolveSelection = resolve
  }))

  useChatStore.setState({
    sessions: [{
      id: 'old',
      projectId: 'p1',
      summary: 'Old session',
      relativeTime: 'now',
      messages: [],
      tasks: unfinishedTasks
    } as any],
    activeSessionId: 'old',
    messages: [],
    tasks: unfinishedTasks,
    expandedCapsule: 'task'
  })

  const pendingSelection = useChatStore.getState().selectSession('old')
  const newSessionId = useChatStore.getState().createSession('p1')
  resolveSelection?.({
    id: 'old',
    projectId: 'p1',
    summary: 'Old session',
    relativeTime: 'now',
    messages: [],
    tasks: unfinishedTasks
  })
  await pendingSelection

  const state = useChatStore.getState()
  expect(state.activeSessionId).toBe(newSessionId)
  expect(state.tasks).toEqual([])
  expect(state.expandedCapsule).toBeNull()
  expect(state.sessions.find((session) => session.id === newSessionId)?.tasks).toEqual([])
})

it('selectSession closes an inherited task capsule when the target has no active tasks', async () => {
  const { useChatStore } = await import('../renderer/src/stores/chatStore')
  const completedTasks: TaskItem[] = [
    { id: 't1', subject: 'Done', description: '', status: 'completed' },
    { id: 't2', subject: 'Stopped', description: '', status: 'cancelled' }
  ]
  const session = {
    id: 'done',
    projectId: 'p1',
    summary: 'Terminal tasks',
    relativeTime: 'now',
    messages: [],
    tasks: completedTasks
  }

  ;(window as any).api.session.get.mockResolvedValue(session)
  useChatStore.setState({
    sessions: [session as any],
    activeSessionId: 'other',
    messages: [],
    tasks: unfinishedTasks,
    expandedCapsule: 'task'
  })

  await useChatStore.getState().selectSession('done')

  expect(useChatStore.getState().tasks).toEqual(completedTasks)
  expect(useChatStore.getState().expandedCapsule).toBeNull()
})
```

- [ ] **Step 2: Run the focused test and confirm the failure**

Run:

```powershell
npx vitest run src/tests/task-session-restore.test.ts
```

Expected: FAIL because `createSession` retains `tasks`/`expandedCapsule`, does not invalidate the pending `selectSession`, and terminal-only selection inherits `'task'` expansion.

- [ ] **Step 3: Implement session-derived Task state isolation**

Update `createSession` in `src/renderer/src/stores/chatStore/slices/sessionSlice.ts`:

```ts
createSession: (projectId: string) => {
  const id = genId()
  _selectSessionSeq += 1
  const session: ChatSession = {
    id,
    projectId,
    summary: '新会话',
    relativeTime: '刚刚',
    messages: [],
    tasks: []
  }
  set((s) => ({
    sessions: [session, ...s.sessions],
    activeSessionId: id,
    messages: [],
    tasks: [],
    expandedCapsule: s.expandedCapsule === 'task' ? null : s.expandedCapsule
  }))
  get().persistCurrentSession()
  return id
},
```

In both disk-backed and memory-fallback `selectSession` state updates, derive expansion from the selected Task list:

```ts
expandedCapsule: hasUnfinishedTasks(selectedTasks)
  ? 'task'
  : s.expandedCapsule === 'task'
    ? null
    : s.expandedCapsule,
```

For the memory fallback, change `set({ ... })` to `set((s) => ({ ... }))` so it uses the same selected-session derivation rather than reading a mutable global snapshot with `get()`.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
npx vitest run src/tests/task-session-restore.test.ts
```

Expected: all tests in `task-session-restore.test.ts` PASS.

- [ ] **Step 5: Commit the isolated session-state change**

```powershell
git add -- src/renderer/src/stores/chatStore/slices/sessionSlice.ts src/tests/task-session-restore.test.ts
git commit -m "Fix Task state isolation across sessions"
```

---

### Task 2: Project Only Active Tasks Into the Capsule

**Files:**
- Modify: `src/renderer/src/components/chat/TaskCapsule.order.ts`
- Modify: `src/renderer/src/components/chat/TaskCapsule.tsx`
- Test: `src/tests/task-capsule-order.test.ts`

**Interfaces:**
- Consumes: persisted `TaskItem[]` containing all statuses.
- Produces: `getTaskDisplayTasks(tasks: TaskItem[]): TaskItem[]`, returning only `pending` and `in_progress` items in original list order.

- [ ] **Step 1: Replace the ordering test with active-projection coverage**

Update `src/tests/task-capsule-order.test.ts`:

```ts
describe('TaskCapsule active task projection', () => {
  it('keeps only pending and in-progress tasks in original list order', () => {
    const tasks = [
      task('completed-first', 'completed'),
      task('pending-second', 'pending'),
      task('running-third', 'in_progress'),
      task('cancelled-fourth', 'cancelled'),
      task('pending-fifth', 'pending')
    ]

    expect(getTaskDisplayTasks(tasks).map((item) => item.id)).toEqual([
      'pending-second',
      'running-third',
      'pending-fifth'
    ])
  })

  it('returns an empty projection when every task is terminal', () => {
    expect(getTaskDisplayTasks([
      task('done', 'completed'),
      task('stopped', 'cancelled')
    ])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the focused test and confirm the failure**

Run:

```powershell
npx vitest run src/tests/task-capsule-order.test.ts
```

Expected: FAIL because `getTaskDisplayTasks` currently returns terminal Tasks.

- [ ] **Step 3: Implement the active projection and consume it before rendering**

Update `src/renderer/src/components/chat/TaskCapsule.order.ts`:

```ts
import type { TaskItem } from '../../../../shared/types/task'

export const getTaskDisplayTasks = (tasks: TaskItem[]): TaskItem[] =>
  tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress')
```

In `src/renderer/src/components/chat/TaskCapsule.tsx`, derive `displayTasks` immediately after reading store state and return `null` when it is empty:

```tsx
const tasks = useChatStore((s) => s.tasks)
const displayTasks = getTaskDisplayTasks(tasks || [])

if (displayTasks.length === 0) {
  return null
}

const total = displayTasks.length
const inProgress = displayTasks.find((task) => task.status === 'in_progress')
```

Use `displayTasks`, not the persisted `tasks`, for group metadata and row rendering. The collapsed fallback label becomes `Tasks ${total}`. Since the projection cannot be all done, render the active `ListTodo` icon and `executing` capsule style directly, and remove terminal-only icon/count branches that are now unreachable.

- [ ] **Step 4: Run focused Task capsule tests**

Run:

```powershell
npx vitest run src/tests/task-capsule-order.test.ts src/tests/task-capsule-theme-colors.test.ts
```

Expected: both test files PASS.

- [ ] **Step 5: Commit the capsule projection change**

```powershell
git add -- src/renderer/src/components/chat/TaskCapsule.order.ts src/renderer/src/components/chat/TaskCapsule.tsx src/tests/task-capsule-order.test.ts
git commit -m "Hide terminal Tasks from the active capsule"
```

---

### Task 3: Persist Full Terminal Snapshots in Expandable TaskUpdate Logs

**Files:**
- Modify: `src/main/tools/builtin/TaskUpdateTool.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLog/utils/timelineBuilder.ts`
- Create: `src/renderer/src/components/chat/ExecutionLogDetail/taskUpdateDetail.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLogDetail/index.tsx`
- Modify: `src/renderer/src/components/chat/ExecutionLogDetail/ExecutionLogDetail.css`
- Test: `src/tests/task-store-persistence.test.ts`
- Test: `src/tests/execution-log-batch-builder.test.ts`

**Interfaces:**
- Consumes: `TaskStore.update(...): TaskItem | null` and persisted `UnifiedTimelineItem.detail?: string`.
- Produces: `TaskUpdate` result field `data.task: TaskItem | null` and `parseTaskUpdateDetail(detail?: string): ParsedTaskUpdateDetail | null`.

- [ ] **Step 1: Add failing full-snapshot and log-summary tests**

In `src/tests/task-store-persistence.test.ts`, add:

```ts
it('returns the complete updated task snapshot for execution-log persistence', async () => {
  const { TaskUpdateTool } = await import('../main/tools/builtin/TaskUpdateTool')
  const { TaskStore } = await import('../main/services/TaskStore')
  const store = TaskStore.getInstance()
  store.create('s1', [{
    subject: 'Verify lifecycle',
    description: 'Confirm terminal Task logging',
    files: ['src/task.ts'],
    acceptanceCriteria: ['Capsule no longer shows the Task'],
    verificationCommand: 'npm test -- task-store-persistence'
  }])

  const result = JSON.parse(await new TaskUpdateTool().execute(
    JSON.stringify({ taskId: 't1', status: 'completed' }),
    { workspaceRoot: process.cwd(), sessionId: 's1' } as any
  ))

  expect(result.data.task).toMatchObject({
    id: 't1',
    subject: 'Verify lifecycle',
    description: 'Confirm terminal Task logging',
    status: 'completed',
    files: ['src/task.ts'],
    acceptanceCriteria: ['Capsule no longer shows the Task'],
    verificationCommand: 'npm test -- task-store-persistence'
  })
})
```

In `src/tests/execution-log-batch-builder.test.ts`, import `parseTaskUpdateDetail` and add a helper plus these cases:

```ts
const taskUpdateTimeline = (status: 'completed' | 'cancelled'): ExecutionTimelineItem[] => [{
  id: `tool_task-${status}`,
  type: 'tool',
  toolCall: {
    id: `task-${status}`,
    name: 'TaskUpdate',
    args: JSON.stringify({ taskId: 't1', status }),
    status: 'success',
    result: JSON.stringify({
      ok: true,
      data: {
        task: {
          id: 't1',
          subject: 'Lifecycle task',
          description: 'Detailed terminal snapshot',
          status,
          files: ['src/task.ts'],
          acceptanceCriteria: ['Terminal state is logged'],
          verificationCommand: 'npm test'
        },
        summary: '1/1 completed'
      }
    }),
    startedAt: 100,
    completedAt: 200,
    sequence: 0
  },
  startedAt: 100,
  updatedAt: 200,
  sequence: 0
}]

it.each([
  ['completed', '完成任务：Lifecycle task'],
  ['cancelled', '取消任务：Lifecycle task']
] as const)('keeps a %s TaskUpdate as a terminal execution log', (status, target) => {
  const [item] = buildUnifiedTimeline(taskUpdateTimeline(status), [], [], undefined, false)
  expect(item).toMatchObject({ toolName: 'TaskUpdate', target, status: 'success' })
})

it('parses complete TaskUpdate detail and tolerates legacy reduced snapshots', () => {
  const [fullItem] = buildUnifiedTimeline(taskUpdateTimeline('completed'), [], [], undefined, false)
  expect(parseTaskUpdateDetail(fullItem.detail)).toMatchObject({
    task: {
      description: 'Detailed terminal snapshot',
      files: ['src/task.ts'],
      acceptanceCriteria: ['Terminal state is logged'],
      verificationCommand: 'npm test'
    }
  })

  expect(parseTaskUpdateDetail(JSON.stringify({
    ok: true,
    data: { task: { id: 't1', subject: 'Legacy', status: 'completed' } }
  }))).toMatchObject({ task: { subject: 'Legacy', status: 'completed' } })
})
```

- [ ] **Step 2: Run the focused tests and confirm the failure**

Run:

```powershell
npx vitest run src/tests/task-store-persistence.test.ts src/tests/execution-log-batch-builder.test.ts
```

Expected: FAIL because `TaskUpdate` returns a reduced snapshot and `parseTaskUpdateDetail` does not exist.

- [ ] **Step 3: Return the complete updated Task snapshot**

In `src/main/tools/builtin/TaskUpdateTool.ts`, replace the reduced task mapping:

```ts
return JSON.stringify({
  ok: true,
  data: {
    task: updated ? { ...updated } : null,
    summary: store.summary(sessionId)
  }
})
```

The shallow copy prevents later in-memory mutation from changing the snapshot before serialization.

In `src/renderer/src/components/chat/ExecutionLog/utils/timelineBuilder.ts`, keep the existing status mapping but use the approved visible summaries:

```ts
if (task.status === 'completed') {
  targetDisplay = `完成任务：${task.subject}`
} else if (task.status === 'in_progress') {
  targetDisplay = `开始执行：${task.subject}`
} else if (task.status === 'cancelled') {
  targetDisplay = `取消任务：${task.subject}`
} else {
  targetDisplay = `更新任务：${task.subject}`
}
```

- [ ] **Step 4: Add a compatibility parser for persisted TaskUpdate details**

Create `src/renderer/src/components/chat/ExecutionLogDetail/taskUpdateDetail.ts`:

```ts
import type { TaskItem } from '../../../../../shared/types/task'

export interface ParsedTaskUpdateDetail {
  task: Partial<TaskItem>
  summary?: string
}

export function parseTaskUpdateDetail(detail?: string): ParsedTaskUpdateDetail | null {
  if (!detail) return null
  try {
    const parsed = JSON.parse(detail)
    const task = parsed?.data?.task
    if (!task || typeof task !== 'object') return null
    return {
      task,
      summary: typeof parsed.data.summary === 'string' ? parsed.data.summary : undefined
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Render structured terminal Task details with legacy fallback**

Import `parseTaskUpdateDetail` into `src/renderer/src/components/chat/ExecutionLogDetail/index.tsx`. In the existing `TaskCreate / TaskUpdate` branch, parse once:

```ts
const taskUpdateDetail = item.toolName === 'TaskUpdate'
  ? parseTaskUpdateDetail(item.detail)
  : null
const task = taskUpdateDetail?.task
const isTerminalTask = task?.status === 'completed' || task?.status === 'cancelled'
```

Before the existing update-request section, render fields only when present:

```tsx
{item.toolName === 'TaskUpdate' && task && isTerminalTask && (
  <div className="exe-log-task-detail" data-status={task.status}>
    <div className="exe-log-task-detail-row">
      <span className="exe-log-param-key">最终状态</span>
      <span className="exe-log-param-val">{task.status}</span>
    </div>
    {task.description && (
      <div className="exe-log-task-detail-row">
        <span className="exe-log-param-key">描述</span>
        <span className="exe-log-param-val">{task.description}</span>
      </div>
    )}
    {task.files && task.files.length > 0 && (
      <div className="exe-log-task-detail-row">
        <span className="exe-log-param-key">涉及文件</span>
        <span className="exe-log-param-val">{task.files.join('\n')}</span>
      </div>
    )}
    {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
      <div className="exe-log-task-detail-row">
        <span className="exe-log-param-key">验收标准</span>
        <span className="exe-log-param-val">{task.acceptanceCriteria.join('\n')}</span>
      </div>
    )}
    {task.verificationCommand && (
      <div className="exe-log-task-detail-row">
        <span className="exe-log-param-key">验证命令</span>
        <code className="exe-log-task-command">{task.verificationCommand}</code>
      </div>
    )}
  </div>
)}
```

Keep the current Update Request and Current Progress sections below it. A legacy reduced snapshot therefore shows its final status and existing raw request/progress information without throwing.

Add compact styles to `src/renderer/src/components/chat/ExecutionLogDetail/ExecutionLogDetail.css`:

```css
.exe-log-task-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  background: var(--bg-panel);
}

.exe-log-task-detail-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}

.exe-log-task-command {
  min-width: 0;
  color: var(--text-main);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 680px) {
  .exe-log-task-detail-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
```

- [ ] **Step 6: Run focused tests and type-checking**

Run:

```powershell
npx vitest run src/tests/task-store-persistence.test.ts src/tests/execution-log-batch-builder.test.ts src/tests/task-session-restore.test.ts src/tests/task-capsule-order.test.ts src/tests/task-capsule-theme-colors.test.ts
npm run typecheck
```

Expected: all focused tests PASS and TypeScript exits with code 0.

- [ ] **Step 7: Run the full regression suite**

Run:

```powershell
npm test
```

Expected: the full Vitest suite PASS. If an unrelated dirty-worktree test fails, record the exact pre-existing failure and verify all focused Task tests still pass.

- [ ] **Step 8: Commit the expandable TaskUpdate log change**

```powershell
git add -- src/main/tools/builtin/TaskUpdateTool.ts src/renderer/src/components/chat/ExecutionLog/utils/timelineBuilder.ts src/renderer/src/components/chat/ExecutionLogDetail/taskUpdateDetail.ts src/renderer/src/components/chat/ExecutionLogDetail/index.tsx src/renderer/src/components/chat/ExecutionLogDetail/ExecutionLogDetail.css src/tests/task-store-persistence.test.ts src/tests/execution-log-batch-builder.test.ts
git commit -m "Show terminal Task details in execution logs"
```

---

## Final Verification

- [ ] Create a Task list in session A and verify only active Tasks appear in A's capsule.
- [ ] Create session B and verify A's capsule disappears immediately.
- [ ] Return to session A and verify its active Tasks return.
- [ ] Mark one Task completed and verify it leaves the capsule while `完成任务：<subject>` remains expandable in the execution log.
- [ ] Mark one Task cancelled and verify it leaves the capsule while `取消任务：<subject>` remains expandable in the execution log.
- [ ] Expand both terminal logs and verify description, files, acceptance criteria, verification command, and final status are shown when supplied.
- [ ] Confirm completed/cancelled Tasks remain in persisted `SessionData.tasks` and are not recreated in the capsule after restart.

---

## Review Hardening

Code review identified existing paths that the original three tasks did not
exercise. The implementation must also include these checks:

- [ ] Bind `TaskCapsule` expansion to `chatStore.expandedCapsule`; verify the
  rendered popover follows the session-scoped store value.
- [ ] Recheck `_selectSessionSeq` after a rejected disk lookup and before the
  memory fallback; cover a deferred rejection invalidated by `createSession`.
- [ ] Validate persisted Task detail fields before rendering arrays or strings
  so malformed legacy results cannot throw.
- [ ] Include full snapshots of Tasks completed by `DelegateTasks` in that
  persisted tool result and derive one TaskUpdate display item per snapshot.
- [ ] Exclude previously completed Tasks skipped during delegated retries from
  newly derived terminal logs.
- [ ] Render a complete terminal snapshot through `ExecutionLogDetail` in a
  component-level test.
