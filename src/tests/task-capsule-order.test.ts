import { describe, expect, it } from 'vitest'
import type { TaskItem } from '../shared/types/task'
import { getTaskDisplayTasks } from '../renderer/src/components/chat/TaskCapsule.order'

const task = (id: string, status: TaskItem['status']): TaskItem => ({
  id,
  status,
  subject: id,
  description: id
})

describe('TaskCapsule active task projection', () => {
  it('keeps only pending and in-progress tasks in original list order', () => {
    const tasks = [
      task('completed-first', 'completed'),
      task('pending-second', 'pending'),
      task('running-third', 'in_progress'),
      task('cancelled-fourth', 'cancelled'),
      task('pending-fifth', 'pending')
    ]

    expect(getTaskDisplayTasks(tasks).map((item) => item.id)).toEqual([
      'pending-second',
      'running-third',
      'pending-fifth'
    ])
  })

  it('returns an empty projection when every task is terminal', () => {
    expect(getTaskDisplayTasks([
      task('done', 'completed'),
      task('stopped', 'cancelled')
    ])).toEqual([])
  })
})
