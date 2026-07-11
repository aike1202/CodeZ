import { describe, expect, it, vi } from 'vitest'
import { deleteSessionWithAttachments } from '../main/ipc/attachment.handlers'

describe('image session lifecycle', () => {
  it('keeps attachments on soft delete and removes them on permanent delete', async () => {
    const session = { id: 's1', isDeleted: false }
    const store = {
      get: vi.fn(() => ({ ...session })),
      delete: vi.fn(async () => { session.isDeleted = true })
    }
    const attachments = { deleteSession: vi.fn(async () => undefined) }

    await deleteSessionWithAttachments(store, attachments, 's1')
    expect(attachments.deleteSession).not.toHaveBeenCalled()

    store.get.mockReturnValue({ id: 's1', isDeleted: true })
    await deleteSessionWithAttachments(store, attachments, 's1')
    expect(attachments.deleteSession).toHaveBeenCalledWith('s1')
  })
})
