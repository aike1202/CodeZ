import { beforeEach, describe, expect, it } from 'vitest'
import { useParallelExecStore } from '../renderer/src/stores/parallelExecStore'
import type { ParallelExecutionEvent } from '../shared/types/parallel'

describe('parallelExecStore authoritative events', () => {
  beforeEach(() => useParallelExecStore.getState().reset())

  it('keeps queued and running Executors distinct and ignores stale events', () => {
    const event: ParallelExecutionEvent = {
      sequence: 3,
      sessionId: 's1',
      executionId: 'exec-1',
      timestamp: 10,
      type: 'updated',
      snapshot: {
        executionId: 'exec-1',
        sessionId: 's1',
        source: 'task:s1',
        status: 'running',
        controlEpoch: 0,
        isolation: 'worktree',
        rationale: '',
        waves: [{ index: 0, stepIds: ['t1', 't2'] }],
        executors: [
          { executorId: 'e1', stepId: 't1', waveIndex: 0, status: 'running', attemptCount: 1, filesModified: [], filesPossiblyModified: [] },
          { executorId: 'e2', stepId: 't2', waveIndex: 0, status: 'queued', attemptCount: 0, filesModified: [], filesPossiblyModified: [] }
        ],
        sequence: 3,
        createdAt: 1,
        updatedAt: 10
      }
    }

    useParallelExecStore.getState().handleExecutionEvent(event)
    expect(useParallelExecStore.getState().waves[0].stepStatuses).toEqual({ t1: 'running', t2: 'queued' })

    useParallelExecStore.getState().handleWaveUpdate({
      executionId: 'exec-1',
      sessionId: 's1',
      waveIndex: 0,
      status: 'completed',
      stepResults: []
    })
    useParallelExecStore.getState().handleDone({
      executionId: 'exec-1',
      sessionId: 's1',
      report: { status: 'halted' }
    })
    expect(useParallelExecStore.getState().overallStatus).toBe('running')

    useParallelExecStore.getState().handleExecutionEvent({
      ...event,
      sequence: 2,
      snapshot: { ...event.snapshot, sequence: 2, status: 'completed' }
    })
    expect(useParallelExecStore.getState().overallStatus).toBe('running')
  })

  it('projects ready artifacts as succeeded without counting them completed', () => {
    const event: ParallelExecutionEvent = {
      sequence: 1,
      sessionId: 's1',
      executionId: 'exec-ready',
      timestamp: 10,
      type: 'updated',
      snapshot: {
        executionId: 'exec-ready',
        sessionId: 's1',
        source: 'task:s1',
        status: 'decision_required',
        controlEpoch: 0,
        isolation: 'worktree',
        rationale: '',
        waves: [{ index: 0, stepIds: ['t1', 't2'] }],
        executors: [
          { executorId: 'e1', stepId: 't1', waveIndex: 0, status: 'succeeded', attemptCount: 1, filesModified: ['a.ts'], filesPossiblyModified: [], artifactStatus: 'ready' },
          { executorId: 'e2', stepId: 't2', waveIndex: 0, status: 'failed', attemptCount: 1, filesModified: [], filesPossiblyModified: [] }
        ],
        sequence: 1,
        createdAt: 1,
        updatedAt: 10
      }
    }

    useParallelExecStore.getState().handleExecutionEvent(event)
    const state = useParallelExecStore.getState()
    expect(state.overallStatus).toBe('decision_required')
    expect(state.waves[0].stepResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 't1', status: 'succeeded' }),
      expect.objectContaining({ stepId: 't2', status: 'failed' })
    ]))
  })
})
