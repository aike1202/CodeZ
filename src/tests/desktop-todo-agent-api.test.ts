import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  }
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

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

const subAgent = {
  type: 'Explore',
  description: 'Investigates a bounded code area.',
  enabled: true
}

const detail = {
  kind: 'available' as const,
  detail: {
    type: 'Explore',
    description: 'Investigates a bounded code area.',
    whenToUse: 'When discovery is needed.',
    maxLoops: 8,
    enabled: true
  }
}

const runRequest = {
  subagentType: 'Explore',
  sessionId: 'session-1',
  task: 'Inspect the runtime.'
}

const runState = {
  runId: 'subagent-1',
  subagentType: 'Explore',
  sessionId: 'session-1',
  providerId: 'provider-1',
  model: 'fast',
  status: 'completed' as const,
  output: 'done',
  createdAt: '2026-07-17T00:00:00Z',
  updatedAt: '2026-07-17T00:00:01Z'
}

let originalWindow: unknown

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
    writable: true
  })
}

describe('desktop task and sub-agent adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.invoke.mockReset()
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
      return
    }
    setWindow(originalWindow)
  })

  it('maps task history and sub-agent settings to existing Tauri commands', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([subAgent])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(runState)
      .mockResolvedValueOnce(runState)
      .mockResolvedValueOnce({ accepted: false, state: runState })

    await expect(desktopApi.executionHistory.getByProject('workspace-1')).resolves.toEqual([task])
    await desktopApi.executionHistory.delete(task.id)
    await expect(desktopApi.subAgent.list()).resolves.toEqual([subAgent])
    await desktopApi.subAgent.toggle('Explore', false)
    await expect(desktopApi.subAgent.getDetail('Explore')).resolves.toEqual(detail)
    await desktopApi.subAgent.setModel('Explore', [{ providerId: 'provider-1', model: 'fast' }])
    await expect(desktopApi.subAgent.run(runRequest)).resolves.toEqual(runState)
    await expect(desktopApi.subAgent.getRun('session-1', 'subagent-1')).resolves.toEqual(runState)
    await expect(desktopApi.subAgent.cancelRun('session-1', 'subagent-1')).resolves.toEqual({
      accepted: false,
      state: runState
    })

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['task_get_by_project', { projectId: 'workspace-1' }],
      ['task_delete', { taskId: 'task-1' }],
      ['subagent_list', undefined],
      ['subagent_toggle', { subagentType: 'Explore', enabled: false }],
      ['subagent_get_detail', { subagentType: 'Explore' }],
      ['subagent_set_model', {
        subagentType: 'Explore',
        selections: [{ providerId: 'provider-1', model: 'fast' }]
      }],
      ['subagent_run', { request: runRequest }],
      ['subagent_get_run', { sessionId: 'session-1', runId: 'subagent-1' }],
      ['subagent_cancel_run', { sessionId: 'session-1', runId: 'subagent-1' }]
    ])
  })

  it('maps typed Todo and Agent lifecycle snapshots to their Tauri commands', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    const todoSnapshot = {
      version: 1,
      sessionId: 'session-1',
      revision: 2,
      nextSequence: 3,
      items: []
    }
    const agentSnapshot = {
      version: 1,
      sessionId: 'session-1',
      revision: 4,
      agents: [],
      messages: []
    }
    const activeIds = { agentIds: ['agent-1'], revision: 4 }
    tauriMocks.invoke
      .mockResolvedValueOnce(todoSnapshot)
      .mockResolvedValueOnce(agentSnapshot)
      .mockResolvedValueOnce(activeIds)

    await expect(desktopApi.todo.snapshot('session-1')).resolves.toEqual(todoSnapshot)
    await expect(desktopApi.agent.snapshot('session-1')).resolves.toEqual(agentSnapshot)
    await expect(desktopApi.agent.activeIds('session-1')).resolves.toEqual(activeIds)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['todo_list', { request: { sessionId: 'session-1' } }],
      ['agent_snapshot', { request: { sessionId: 'session-1' } }],
      ['agent_active_ids', { request: { sessionId: 'session-1' } }]
    ])
  })

  it('rejects malformed task history before it reaches the renderer', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockResolvedValueOnce([{ id: 42 }])

    await expect(desktopApi.executionHistory.getByProject('workspace-1')).rejects.toThrow('without a valid id')
  })
})
