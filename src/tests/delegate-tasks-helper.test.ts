import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  compactIndependentSingletonWaves,
  validateSharedDelegationReadiness,
  resolveDelegateIsolation,
} from '../main/agent/AgentRunner/delegateTasksHelper'
import type { ExecUnit, ExecutionWave } from '../shared/types/parallel'

describe('resolveDelegateIsolation', () => {
  function initGitRepo(): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'codez-delegate-git-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    git(['init'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test User'])
    writeFileSync(path.join(repo, 'README.md'), '# temp\n')
    git(['add', '-A'])
    git(['commit', '-m', 'init'])
    return repo
  }

  it('falls back to shared mode when worktree is requested outside a git repository', () => {
    const nonGit = mkdtempSync(path.join(os.tmpdir(), 'codez-delegate-nongit-'))

    try {
      const result = resolveDelegateIsolation(undefined, nonGit)

      expect(result).toEqual({
        isolation: 'shared',
        fallbackReason:
          '当前目录不是 Git 仓库，已从 worktree 隔离自动改用 shared 共享工作区模式。',
      })
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('keeps explicit shared mode outside a git repository', () => {
    const nonGit = mkdtempSync(path.join(os.tmpdir(), 'codez-delegate-nongit-'))

    try {
      expect(resolveDelegateIsolation('shared', nonGit)).toEqual({ isolation: 'shared' })
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('keeps worktree mode inside a git repository', () => {
    const repo = initGitRepo()

    try {
      expect(resolveDelegateIsolation(undefined, repo)).toEqual({ isolation: 'worktree' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('compactIndependentSingletonWaves', () => {
  it('combines serial singleton waves when their files are disjoint', () => {
    const units = new Map<string, ExecUnit>([
      ['t1', { id: 't1', title: 'A', description: '', files: ['src/a.ts'] }],
      ['t2', { id: 't2', title: 'B', description: '', files: ['src/b.ts'] }],
      ['t3', { id: 't3', title: 'C', description: '', files: ['src/c.ts'] }],
    ])
    const waves: ExecutionWave[] = [
      { index: 0, stepIds: ['t1'] },
      { index: 1, stepIds: ['t2'] },
      { index: 2, stepIds: ['t3'] },
    ]

    expect(compactIndependentSingletonWaves(waves, units)).toEqual([
      { index: 0, stepIds: ['t1', 't2', 't3'] },
    ])
  })

  it('keeps conflicting singleton waves separate', () => {
    const units = new Map<string, ExecUnit>([
      ['t1', { id: 't1', title: 'A', description: '', files: ['src/shared.ts'] }],
      ['t2', { id: 't2', title: 'B', description: '', files: ['src/shared.ts'] }],
    ])
    const waves: ExecutionWave[] = [
      { index: 0, stepIds: ['t1'] },
      { index: 1, stepIds: ['t2'] },
    ]

    expect(compactIndependentSingletonWaves(waves, units)).toEqual(waves)
  })
})

describe('validateSharedDelegationReadiness', () => {
  it('rejects shared delegation when any unit has no declared files', () => {
    const units: ExecUnit[] = [
      { id: 't1', title: 'A', description: '', files: ['src/a.ts'] },
      { id: 't2', title: 'B', description: '' },
    ]

    expect(validateSharedDelegationReadiness(units)).toEqual(
      "Shared Worker delegation requires every task to declare `files`; missing: t2. Add file boundaries or run these tasks sequentially."
    )
  })

  it('allows shared delegation when every unit declares files', () => {
    const units: ExecUnit[] = [
      { id: 't1', title: 'A', description: '', files: ['src/a.ts'] },
      { id: 't2', title: 'B', description: '', files: ['src/b.ts'] },
    ]

    expect(validateSharedDelegationReadiness(units)).toBeNull()
  })
})
