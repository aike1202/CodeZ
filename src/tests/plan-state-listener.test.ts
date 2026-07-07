import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspace: null })
  }
}))

describe('plan state listener lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not register duplicate plan listeners and removes them on cleanup', async () => {
    const on = vi.fn()
    const removeListener = vi.fn()
    ;(globalThis as any).window = {
      electron: {
        ipcRenderer: {
          on,
          removeListener
        }
      }
    }

    const { useChatStore } = await import('../renderer/src/stores/chatStore')

    const firstCleanup = useChatStore.getState().initPlanStateListener()
    const secondCleanup = useChatStore.getState().initPlanStateListener()

    expect(on).toHaveBeenCalledTimes(4)

    secondCleanup()
    expect(removeListener).not.toHaveBeenCalled()

    firstCleanup()
    expect(removeListener).toHaveBeenCalledTimes(4)
    expect(removeListener.mock.calls.map(([channel]) => channel)).toEqual([
      'plan:subagent-progress',
      'plan:review-request',
      'plan:state-changed',
      'plan:linked'
    ])
  })
})
