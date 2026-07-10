import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { NestedCommandExpander } from '../main/services/permission/NestedCommandExpander'
import { PathImpactAnalyzer } from '../main/services/permission/PathImpactAnalyzer'

describe('permission operation analysis', () => {
  it('expands package scripts and records their hash', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-op-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8')
      const result = await new NestedCommandExpander().expandCommand('bash', ['npm', 'test'], root, root)
      expect(result.command).toBe('vitest run')
      expect(result.snapshots[0].path).toBe(path.join(root, 'package.json'))
      expect(result.snapshots[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a symlink escape as external', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-root-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'codez-permission-outside-'))
    try {
      await mkdir(path.join(root, 'links'))
      await symlink(outside, path.join(root, 'links', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
      const result = await new PathImpactAnalyzer().analyze(path.join(root, 'links', 'outside', 'x.txt'), root)
      expect(result.insideWorkspace).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
