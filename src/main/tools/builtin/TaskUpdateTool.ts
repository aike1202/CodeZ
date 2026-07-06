import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'
import type { TaskStatus } from '../../../shared/types/task'

const VALID_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

/**
 * 更新单个 Task 的状态或字段。
 *
 * 推进流程：pending → in_progress → completed。同一时刻至多 1 个 in_progress。
 * 完成一项后立即标 completed，再开始下一项。
 */
export class TaskUpdateTool extends Tool {
  get name() {
    return 'TaskUpdate'
  }

  get description() {
    return [
      'Update a task by id: change its status or edit its fields.',
      '',
      'Rules:',
      '- Progress a task through pending → in_progress → completed.',
      '- Keep at most ONE task in_progress at a time.',
      '- Mark a task completed as soon as it is done, before starting the next.',
      '- If you cannot finish a task, set status to "cancelled".'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The id of the task to update (e.g. "t2").'
        },
        status: {
          type: 'string',
          enum: VALID_STATUSES,
          description: 'New status.'
        },
        subject: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace the declared file set.'
        },
        activeForm: { type: 'string', description: 'New progress-spinner label.' }
      },
      required: ['taskId']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    const sessionId = context.sessionId
    if (!sessionId) {
      return JSON.stringify({ ok: false, error: 'TaskUpdate requires an active session.' })
    }

    let parsed: {
      taskId?: string
      status?: string
      subject?: string
      description?: string
      files?: string[]
      activeForm?: string
    }
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return JSON.stringify({ ok: false, error: 'Invalid JSON arguments for TaskUpdate.' })
    }

    if (!parsed.taskId) {
      return JSON.stringify({ ok: false, error: 'TaskUpdate requires a `taskId`.' })
    }
    if (parsed.status && !VALID_STATUSES.includes(parsed.status as TaskStatus)) {
      return JSON.stringify({
        ok: false,
        error: `Invalid status '${parsed.status}'. Must be one of: ${VALID_STATUSES.join(', ')}.`
      })
    }

    const store = TaskStore.getInstance()
    if (!store.getById(sessionId, parsed.taskId)) {
      return JSON.stringify({ ok: false, error: `Task '${parsed.taskId}' not found.` })
    }

    const updated = store.update(sessionId, parsed.taskId, {
      status: parsed.status as TaskStatus | undefined,
      subject: parsed.subject,
      description: parsed.description,
      files: parsed.files,
      activeForm: parsed.activeForm
    })

    // 单一 in_progress 校验：越界则回滚该次状态变更
    if (parsed.status === 'in_progress' && !store.hasAtMostOneInProgress(sessionId)) {
      store.update(sessionId, parsed.taskId, { status: 'pending' })
      return JSON.stringify({
        ok: false,
        error: 'Another task is already in_progress. Complete or cancel it before starting a new one.'
      })
    }

    return JSON.stringify({
      ok: true,
      data: {
        task: updated ? { id: updated.id, subject: updated.subject, status: updated.status } : null,
        summary: store.summary(sessionId)
      }
    })
  }
}
