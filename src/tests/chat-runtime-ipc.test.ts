import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/ipc/channels'
import type {
  SessionRuntimeStatus,
  SessionRuntimeStatusChanged
} from '../shared/types/subagent'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener
  }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

describe('chat runtime IPC contract', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('defines a versioned runtime status changed payload', () => {
    const status = {
      sessionId: 'session-1',
      mainRunnerActive: true,
      activeSubAgentIds: ['subagent-1']
    } satisfies SessionRuntimeStatus
    const event = { version: 2, status } satisfies SessionRuntimeStatusChanged

    expect(IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED).toBe('chat:runtime:status-changed')
    expect(event).toEqual({ version: 2, status })
    expectTypeOf(event.version).toEqualTypeOf<number>()
    expectTypeOf(event.status).toMatchTypeOf<SessionRuntimeStatus>()
  })

  it('forwards runtime status events and removes the exact listener on cleanup', async () => {
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    await import('../preload/index')
    const exposedApi = electronMocks.exposeInMainWorld.mock.calls.find(
      ([key]) => key === 'api'
    )?.[1] as import('../preload/index').WebAPI
    const callback = vi.fn()
    const cleanup = exposedApi.chat.onRuntimeStatusChanged(callback)
    const handler = electronMocks.on.mock.calls[0][1]
    const payload: SessionRuntimeStatusChanged = {
      version: 3,
      status: {
        sessionId: 'session-1',
        mainRunnerActive: false,
        activeSubAgentIds: []
      }
    }

    expect(electronMocks.on).toHaveBeenCalledWith(
      IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED,
      handler
    )
    handler({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)

    cleanup()
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.CHAT_RUNTIME_STATUS_CHANGED,
      handler
    )
  })
})
