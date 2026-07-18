import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../shared/types/todo'
import {
  getRemainingTodoCount,
  getTodoDisplayItems
} from '../renderer/src/components/chat/TodoCapsule.order'

const task = (id: string, status: TodoItem['status']): TodoItem => ({
  id,
  status,
  subject: id,
  description: id
})

describe('TodoCapsule task projection', () => {
  it('keeps every task visible in original list order', () => {
    const tasks = [
      task('completed-first', 'completed'),
      task('pending-second', 'pending'),
      task('running-third', 'in_progress'),
      task('cancelled-fourth', 'cancelled'),
      task('pending-fifth', 'pending')
    ]

    expect(getTodoDisplayItems(tasks).map((item) => item.id)).toEqual([
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

    expect(getTodoDisplayItems(tasks)).toEqual(tasks)
    expect(getRemainingTodoCount(tasks)).toBe(0)
  })

  it('counts only pending and in-progress tasks as remaining', () => {
    expect(getRemainingTodoCount([
      task('done', 'completed'),
      task('waiting', 'pending'),
      task('running', 'in_progress'),
      task('stopped', 'cancelled')
    ])).toBe(2)
  })
})
