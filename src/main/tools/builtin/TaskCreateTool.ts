import { Tool, ToolContext } from '../Tool'
import { TaskStore, TaskData } from '../../services/TaskStore'
import { notifyTaskUpsert } from '../../ipc/task.handlers'

interface TaskCreateArgs {
  subject: string
  description: string
  blockedBy?: string[]
}

export class TaskCreateTool extends Tool {
  get name(): string {
    return 'TaskCreate'
  }

  get description(): string {
    return 'Create a new task in the session task list to track progress during complex multi-step work. Tasks are visible to the user in a task panel.'
  }

  get parameters_schema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Short title for the task' },
        description: { type: 'string', description: 'Details of what this task involves' },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of task IDs that must be completed before this one can start.',
        },
      },
      required: ['subject', 'description'],
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    let parsed: TaskCreateArgs
    try {
      parsed = JSON.parse(args)
    } catch {
      return JSON.stringify({
        ok: false,
        error: { code: 'INVALID_JSON', message: 'Failed to parse arguments as JSON.' },
      })
    }

    if (!parsed.subject || !parsed.subject.trim()) {
      return JSON.stringify({
        ok: false,
        error: { code: 'MISSING_SUBJECT', message: 'subject is required and cannot be empty.' },
      })
    }

    const now = new Date().toISOString()
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const task: TaskData = {
      id: taskId,
      sessionId: context.sessionId || 'unknown',
      subject: parsed.subject.trim(),
      description: (parsed.description || '').trim(),
      status: 'pending',
      blocks: [],
      blockedBy: parsed.blockedBy || [],
      owner: 'main-agent',
      createdAt: now,
      updatedAt: now,
    }

    const store = new TaskStore()
    await store.load()
    await store.save(task)

    // Establish reverse dependencies for each blockedBy entry
    if (parsed.blockedBy && parsed.blockedBy.length > 0) {
      for (const blockerId of parsed.blockedBy) {
        try {
          await store.addDependency(taskId, blockerId)
        } catch {
          // Non-fatal: dependency may reference a task that does not exist yet
        }
      }
    }

    try {
      notifyTaskUpsert(task)
    } catch {
      // Non-fatal: notification failure should not break task creation
    }

    return JSON.stringify({
      ok: true,
      data: { taskId: task.id, subject: task.subject, status: task.status },
    })
  }
}
