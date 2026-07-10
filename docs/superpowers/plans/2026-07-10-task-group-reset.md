# Task Group Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a fresh current Task list when a completed list is followed by another `TaskCreate` call, so progress no longer accumulates across completed groups.

**Architecture:** Keep `TaskStore` as the single source of truth for the current session Task list. On creation, retain the existing list only while it contains unfinished work; once every existing Task is terminal, replace the current list before adding the next group while preserving the session-level ID counter.

**Tech Stack:** TypeScript, Electron, Vitest

## Global Constraints

- Preserve existing unfinished-list append behavior.
- Treat both `completed` and `cancelled` as terminal statuses.
- Keep Task IDs monotonic within a session to avoid reusing historical IDs.
- Do not modify unrelated dirty worktree files.
- Do not create a commit unless the user explicitly requests one.

---

### Task 1: Reproduce Completed-List Accumulation

**Files:**
- Modify: `src/tests/task-store-persistence.test.ts`
- Test: `src/tests/task-store-persistence.test.ts`

**Interfaces:**
- Consumes: `TaskStore.create(sessionId, items)` and `TaskStore.update(sessionId, taskId, patch)`
- Produces: A regression test proving the persisted current list contains only the new group after the previous list is terminal.

- [ ] **Step 1: Write the failing test**

```ts
it('starts a fresh task list after the previous list is finished', async () => {
  const { TaskStore } = await import('../main/services/TaskStore')
  const store = TaskStore.getInstance()
  store.create('s1', [{ subject: 'First task' }, { subject: 'Second task' }])
  store.update('s1', 't1', { status: 'completed' })
  store.update('s1', 't2', { status: 'cancelled' })

  store.create('s1', [{ subject: 'Next task' }])

  expect(store.list('s1')).toEqual([
    expect.objectContaining({ id: 't3', subject: 'Next task', status: 'pending' })
  ])
  expect(sessionRecord.tasks).toEqual(store.list('s1'))
})
```

- [ ] **Step 2: Run the regression test**

Run: `npm test -- src/tests/task-store-persistence.test.ts`

Expected: FAIL because `TaskStore.create` still leaves `t1` and `t2` in the current list.

- [ ] **Step 3: Lock the unfinished-list compatibility branch**

```ts
it('keeps appending while the current task list has unfinished work', async () => {
  const { TaskStore } = await import('../main/services/TaskStore')
  const store = TaskStore.getInstance()
  store.create('s1', [{ subject: 'Completed task' }, { subject: 'Pending task' }])
  store.update('s1', 't1', { status: 'completed' })

  store.create('s1', [{ subject: 'Appended task' }])

  expect(store.list('s1').map(task => ({ id: task.id, status: task.status }))).toEqual([
    { id: 't1', status: 'completed' },
    { id: 't2', status: 'pending' },
    { id: 't3', status: 'pending' }
  ])
})
```

### Task 2: Reset the Finished Current List

**Files:**
- Modify: `src/main/services/TaskStore.ts`
- Test: `src/tests/task-store-persistence.test.ts`

**Interfaces:**
- Consumes: Existing `TaskItem.status` values.
- Produces: `TaskStore.create` that replaces a fully terminal current list and continues appending to a list with unfinished work.

- [ ] **Step 1: Implement the minimal lifecycle rule**

```ts
const existing = this.bySession.get(sessionId) ?? []
const list = existing.length > 0 && existing.every(task =>
  task.status === 'completed' || task.status === 'cancelled'
) ? [] : existing
```

- [ ] **Step 2: Verify the focused regression test**

Run: `npm test -- src/tests/task-store-persistence.test.ts`

Expected: PASS, including persistence and second-`in_progress` guard coverage.

- [ ] **Step 3: Verify related Task behavior**

Run: `npm test -- src/tests/task-capsule-order.test.ts src/tests/task-session-restore.test.ts`

Expected: PASS; Task display order and session restoration remain unchanged.

- [ ] **Step 4: Type-check the project**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors introduced by the lifecycle change.

## Self-Review

- Spec coverage: The test covers a 100%-finished group followed by a new group, including `cancelled` as terminal.
- Placeholder scan: The plan contains no deferred implementation placeholders.
- Type consistency: The plan uses the existing `TaskStore` and `TaskItem` interfaces without adding new types.
