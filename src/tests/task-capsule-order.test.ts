import { describe, expect, it } from 'vitest'
import type { TaskItem } from '../shared/types/task'
import { getTaskDisplayTasks } from '../renderer/src/components/chat/TaskCapsule.order'

const task = (id: string, status: TaskItem['status']): TaskItem => ({
  id,
  status,
  subject: id,
  description: id
})

describe('TaskCapsule display order', () => {
  it('keeps tasks in their original list order regardless of status', () => {
    const tasks = [
      task('completed-first', 'completed'),
      task('pending-second', 'pending'),
      task('running-third', 'in_progress'),
      task('cancelled-fourth', 'cancelled')
    ]

    expect(getTaskDisplayTasks(tasks).map((item) => item.id)).toEqual([
      'completed-first',
      'pending-second',
      'running-third',
      'cancelled-fourth'
    ])
  })
})
