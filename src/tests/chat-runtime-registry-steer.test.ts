import { describe, expect, it, vi } from 'vitest'
import { ChatRuntimeRegistry } from '../main/services/ChatRuntimeRegistry'

describe('ChatRuntimeRegistry session lookup', () => {
  it('returns only the runner registered for the requested session', () => {
    const first = { abort: vi.fn() }
    const second = { abort: vi.fn() }
    const registry = new ChatRuntimeRegistry<typeof first>()
    registry.register('stream-1', 'session-1', first)
    registry.register('stream-2', 'session-2', second)

    expect(registry.getRunnerForSession('session-1')).toBe(first)
    expect(registry.getRunnerForSession('session-2')).toBe(second)
    expect(registry.getRunnerForSession('missing')).toBeUndefined()
  })

  it('stops returning a runner after its stream is unregistered', () => {
    const runner = { abort: vi.fn() }
    const registry = new ChatRuntimeRegistry<typeof runner>()
    registry.register('stream-1', 'session-1', runner)
    registry.unregister('stream-1')

    expect(registry.getRunnerForSession('session-1')).toBeUndefined()
  })
})
