import type { TaskItem, TaskStatus } from '../../../../shared/types/task'

export type TaskDisplayStatus = TaskStatus | 'blocked'

const ACTIVE_STATUSES = new Set<TaskDisplayStatus>([
  'in_progress'
])

export function getTaskDisplayStatus(task: TaskItem, tasks: TaskItem[] = []): TaskDisplayStatus {
  return task.status === 'pending' && getTaskBlockReason(task, tasks) ? 'blocked' : task.status
}

export function getTaskBlockReason(task: TaskItem, tasks: TaskItem[]): string | undefined {
  if (task.status !== 'pending') return undefined
  const reasons: string[] = []
  if (task.requiresApproval && task.approvalStatus !== 'approved') {
    reasons.push('等待审批')
  }
  const unfinishedDependencies = (task.blockedBy || []).filter((dependencyId) => {
    const dependency = tasks.find((candidate) => candidate.id === dependencyId)
    return !dependency || dependency.status !== 'completed'
  })
  if (unfinishedDependencies.length > 0) {
    const labels = unfinishedDependencies.map((dependencyId) =>
      tasks.find((candidate) => candidate.id === dependencyId)?.subject || dependencyId
    )
    reasons.push(`等待: ${labels.join('、')}`)
  }
  return reasons.length > 0 ? reasons.join(' · ') : undefined
}

export function isTaskDisplayActive(status: TaskDisplayStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

export function getTaskStatusLabel(status: TaskDisplayStatus): string {
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
