import { Tool, type ToolContext } from '../Tool'
import { getExecutionController } from '../../services/execution/ExecutionController'

export class ExecutionInspectTool extends Tool {
  get name() { return 'ExecutionInspect' }

  get summary() { return 'Inspect authoritative parallel Executor state.' }

  get description() {
    return [
      'Inspect authoritative parallel execution state before deciding whether to stop, retry, or take over.',
      'Without execution_id, returns all executions for the current session.',
      'With executor_id, returns only that Executor snapshot including failure, files, worktree, and handoff.'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        execution_id: { type: 'string', description: 'Execution id returned by DelegateTasks.' },
        executor_id: { type: 'string', description: 'Optional logical Executor id.' }
      },
      required: []
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    const sessionId = context.sessionId
    if (!sessionId) return JSON.stringify({ ok: false, error: 'ExecutionInspect requires an active session.' })

    let parsed: { execution_id?: string; executor_id?: string }
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return JSON.stringify({ ok: false, error: 'Invalid JSON arguments for ExecutionInspect.' })
    }

    const controller = getExecutionController()
    controller.restoreSession(context.workspaceRoot, sessionId)
    if (!parsed.execution_id) {
      return JSON.stringify({ ok: true, data: { executions: controller.listSession(sessionId) } })
    }
    const execution = controller.getExecution(parsed.execution_id)
    if (!execution || execution.sessionId !== sessionId) {
      return JSON.stringify({ ok: false, error: `Execution '${parsed.execution_id}' was not found in this session.` })
    }
    if (!parsed.executor_id) return JSON.stringify({ ok: true, data: execution })
    const executor = execution.executors.find((item) => item.executorId === parsed.executor_id)
    if (!executor) {
      return JSON.stringify({ ok: false, error: `Executor '${parsed.executor_id}' was not found.` })
    }
    return JSON.stringify({
      ok: true,
      data: {
        executionId: execution.executionId,
        sessionId: execution.sessionId,
        status: execution.status,
        executor
      }
    })
  }
}
