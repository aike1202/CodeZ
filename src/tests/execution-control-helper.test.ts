import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import { handleExecutionControl } from '../main/agent/AgentRunner/executionControlHelper'
import { SubAgentManager, type SubAgentContext, type SubAgentResult } from '../main/agent/SubAgentManager'
import { getExecutionController } from '../main/services/execution/ExecutionController'

const callbacks = {
  onChunk: () => undefined,
  onDone: () => undefined,
  onError: () => undefined
}

const config = (workspaceRoot: string) => ({
  workspaceRoot,
  sessionId: 's1',
  providerId: 'provider-test',
  baseUrl: '',
  apiKey: '',
  apiFormat: 'openai',
  model: 'test',
  contextCapabilities: {
    contextWindowTokens: 10000,
    maxInputTokens: 8000,
    maxOutputTokens: 2000,
    reasoningCountsAgainstContext: false
  }
})

describe('ExecutionControl recovery', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    getExecutionController().resetForTests()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function failedExecution(canResume: boolean) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codez-execution-recovery-'))
    roots.push(root)
    const controller = getExecutionController()
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'shared',
      rationale: '',
      executorDefinitions: {
        t1: { task: 'Implement t1', context: 'Known context', assignedFiles: ['src/a.ts'] }
      }
    })
    const attempt = controller.startExecutor(execution.executionId, 't1')
    controller.finishExecutor(execution.executionId, 't1', {
      stepId: 't1',
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: canResume ? 'interrupted' : 'failed',
      summary: 'not complete',
      filesModified: [],
      handoff: {
        reasonCode: canResume ? 'parent_interrupted' : 'protocol_failure',
        reason: 'not complete',
        originalTask: 'Implement t1',
        filesExamined: [],
        filesModified: [],
        filesPossiblyModified: [],
        recentTools: [],
        workspaceMayHaveUntrackedChanges: false,
        canResume
      }
    })
    controller.markExecutionTerminal(execution.executionId, 'halted')
    return { root, controller, execution, executorId: attempt.snapshot.executorId }
  }

  it('restarts a failed logical Executor as a new attempt', async () => {
    const setup = failedExecution(false)
    let spawnedContext: SubAgentContext | undefined
    vi.spyOn(SubAgentManager, 'spawn').mockImplementation(async (_type, ctx): Promise<SubAgentResult> => {
      spawnedContext = ctx
      return {
        type: 'Executor',
        status: 'completed',
        output: 'done',
        structuredOutput: { status: 'completed', summary: 'done', filesModified: ['src/a.ts'] } as any,
        toolCallCount: 1,
        filesExamined: []
      }
    })

    const response = await handleExecutionControl(
      'tool-1',
      JSON.stringify({ execution_id: setup.execution.executionId, executor_id: setup.executorId, action: 'restart' }),
      config(setup.root),
      callbacks
    )
    const content = JSON.parse(response.content)

    expect(content.ok).toBe(true)
    expect(spawnedContext?.resumeSubAgentId).toBeUndefined()
    expect(spawnedContext?.providerId).toBe('provider-test')
    expect(spawnedContext?.controlToken?.attemptId).toBeTruthy()
    expect(spawnedContext?.permissionScope).toMatchObject({
      allowedWriteFiles: ['src/a.ts'],
      allowBash: true
    })
    expect(setup.controller.getExecution(setup.execution.executionId)?.executors[0].attemptCount).toBe(2)
    expect(setup.controller.getExecution(setup.execution.executionId)?.status).toBe('completed')
  })

  it('resumes the existing durable SubAgent scope when handoff permits it', async () => {
    const setup = failedExecution(true)
    let spawnedContext: SubAgentContext | undefined
    vi.spyOn(SubAgentManager, 'spawn').mockImplementation(async (_type, ctx): Promise<SubAgentResult> => {
      spawnedContext = ctx
      return {
        type: 'Executor',
        status: 'completed',
        output: 'resumed',
        structuredOutput: { status: 'completed', summary: 'resumed', filesModified: [] } as any,
        toolCallCount: 1,
        filesExamined: []
      }
    })

    const response = await handleExecutionControl(
      'tool-2',
      JSON.stringify({ execution_id: setup.execution.executionId, executor_id: setup.executorId, action: 'resume' }),
      config(setup.root),
      callbacks
    )

    expect(JSON.parse(response.content).ok).toBe(true)
    expect(spawnedContext?.resumeSubAgentId).toBe(setup.executorId)
    expect(spawnedContext?.subAgentId).toBe(setup.executorId)
    expect(spawnedContext?.providerId).toBe('provider-test')
  })

  it('rejects restart when the durable context can be resumed', async () => {
    const setup = failedExecution(true)
    const spawn = vi.spyOn(SubAgentManager, 'spawn')

    const response = await handleExecutionControl(
      'tool-resumable-restart',
      JSON.stringify({
        execution_id: setup.execution.executionId,
        executor_id: setup.executorId,
        action: 'restart'
      }),
      config(setup.root),
      callbacks
    )

    expect(JSON.parse(response.content)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Use resume')
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(setup.controller.getExecution(setup.execution.executionId)?.executors[0].attemptCount).toBe(1)
  })

  it('resumes the same child context after a restart attempt is stopped', async () => {
    const setup = failedExecution(false)
    const parent = new AbortController()
    const contexts: SubAgentContext[] = []
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => { startedResolve = resolve })

    vi.spyOn(SubAgentManager, 'spawn').mockImplementation(async (_type, ctx): Promise<SubAgentResult> => {
      contexts.push(ctx)
      if (contexts.length === 1) {
        startedResolve()
        if (!ctx.parentSignal?.aborted) {
          await new Promise<void>((resolve) =>
            ctx.parentSignal?.addEventListener('abort', () => resolve(), { once: true }))
        }
        return {
          type: 'Executor',
          status: 'interrupted',
          output: 'Stopped while recovering.',
          toolCallCount: 3,
          filesExamined: ['src/a.ts'],
          handoff: {
            reasonCode: 'parent_interrupted',
            reason: 'Stopped while recovering.',
            originalTask: ctx.task,
            filesExamined: ['src/a.ts'],
            filesModified: [],
            filesPossiblyModified: [],
            recentTools: [],
            workspaceMayHaveUntrackedChanges: false,
            canResume: true
          }
        }
      }
      return {
        type: 'Executor',
        status: 'completed',
        output: 'resumed',
        structuredOutput: { status: 'completed', summary: 'resumed', filesModified: [] } as any,
        toolCallCount: 1,
        filesExamined: ['src/a.ts']
      }
    })

    const restarting = handleExecutionControl(
      'tool-restart-interrupted',
      JSON.stringify({
        execution_id: setup.execution.executionId,
        executor_id: setup.executorId,
        action: 'restart'
      }),
      config(setup.root),
      callbacks,
      parent.signal
    )
    await started
    parent.abort('user stopped')
    expect(JSON.parse((await restarting).content).ok).toBe(false)

    const interrupted = setup.controller.getExecution(setup.execution.executionId)!.executors[0]
    expect(interrupted).toMatchObject({
      status: 'stopped',
      handoff: { reasonCode: 'parent_interrupted', canResume: true }
    })
    expect(interrupted.subAgentId).not.toBe(setup.executorId)

    const resumed = await handleExecutionControl(
      'tool-resume-after-stop',
      JSON.stringify({
        execution_id: setup.execution.executionId,
        executor_id: setup.executorId,
        action: 'resume'
      }),
      config(setup.root),
      callbacks
    )

    expect(JSON.parse(resumed.content).ok).toBe(true)
    expect(contexts[1].subAgentId).toBe(interrupted.subAgentId)
    expect(contexts[1].resumeSubAgentId).toBe(interrupted.subAgentId)
    expect(setup.controller.getExecution(setup.execution.executionId)?.status).toBe('completed')
  })

  it('accepts ready artifacts without requiring an Executor id', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codez-execution-accept-'))
    roots.push(root)
    const controller = getExecutionController()
    const execution = controller.createExecution({
      workspaceRoot: root,
      sessionId: 's1',
      source: 'task:s1',
      waves: [{ index: 0, stepIds: ['t1'] }],
      isolation: 'worktree',
      rationale: ''
    })
    const attempt = controller.startExecutor(execution.executionId, 't1')
    controller.finishExecutor(execution.executionId, 't1', {
      stepId: 't1',
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: 'completed',
      summary: 'ready',
      filesModified: []
    })
    controller.registerArtifact(execution.executionId, attempt.snapshot.executorId, async () => null)

    const response = await handleExecutionControl(
      'tool-3',
      JSON.stringify({ execution_id: execution.executionId, action: 'accept_completed' }),
      config(root),
      callbacks
    )
    const content = JSON.parse(response.content)

    expect(content.ok).toBe(true)
    expect(content.data.status).toBe('completed')
    expect(content.data.executors[0]).toMatchObject({ status: 'completed', artifactStatus: 'merged' })
  })
})
