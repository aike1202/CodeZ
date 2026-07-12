import { Tool, type ToolContext } from '../Tool'
import { getExecutionController } from '../../services/execution/ExecutionController'

type ControlArgs = {
  execution_id?: string
  executor_id?: string
  action?: 'stop_executor' | 'stop_all' | 'takeover' | 'resume' | 'restart' | 'accept_completed'
  reason?: string
}

export class ExecutionControlTool extends Tool {
  get name() { return 'ExecutionControl' }

  get summary() { return 'Stop, recover, take over, or accept output from managed Executors.' }

  get description() {
    return [
      'Control an existing parallel execution using the authoritative Runtime controller.',
      'Use stop_executor for one Executor, stop_all for the entire execution, resume to continue durable',
      'child context, restart for a new child context with the saved task, takeover to transfer work,',
      'or accept_completed to merge ready worktree artifacts.',
      'A successful stop revokes the lease before returning, so stale attempts cannot start new tools.'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        execution_id: { type: 'string', description: 'Target execution id.' },
        executor_id: { type: 'string', description: 'Required for per-Executor actions; optional for accept_completed.' },
        action: {
          type: 'string',
          enum: ['stop_executor', 'stop_all', 'takeover', 'resume', 'restart', 'accept_completed'],
          description: 'Control action.'
        },
        reason: { type: 'string', description: 'Optional audit reason.' }
      },
      required: ['execution_id', 'action']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    const sessionId = context.sessionId
    if (!sessionId) return JSON.stringify({ ok: false, error: 'ExecutionControl requires an active session.' })

    let parsed: ControlArgs
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return JSON.stringify({ ok: false, error: 'Invalid JSON arguments for ExecutionControl.' })
    }
    if (!parsed.execution_id || !parsed.action) {
      return JSON.stringify({ ok: false, error: 'execution_id and action are required.' })
    }

    const controller = getExecutionController()
    controller.restoreSession(context.workspaceRoot, sessionId)
    const existing = controller.getExecution(parsed.execution_id)
    if (!existing || existing.sessionId !== sessionId) {
      return JSON.stringify({ ok: false, error: `Execution '${parsed.execution_id}' was not found in this session.` })
    }

    try {
      if (parsed.action === 'resume' || parsed.action === 'restart') {
        return JSON.stringify({
          ok: false,
          error: `${parsed.action} must be executed through the active AgentRunner so current model configuration is available.`
        })
      }
      let snapshot
      if (parsed.action === 'stop_all') {
        snapshot = controller.stopExecution(parsed.execution_id, parsed.reason)
      } else if (parsed.action === 'accept_completed') {
        snapshot = await controller.acceptCompleted(parsed.execution_id, parsed.executor_id)
      } else {
        if (!parsed.executor_id) {
          return JSON.stringify({ ok: false, error: `executor_id is required for ${parsed.action}.` })
        }
        snapshot = parsed.action === 'takeover'
          ? controller.takeover(parsed.execution_id, parsed.executor_id)
          : controller.stopExecutor(parsed.execution_id, parsed.executor_id, parsed.reason)
      }
      return JSON.stringify({ ok: true, data: snapshot })
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
