import type { TaskItem } from '../../../../../shared/types/task'

export interface ParsedTaskUpdateDetail {
  task: Partial<TaskItem>
  summary?: string
}

export function parseTaskUpdateDetail(detail?: string): ParsedTaskUpdateDetail | null {
  if (!detail) return null

  try {
    const parsed = JSON.parse(detail)
    const task = parsed?.data?.task
    if (!task || typeof task !== 'object') return null

    return {
      task,
      summary: typeof parsed.data.summary === 'string' ? parsed.data.summary : undefined
    }
  } catch {
    return null
  }
}
