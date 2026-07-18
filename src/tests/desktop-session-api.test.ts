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

const session = {
  id: 'session-1',
  projectId: 'project-1',
  summary: 'Session summary',
  relativeTime: 'now',
  messages: [{
    id: 'message-1',
    role: 'agent',
    content: 'Completed',
    executionTimeline: [{ id: 'timeline-1', type: 'tool' }]
  }]
}

let originalWindow: unknown

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
    writable: true
  })
}

describe('desktop session adapter', () => {
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

  it('maps typed session operations to the Tauri commands and preserves rich message fields', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await expect(desktopApi.session.list()).resolves.toEqual([session])
    await expect(desktopApi.session.get(session.id)).resolves.toEqual(session)
    await desktopApi.session.save(session)
    await desktopApi.session.delete(session.id)

    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['session_list', undefined],
      ['session_get', { sessionId: session.id }],
      ['session_save', { session }],
      ['session_delete', { sessionId: session.id }]
    ])
  })

  it('preserves valid image-only messages with empty text content', async () => {
    const imageOnlySession = {
      ...session,
      messages: [{ ...session.messages[0], content: '' }]
    }
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockResolvedValueOnce([imageOnlySession])

    await expect(desktopApi.session.list()).resolves.toEqual([imageOnlySession])
  })

  it('rejects malformed session documents before they reach renderer state', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockResolvedValueOnce([{
      id: 'session-1',
      projectId: 'project-1',
      summary: 'Broken session',
      messages: []
    }])

    await expect(desktopApi.session.list()).rejects.toThrow('invalid relative time')
  })
})
