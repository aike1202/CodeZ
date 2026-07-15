import { describe, expect, it, vi } from 'vitest'
import { PendingApprovalBroker } from '../main/ipc/PendingApprovalBroker'

describe('PendingApprovalBroker', () => {
  it('denies every pending request for a stopped stream exactly once', () => {
    const broker = new PendingApprovalBroker()
    const first = vi.fn()
    const second = vi.fn()
    broker.register('stream-1', first)
    broker.register('stream-1', second)

    expect(broker.count('stream-1')).toBe(2)
    broker.denyAll('stream-1')
    broker.denyAll('stream-1')

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(broker.count('stream-1')).toBe(0)
  })

  it('lets a normal response unregister without affecting other streams', () => {
    const broker = new PendingApprovalBroker()
    const first = vi.fn()
    const second = vi.fn()
    const unregister = broker.register('stream-1', first)
    broker.register('stream-2', second)

    unregister()
    broker.denyAll('stream-1')
    broker.denyAll('stream-2')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })
})
