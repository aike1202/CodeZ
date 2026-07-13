import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.hoisted(() => vi.fn())
const saveMock = vi.hoisted(() => vi.fn())
const sessionRecord = vi.hoisted(() => ({
  id: 's1',
  projectId: 'p1',
  summary: 'Realtime tasks',
  relativeTime: 'now',
  messages: [] as any[],
  tasks: [] as any[],
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: sendMock } }]),
  },
}))

vi.mock('../main/ipc/session.handlers', () => ({
  getSessionStore: () => ({
    get: (sessionId: string) => sessionId === sessionRecord.id ? sessionRecord : undefined,
    save: saveMock,
  }),
}))

describe('Task Executor realtime projection', () => {
  let root: string

  beforeEach(() => {
    vi.resetModules()
    root = mkdtempSync(path.join(os.tmpdir(), 'codez-task-realtime-'))
    sessionRecord.tasks = []
    saveMock.mockReset()
    sendMock.mockReset()
  })

  afterEach(async () => {
    const { getExecutionController } = await import('../main/services/execution/ExecutionController')
    getExecutionController().resetForTests()
    rmSync(root, { recursive: true, force: true })
  })

  it('projects queued, running, completed, and failed Executors per TaskItem', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const { getExecutionController } = await import('../main/services/execution/ExecutionController')
    const store = TaskStore.getInstance()
    store.create('s1', [{ subject: 'First' }, { subject: 'Second' }])
    const controller = getExecutionController()

    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1', 't2'] }],
      isolation: 'shared',
      rationale: 'independent',
    })
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'pending',
      executorRuntime: { status: 'queued', executionId: execution.executionId },
    })

    const attempt = controller.startExecutor(execution.executionId, 't1')
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'in_progress',
      executorRuntime: { status: 'running', attemptCount: 1 },
    })
    expect(store.getById('s1', 't2')).toMatchObject({
      status: 'pending',
      executorRuntime: { status: 'queued' },
    })

    controller.finishExecutor(execution.executionId, 't1', {
      stepId: 't1',
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: 'completed',
      summary: 'done',
      filesModified: ['src/a.ts'],
    })
    controller.failExecutorBeforeStart(execution.executionId, 't2', 'provider unavailable')

    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'completed',
      executorRuntime: { status: 'completed', summary: 'done' },
    })
    expect(store.getById('s1', 't2')).toMatchObject({
      status: 'pending',
      executorRuntime: { status: 'failed', error: 'provider unavailable' },
    })
    expect(sendMock).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({ sessionId: 's1', tasks: expect.any(Array) })
    )
  })

  it('keeps worktree output in progress until the artifact is integrated', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const { getExecutionController } = await import('../main/services/execution/ExecutionController')
    const store = TaskStore.getInstance()
    store.create('s1', [{ subject: 'Integrate worktree' }])
    const controller = getExecutionController()
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'worktree',
      rationale: '',
    })
    const attempt = controller.startExecutor(execution.executionId, 't1')
    const result = {
      stepId: 't1',
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: 'completed' as const,
      summary: 'implemented',
      filesModified: ['src/a.ts'],
    }

    controller.finishExecutor(execution.executionId, 't1', result)
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'in_progress',
      executorRuntime: { status: 'completed', artifactStatus: 'none' },
    })

    controller.reconcileExecutorResult(execution.executionId, {
      ...result,
      artifactStatus: 'merged',
    })
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'completed',
      executorRuntime: { status: 'completed', artifactStatus: 'merged' },
    })
  })

  it('projects stop and retry immediately without rebroadcasting heartbeat-only events', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const { getExecutionController } = await import('../main/services/execution/ExecutionController')
    const store = TaskStore.getInstance()
    store.create('s1', [{ subject: 'Recover work' }])
    const controller = getExecutionController()
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'shared',
      rationale: '',
    })
    const first = controller.startExecutor(execution.executionId, 't1')

    saveMock.mockClear()
    sendMock.mockClear()
    expect(controller.heartbeat(first.token)).toBe(true)
    expect(saveMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()

    controller.stopExecutor(execution.executionId, first.snapshot.executorId)
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'pending',
      executorRuntime: { status: 'stopped' },
    })

    controller.startExecutor(execution.executionId, 't1')
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'in_progress',
      executorRuntime: { status: 'running', attemptCount: 2 },
    })
  })

  it('detaches a manually transitioned Task from late events of its old Executor', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const { getExecutionController } = await import('../main/services/execution/ExecutionController')
    const store = TaskStore.getInstance()
    store.create('s1', [{ subject: 'Take over manually' }])
    const controller = getExecutionController()
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'shared',
      rationale: '',
    })
    const attempt = controller.startExecutor(execution.executionId, 't1')

    store.update('s1', 't1', { status: 'cancelled' })
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'cancelled',
      executorRuntime: { detached: true },
    })

    controller.heartbeat(attempt.token)
    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'cancelled',
      executorRuntime: { status: 'running', detached: true },
    })
  })

  it('projects a persisted running Executor to lost when its Runtime is restored', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const { getExecutionController } = await import('../main/services/execution/ExecutionController')
    const store = TaskStore.getInstance()
    store.create('s1', [{ subject: 'Recover after restart' }])
    const controller = getExecutionController()
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'shared',
      rationale: '',
    })
    controller.startExecutor(execution.executionId, 't1')
    expect(store.getById('s1', 't1')?.executorRuntime?.status).toBe('running')

    controller.resetForTests()
    TaskStore.getInstance()
    controller.restoreSession(root, 's1')

    expect(store.getById('s1', 't1')).toMatchObject({
      status: 'pending',
      executorRuntime: {
        status: 'lost',
        failureReason: 'runtime_missing',
      },
    })
  })
})
