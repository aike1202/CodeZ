import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { getExecutionController } from '../main/services/execution/ExecutionController'
import { ExecutionInspectTool } from '../main/tools/builtin/ExecutionInspectTool'
import { ExecutionControlTool } from '../main/tools/builtin/ExecutionControlTool'
import { authorizeSubAgentToolCall } from '../main/agent/SubAgentManager'

describe('Execution tools and lease enforcement', () => {
  const roots: string[] = []

  afterEach(() => {
    getExecutionController().resetForTests()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function createRunningExecution() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codez-execution-tools-'))
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
    return { root, controller, execution, attempt }
  }

  it('lets the main Agent inspect and stop an execution', async () => {
    const { root, execution, attempt } = createRunningExecution()
    const inspect = new ExecutionInspectTool()
    const control = new ExecutionControlTool()

    const before = JSON.parse(await inspect.execute(
      JSON.stringify({ execution_id: execution.executionId }),
      { workspaceRoot: root, sessionId: 's1' }
    ))
    expect(before.ok).toBe(true)
    expect(before.data.executors[0].status).toBe('running')

    const stopped = JSON.parse(await control.execute(
      JSON.stringify({ execution_id: execution.executionId, action: 'stop_all' }),
      { workspaceRoot: root, sessionId: 's1' }
    ))
    expect(stopped.ok).toBe(true)
    expect(stopped.data.status).toBe('stopped')
    expect(attempt.signal.aborted).toBe(true)
  })

  it('denies a tool call after the main Agent revokes the Executor lease', async () => {
    const { root, controller, execution, attempt } = createRunningExecution()
    controller.stopExecution(execution.executionId)

    const denial = await authorizeSubAgentToolCall(
      'Read',
      { files: [{ file_path: 'README.md' }] },
      root,
      's1',
      undefined,
      undefined,
      attempt.snapshot.executorId,
      attempt.token
    )

    expect(denial).toMatch(/control denied/i)
  })

  it('does not reveal another session execution', async () => {
    const { root, execution } = createRunningExecution()
    const inspect = new ExecutionInspectTool()
    const result = JSON.parse(await inspect.execute(
      JSON.stringify({ execution_id: execution.executionId }),
      { workspaceRoot: root, sessionId: 's2' }
    ))
    expect(result.ok).toBe(false)
  })

  it('accepts a ready artifact through ExecutionControl', async () => {
    const { root, controller, execution, attempt } = createRunningExecution()
    controller.finishExecutor(execution.executionId, 't1', {
      stepId: 't1',
      executorId: attempt.snapshot.executorId,
      attemptId: attempt.token.attemptId,
      status: 'completed',
      summary: 'ready',
      filesModified: []
    })
    controller.registerArtifact(execution.executionId, attempt.snapshot.executorId, async () => null)

    const control = new ExecutionControlTool()
    const result = JSON.parse(await control.execute(
      JSON.stringify({ execution_id: execution.executionId, action: 'accept_completed' }),
      { workspaceRoot: root, sessionId: 's1' }
    ))

    expect(result.ok).toBe(true)
    expect(result.data.status).toBe('completed')
    expect(result.data.executors[0]).toMatchObject({ status: 'completed', artifactStatus: 'merged' })
  })
})
