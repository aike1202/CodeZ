import { describe, expect, it } from 'vitest'
import type { TaskItem } from '../shared/types/task'
import {
  getRemainingTaskCount,
  getTaskDisplayTasks
} from '../renderer/src/components/chat/TaskCapsule.order'

const task = (id: string, status: TaskItem['status']): TaskItem => ({
  id,
  status,
  subject: id,
  description: id
})

describe('TaskCapsule task projection', () => {
  it('keeps every task visible in original list order', () => {
    const tasks = [
      task('completed-first', 'completed'),
      task('pending-second', 'pending'),
      task('running-third', 'in_progress'),
      task('cancelled-fourth', 'cancelled'),
      task('pending-fifth', 'pending')
    ]

    expect(getTaskDisplayTasks(tasks).map((item) => item.id)).toEqual([
      'completed-first',
      'pending-second',
      'running-third',
      'cancelled-fourth',
      'pending-fifth'
    ])
  })

  it('keeps terminal tasks visible while reporting zero remaining tasks', () => {
    const tasks = [
      task('done', 'completed'),
      task('stopped', 'cancelled')
    ]

    expect(getTaskDisplayTasks(tasks)).toEqual(tasks)
    expect(getRemainingTaskCount(tasks)).toBe(0)
  })

  it('counts only pending and in-progress tasks as remaining', () => {
    expect(getRemainingTaskCount([
      task('done', 'completed'),
      task('waiting', 'pending'),
      task('running', 'in_progress'),
      task('stopped', 'cancelled')
    ])).toBe(2)
  })
})
