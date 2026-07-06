import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'

/**
 * 按 id 查询单个 Task 的完整详情。
 *
 * 用于在开始执行前获取某个 Task 的完整描述、依赖关系、当前状态等。
 */
export class TaskGetTool extends Tool {
  get name() {
    return 'TaskGet'
  }

  get summary() {
    return 'Look up a single task by its id.'
  }

  get description() {
    return [
      'Look up a single task by its id, returning full details (subject, description, status, files,',
      'dependencies).',
      '',
      'Use this before starting a task to confirm its scope, or to check the status of a specific task',
      'when the summary from TaskList is not enough.'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task to query (e.g. "t2").'
        }
      },
      required: ['taskId']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    const sessionId = context.sessionId
    if (!sessionId) {
      return JSON.stringify({ ok: false, error: 'TaskGet requires an active session.' })
    }

    let parsed: { taskId?: string }
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return JSON.stringify({ ok: false, error: 'Invalid JSON arguments for TaskGet.' })
    }

    if (!parsed.taskId) {
      return JSON.stringify({ ok: false, error: 'TaskGet requires a `taskId`.' })
    }

    const store = TaskStore.getInstance()
    const task = store.getById(sessionId, parsed.taskId)

    if (!task) {
      return JSON.stringify({
        ok: false,
        error: `Task '${parsed.taskId}' not found. Use TaskList to see valid ids.`
      })
    }

    return JSON.stringify({
      ok: true,
      data: {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        ...(task.files && task.files.length > 0 ? { files: task.files } : {}),
        ...(task.activeForm ? { activeForm: task.activeForm } : {})
      }
    })
  }
}
