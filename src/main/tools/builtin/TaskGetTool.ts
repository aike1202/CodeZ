import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'

export class TaskGetTool extends Tool {
  get name() {
    return 'TaskGet'
  }

  get description() {
    return 'Retrieve full details of a task by its ID.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to retrieve.' },
      },
      required: ['taskId'],
    }
  }

  async execute(args: string, _context: ToolContext): Promise<string> {
    let parsed: { taskId: string }
    try {
      parsed = JSON.parse(args)
    } catch {
      return JSON.stringify({
        ok: false,
        error: { code: 'INVALID_JSON', message: 'Failed to parse arguments as JSON.' },
      })
    }

    if (!parsed.taskId || typeof parsed.taskId !== 'string') {
      return JSON.stringify({
        ok: false,
        error: { code: 'MISSING_ARG', message: 'taskId is required and must be a string.' },
      })
    }

    const store = new TaskStore()
    await store.load()
    const task = store.getById(parsed.taskId)

    if (!task) {
      return JSON.stringify({
        ok: false,
        error: { code: 'NOT_FOUND', message: `Task "${parsed.taskId}" not found.` },
      })
    }

    return JSON.stringify({ ok: true, data: task })
  }
}
