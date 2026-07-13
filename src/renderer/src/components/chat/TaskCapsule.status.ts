import type { ExecutorRuntimeStatus } from '../../../../shared/types/parallel'
import type { TaskItem, TaskStatus } from '../../../../shared/types/task'

export type TaskDisplayStatus = TaskStatus | ExecutorRuntimeStatus | 'integrating'

const ACTIVE_STATUSES = new Set<TaskDisplayStatus>([
  'in_progress',
  'running',
  'paused',
  'stopping',
  'succeeded',
  'taken_over',
  'integrating',
])

export function getTaskDisplayStatus(task: TaskItem): TaskDisplayStatus {
  if (task.status === 'completed' || task.status === 'cancelled') return task.status
  if (!task.executorRuntime || task.executorRuntime.detached) return task.status
  if (task.executorRuntime.artifactStatus === 'merging') return 'integrating'
  if (task.executorRuntime.status === 'completed') {
    return task.executorRuntime.isolation === 'worktree' &&
      task.executorRuntime.artifactStatus !== 'merged'
      ? 'integrating'
      : 'completed'
  }
  return task.executorRuntime.status
}

export function isTaskDisplayActive(status: TaskDisplayStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

export function getTaskStatusLabel(status: TaskDisplayStatus): string {
  switch (status) {
    case 'pending':
    case 'queued':
      return '待执行'
    case 'in_progress':
    case 'running':
      return '执行中'
    case 'paused':
      return '已暂停'
    case 'stopping':
      return '正在停止'
    case 'succeeded':
      return '待接纳'
    case 'integrating':
      return '正在整合'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'interrupted':
      return '已中断'
    case 'lost':
      return '运行时丢失'
    case 'stopped':
      return '已停止'
    case 'taken_over':
      return '主 Agent 接管'
    case 'cancelled':
      return '已取消'
  }
}
