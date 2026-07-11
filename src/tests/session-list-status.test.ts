import { describe, expect, it } from 'vitest'
import {
  deriveSessionListStatus,
  getSessionStatusPresentation
} from '../renderer/src/App/hooks/sessionListStatus'

const idleRuntime = {
  sessionId: 's1',
  mainRunnerActive: false,
  activeSubAgentIds: []
}

describe('session list status', () => {
  it('uses action-required before running and error', () => {
    const status = deriveSessionListStatus({
      messages: [{
        id: 'agent-1',
        role: 'agent',
        content: '',
        executionStatus: 'error',
        permissionRequests: [{ id: 'permission-1', status: 'pending' }]
      } as any],
      runtimeStatus: {
        version: 3,
        status: { ...idleRuntime, mainRunnerActive: true }
      }
    })

    expect(status).toBe('action-required')
  })

  it('uses running before an older execution error', () => {
    const status = deriveSessionListStatus({
      messages: [{ id: 'agent-1', role: 'agent', content: '', executionStatus: 'error' }],
      runtimeStatus: {
        version: 2,
        status: { ...idleRuntime, activeSubAgentIds: ['sub-1'] }
      }
    })

    expect(status).toBe('running')
  })

  it('only reports an error when the latest execution ended in error', () => {
    expect(deriveSessionListStatus({
      messages: [
        { id: 'agent-1', role: 'agent', content: '', executionStatus: 'error' },
        { id: 'agent-2', role: 'agent', content: '', executionStatus: 'completed' }
      ],
      runtimeStatus: { version: 1, status: idleRuntime }
    })).toBe('idle')

    expect(deriveSessionListStatus({
      messages: [
        { id: 'agent-1', role: 'agent', content: '', executionStatus: 'completed' },
        { id: 'agent-2', role: 'agent', content: '', executionStatus: 'error' }
      ],
      runtimeStatus: { version: 1, status: idleRuntime }
    })).toBe('error')
  })

  it('provides stable accessible labels for all four states', () => {
    expect(getSessionStatusPresentation('action-required').label).toBe('需要确认')
    expect(getSessionStatusPresentation('running').label).toBe('正在运行')
    expect(getSessionStatusPresentation('error').label).toBe('执行出错')
    expect(getSessionStatusPresentation('idle').label).toBe('空闲')
  })
})
