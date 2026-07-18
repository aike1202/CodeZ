import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoUpdatedEvent } from '../renderer/src/shared/desktop/generated/contracts'

const tauriMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  listen: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }))

import { desktopEvents, isTodoUpdatedEvent } from '../renderer/src/shared/desktop/events'

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

  it('delivers only consistent Todo envelopes', async () => {
    const callback = vi.fn()
    const unlisten = await desktopEvents.todo.onUpdated(callback)
    tauriMocks.listeners.get('todo:updated')?.({ payload: todoEvent })
    tauriMocks.listeners.get('todo:updated')?.({ payload: { ...todoEvent, revision: 2 } })
    unlisten()

    expect(callback).toHaveBeenCalledOnce()
    expect(tauriMocks.unlisten).toHaveBeenCalledOnce()
  })

  it('rejects envelope revisions that disagree with their snapshots', () => {
    expect(isTodoUpdatedEvent(todoEvent)).toBe(true)
    expect(isTodoUpdatedEvent({ ...todoEvent, revision: 2 })).toBe(false)
  })
})
