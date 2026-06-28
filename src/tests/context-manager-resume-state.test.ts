import { describe, it, expect } from 'vitest'
import { ContextManager } from '../main/agent/ContextManager'

describe('ContextManager ResumeState helpers', () => {
  it('createResumeStateKey 应基于 workspace 和 session 生成稳定 key', () => {
    const key1 = ContextManager.createResumeStateKey('/tmp/codez-project', 'session-a')
    const key2 = ContextManager.createResumeStateKey('/tmp/codez-project', 'session-a')
    const key3 = ContextManager.createResumeStateKey('/tmp/codez-project', 'session-b')

    expect(key1).toBe(key2)
    expect(key1).toContain('workspace_')
    expect(key1).toContain('session-a')
    expect(key3).not.toBe(key1)
  })

  it('createResumeStateKey 不传 session 时应回退到 workspace 级 key', () => {
    const key = ContextManager.createResumeStateKey('/tmp/codez-project')
    expect(key).toMatch(/^workspace_[a-f0-9]+$/)
  })
})
