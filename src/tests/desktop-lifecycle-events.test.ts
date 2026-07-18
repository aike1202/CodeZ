import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentUpdatedEvent,
  TodoUpdatedEvent
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
  isTodoUpdatedEvent
} from '../renderer/src/shared/desktop/events'

const todoEvent: TodoUpdatedEvent = {
  version: 1,
  sessionId: 'session-1',
  revision: 1,
  snapshot: {
    version: 2,
    sessionId: 'session-1',
    revision: 1,
    nextSequence: 2,
    items: [],
    archivedItems: []
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

  it('delivers only consistent Todo and Agent envelopes and returns the native unlisteners', async () => {
    const todoCallback = vi.fn()
    const agentCallback = vi.fn()
    const unlistenTodo = await desktopEvents.todo.onUpdated(todoCallback)
    const unlistenAgent = await desktopEvents.agent.onUpdated(agentCallback)

    tauriMocks.listeners.get('todo:updated')?.({ payload: todoEvent })
    tauriMocks.listeners.get('todo:updated')?.({
      payload: { ...todoEvent, revision: 2 }
    })
    tauriMocks.listeners.get('agent:updated')?.({ payload: agentEvent })
    tauriMocks.listeners.get('agent:updated')?.({
      payload: { ...agentEvent, sessionId: 'other-session' }
    })
    unlistenTodo()
    unlistenAgent()

    expect(todoCallback).toHaveBeenCalledOnce()
    expect(agentCallback).toHaveBeenCalledOnce()
    expect(tauriMocks.unlisten).toHaveBeenCalledTimes(2)
  })

  it('rejects envelope revisions that disagree with their snapshots', () => {
    expect(isTodoUpdatedEvent(todoEvent)).toBe(true)
    expect(isAgentUpdatedEvent(agentEvent)).toBe(true)
    expect(isTodoUpdatedEvent({ ...todoEvent, revision: 2 })).toBe(false)
    expect(isTodoUpdatedEvent({
      ...todoEvent,
      snapshot: { ...todoEvent.snapshot, archivedItems: undefined }
    })).toBe(false)
    expect(isAgentUpdatedEvent({ ...agentEvent, revision: 2 })).toBe(false)
  })
})
