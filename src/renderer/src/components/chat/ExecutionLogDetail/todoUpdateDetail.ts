import type { TodoItem } from '../../../../../shared/types/todo'

export interface ParsedTodoUpdateDetail {
  todo: Partial<TodoItem>
  summary?: string
}

const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed', 'cancelled'])

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined
}

export function parseTodoUpdateDetail(detail?: string): ParsedTodoUpdateDetail | null {
  if (!detail) return null

  try {
    const parsed = JSON.parse(detail)
    const todo = parsed?.data?.updated?.[0] ?? parsed?.data?.todo
    if (!todo || typeof todo !== 'object') return null

    return {
      todo: {
        id: optionalString(todo.id),
        subject: optionalString(todo.subject),
        description: optionalString(todo.description),
        status: TODO_STATUSES.has(todo.status) ? todo.status : undefined,
        files: optionalStringArray(todo.files),
        acceptanceCriteria: optionalStringArray(todo.acceptanceCriteria),
        verificationCommand: optionalString(todo.verificationCommand)
      },
      summary: typeof parsed.data.summary === 'string' ? parsed.data.summary : undefined
    }
  } catch {
    return null
  }
}
