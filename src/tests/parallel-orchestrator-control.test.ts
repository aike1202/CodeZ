import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import { SubAgentManager } from '../main/agent/SubAgentManager'
import { orchestrateParallelExecution } from '../main/agent/AgentRunner/parallelOrchestrator'
import { getExecutionController } from '../main/services/execution/ExecutionController'

describe('parallel orchestrator control authority', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    getExecutionController().resetForTests()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('propagates parent stop to every Executor and returns a stopped report', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codez-orchestrator-stop-'))
    roots.push(root)
    const parent = new AbortController()
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => { startedResolve = resolve })

    vi.spyOn(SubAgentManager, 'spawn').mockImplementation(async (_type, ctx) => {
      startedResolve()
      if (!ctx.parentSignal?.aborted) {
        await new Promise<void>((resolve) => ctx.parentSignal?.addEventListener('abort', () => resolve(), { once: true }))
      }
      return {
        type: 'Executor',
        status: 'interrupted',
        output: 'Stopped by parent.',
        toolCallCount: 0,
        filesExamined: [],
        handoff: {
          reasonCode: 'parent_interrupted',
          reason: 'Stopped by parent.',
          originalTask: ctx.task,
          filesExamined: [],
          filesModified: [],
          filesPossiblyModified: [],
          recentTools: [],
          workspaceMayHaveUntrackedChanges: false,
          canResume: true
        }
      }
    })

    const run = orchestrateParallelExecution(
      [{ id: 't1', title: 'Task 1', description: 'Do work', files: ['src/a.ts'] }],
      new Set(),
      { waves: [{ index: 0, stepIds: ['t1'] }], isolation: 'shared', rationale: '' },
      'shared',
      { source: 'task:s1', onStatusChange: () => undefined },
      {
        workspaceRoot: root,
        sessionId: 's1',
        parentSignal: parent.signal,
        apiConfig: { baseUrl: '', apiKey: '', apiFormat: 'openai', model: 'test' },
        contextCapabilities: {
          contextWindowTokens: 10000,
          maxInputTokens: 8000,
          maxOutputTokens: 2000,
          reasoningCountsAgainstContext: false
        }
      },
      {
        onChunk: () => undefined,
        onDone: () => undefined,
        onError: () => undefined
      }
    )

    await started
    parent.abort('user stopped')
    const report = await run

    expect(report.status).toBe('stopped')
    expect(report.waves[0].results[0].status).toBe('interrupted')
    expect(getExecutionController().getExecution(report.executionId!)?.status).toBe('stopped')
  })

  it('preserves successful siblings as ready artifacts when their wave partially fails', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codez-orchestrator-partial-'))
    roots.push(root)
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    git(['init'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test User'])
    writeFileSync(path.join(root, 'base.txt'), 'base\n', 'utf8')
    git(['add', '-A'])
    git(['commit', '-m', 'base'])
    const statusChanges: Array<{ id: string; status: string }> = []

    vi.spyOn(SubAgentManager, 'spawn').mockImplementation(async (_type, ctx) => {
      const stepId = /^Step ([^:]+):/.exec(ctx.task)?.[1] || 'unknown'
      if (stepId !== 't3') {
        writeFileSync(path.join(ctx.workspaceRoot, `${stepId}.txt`), `${stepId}\n`, 'utf8')
        return {
          type: 'Executor',
          status: 'completed',
          output: `${stepId} complete`,
          structuredOutput: {
            status: 'completed',
            summary: `${stepId} complete`,
            filesModified: [`${stepId}.txt`]
          },
          toolCallCount: 1,
          filesExamined: []
        } as any
      }
      return {
        type: 'Executor',
        status: 'failed',
        output: 't3 failed',
        structuredOutput: {
          status: 'failed',
          summary: 't3 failed',
          filesModified: [],
          blockers: ['test failure']
        },
        toolCallCount: 1,
        filesExamined: []
      } as any
    })

    const report = await orchestrateParallelExecution(
      ['t1', 't2', 't3'].map((id) => ({ id, title: id, description: `Run ${id}`, files: [`${id}.txt`] })),
      new Set(),
      { waves: [{ index: 0, stepIds: ['t1', 't2', 't3'] }], isolation: 'worktree', rationale: '' },
      'worktree',
      {
        source: 'task:s1',
        onStatusChange: (id, status) => { statusChanges.push({ id, status }) }
      },
      {
        workspaceRoot: root,
        sessionId: 's1',
        apiConfig: { baseUrl: '', apiKey: '', apiFormat: 'openai', model: 'test' }
      },
      { onChunk: () => undefined, onDone: () => undefined, onError: () => undefined }
    )

    const controller = getExecutionController()
    const before = controller.getExecution(report.executionId!)!
    expect(report.status).toBe('halted')
    expect(before.status).toBe('decision_required')
    expect(before.executors.filter((executor) => executor.status === 'succeeded')).toHaveLength(2)
    expect(before.executors.filter((executor) => executor.artifactCommit)).toHaveLength(2)
    expect(before.executors.find((executor) => executor.stepId === 't3')?.status).toBe('failed')
    expect(existsSync(path.join(root, 't1.txt'))).toBe(false)
    expect(existsSync(path.join(root, 't2.txt'))).toBe(false)

    const accepted = await controller.acceptCompleted(report.executionId!)
    expect(accepted.executors.filter((executor) => executor.artifactStatus === 'merged')).toHaveLength(2)
    expect(existsSync(path.join(root, 't1.txt'))).toBe(true)
    expect(existsSync(path.join(root, 't2.txt'))).toBe(true)
    expect(statusChanges).toEqual(expect.arrayContaining([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'completed' },
      { id: 't3', status: 'pending' }
    ]))

    const failedExecutor = accepted.executors.find((executor) => executor.stepId === 't3')!
    const retry = controller.startExecutor(report.executionId!, failedExecutor.stepId)
    expect(retry.snapshot.executorId).toBe(failedExecutor.executorId)
    expect(retry.snapshot.attemptCount).toBe(2)
  })
})
