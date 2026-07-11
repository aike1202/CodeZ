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

  it('increments revisions and notifies only for real lifecycle changes', () => {
    const registry = new ChatRuntimeRegistry<{ abort(): void }>()
    const changedSessions: string[] = []
    const unsubscribe = registry.onChange((sessionId) => changedSessions.push(sessionId))

    registry.register('stream-1', 's1', { abort() {} })
    expect(registry.getVersion('s1')).toBe(1)

    registry.unregister('stream-1')
    expect(registry.getStatus('s1', []).mainRunnerActive).toBe(false)
    expect(registry.getVersion('s1')).toBe(2)

    registry.unregister('stream-1')
    expect(registry.getVersion('s1')).toBe(2)
    expect(changedSessions).toEqual(['s1', 's1'])

    unsubscribe()
    registry.touch('s1')
    expect(registry.getVersion('s1')).toBe(3)
    expect(changedSessions).toEqual(['s1', 's1'])
  })
})
