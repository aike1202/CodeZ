import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { ChatState } from '../renderer/src/stores/chatStore/types'
import { createRuntimeStatusSlice } from '../renderer/src/stores/chatStore/slices/runtimeStatusSlice'

const inactiveStatus = {
  sessionId: 'session-a',
  mainRunnerActive: false,
  activeSubAgentIds: []
}

describe('renderer runtime status slice', () => {
  beforeEach(() => {
    ;(globalThis as any).window = {
      api: {
        chat: {
          getRuntimeStatus: vi.fn()
        }
      }
    }
  })

  it('does not let an unversioned query overwrite a newer event', async () => {
    let resolveQuery!: (value: typeof inactiveStatus) => void
    ;(window as any).api.chat.getRuntimeStatus.mockReturnValue(
      new Promise((resolve) => { resolveQuery = resolve })
    )
    const store = createStore<ChatState>()((...args) => ({
      ...createRuntimeStatusSlice(...args)
    } as ChatState))

    const refresh = store.getState().refreshRuntimeStatuses(['session-a'])
    store.getState().applyRuntimeStatus({
      version: 2,
      status: { ...inactiveStatus, mainRunnerActive: true }
    })
    resolveQuery(inactiveStatus)
    await refresh

    expect(store.getState().runtimeStatuses['session-a']).toEqual({
      version: 2,
      status: { ...inactiveStatus, mainRunnerActive: true }
    })
  })

  it('stores an initial query result and ignores older events', async () => {
    ;(window as any).api.chat.getRuntimeStatus.mockResolvedValue(inactiveStatus)
    const store = createStore<ChatState>()((...args) => ({
      ...createRuntimeStatusSlice(...args)
    } as ChatState))

    await store.getState().refreshRuntimeStatuses(['session-a', 'session-a'])
    store.getState().applyRuntimeStatus({
      version: 0,
      status: { ...inactiveStatus, mainRunnerActive: true }
    })

    expect((window as any).api.chat.getRuntimeStatus).toHaveBeenCalledTimes(1)
    expect(store.getState().runtimeStatuses['session-a']).toEqual({
      version: 0,
      status: inactiveStatus
    })
  })

  it('does not restore a deleted session status from a late event', () => {
    const store = createStore<ChatState>()((...args) => ({
      sessions: [{ id: 'session-a', isDeleted: false }],
      ...createRuntimeStatusSlice(...args)
    } as ChatState))
    store.getState().applyRuntimeStatus({ version: 1, status: inactiveStatus })

    store.setState({ sessions: [{ id: 'session-a', isDeleted: true }] } as Partial<ChatState>)
    store.getState().clearRuntimeStatus('session-a')
    store.getState().applyRuntimeStatus({
      version: 2,
      status: { ...inactiveStatus, mainRunnerActive: true }
    })

    expect(store.getState().runtimeStatuses['session-a']).toBeUndefined()
  })
})
