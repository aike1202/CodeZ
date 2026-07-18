import type { TodoItem, TodoStatus } from '../../../../shared/types/todo'

export type TodoDisplayStatus = TodoStatus | 'blocked'

const ACTIVE_STATUSES = new Set<TodoDisplayStatus>([
  'in_progress'
])

export function getTodoDisplayStatus(todo: TodoItem, todos: TodoItem[] = []): TodoDisplayStatus {
  return todo.status === 'pending' && getTodoBlockReason(todo, todos) ? 'blocked' : todo.status
}

export function getTodoBlockReason(todo: TodoItem, todos: TodoItem[]): string | undefined {
  if (todo.status !== 'pending') return undefined
  const reasons: string[] = []
  if (todo.requiresApproval && todo.approvalStatus !== 'approved') {
    reasons.push('等待审批')
  }
  const unfinishedDependencies = (todo.blockedBy || []).filter((dependencyId) => {
    const dependency = todos.find((candidate) => candidate.id === dependencyId)
    return !dependency || dependency.status !== 'completed'
  })
  if (unfinishedDependencies.length > 0) {
    const labels = unfinishedDependencies.map((dependencyId) =>
      todos.find((candidate) => candidate.id === dependencyId)?.subject || dependencyId
    )
    reasons.push(`等待: ${labels.join('、')}`)
  }
  return reasons.length > 0 ? reasons.join(' · ') : undefined
}

export function isTodoDisplayActive(status: TodoDisplayStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

export function getTodoStatusLabel(status: TodoDisplayStatus): string {
  switch (status) {
    case 'pending':
      return '待执行'
    case 'blocked':
      return '已阻塞'
    case 'in_progress':
      return '执行中'
    case 'completed':
      return '已完成'
    case 'cancelled':
      return '已取消'
  }
}
