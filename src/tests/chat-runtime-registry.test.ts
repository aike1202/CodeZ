import { describe, expect, it } from 'vitest'
import { ChatRuntimeRegistry } from '../main/services/ChatRuntimeRegistry'

describe('ChatRuntimeRegistry', () => {
  it('reports only runners and subagents belonging to the requested session', () => {
    const registry = new ChatRuntimeRegistry<{ abort(): void }>()
    registry.register('stream-1', 's1', { abort() {} })
    registry.register('stream-2', 's2', { abort() {} })

    expect(registry.getStatus('s1', ['subagent-a'])).toEqual({
      sessionId: 's1',
      mainRunnerActive: true,
      activeSubAgentIds: ['subagent-a']
    })
    expect(registry.getStatus('missing', [])).toEqual({
      sessionId: 'missing',
      mainRunnerActive: false,
      activeSubAgentIds: []
    })
  })

  it('removes terminal streams exactly once', () => {
    const registry = new ChatRuntimeRegistry<{ abort(): void }>()
    registry.register('stream-1', 's1', { abort() {} })
    registry.unregister('stream-1')
    registry.unregister('stream-1')

    expect(registry.getStatus('s1', []).mainRunnerActive).toBe(false)
  })
})
