import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptPendingEdits } from '../renderer/src/components/chat/EditApprovalWidget'
import { useChatStore } from '../renderer/src/stores/chatStore'

const saveSession = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../renderer/src/shared/desktop/api', () => ({
  desktopApi: { session: { save: saveSession } }
}))

afterEach(() => {
  saveSession.mockClear()
})

describe('edit approval acceptance', () => {
  it('accepts every pending file without requiring transaction paths', () => {
    const accept = vi.fn()

    acceptPendingEdits(
      [
        { filePath: 'docs/spec.md' },
        { filePath: 'docs/plan.md' },
      ],
      {},
      accept
    )

    expect(accept.mock.calls).toEqual([
      ['docs/spec.md'],
      ['docs/plan.md'],
    ])
  })

  it('preserves prior decisions and deduplicates repeated file edits', () => {
    const accept = vi.fn()

    acceptPendingEdits(
      [
        { filePath: 'accepted.md' },
        { filePath: 'pending.md' },
        { filePath: 'pending.md' },
        { filePath: 'rejected.md' },
      ],
      {
        'accepted.md': 'accepted',
        'rejected.md': 'rejected',
      },
      accept
    )

    expect(accept).toHaveBeenCalledOnce()
    expect(accept).toHaveBeenCalledWith('pending.md')
  })

  it('records all accepted files in one message update', async () => {
    const message = { id: 'agent-1', role: 'agent' as const, content: '' }
    const session = {
      id: 'session-1', projectId: 'project-1', summary: '', relativeTime: '', messages: [message]
    }
    useChatStore.setState({
      sessions: [session], activeSessionId: session.id, messages: [message]
    } as any)

    useChatStore.getState().setEditStatuses('agent-1', {
      'docs/spec.md': 'accepted',
      'docs/plan.md': 'accepted'
    })

    expect(useChatStore.getState().messages[0].editStatuses).toEqual({
      'docs/spec.md': 'accepted',
      'docs/plan.md': 'accepted'
    })
    expect(useChatStore.getState().sessions[0].messages[0].editStatuses).toEqual({
      'docs/spec.md': 'accepted',
      'docs/plan.md': 'accepted'
    })
    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce())
  })
})
