import { describe, it, expect } from 'vitest'
import {
  parseWaves,
  findWaveFileConflicts,
  validateGrouping,
  computeConcurrencyLimit,
  runWithConcurrencyLimit,
} from '../main/agent/AgentRunner/parallelOrchestrator'
import type { PlanStep } from '../shared/types/plan'
import type { ExecutionWave } from '../shared/types/parallel'

function step(id: string, files?: string[]): PlanStep {
  return { id, title: `Step ${id}`, description: '', status: 'pending', ...(files ? { files } : {}) }
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
