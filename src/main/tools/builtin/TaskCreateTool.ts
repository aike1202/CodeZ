import { Tool, ToolContext } from '../Tool'
import { TaskStore } from '../../services/TaskStore'

/**
 * 创建一个或多个轻量 Task（待办）。
 *
 * Task 仅存于会话内存，随会话生命周期存活；模型自主创建，无需用户批准。
 * 适用于"多于 2-3 步、值得追踪进度"的中等任务。简单任务直接做，不要建 Task。
 */
export class TaskCreateTool extends Tool {
  get name() {
    return 'TaskCreate'
  }

  get description() {
    return [
      'Create one or more lightweight tasks (a todo list) for the current session to track multi-step work.',
      '',
      'When to use:',
      '- The work involves more than 2-3 distinct steps worth tracking.',
      '- You want to show the user structured progress.',
      '',
      'When NOT to use:',
      '- A single, trivial change — just do it directly, do not create tasks.',
      '',
      'Each task gets a stable id (t1, t2 ...) you can later reference in TaskUpdate or DelegateTasks.',
      'Tasks start as "pending". Declare `files` if you know which files a task will touch — this enables',
      'parallel delegation with conflict checking.',
      '',
      'Optionally include `title` and `subtitle` at the list level (first task only) — these appear in the',
      'task capsule header and help the user recognize the project context when resuming a session.'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional list-level heading, e.g. "TodoList App Development Tasks". Rendered in the task capsule.'
        },
        subtitle: {
          type: 'string',
          description: 'Optional list-level subheading, e.g. "React + Electron desktop todo app".'
        },
        tasks: {
          type: 'array',
          description: 'The tasks to create, in execution order.',
          items: {
            type: 'object',
            properties: {
              subject: {
                type: 'string',
                description: 'Short imperative title, e.g. "Extract useAuth hook".'
              },
              description: {
                type: 'string',
                description: 'What needs to be done + acceptance criteria.'
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files this task will touch (relative to workspace root). Optional but recommended.'
              },
              activeForm: {
                type: 'string',
                description: 'Present-continuous label for the progress spinner, e.g. "Extracting useAuth hook".'
              }
            },
            required: ['subject']
          }
        }
      },
      required: ['tasks']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    const sessionId = context.sessionId
    if (!sessionId) {
      return JSON.stringify({ ok: false, error: 'TaskCreate requires an active session.' })
    }

    let parsed: { title?: string; subtitle?: string; tasks?: Array<{ subject?: string; description?: string; files?: string[]; activeForm?: string }> }
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return JSON.stringify({ ok: false, error: 'Invalid JSON arguments for TaskCreate.' })
    }

    const items = (parsed.tasks || []).filter(t => t && typeof t.subject === 'string' && t.subject.trim())
    if (items.length === 0) {
      return JSON.stringify({ ok: false, error: 'TaskCreate requires a non-empty `tasks` array with subjects.' })
    }

    const store = TaskStore.getInstance()
    const created = store.create(
      sessionId,
      items.map((t, i) => ({
        subject: t.subject!.trim(),
        description: t.description,
        files: t.files,
        activeForm: t.activeForm,
        // 仅第一项携带 title/subtitle（列表头，不是每个 task 都有）
        ...(i === 0 && parsed.title ? { title: parsed.title } : {}),
        ...(i === 0 && parsed.subtitle ? { subtitle: parsed.subtitle } : {}),
      }))
    )

    return JSON.stringify({
      ok: true,
      data: {
        created: created.slice(-items.length).map(t => ({ id: t.id, subject: t.subject, status: t.status })),
        summary: store.summary(sessionId)
      }
    })
  }
}
