import type { TaskItem } from '../../../../shared/types/task'

export const getTaskDisplayTasks = (tasks: TaskItem[]): TaskItem[] =>
  tasks

export const getRemainingTaskCount = (tasks: TaskItem[]): number =>
  tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').length
