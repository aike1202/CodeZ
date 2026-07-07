import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'

/**
 * 列出当前会话的全部 Task 及汇总。
 *
 * 用于回顾已完成/待办、避免重复创建、确认下一步该做什么。
 */
export class TaskListTool extends Tool {
  get name() {
    return 'TaskList'
  }

  get summary() {
    return 'List all tasks with progress summary.'
  }

  get description() {
    return [
      'List all tasks for the current session with a progress summary.',
      'Use this to review what is done, in progress, and pending before deciding the next step,',
      'or to look up task ids before calling TaskUpdate / DelegateTasks.'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {},
      required: []
    }
  }

  async execute(_args: string, context: ToolContext): Promise<string> {
    const sessionId = context.sessionId
    if (!sessionId) {
      return JSON.stringify({ ok: false, error: 'TaskList requires an active session.' })
    }

    const store = TaskStore.getInstance()
    const tasks = store.list(sessionId)

    return JSON.stringify({
      ok: true,
      data: {
        tasks: tasks.map(t => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          ...(t.groupId ? { groupId: t.groupId } : {}),
          ...(t.groupTitle ? { groupTitle: t.groupTitle } : {}),
          ...(t.riskLevel ? { riskLevel: t.riskLevel } : {}),
          ...(t.requiresApproval !== undefined ? { requiresApproval: t.requiresApproval } : {}),
          ...(t.approvalStatus ? { approvalStatus: t.approvalStatus } : {}),
          ...(t.files && t.files.length > 0 ? { files: t.files } : {})
        })),
        summary: store.summary(sessionId)
      }
    })
  }
}
