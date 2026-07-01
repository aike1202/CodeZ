# Task 管理工具 Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add TaskCreate/TaskGet/TaskList/TaskUpdate tools with dependency tracking, extend TaskStore model, and render tasks as a capsule+panel in ChatArea.

**Architecture:** Extend the existing `TaskStore` with the new `TaskData` fields and methods, add 4 Tools following the `AskUserQuestionTool` pattern, register in ToolManager, add IPC channels for real-time task sync to the renderer, build TaskPanel as a standalone component, and integrate as a sticky capsule in ChatAreaLayout.

**Tech Stack:** TypeScript, Electron IPC, Vitest, React + Zustand

## Global Constraints

- All new services and tools use static methods or follow existing patterns from AskUserQuestionTool
- Task identity bound to `sessionId`, persisted to `tasks.json`
- Task dependency DAG validated in TaskUpdateTool (cannot complete a task blocked by unfinished tasks)
- Only one task `in_progress` at a time (single Agent constraint)
- Frontend TaskPanel is read-only display — no interactive editing
- Mutex with Plan capsule handled in Plan implementation plan (not here)

---

### Task 1: Extend TaskStore — Data Model and New Methods

**Files:**
- Modify: `src/main/services/TaskStore.ts:1-69`

**Interfaces:**
- Produces: `TaskData` type with new fields (sessionId, subject, description, blocks, blockedBy, owner)
- Produces: `TaskStore.getBySession(sessionId: string): TaskData[]`
- Produces: `TaskStore.getById(taskId: string): TaskData | undefined`
- Produces: `TaskStore.updateStatus(taskId: string, status: TaskData['status']): Promise<void>`
- Produces: `TaskStore.addDependency(taskId: string, blockedByTaskId: string): Promise<void>`
- Produces: `TaskStore.removeDependency(taskId: string, blockedByTaskId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/tests/task-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import { TaskStore, TaskData } from '../main/services/TaskStore'
import { app } from 'electron'

// Mock electron app to return a test directory
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(path.join(__dirname, 'tmp_task_store'))
  }
}))

describe('TaskStore', () => {
  let store: TaskStore
  const sessionId = 'test-session-1'

  beforeEach(async () => {
    store = new TaskStore()
    await store.load()
  })

  afterEach(async () => {
    const dir = path.join(__dirname, 'tmp_task_store')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('should create a task with all new fields', async () => {
    const task: TaskData = {
      id: 'task-1',
      sessionId,
      subject: 'Test task',
      description: 'A test task description',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await store.save(task)
    const bySession = store.getBySession(sessionId)
    expect(bySession).toHaveLength(1)
    expect(bySession[0].subject).toBe('Test task')
    expect(bySession[0].description).toBe('A test task description')
    expect(bySession[0].owner).toBe('main-agent')
  })

  it('getById should find a saved task', async () => {
    const task: TaskData = {
      id: 'task-2',
      sessionId,
      subject: 'Find me',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await store.save(task)
    const found = store.getById('task-2')
    expect(found).toBeTruthy()
    expect(found!.subject).toBe('Find me')
  })

  it('getById should return undefined for non-existent task', () => {
    const found = store.getById('nonexistent')
    expect(found).toBeUndefined()
  })

  it('updateStatus should change status and update updatedAt', async () => {
    const task: TaskData = {
      id: 'task-3',
      sessionId,
      subject: 'Status test',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await store.save(task)
    await store.updateStatus('task-3', 'in_progress')
    const updated = store.getById('task-3')
    expect(updated!.status).toBe('in_progress')
    expect(updated!.updatedAt).not.toBe(task.updatedAt)
  })

  it('addDependency should create bidirectional links', async () => {
    const taskA: TaskData = { id: 'a', sessionId, subject: 'A', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const taskB: TaskData = { id: 'b', sessionId, subject: 'B', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await store.save(taskA)
    await store.save(taskB)
    await store.addDependency('b', 'a')  // B blocked by A
    const a = store.getById('a')
    const b = store.getById('b')
    expect(a!.blocks).toContain('b')
    expect(b!.blockedBy).toContain('a')
  })

  it('removeDependency should clean up both sides', async () => {
    const taskA: TaskData = { id: 'a2', sessionId, subject: 'A', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const taskB: TaskData = { id: 'b2', sessionId, subject: 'B', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await store.save(taskA)
    await store.save(taskB)
    await store.addDependency('b2', 'a2')
    await store.removeDependency('b2', 'a2')
    const a = store.getById('a2')
    const b = store.getById('b2')
    expect(a!.blocks).not.toContain('b2')
    expect(b!.blockedBy).not.toContain('a2')
  })

  it('getBySession should only return tasks for that session', async () => {
    const t1: TaskData = { id: 't1', sessionId: 's1', subject: 'S1', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const t2: TaskData = { id: 't2', sessionId: 's2', subject: 'S2', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await store.save(t1)
    await store.save(t2)
    expect(store.getBySession('s1')).toHaveLength(1)
    expect(store.getBySession('s1')[0].subject).toBe('S1')
    expect(store.getBySession('s2')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/task-store.test.ts`
Expected: FAIL — getBySession, getById, updateStatus, addDependency, removeDependency not defined

- [ ] **Step 3: Update TaskStore implementation**

Replace `src/main/services/TaskStore.ts`:

```ts
import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

export interface TaskData {
  id: string
  sessionId: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  blocks: string[]
  blockedBy: string[]
  owner: string
  createdAt: string
  updatedAt: string
}

const TASKS_FILE = 'tasks.json'

export class TaskStore {
  private filePath: string
  private cache: TaskData[] = []

  constructor() {
    this.filePath = path.join(app.getPath('userData'), TASKS_FILE)
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed?.tasks)) {
        this.cache = parsed.tasks
      }
    } catch {
      this.cache = []
    }
  }

  getAllByProject(projectId: string): TaskData[] {
    return this.cache.filter((t) => (t as any).projectId === projectId)
  }

  getBySession(sessionId: string): TaskData[] {
    return this.cache.filter((t) => t.sessionId === sessionId)
  }

  getById(taskId: string): TaskData | undefined {
    return this.cache.find((t) => t.id === taskId)
  }

  async save(task: TaskData): Promise<void> {
    const idx = this.cache.findIndex((t) => t.id === task.id)
    if (idx >= 0) {
      this.cache[idx] = { ...task, updatedAt: new Date().toISOString() }
    } else {
      this.cache.push({ ...task })
    }
    await this.persist()
  }

  async updateStatus(taskId: string, status: TaskData['status']): Promise<void> {
    const idx = this.cache.findIndex((t) => t.id === taskId)
    if (idx < 0) throw new Error(`Task ${taskId} not found`)
    this.cache[idx] = {
      ...this.cache[idx],
      status,
      updatedAt: new Date().toISOString()
    }
    await this.persist()
  }

  async addDependency(taskId: string, blockedByTaskId: string): Promise<void> {
    const task = this.cache.find((t) => t.id === taskId)
    const blocker = this.cache.find((t) => t.id === blockedByTaskId)
    if (!task || !blocker) throw new Error('Task not found')

    if (!task.blockedBy.includes(blockedByTaskId)) {
      task.blockedBy.push(blockedByTaskId)
      task.updatedAt = new Date().toISOString()
    }
    if (!blocker.blocks.includes(taskId)) {
      blocker.blocks.push(taskId)
      blocker.updatedAt = new Date().toISOString()
    }
    await this.persist()
  }

  async removeDependency(taskId: string, blockedByTaskId: string): Promise<void> {
    const task = this.cache.find((t) => t.id === taskId)
    const blocker = this.cache.find((t) => t.id === blockedByTaskId)
    if (!task || !blocker) throw new Error('Task not found')

    task.blockedBy = task.blockedBy.filter((id) => id !== blockedByTaskId)
    task.updatedAt = new Date().toISOString()
    blocker.blocks = blocker.blocks.filter((id) => id !== taskId)
    blocker.updatedAt = new Date().toISOString()
    await this.persist()
  }

  async delete(taskId: string): Promise<void> {
    // Clean up dependencies before deleting
    const task = this.cache.find((t) => t.id === taskId)
    if (task) {
      for (const blockerId of task.blockedBy) {
        await this.removeDependency(taskId, blockerId).catch(() => {})
      }
      for (const blockedId of [...task.blocks]) {
        await this.removeDependency(blockedId, taskId).catch(() => {})
      }
    }
    this.cache = this.cache.filter((t) => t.id !== taskId)
    await this.persist()
  }

  private async persist(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        this.filePath,
        JSON.stringify({ tasks: this.cache }, null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('TaskStore persist error:', error)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/task-store.test.ts`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/TaskStore.ts src/tests/task-store.test.ts
git commit -m "feat(task): extend TaskStore with session scoping, dependency tracking, and status methods"
```

---

### Task 2: Add Task IPC Channels

**Files:**
- Modify: `src/shared/ipc/channels.ts:44-47`
- Modify: `src/main/ipc/task.handlers.ts:1-29`

**Interfaces:**
- Produces: `IPC_CHANNELS.TASK_UPSERT: 'task:upsert'` — main→renderer
- Produces: `IPC_CHANNELS.PLAN_STATE_CHANGED: 'plan:state-changed'` — main→renderer
- Produces: `task.handlers.emitTaskUpsert()` — push single task to frontend

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/ipc/channels.ts`, add after line 47 (`TASK_DELETE`):

```ts
  TASK_UPSERT: 'task:upsert',
  TASK_SYNC: 'task:sync',

  // Plan
  PLAN_STATE_CHANGED: 'plan:state-changed',
  PLAN_APPROVE: 'plan:approve',
  PLAN_REJECT: 'plan:reject',
```

- [ ] **Step 2: Add task IPC handler**

In `src/main/ipc/task.handlers.ts`, add `emitTaskUpsert`:

```ts
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

// ...existing code...

export function notifyTaskUpsert(task: TaskData): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send(IPC_CHANNELS.TASK_UPSERT, task)
  }
}

export function notifyTaskSync(sessionId: string): void {
  const store = getTaskStore()
  const tasks = store.getBySession(sessionId)
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send(IPC_CHANNELS.TASK_SYNC, { sessionId, tasks })
  }
}
```

- [ ] **Step 3: Export from task.handlers module**

Add the function signatures to the top-level exports so tools can import `notifyTaskUpsert`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors (pre-existing PromptArea.tsx error is fine)

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc/channels.ts src/main/ipc/task.handlers.ts
git commit -m "feat(task): add TASK_UPSERT and PLAN_STATE_CHANGED IPC channels"
```

---

### Task 3: TaskCreateTool

**Files:**
- Create: `src/main/tools/builtin/TaskCreateTool.ts`
- Create: `src/tests/task-create-tool.test.ts`

**Interfaces:**
- Consumes: `TaskStore.save()`, `TaskStore.addDependency()`, `notifyTaskUpsert()`
- Produces: `TaskCreateTool` extending `Tool`

- [ ] **Step 1: Write test**

Create `src/tests/task-create-tool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskCreateTool } from '../main/tools/builtin/TaskCreateTool'

vi.mock('../main/services/TaskStore', () => {
  const tasks: any[] = []
  return {
    TaskStore: vi.fn().mockImplementation(() => ({
      save: vi.fn(async (t: any) => { tasks.push(t) }),
      addDependency: vi.fn(async () => {}),
      getById: vi.fn((id: string) => tasks.find(t => t.id === id)),
      getBySession: vi.fn(() => tasks)
    }))
  }
})

vi.mock('../main/ipc/task.handlers', () => ({
  notifyTaskUpsert: vi.fn(),
  notifyTaskSync: vi.fn()
}))

describe('TaskCreateTool', () => {
  let tool: TaskCreateTool

  beforeEach(() => { tool = new TaskCreateTool() })

  it('should have correct name', () => {
    expect(tool.name).toBe('TaskCreate')
  })

  it('should create a task with required fields', async () => {
    const result = await tool.execute(JSON.stringify({
      subject: 'Test task',
      description: 'A test task'
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.subject).toBe('Test task')
    expect(parsed.data.status).toBe('pending')
    expect(parsed.data.taskId).toBeTruthy()
  })

  it('should reject empty subject', async () => {
    const result = await tool.execute(JSON.stringify({
      subject: '',
      description: ''
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBeTruthy()
  })

  it('should create task with dependencies', async () => {
    const result = await tool.execute(JSON.stringify({
      subject: 'Blocked task',
      description: '',
      blockedBy: ['task-1']
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/task-create-tool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TaskCreateTool**

Create `src/main/tools/builtin/TaskCreateTool.ts`:

```ts
import { Tool, ToolContext } from '../Tool'
import { v4 as uuidv4 } from 'crypto'
import { TaskStore, TaskData } from '../../services/TaskStore'
import { notifyTaskUpsert } from '../../ipc/task.handlers'

interface TaskCreateArgs {
  subject: string
  description: string
  blockedBy?: string[]
}

export class TaskCreateTool extends Tool {
  get name() { return 'TaskCreate' }

  get description() {
    return 'Create a new task in the session task list to track progress during complex multi-step work. Tasks are visible to the user in a task panel.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Short title for the task' },
        description: { type: 'string', description: 'Details of what this task involves' },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of task IDs that must be completed before this one can start.'
        }
      },
      required: ['subject', 'description']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    let parsed: TaskCreateArgs
    try {
      parsed = JSON.parse(args)
    } catch {
      return JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: 'Failed to parse arguments as JSON.' } })
    }

    if (!parsed.subject || !parsed.subject.trim()) {
      return JSON.stringify({ ok: false, error: { code: 'MISSING_SUBJECT', message: 'subject is required and cannot be empty.' } })
    }

    const now = new Date().toISOString()
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const task: TaskData = {
      id: taskId,
      sessionId: context.sessionId || 'unknown',
      subject: parsed.subject.trim(),
      description: (parsed.description || '').trim(),
      status: 'pending',
      blocks: [],
      blockedBy: parsed.blockedBy || [],
      owner: 'main-agent',
      createdAt: now,
      updatedAt: now
    }

    const store = new TaskStore()
    await store.load()
    await store.save(task)

    // Establish reverse dependencies for each blockedBy entry
    if (parsed.blockedBy && parsed.blockedBy.length > 0) {
      for (const blockerId of parsed.blockedBy) {
        try {
          await store.addDependency(taskId, blockerId)
        } catch {
          // Non-fatal: dependency may reference a task that doesn't exist yet
        }
      }
    }

    try { notifyTaskUpsert(task) } catch {}

    return JSON.stringify({
      ok: true,
      data: { taskId: task.id, subject: task.subject, status: task.status }
    })
  }
}
```

Note: `v4 as uuidv4` — replace with the inline ID generator shown above (no uuid import needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/task-create-tool.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/TaskCreateTool.ts src/tests/task-create-tool.test.ts
git commit -m "feat(task): add TaskCreateTool"
```

---

### Task 4: TaskGetTool + TaskListTool

**Files:**
- Create: `src/main/tools/builtin/TaskGetTool.ts`
- Create: `src/main/tools/builtin/TaskListTool.ts`

- [ ] **Step 1: Implement both tools (simple enough to do together)**

Create `src/main/tools/builtin/TaskGetTool.ts`:

```ts
import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'

export class TaskGetTool extends Tool {
  get name() { return 'TaskGet' }
  get description() { return 'Retrieve full details of a task by its ID.' }
  get parameters_schema() {
    return {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId']
    }
  }
  async execute(args: string, _context: ToolContext): Promise<string> {
    const { taskId } = JSON.parse(args)
    const store = new TaskStore()
    await store.load()
    const task = store.getById(taskId)
    if (!task) return JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `Task "${taskId}" not found.` } })
    return JSON.stringify({ ok: true, data: task })
  }
}
```

Create `src/main/tools/builtin/TaskListTool.ts`:

```ts
import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'

export class TaskListTool extends Tool {
  get name() { return 'TaskList' }
  get description() { return 'List all tasks in the current session with their status. Use this to review progress before continuing work.' }
  get parameters_schema() { return { type: 'object', properties: {} } }
  async execute(_args: string, context: ToolContext): Promise<string> {
    const store = new TaskStore()
    await store.load()
    const tasks = store.getBySession(context.sessionId || '')
    const counts = { completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
    for (const t of tasks) {
      if (t.status === 'completed') counts.completed++
      else if (t.status === 'in_progress') counts.in_progress++
      else if (t.status === 'cancelled') counts.cancelled++
      else counts.pending++
    }
    const total = tasks.length
    const summary = `${counts.completed}/${total} completed, ${counts.in_progress} in progress, ${counts.pending} pending` + (counts.cancelled > 0 ? `, ${counts.cancelled} cancelled` : '')
    return JSON.stringify({ ok: true, data: { tasks, summary } })
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add src/main/tools/builtin/TaskGetTool.ts src/main/tools/builtin/TaskListTool.ts
git commit -m "feat(task): add TaskGetTool and TaskListTool"
```

---

### Task 5: TaskUpdateTool (with DAG validation)

**Files:**
- Create: `src/main/tools/builtin/TaskUpdateTool.ts`
- Create: `src/tests/task-update-tool.test.ts`

- [ ] **Step 1: Write test**

Create `src/tests/task-update-tool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskUpdateTool } from '../main/tools/builtin/TaskUpdateTool'
import { TaskStore } from '../main/services/TaskStore'

vi.mock('../main/services/TaskStore', () => {
  const tasks: any[] = []
  return {
    TaskStore: vi.fn().mockImplementation(() => ({
      load: vi.fn(async () => {}),
      save: vi.fn(async (t: any) => {
        const idx = tasks.findIndex(x => x.id === t.id)
        if (idx >= 0) tasks[idx] = t; else tasks.push(t)
      }),
      getById: vi.fn((id: string) => tasks.find(t => t.id === id)),
      getBySession: vi.fn(() => tasks),
      updateStatus: vi.fn(async (id: string, status: string) => {
        const t = tasks.find(x => x.id === id)
        if (t) { t.status = status; t.updatedAt = new Date().toISOString() }
      }),
      addDependency: vi.fn(async () => {}),
      removeDependency: vi.fn(async () => {}),
      delete: vi.fn(async () => {})
    }))
  }
})

vi.mock('../main/ipc/task.handlers', () => ({
  notifyTaskUpsert: vi.fn(),
  notifyTaskSync: vi.fn()
}))

describe('TaskUpdateTool', () => {
  let tool: TaskUpdateTool

  beforeEach(async () => {
    tool = new TaskUpdateTool()
    // Seed tasks
    const store = new TaskStore()
    await store.save({ id: 't1', sessionId: 's1', subject: 'Task 1', description: '', status: 'in_progress', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: '', updatedAt: '' })
    await store.save({ id: 't2', sessionId: 's1', subject: 'Task 2', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: '', updatedAt: '' })
  })

  it('should have correct name', () => { expect(tool.name).toBe('TaskUpdate') })

  it('should update status', async () => {
    const result = await tool.execute(JSON.stringify({ taskId: 't1', status: 'completed' }), { workspaceRoot: '/test', sessionId: 's1' })
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.status).toBe('completed')
  })

  it('should reject setting in_progress when another task already in_progress', async () => {
    // t1 is already in_progress from seed
    const result = await tool.execute(JSON.stringify({ taskId: 't2', status: 'in_progress' }), { workspaceRoot: '/test', sessionId: 's1' })
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('ALREADY_IN_PROGRESS')
  })

  it('should reject completing a task that is still blocked', async () => {
    // Make t1 blocked by t2 (t2 is pending)
    const store = new TaskStore()
    await store.addDependency('t1', 't2')
    const result = await tool.execute(JSON.stringify({ taskId: 't1', status: 'completed' }), { workspaceRoot: '/test', sessionId: 's1' })
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('BLOCKED')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/task-update-tool.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement TaskUpdateTool**

Create `src/main/tools/builtin/TaskUpdateTool.ts`:

```ts
import { Tool, ToolContext } from '../Tool'
import { TaskStore, TaskData } from '../../services/TaskStore'
import { notifyTaskUpsert } from '../../ipc/task.handlers'

interface TaskUpdateArgs {
  taskId: string
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  subject?: string
  description?: string
  blocks?: string[]
  blockedBy?: string[]
}

export class TaskUpdateTool extends Tool {
  get name() { return 'TaskUpdate' }
  get description() {
    return 'Update a task status or description. Status flow: pending → in_progress → completed (or cancelled). Only one task in_progress at a time.'
  }
  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
        subject: { type: 'string' },
        description: { type: 'string' },
        blocks: { type: 'array', items: { type: 'string' } },
        blockedBy: { type: 'array', items: { type: 'string' } }
      },
      required: ['taskId']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    let parsed: TaskUpdateArgs
    try { parsed = JSON.parse(args) } catch {
      return JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: 'Failed to parse arguments.' } })
    }

    const store = new TaskStore()
    await store.load()
    const task = store.getById(parsed.taskId)
    if (!task) return JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `Task "${parsed.taskId}" not found.` } })

    // Status validation
    if (parsed.status) {
      // Check: cannot set in_progress if another task is already in_progress
      if (parsed.status === 'in_progress') {
        const sessionTasks = store.getBySession(task.sessionId)
        const alreadyInProgress = sessionTasks.find(t => t.id !== parsed.taskId && t.status === 'in_progress')
        if (alreadyInProgress) {
          return JSON.stringify({
            ok: false,
            error: { code: 'ALREADY_IN_PROGRESS', message: `Task "${alreadyInProgress.id}" (${alreadyInProgress.subject}) is already in_progress. Complete or cancel it first.` }
          })
        }
      }

      // Check: cannot complete if blocked by unfinished tasks
      if (parsed.status === 'completed') {
        const unfinishedBlockers = (task.blockedBy || [])
          .map(id => store.getById(id))
          .filter((t): t is TaskData => !!t && t.status !== 'completed' && t.status !== 'cancelled')
        if (unfinishedBlockers.length > 0) {
          return JSON.stringify({
            ok: false,
            error: { code: 'BLOCKED', message: `Cannot complete: blocked by ${unfinishedBlockers.map(t => `"${t.id}" (${t.subject}, ${t.status})`).join(', ')}.` }
          })
        }
      }

      // Cancellation: auto-remove blocks relationships
      if (parsed.status === 'cancelled') {
        for (const blockedId of [...task.blocks]) {
          await store.removeDependency(blockedId, task.id).catch(() => {})
        }
      }

      task.status = parsed.status
    }

    if (parsed.subject !== undefined) task.subject = parsed.subject.trim()
    if (parsed.description !== undefined) task.description = parsed.description.trim()

    // Replace dependency lists if provided
    if (parsed.blocks !== undefined) {
      for (const oldId of task.blocks) { await store.removeDependency(oldId, task.id).catch(() => {}) }
      task.blocks = []
      for (const blockedId of parsed.blocks) { await store.addDependency(blockedId, task.id).catch(() => {}) }
    }
    if (parsed.blockedBy !== undefined) {
      for (const oldId of task.blockedBy) { await store.removeDependency(task.id, oldId).catch(() => {}) }
      task.blockedBy = []
      for (const blockerId of parsed.blockedBy) { await store.addDependency(task.id, blockerId).catch(() => {}) }
    }

    task.updatedAt = new Date().toISOString()
    await store.save(task)
    try { notifyTaskUpsert(task) } catch {}

    return JSON.stringify({ ok: true, data: task })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/task-update-tool.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/builtin/TaskUpdateTool.ts src/tests/task-update-tool.test.ts
git commit -m "feat(task): add TaskUpdateTool with DAG validation and single-in-progress constraint"
```

---

### Task 6: Register Tools in ToolManager

**Files:**
- Modify: `src/main/tools/ToolManager.ts:1-17`

- [ ] **Step 1: Import and register 4 new tools**

In `src/main/tools/ToolManager.ts`, add imports:

```ts
import { TaskCreateTool } from './builtin/TaskCreateTool'
import { TaskGetTool } from './builtin/TaskGetTool'
import { TaskListTool } from './builtin/TaskListTool'
import { TaskUpdateTool } from './builtin/TaskUpdateTool'
```

Add to `registerBuiltinTools()` array:

```ts
new TaskCreateTool(),
new TaskGetTool(),
new TaskListTool(),
new TaskUpdateTool(),
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 3: Run full test suite**

Run: `npm run test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/main/tools/ToolManager.ts
git commit -m "feat(task): register TaskCreate/TaskGet/TaskList/TaskUpdate in ToolManager"
```

---

### Task 7: Frontend — chatStore + IPC Listener

**Files:**
- Modify: `src/renderer/src/stores/chatStore.ts:142-182`

**Interfaces:**
- Produces: `chatStore.tasks: TaskData[]`
- Produces: `chatStore.expandedCapsule: 'task' | 'plan' | null`
- Produces: `chatStore.setExpandedCapsule(capsule)`
- Produces: `chatStore.upsertTask(task: TaskData)`

- [ ] **Step 1: Add state and actions to chatStore**

In `chatStore.ts`, add to the `ChatState` interface:

```ts
tasks: TaskData[]
expandedCapsule: 'task' | 'plan' | null
setExpandedCapsule: (capsule: 'task' | 'plan' | null) => void
upsertTask: (task: TaskData) => void
```

Add to the `create` initial state:

```ts
tasks: [],
expandedCapsule: null,
```

Add actions:

```ts
setExpandedCapsule: (capsule) => set({ expandedCapsule: capsule }),

upsertTask: (task) => set((state) => {
  const idx = state.tasks.findIndex(t => t.id === task.id)
  const newTasks = idx >= 0
    ? [...state.tasks.slice(0, idx), task, ...state.tasks.slice(idx + 1)]
    : [...state.tasks, task]
  return { tasks: newTasks }
}),
```

- [ ] **Step 2: Register IPC listener for TASK_UPSERT**

In the `preload/index.ts` or in a store initialization hook, listen for `TASK_UPSERT`:

```ts
// In chatStore, add an "initTaskListener" action
initTaskListener: () => {
  window.api.on('task:upsert', (_event: any, task: TaskData) => {
    useChatStore.getState().upsertTask(task)
  })
  window.api.on('task:sync', (_event: any, data: { sessionId: string; tasks: TaskData[] }) => {
    set({ tasks: data.tasks })
  })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/stores/chatStore.ts
git commit -m "feat(task): add tasks/expandedCapsule state and IPC listener to chatStore"
```

---

### Task 8: Frontend — TaskPanel + Task Capsule

**Files:**
- Create: `src/renderer/src/components/chat/TaskPanel.tsx`
- Create: `src/renderer/src/components/chat/TaskPanel.css`
- Modify: `src/renderer/src/components/chat/ChatAreaLayout.tsx`

- [ ] **Step 1: Create TaskPanel component**

Create `src/renderer/src/components/chat/TaskPanel.tsx`:

```tsx
import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import type { TaskData } from '../../../../main/services/TaskStore'
import './TaskPanel.css'

const SORT_ORDER: Record<string, number> = {
  in_progress: 0, pending: 1, blocked: 2, completed: 3, cancelled: 4
}

function getSortKey(t: TaskData): number {
  if (t.status === 'pending' && t.blockedBy.length > 0) return SORT_ORDER['blocked']
  return SORT_ORDER[t.status] ?? 5
}

const STATUS_ICON: Record<string, string> = {
  pending: '⬜',        // ⬜
  in_progress: '\u{1F504}', // 🔄
  completed: '✅',      // ✅
  cancelled: '❌',      // ❌
}

const BLOCKED_ICON = '\u{1F512}' // 🔒

export const TaskPanel: React.FC = () => {
  const tasks = useChatStore(s => s.tasks)
  const expandedCapsule = useChatStore(s => s.expandedCapsule)
  const setExpandedCapsule = useChatStore(s => s.setExpandedCapsule)

  if (tasks.length === 0) return null

  const completed = tasks.filter(t => t.status === 'completed').length
  const hasUnfinished = tasks.some(t => t.status === 'in_progress' || t.status === 'pending')
  const hasInProgress = tasks.some(t => t.status === 'in_progress')

  const sorted = [...tasks].sort((a, b) => getSortKey(a) - getSortKey(b))
  const isExpanded = expandedCapsule === 'task'

  const capsuleColor = hasInProgress ? '#3b82f6' : hasUnfinished ? '#3b82f6' : '#22c55e'
  const capsuleText = hasInProgress ? `▶ Tasks ${completed}/${tasks.length}`
    : hasUnfinished ? `▶ Tasks ${completed}/${tasks.length}`
    : `✅ All done`

  return (
    <div className="task-capsule-container">
      {/* Collapsed Capsule */}
      <button
        className={`task-capsule ${isExpanded ? 'expanded' : ''}`}
        style={{ borderColor: capsuleColor }}
        onClick={() => setExpandedCapsule(isExpanded ? null : 'task')}
        title="Toggle task panel"
      >
        <span className="capsule-icon">{capsuleText}</span>
      </button>

      {/* Expanded Panel */}
      {isExpanded && (
        <div className="task-panel">
          <div className="task-panel-header">
            <span>Tasks {completed}/{tasks.length}</span>
            <button onClick={() => setExpandedCapsule(null)}>{'▲'} collapse</button>
          </div>
          <div className="task-panel-list">
            {sorted.map(task => (
              <div key={task.id} className={`task-row status-${task.status}${task.status === 'in_progress' ? ' active' : ''}`}>
                <span className="task-status-icon">
                  {task.status === 'pending' && task.blockedBy.length > 0 ? BLOCKED_ICON : STATUS_ICON[task.status]}
                </span>
                <span className={`task-subject ${task.status === 'completed' || task.status === 'cancelled' ? 'strikethrough' : ''}`}>
                  {task.subject}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create CSS**

Create `src/renderer/src/components/chat/TaskPanel.css`:

```css
.task-capsule-container {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
}

.task-capsule {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 12px;
  border: 1.5px solid;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  align-self: flex-start;
  margin: 4px 8px;
}

.task-capsule:hover { opacity: 0.8; }

.task-panel {
  background: var(--bg-secondary, #f8f9fa);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  padding: 8px 12px;
}

.task-panel-header {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 13px;
}

.task-row.active { background: rgba(59, 130, 246, 0.08); border-radius: 4px; padding: 3px 4px; }
.task-row.status-cancelled { opacity: 0.5; }

.task-status-icon { font-size: 12px; width: 18px; text-align: center; flex-shrink: 0; }
.task-subject.strikethrough { text-decoration: line-through; }
```

- [ ] **Step 3: Integrate into ChatAreaLayout**

In `ChatAreaLayout.tsx`, import and place `<TaskPanel />` at the top of the chat area, before the message list:

```tsx
import { TaskPanel } from './TaskPanel'

// In the JSX, before scrolling message container:
<TaskPanel />
```

- [ ] **Step 4: Run typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no new errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/chat/TaskPanel.tsx src/renderer/src/components/chat/TaskPanel.css src/renderer/src/components/chat/ChatAreaLayout.tsx
git commit -m "feat(task): add TaskPanel capsule component integrated in ChatAreaLayout"
```

---

### Task 9: System Prompt Update

**Files:**
- Modify: `src/main/services/SystemPromptService.ts:896-925` (buildDeveloperInstructions)

- [ ] **Step 1: Add TASK MANAGEMENT section**

In `buildDeveloperInstructions()`, after the CONTEXT MANAGEMENT block, add:

```ts
    lines.push('')
    lines.push('  【TASK MANAGEMENT】')
    lines.push('  When working on complex multi-step tasks:')
    lines.push('  - Use TaskCreate to record steps before starting.')
    lines.push('  - Use TaskUpdate to mark progress (pending → in_progress → completed).')
    lines.push('  - Use TaskList to review what has been done and what remains.')
    lines.push('  - Only ONE task in_progress at a time.')
    lines.push('  - A task blocked by an unfinished task cannot start.')
    lines.push('  - If you cannot complete a task, cancel it with a clear reason in the description.')
```

- [ ] **Step 2: Run SystemPromptService test**

Run: `npx vitest run src/tests/system-prompt-service.test.ts`
Expected: all 14 tests pass

- [ ] **Step 3: Commit**

```bash
git add src/main/services/SystemPromptService.ts
git commit -m "feat(task): add TASK MANAGEMENT rules to system prompt"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero new errors

- [ ] **Step 2: Run all tests**

Run: `npm run test`
Expected: all test suites pass

- [ ] **Step 3: Smoke test — task tools visible in Agent context**

Start the app and send any message that would trigger tool usage. Verify the Agent's system prompt includes `<available_tools>` with TaskCreate/TaskGet/TaskList/TaskUpdate listed, and the `<developer_instructions>` contains TASK MANAGEMENT rules.
