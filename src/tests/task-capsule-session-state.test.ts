import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskCapsule } from '../renderer/src/components/chat/TaskCapsule'
import type { TaskItem } from '../shared/types/task'

const mockChatState = vi.hoisted(() => ({
  tasks: [] as TaskItem[],
  expandedCapsule: null as 'task' | 'plan' | null,
  setExpandedCapsule: vi.fn()
}))

vi.mock('../renderer/src/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockChatState) => unknown) => selector(mockChatState)
}))

const activeTasks: TaskItem[] = [
  {
    id: 't1',
    subject: 'Keep Task state session-scoped',
    description: 'The store controls visible expansion.',
    status: 'pending'
  }
]

describe('TaskCapsule session state', () => {
  beforeEach(() => {
    mockChatState.tasks = activeTasks
    mockChatState.expandedCapsule = null
    mockChatState.setExpandedCapsule.mockReset()
  })

  it('renders its popover only when the session-scoped task capsule is expanded', () => {
    const collapsed = renderToStaticMarkup(React.createElement(TaskCapsule))
    expect(collapsed).not.toContain('plan-capsule-popover')

    mockChatState.expandedCapsule = 'task'
    const expanded = renderToStaticMarkup(React.createElement(TaskCapsule))
    expect(expanded).toContain('plan-capsule-popover')
    expect(expanded).toContain('Keep Task state session-scoped')
  })
})
