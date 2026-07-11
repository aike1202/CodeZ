import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { PermissionRuleStore } from '../main/services/permission/PermissionRuleStore'

describe('PermissionRuleStore', () => {
  it('matches session rules only in their session', async () => {
    const store = new PermissionRuleStore(':memory:')
    await store.remember({ workspaceRoot: '/repo', sessionId: 'a', permission: 'network', pattern: 'npm install react', action: 'allow', scope: 'session', hardline: false })
    expect(await store.resolve('/repo', 'a', 'network', 'npm install react')).toBe('allow')
    expect(await store.resolve('/repo', 'b', 'network', 'npm install react')).toBeNull()
  })

  it('refuses to persist Hardline allows', async () => {
    const store = new PermissionRuleStore(':memory:')
    await expect(store.remember({ workspaceRoot: '/repo', sessionId: 'a', permission: 'hardline', pattern: 'sudo rm -rf /', action: 'allow', scope: 'workspace', hardline: true })).rejects.toThrow(/Hardline/)
    await expect(store.remember({ workspaceRoot: '/repo', sessionId: 'a', permission: 'hardline', pattern: 'sudo rm -rf /', action: 'allow', scope: 'workspace', hardline: false })).rejects.toThrow(/Hardline/)
  })

  it('matches wildcard rules and uses the last matching rule', async () => {
    const store = new PermissionRuleStore(':memory:')
    await store.remember({ workspaceRoot: '/repo', permission: 'network', pattern: 'npm *', action: 'allow', scope: 'workspace', hardline: false })
    await store.remember({ workspaceRoot: '/repo', permission: 'network', pattern: 'npm publish', action: 'deny', scope: 'workspace', hardline: false })

    expect(await store.resolve('/repo', undefined, 'network', 'npm install react')).toBe('allow')
    expect(await store.resolve('/repo', undefined, 'network', 'npm publish')).toBe('deny')
  })

  it('does not apply a rule from another capability', async () => {
    const store = new PermissionRuleStore(':memory:')
    await store.remember({ workspaceRoot: '/repo', permission: 'shell', pattern: 'npm *', action: 'allow', scope: 'workspace', hardline: false })

    expect(await store.resolve('/repo', undefined, 'network', 'npm install react')).toBeNull()
  })

  it('ignores structurally corrupted stored rules', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-rules-'))
    try {
      const filePath = path.join(root, 'rules.json')
      await writeFile(filePath, JSON.stringify({ rules: [null, {}, { workspace: '/repo', pattern: 42, action: 'allow' }] }), 'utf8')
      const store = new PermissionRuleStore(filePath)

      expect(await store.resolve('/repo', undefined, 'shell', 'git status')).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
