import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionController } from '../main/services/execution/ExecutionController'

describe('ExecutionController', () => {
  let root: string
  let controller: ExecutionController

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'codez-execution-controller-'))
    controller = new ExecutionController()
  })

  afterEach(() => {
    controller.resetForTests()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates stable logical executors and unique attempts', () => {
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1', 't2'] }],
      isolation: 'worktree',
      rationale: 'independent'
    })

    const first = controller.startExecutor(execution.executionId, 't1')
    controller.finishExecutor(execution.executionId, 't1', {
      stepId: 't1',
      executorId: first.snapshot.executorId,
      attemptId: first.token.attemptId,
      status: 'failed',
      summary: 'failed',
      filesModified: []
    })
    const second = controller.startExecutor(execution.executionId, 't1')

    expect(second.snapshot.executorId).toBe(first.snapshot.executorId)
    expect(second.token.attemptId).not.toBe(first.token.attemptId)
    expect(second.snapshot.attemptCount).toBe(2)
  })

  it('revokes every lease before confirming execution stop', () => {
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1', 't2'] }],
      isolation: 'worktree',
      rationale: ''
    })
    const first = controller.startExecutor(execution.executionId, 't1')
    const second = controller.startExecutor(execution.executionId, 't2')

    const stopped = controller.stopExecution(execution.executionId)

    expect(stopped.status).toBe('stopped')
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(controller.assertLeaseActive(first.token)).toMatch(/stale|revoked|stopped/i)
    expect(controller.assertLeaseActive(second.token)).toMatch(/stale|revoked|stopped/i)
  })

  it('ignores a terminal result from a revoked attempt', () => {
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'worktree',
      rationale: ''
    })
    const attempt = controller.startExecutor(execution.executionId, 't1')
    controller.stopExecution(execution.executionId)

    const accepted = controller.finishExecutor(execution.executionId, 't1', {
      stepId: 't1',
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: 'completed',
      summary: 'late success',
      filesModified: ['src/a.ts']
    })

    expect(accepted).toBe(false)
    expect(controller.getExecution(execution.executionId)?.status).toBe('stopped')
    expect(controller.getExecution(execution.executionId)?.executors[0].status).toBe('stopped')
  })

  it('does not reconcile a late result over a stopped or newer Executor attempt', () => {
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'shared',
      rationale: ''
    })
    const first = controller.startExecutor(execution.executionId, 't1')
    controller.stopExecutor(execution.executionId, first.snapshot.executorId)

    controller.reconcileExecutorResult(execution.executionId, {
      stepId: 't1',
      executorId: first.snapshot.executorId,
      attemptId: first.token.attemptId,
      status: 'completed',
      summary: 'late',
      filesModified: []
    })
    expect(controller.getExecution(execution.executionId)?.executors[0].status).toBe('stopped')

    const second = controller.startExecutor(execution.executionId, 't1')
    controller.reconcileExecutorResult(execution.executionId, {
      stepId: 't1',
      executorId: first.snapshot.executorId,
      attemptId: first.token.attemptId,
      status: 'failed',
      summary: 'older attempt failed late',
      filesModified: []
    })
    expect(controller.getExecution(execution.executionId)?.executors[0]).toMatchObject({
      status: 'running',
      attemptId: second.token.attemptId
    })
  })

  it('rejects duplicate step ids before scheduling', () => {
    expect(() => controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [
        { index: 0, stepIds: ['t1'] },
        { index: 1, stepIds: ['t1'] }
      ],
      isolation: 'worktree',
      rationale: ''
    })).toThrow(/Duplicate step id/)
  })

  it('restores an unfinished execution as decision_required with lost Executors', () => {
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'worktree',
      rationale: ''
    })
    controller.startExecutor(execution.executionId, 't1')

    controller.resetForTests()
    controller = new ExecutionController()
    const restored = controller.restoreSession(root, 's1')

    expect(restored).toHaveLength(1)
    expect(restored[0].status).toBe('decision_required')
    expect(restored[0].executors[0].status).toBe('lost')
    expect(restored[0].executors[0].failureReason).toBe('runtime_missing')
  })

  it('keeps successful artifacts ready until explicitly accepted', async () => {
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1', 't2'] }],
      isolation: 'worktree',
      rationale: ''
    })
    const first = controller.startExecutor(execution.executionId, 't1')
    controller.finishExecutor(execution.executionId, 't1', {
      stepId: 't1',
      executorId: first.snapshot.executorId,
      attemptId: first.token.attemptId,
      status: 'completed',
      summary: 'ready',
      filesModified: ['src/a.ts']
    })
    controller.failExecutorBeforeStart(execution.executionId, 't2', 'failed')
    let mergeCount = 0
    controller.registerArtifact(execution.executionId, first.snapshot.executorId, async () => {
      mergeCount += 1
      return null
    })
    controller.markDecisionRequired(execution.executionId)

    const ready = controller.getExecution(execution.executionId)!
    expect(ready.executors[0]).toMatchObject({ status: 'succeeded', artifactStatus: 'ready' })

    const accepted = await controller.acceptCompleted(execution.executionId, first.snapshot.executorId)
    expect(mergeCount).toBe(1)
    expect(accepted.status).toBe('decision_required')
    expect(accepted.executors[0]).toMatchObject({ status: 'completed', artifactStatus: 'merged' })
    await expect(controller.acceptCompleted(execution.executionId, first.snapshot.executorId))
      .rejects.toThrow(/no ready artifact/i)
    expect(mergeCount).toBe(1)
  })
})
