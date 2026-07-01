import { Tool, ToolContext } from '../Tool'
import { TaskStore, TaskData } from '../../services/TaskStore'
import { notifyTaskUpsert } from '../../ipc/task.handlers'

interface TaskUpdateArgs {
  taskId: string
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  subject?: string
  description?: string
  blocks?: string[]
  blockedBy?: string[]
}

export class TaskUpdateTool extends Tool {
  get name() {
    return 'TaskUpdate'
  }

  get description() {
    return 'Update a task status or description. Status flow: pending → in_progress → completed (or cancelled). Only one task in_progress at a time.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The ID of the task to update.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          description: 'New status for the task.',
        },
        subject: {
          type: 'string',
          description: 'New subject/title for the task.',
        },
        description: {
          type: 'string',
          description: 'New description for the task.',
        },
        blocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that this task blocks (replaces entire list).',
        },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that block this task (replaces entire list).',
        },
      },
      required: ['taskId'],
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    let parsed: TaskUpdateArgs
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
        error: {
          code: 'NOT_FOUND',
          message: `Task "${parsed.taskId}" not found.`,
        },
      })
    }

    // --- Status validation ---
    if (parsed.status) {
      // Check: cannot set in_progress if another task is already in_progress
      if (parsed.status === 'in_progress') {
        const sessionTasks = store.getBySession(task.sessionId)
        const alreadyInProgress = sessionTasks.find(
          (t) => t.id !== parsed.taskId && t.status === 'in_progress',
        )
        if (alreadyInProgress) {
          return JSON.stringify({
            ok: false,
            error: {
              code: 'ALREADY_IN_PROGRESS',
              message: `Task "${alreadyInProgress.id}" (${alreadyInProgress.subject}) is already in_progress. Complete or cancel it first.`,
            },
          })
        }
      }

      // Check: cannot complete if blocked by unfinished tasks
      if (parsed.status === 'completed') {
        const unfinishedBlockers = (task.blockedBy || [])
          .map((id) => store.getById(id))
          .filter(
            (t): t is TaskData =>
              !!t && t.status !== 'completed' && t.status !== 'cancelled',
          )
        if (unfinishedBlockers.length > 0) {
          return JSON.stringify({
            ok: false,
            error: {
              code: 'BLOCKED',
              message: `Cannot complete: blocked by ${unfinishedBlockers.map((t) => `"${t.id}" (${t.subject}, ${t.status})`).join(', ')}.`,
            },
          })
        }
      }

      // Cancellation: auto-remove all blocks relationships
      if (parsed.status === 'cancelled') {
        for (const blockedId of [...task.blocks]) {
          await store.removeDependency(blockedId, task.id).catch(() => {})
        }
      }

      task.status = parsed.status
    }

    // --- Field updates ---
    if (parsed.subject !== undefined) {
      task.subject = parsed.subject.trim()
    }
    if (parsed.description !== undefined) {
      task.description = parsed.description.trim()
    }

    // --- Replace dependency lists if provided ---
    if (parsed.blocks !== undefined) {
      // Remove old blocks relationships
      for (const oldId of task.blocks) {
        await store.removeDependency(oldId, task.id).catch(() => {})
      }
      task.blocks = []
      // Add new blocks relationships
      for (const blockedId of parsed.blocks) {
        await store.addDependency(blockedId, task.id).catch(() => {})
      }
    }

    if (parsed.blockedBy !== undefined) {
      // Remove old blockedBy relationships
      for (const oldId of task.blockedBy) {
        await store.removeDependency(task.id, oldId).catch(() => {})
      }
      task.blockedBy = []
      // Add new blockedBy relationships
      for (const blockerId of parsed.blockedBy) {
        await store.addDependency(task.id, blockerId).catch(() => {})
      }
    }

    task.updatedAt = new Date().toISOString()
    await store.save(task)

    // Notify frontend
    try {
      notifyTaskUpsert(task)
    } catch {
      // Non-fatal: frontend may not be available in tests
    }

    return JSON.stringify({ ok: true, data: task })
  }
}
