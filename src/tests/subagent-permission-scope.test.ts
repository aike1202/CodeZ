import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { authorizeSubAgentToolCall, checkSubAgentToolPermission } from '../main/agent/SubAgentManager'
import type { SubAgentPermissionScope } from '../main/agent/SubAgentManager'

const WS = path.resolve('/tmp/codez-ws')

describe('checkSubAgentToolPermission', () => {
  describe('no scope (read-only subagent)', () => {
    it('allows read-only tools', () => {
      expect(checkSubAgentToolPermission('Read', { files: [{ file_path: 'a.ts' }] }, WS, undefined)).toBeNull()
      expect(checkSubAgentToolPermission('Grep', {}, WS, undefined)).toBeNull()
    })
    it('denies write and shell tools', () => {
      expect(checkSubAgentToolPermission('Edit', { file_path: 'a.ts' }, WS, undefined)).toMatch(/not permitted/)
      expect(checkSubAgentToolPermission('Bash', { command: 'ls' }, WS, undefined)).toMatch(/not permitted/)
    })
  })

  describe('shared scope (allowedWriteFiles)', () => {
    const scope: SubAgentPermissionScope = {
      allowedWriteFiles: ['src/a.ts', 'src/b.ts'],
      allowBash: true,
    }
    it('allows writes to assigned files', () => {
      expect(checkSubAgentToolPermission('Write', { file_path: 'src/a.ts' }, WS, scope)).toBeNull()
      expect(checkSubAgentToolPermission('Edit', { file_path: path.resolve(WS, 'src/b.ts') }, WS, scope)).toBeNull()
      expect(checkSubAgentToolPermission('NotebookEdit', { notebook_path: 'src/a.ts' }, WS, scope)).toBeNull()
    })
    it('denies writes outside assigned files', () => {
      expect(checkSubAgentToolPermission('Write', { file_path: 'src/c.ts' }, WS, scope)).toMatch(/outside your assigned/)
    })
    it('denies workspace-escaping writes', () => {
      expect(checkSubAgentToolPermission('Write', { file_path: path.resolve('/tmp/evil.ts') }, WS, scope)).toMatch(/escapes the workspace/)
    })
    it('denies writes through an in-workspace link to an external directory', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codez-subagent-scope-'))
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codez-subagent-outside-'))
      try {
        const link = path.join(root, 'external-link')
        await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
        const linkedTarget = path.join(link, 'new.ts')
        expect(checkSubAgentToolPermission(
          'Write',
          { file_path: linkedTarget },
          root,
          { allowedWriteFiles: [linkedTarget] }
        )).toMatch(/escapes the workspace/)
      } finally {
        await fs.rm(root, { recursive: true, force: true })
        await fs.rm(outside, { recursive: true, force: true })
      }
    })
    it('delegates allowed shell commands to the runtime permission policy', () => {
      expect(checkSubAgentToolPermission('Bash', { command: 'npm test' }, WS, scope)).toBeNull()
      expect(checkSubAgentToolPermission('PowerShell', { command: 'npm run tauri dev' }, WS, scope)).toBeNull()
    })

    it('allows ordinary shell commands after runtime permission evaluation', async () => {
      await expect(authorizeSubAgentToolCall(
        'Bash',
        { command: 'git status' },
        WS,
        'session-a',
        scope
      )).resolves.toBeNull()
    })

    it('routes Hardline shell commands through the parent approval handler', async () => {
      const approve = vi.fn().mockResolvedValue(false)
      const denial = await authorizeSubAgentToolCall(
        'Bash',
        { command: 'sudo rm -rf /var/lib/example' },
        WS,
        'session-a',
        scope,
        approve,
        'subagent-a'
      )

      expect(denial).toContain('User denied permission')
      expect(approve).toHaveBeenCalledOnce()
      expect(approve.mock.calls[0][0]).toMatchObject({
        toolName: 'Bash',
        hardline: true,
        agentId: 'subagent-a',
        allowedScopes: ['once']
      })
    })
  })

  describe('shared scope without allowBash', () => {
    it('blocks shell commands', () => {
      const scope: SubAgentPermissionScope = { allowedWriteFiles: ['a.ts'] }
      expect(checkSubAgentToolPermission('Bash', { command: 'npm test' }, WS, scope)).toMatch(/not permitted/)
    })
  })

  describe('worktree scope (allowAllWritesInWorkspace)', () => {
    const scope: SubAgentPermissionScope = { allowAllWritesInWorkspace: true, allowBash: true }
    it('allows any write inside workspace', () => {
      expect(checkSubAgentToolPermission('Write', { file_path: 'anything.ts' }, WS, scope)).toBeNull()
      expect(checkSubAgentToolPermission('Edit', { file_path: 'deep/nested/x.ts' }, WS, scope)).toBeNull()
    })
    it('still blocks workspace escape', () => {
      expect(checkSubAgentToolPermission('Write', { file_path: path.resolve('/tmp/evil.ts') }, WS, scope)).toMatch(/escapes the workspace/)
    })
  })
})
