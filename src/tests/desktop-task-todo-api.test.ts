import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  }
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

import { desktopApi } from '../renderer/src/shared/desktop/api'

const task = {
  id: 'task-1',
  projectId: 'workspace-1',
  title: 'Verify bridge',
  timestamp: 1_700_000_000_000,
  status: 'completed',
  description: 'Use the Tauri facade.',
  filesModified: ['src/renderer/src/shared/desktop/api.ts'],
  commandsRun: ['npm run typecheck']
}

let originalWindow: unknown

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
    writable: true
  })
}

describe('desktop task and Todo adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.invoke.mockReset()
  })

  afterEach(() => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else setWindow(originalWindow)
  })

  it('maps task history and Todo snapshots to Tauri commands', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    const todoSnapshot = {
      version: 2,
      sessionId: 'session-1',
      revision: 2,
      nextSequence: 3,
      items: [],
      archivedItems: []
    }
    tauriMocks.invoke
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(todoSnapshot)

    await expect(desktopApi.executionHistory.getByProject('workspace-1')).resolves.toEqual([task])
    await desktopApi.executionHistory.delete(task.id)
    await expect(desktopApi.todo.snapshot('session-1')).resolves.toEqual(todoSnapshot)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['task_get_by_project', { projectId: 'workspace-1' }],
      ['task_delete', { taskId: 'task-1' }],
      ['todo_list', { request: { sessionId: 'session-1' } }]
    ])
  })

  it('rejects malformed task history before it reaches the renderer', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockResolvedValueOnce([{ id: 42 }])

    await expect(desktopApi.executionHistory.getByProject('workspace-1'))
      .rejects.toThrow('without a valid id')
  })
})
