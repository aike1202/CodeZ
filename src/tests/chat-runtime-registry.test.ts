import { describe, expect, it, vi } from 'vitest'
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

  it('keeps a runner active while an abort request is still cleaning up', () => {
    const runner = { abort: vi.fn() }
    const registry = new ChatRuntimeRegistry<typeof runner>()
    registry.register('stream-1', 's1', runner)

    expect(registry.requestAbort('stream-1')).toBe(true)
    expect(runner.abort).toHaveBeenCalledOnce()
    expect(registry.getStatus('s1', []).mainRunnerActive).toBe(true)
    expect(registry.getVersion('s1')).toBe(1)

    registry.unregister('stream-1')
    expect(registry.getStatus('s1', []).mainRunnerActive).toBe(false)
    expect(registry.getVersion('s1')).toBe(2)
    expect(registry.requestAbort('stream-1')).toBe(false)
  })
})
