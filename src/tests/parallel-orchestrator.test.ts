import { execFileSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import {
  parseWaves,
  findWaveFileConflicts,
  validateGrouping,
  computeConcurrencyLimit,
  mergeWorktree,
  mergePreparedWorktreeTracked,
  normalizeWorkerResult,
  runWithConcurrencyLimit,
} from '../main/agent/AgentRunner/parallelOrchestrator'
import type { PlanStep } from '../shared/types/plan'
import type { ExecutionWave } from '../shared/types/parallel'

function step(id: string, files?: string[]): PlanStep {
  return { id, title: `Step ${id}`, description: '', status: 'pending', ...(files ? { files } : {}) }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 30_000 })
}

describe('parseWaves', () => {
  it('parses valid JSON string entries and sorts by index', () => {
    const waves = parseWaves([
      '{"index":1,"stepIds":["p2","p3"]}',
      '{"index":0,"stepIds":["p0"]}',
    ])
    expect(waves).toEqual([
      { index: 0, stepIds: ['p0'] },
      { index: 1, stepIds: ['p2', 'p3'] },
    ])
  })

  it('skips invalid entries', () => {
    const waves = parseWaves([
      'not json',
      '{"index":0}', // missing stepIds
      '{"stepIds":["p1"]}', // missing index
      '{"index":0,"stepIds":[1,2]}', // non-string ids
      '{"index":0,"stepIds":["p0"]}', // valid
    ])
    expect(waves).toEqual([{ index: 0, stepIds: ['p0'] }])
  })
})

describe('findWaveFileConflicts', () => {
  const stepsById = new Map<string, PlanStep>([
    ['p0', step('p0', ['src/a.ts'])],
    ['p1', step('p1', ['src/b.ts'])],
    ['p2', step('p2', ['src/a.ts', 'src/c.ts'])],
  ])

  it('returns empty when files are disjoint', () => {
    const wave: ExecutionWave = { index: 0, stepIds: ['p0', 'p1'] }
    expect(findWaveFileConflicts(wave, stepsById)).toEqual([])
  })

  it('detects overlapping files', () => {
    const wave: ExecutionWave = { index: 0, stepIds: ['p0', 'p2'] }
    const conflicts = findWaveFileConflicts(wave, stepsById)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ a: 'p0', b: 'p2', files: ['src/a.ts'] })
  })
})

describe('validateGrouping', () => {
  const stepsById = new Map<string, PlanStep>([
    ['p0', step('p0', ['src/a.ts'])],
    ['p1', step('p1', ['src/a.ts'])], // conflicts with p0
  ])

  it('shared mode hard-rejects file conflicts', () => {
    const waves: ExecutionWave[] = [{ index: 0, stepIds: ['p0', 'p1'] }]
    const result = validateGrouping(waves, stepsById, 'shared')
    expect(result.error).toMatch(/File conflict in shared isolation/)
  })

  it('worktree mode only warns on conflicts', () => {
    const waves: ExecutionWave[] = [{ index: 0, stepIds: ['p0', 'p1'] }]
    const result = validateGrouping(waves, stepsById, 'worktree')
    expect(result.error).toBeNull()
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('passes when no conflicts', () => {
    const disjoint = new Map<string, PlanStep>([
      ['p0', step('p0', ['src/a.ts'])],
      ['p1', step('p1', ['src/b.ts'])],
    ])
    const waves: ExecutionWave[] = [{ index: 0, stepIds: ['p0', 'p1'] }]
    expect(validateGrouping(waves, disjoint, 'shared').error).toBeNull()
  })
})

describe('computeConcurrencyLimit', () => {
  it('caps at 6', () => {
    expect(computeConcurrencyLimit(16)).toBe(6)
  })
  it('uses cpuCount - 1 below cap', () => {
    expect(computeConcurrencyLimit(4)).toBe(3)
  })
  it('never goes below 1', () => {
    expect(computeConcurrencyLimit(1)).toBe(1)
    expect(computeConcurrencyLimit(0)).toBe(1)
  })
})

describe('mergeWorktree', () => {
  it('returns an error when worktree commit fails for a real reason', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codez-merge-worktree-'))
    const repo = path.join(tmp, 'repo')
    const wt = path.join(tmp, 'wt')
    const hooks = path.join(tmp, 'hooks')

    try {
      mkdirSync(repo)
      git(repo, ['init'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])
      writeFileSync(path.join(repo, 'a.txt'), 'base\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'base'])

      git(repo, ['worktree', 'add', '-b', 'feature', wt])
      writeFileSync(path.join(wt, 'a.txt'), 'feature\n')
      mkdirSync(hooks)
      const preCommit = path.join(hooks, 'pre-commit')
      writeFileSync(preCommit, '#!/bin/sh\nexit 1\n')
      chmodSync(preCommit, 0o755)
      git(wt, ['config', 'core.hooksPath', hooks])

      const result = mergeWorktree(repo, 'wt', wt, 'feature')

      expect(result).toMatch(/commit failed/i)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects a symlink tree entry before changing HEAD or the worktree', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codez-merge-symlink-'))
    const repo = path.join(tmp, 'repo')
    try {
      mkdirSync(repo)
      git(repo, ['init'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])
      writeFileSync(path.join(repo, 'base.txt'), 'base\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'base'])
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: repo, encoding: 'utf8'
      }).trim()
      const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo, encoding: 'utf8'
      }).trim()
      git(repo, ['checkout', '-b', 'feature-link'])
      const blobSource = path.join(tmp, 'link-target.txt')
      writeFileSync(blobSource, 'base.txt')
      const blob = execFileSync('git', ['hash-object', '-w', blobSource], {
        cwd: repo, encoding: 'utf8'
      }).trim()
      git(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},link.txt`])
      git(repo, ['commit', '-m', 'add link'])
      git(repo, ['checkout', baseBranch])

      const result = await mergePreparedWorktreeTracked(repo, 'feature-link')

      expect(result).toMatch(/refuses symlink, submodule, or special entry/i)
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim())
        .toBe(baseHead)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('serializes disjoint merges that share one Git common directory', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codez-merge-lock-'))
    const repo = path.join(tmp, 'repo')
    try {
      mkdirSync(repo)
      git(repo, ['init'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])
      writeFileSync(path.join(repo, 'base.txt'), 'base\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'base'])
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: repo, encoding: 'utf8'
      }).trim()
      git(repo, ['checkout', '-b', 'feature-one'])
      writeFileSync(path.join(repo, 'one.txt'), 'one\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'one'])
      git(repo, ['checkout', baseBranch])
      git(repo, ['checkout', '-b', 'feature-two'])
      writeFileSync(path.join(repo, 'two.txt'), 'two\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'two'])
      git(repo, ['checkout', baseBranch])

      let releaseFirst!: () => void
      let markFirstEntered!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve })
      let secondEntered = false
      const firstService = {
        runExternalMutation: async (_id: string, _paths: string[], operation: () => void) => {
          markFirstEntered()
          await firstGate
          return operation()
        }
      }
      const secondService = {
        runExternalMutation: async (_id: string, _paths: string[], operation: () => void) => {
          secondEntered = true
          return operation()
        }
      }

      const first = mergePreparedWorktreeTracked(
        repo, 'feature-one', { id: 'tx-one', service: firstService as any }
      )
      await firstEntered
      const second = mergePreparedWorktreeTracked(
        repo, 'feature-two', { id: 'tx-two', service: secondService as any }
      )
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(secondEntered).toBe(false)
      releaseFirst()

      await expect(first).resolves.toBeNull()
      await expect(second).resolves.toBeNull()
      expect(secondEntered).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('normalizeWorkerResult', () => {
  it('preserves an explicit failed Runtime result even when it has text output', () => {
    const result = normalizeWorkerResult({
      type: 'Executor',
      status: 'failed',
      output: 'Provider request failed.',
      toolCallCount: 2
    })

    expect(result.status).toBe('failed')
    expect(result.summary).toBe('Provider request failed.')
  })

  it('preserves an interrupted Runtime result and confirmed modified files', () => {
    const result = normalizeWorkerResult({
      type: 'Executor',
      status: 'interrupted',
      output: 'Stopped by parent.',
      handoff: {
        reasonCode: 'parent_interrupted',
        reason: 'Stopped by parent.',
        originalTask: 'task',
        filesExamined: [],
        filesModified: ['src/a.ts'],
        filesPossiblyModified: [],
        recentTools: [],
        workspaceMayHaveUntrackedChanges: false,
        canResume: true
      }
    })

    expect(result.status).toBe('interrupted')
    expect(result.filesModified).toEqual(['src/a.ts'])
  })

  it('recovers plain-text worker output as a completed summary', () => {
    const result = normalizeWorkerResult({
      type: 'Worker',
      output: 'Implemented the requested change and verified it.',
      toolCallCount: 3,
    })

    expect(result).toEqual({
      status: 'completed',
      summary: 'Implemented the requested change and verified it.',
      filesModified: [],
      blockers: undefined,
    })
  })

  it('fails when the worker produced neither structured output nor text', () => {
    const result = normalizeWorkerResult({
      type: 'Worker',
      output: '',
      toolCallCount: 0,
    })

    expect(result.status).toBe('failed')
    expect(result.summary).toMatch(/no structured output/i)
  })
})

describe('runWithConcurrencyLimit', () => {
  it('runs all thunks and preserves order', async () => {
    const thunks = [1, 2, 3, 4, 5].map(n => () => Promise.resolve(n * 10))
    const results = await runWithConcurrencyLimit(thunks, 2)
    expect(results).toEqual([10, 20, 30, 40, 50])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const thunks = Array.from({ length: 10 }, () => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(r => setTimeout(r, 5))
      active--
      return active
    })
    await runWithConcurrencyLimit(thunks, 3)
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('handles empty input', async () => {
    expect(await runWithConcurrencyLimit([], 4)).toEqual([])
  })
})
