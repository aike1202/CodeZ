import { describe, expect, it } from 'vitest'
import { PermissionRuleStore } from '../main/services/permission/PermissionRuleStore'

describe('PermissionRuleStore', () => {
  it('matches session rules only in their session', async () => {
    const store = new PermissionRuleStore(':memory:')
    await store.remember({ workspaceRoot: '/repo', sessionId: 'a', pattern: 'npm install react', action: 'allow', scope: 'session', riskLevel: 2 })
    expect(await store.resolve('/repo', 'a', 'npm install react')).toBe('allow')
    expect(await store.resolve('/repo', 'b', 'npm install react')).toBeNull()
  })

  it('refuses to persist L4 allows', async () => {
    const store = new PermissionRuleStore(':memory:')
    await expect(store.remember({ workspaceRoot: '/repo', sessionId: 'a', pattern: 'sudo rm -rf /', action: 'allow', scope: 'workspace', riskLevel: 4 })).rejects.toThrow(/L4/)
  })
})
