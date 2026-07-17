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

    await expect(desktopApi.task.getByProject('workspace-1')).resolves.toEqual([task])
    await desktopApi.task.delete(task.id)
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

  it('maps typed Task and Agent lifecycle snapshots to their Tauri commands', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    const taskSnapshot = {
      version: 1,
      sessionId: 'session-1',
      revision: 2,
      nextSequence: 3,
      tasks: []
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
      .mockResolvedValueOnce(taskSnapshot)
      .mockResolvedValueOnce(agentSnapshot)
      .mockResolvedValueOnce(activeIds)

    await expect(desktopApi.task.snapshot('session-1')).resolves.toEqual(taskSnapshot)
    await expect(desktopApi.agent.snapshot('session-1')).resolves.toEqual(agentSnapshot)
    await expect(desktopApi.agent.activeIds('session-1')).resolves.toEqual(activeIds)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['task_list', { request: { sessionId: 'session-1' } }],
      ['agent_snapshot', { request: { sessionId: 'session-1' } }],
      ['agent_active_ids', { request: { sessionId: 'session-1' } }]
    ])
  })

  it('contains frozen Electron fallbacks inside the adapter boundary', async () => {
    const legacyTask = {
      getByProject: vi.fn().mockResolvedValue([task]),
      delete: vi.fn().mockResolvedValue(undefined)
    }
    const legacySubAgent = {
      list: vi.fn().mockResolvedValue([subAgent]),
      toggle: vi.fn().mockResolvedValue(undefined),
      getDetail: vi.fn().mockResolvedValue(detail.detail),
      setModel: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(runState),
      getRun: vi.fn().mockResolvedValue(runState),
      cancelRun: vi.fn().mockResolvedValue({ accepted: false, state: runState }),
      onState: vi.fn().mockReturnValue(() => undefined)
    }
    setWindow({ api: { task: legacyTask, subAgent: legacySubAgent } })

    await expect(desktopApi.task.getByProject('workspace-1')).resolves.toEqual([task])
    await desktopApi.task.delete(task.id)
    await expect(desktopApi.subAgent.list()).resolves.toEqual([subAgent])
    await desktopApi.subAgent.toggle('Explore', false)
    await expect(desktopApi.subAgent.getDetail('Explore')).resolves.toEqual(detail.detail)
    await desktopApi.subAgent.setModel('Explore', [])
    await desktopApi.subAgent.run(runRequest)
    await desktopApi.subAgent.getRun('session-1', 'subagent-1')
    await desktopApi.subAgent.cancelRun('session-1', 'subagent-1')

    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(legacyTask.getByProject).toHaveBeenCalledWith('workspace-1')
    expect(legacyTask.delete).toHaveBeenCalledWith('task-1')
    expect(legacySubAgent.list).toHaveBeenCalledOnce()
    expect(legacySubAgent.toggle).toHaveBeenCalledWith('Explore', false)
    expect(legacySubAgent.getDetail).toHaveBeenCalledWith('Explore')
    expect(legacySubAgent.setModel).toHaveBeenCalledWith('Explore', [])
    expect(legacySubAgent.run).toHaveBeenCalledWith(runRequest)
    expect(legacySubAgent.getRun).toHaveBeenCalledWith('subagent-1')
    expect(legacySubAgent.cancelRun).toHaveBeenCalledWith('subagent-1')
  })

  it('rejects malformed task history before it reaches the renderer', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockResolvedValueOnce([{ id: 42 }])

    await expect(desktopApi.task.getByProject('workspace-1')).rejects.toThrow('without a valid id')
  })
})
