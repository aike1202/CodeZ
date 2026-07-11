import type { TaskItem } from '../../../../../shared/types/task'

export interface ParsedTaskUpdateDetail {
  task: Partial<TaskItem>
  summary?: string
}

const TASK_STATUSES = new Set<TaskItem['status']>(['pending', 'in_progress', 'completed', 'cancelled'])

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined
}

export function parseTaskUpdateDetail(detail?: string): ParsedTaskUpdateDetail | null {
  if (!detail) return null

  try {
    const parsed = JSON.parse(detail)
    const task = parsed?.data?.task
    if (!task || typeof task !== 'object') return null

    return {
      task: {
        id: optionalString(task.id),
        subject: optionalString(task.subject),
        description: optionalString(task.description),
        status: TASK_STATUSES.has(task.status) ? task.status : undefined,
        files: optionalStringArray(task.files),
        acceptanceCriteria: optionalStringArray(task.acceptanceCriteria),
        verificationCommand: optionalString(task.verificationCommand)
      },
      summary: typeof parsed.data.summary === 'string' ? parsed.data.summary : undefined
    }
  } catch {
    return null
  }
}
