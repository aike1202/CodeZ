import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'

export class TaskListTool extends Tool {
  get name() {
    return 'TaskList'
  }

  get description() {
    return 'List all tasks in the current session with their status. Use this to review progress before continuing work.'
  }

  get parameters_schema() {
    return { type: 'object', properties: {} }
  }

  async execute(_args: string, context: ToolContext): Promise<string> {
    const store = new TaskStore()
    await store.load()
    const tasks = store.getBySession(context.sessionId || '')

    const counts = { completed: 0, in_progress: 0, pending: 0, cancelled: 0 }
    for (const t of tasks) {
      if (t.status === 'completed') counts.completed++
      else if (t.status === 'in_progress') counts.in_progress++
      else if (t.status === 'cancelled') counts.cancelled++
      else counts.pending++
    }

    const total = tasks.length
    const parts: string[] = []
    parts.push(`${counts.completed}/${total} completed`)
    parts.push(`${counts.in_progress} in progress`)
    parts.push(`${counts.pending} pending`)
    if (counts.cancelled > 0) {
      parts.push(`${counts.cancelled} cancelled`)
    }
    const summary = parts.join(', ')

    return JSON.stringify({ ok: true, data: { tasks, summary } })
  }
}
