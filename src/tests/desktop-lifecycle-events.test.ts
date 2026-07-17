import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentUpdatedEvent,
  TaskUpdatedEvent
} from '../renderer/src/shared/desktop/generated/contracts'

const tauriMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  listen: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen
}))

import {
  desktopEvents,
  isAgentUpdatedEvent,
  isTaskUpdatedEvent
} from '../renderer/src/shared/desktop/events'

const taskEvent: TaskUpdatedEvent = {
  version: 1,
  sessionId: 'session-1',
  revision: 1,
  snapshot: {
    version: 1,
    sessionId: 'session-1',
    revision: 1,
    nextSequence: 2,
    tasks: []
  }
}

const agentEvent: AgentUpdatedEvent = {
  version: 1,
  sessionId: 'session-1',
  revision: 1,
  snapshot: {
    version: 1,
    sessionId: 'session-1',
    revision: 1,
    agents: [],
    messages: []
  }
}

let originalWindow: unknown

describe('desktop lifecycle event facade', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
      writable: true
    })
    tauriMocks.listeners.clear()
    tauriMocks.unlisten.mockReset()
    tauriMocks.listen.mockReset()
    tauriMocks.listen.mockImplementation(async (
      name: string,
      callback: (event: { payload: unknown }) => void
    ) => {
      tauriMocks.listeners.set(name, callback)
      return tauriMocks.unlisten
    })
  })

  afterEach(() => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true
    })
  })

  it('delivers only consistent Task and Agent envelopes and returns the native unlisteners', async () => {
    const taskCallback = vi.fn()
    const agentCallback = vi.fn()
    const unlistenTask = await desktopEvents.task.onUpdated(taskCallback)
    const unlistenAgent = await desktopEvents.agent.onUpdated(agentCallback)

    tauriMocks.listeners.get('task:updated')?.({ payload: taskEvent })
    tauriMocks.listeners.get('task:updated')?.({
      payload: { ...taskEvent, revision: 2 }
    })
    tauriMocks.listeners.get('agent:updated')?.({ payload: agentEvent })
    tauriMocks.listeners.get('agent:updated')?.({
      payload: { ...agentEvent, sessionId: 'other-session' }
    })
    unlistenTask()
    unlistenAgent()

    expect(taskCallback).toHaveBeenCalledOnce()
    expect(agentCallback).toHaveBeenCalledOnce()
    expect(tauriMocks.unlisten).toHaveBeenCalledTimes(2)
  })

  it('rejects envelope revisions that disagree with their snapshots', () => {
    expect(isTaskUpdatedEvent(taskEvent)).toBe(true)
    expect(isAgentUpdatedEvent(agentEvent)).toBe(true)
    expect(isTaskUpdatedEvent({ ...taskEvent, revision: 2 })).toBe(false)
    expect(isAgentUpdatedEvent({ ...agentEvent, revision: 2 })).toBe(false)
  })
})
