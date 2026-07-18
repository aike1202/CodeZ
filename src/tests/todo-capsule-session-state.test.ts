import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoCapsule } from '../renderer/src/components/chat/TodoCapsule'
import type { TodoItem } from '../shared/types/todo'

const mockChatState = vi.hoisted(() => ({
  todos: [] as TodoItem[],
  expandedCapsule: null as 'todo' | 'plan' | null,
  setExpandedCapsule: vi.fn()
}))

vi.mock('../renderer/src/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockChatState) => unknown) => selector(mockChatState)
}))

const activeTasks: TodoItem[] = [
  {
    id: 't1',
    subject: 'Keep Todo state session-scoped',
    description: 'The store controls visible expansion.',
    status: 'pending'
  }
]

describe('TodoCapsule session state', () => {
  beforeEach(() => {
    mockChatState.todos = activeTasks
    mockChatState.expandedCapsule = null
    mockChatState.setExpandedCapsule.mockReset()
  })

  it('renders its popover only when the session-scoped task capsule is expanded', () => {
    const collapsed = renderToStaticMarkup(React.createElement(TodoCapsule))
    expect(collapsed).not.toContain('plan-capsule-popover')

    mockChatState.expandedCapsule = 'todo'
    const expanded = renderToStaticMarkup(React.createElement(TodoCapsule))
    expect(expanded).toContain('plan-capsule-popover')
    expect(expanded).toContain('Keep Todo state session-scoped')
  })

  it('renders Todo status from stored state', () => {
    mockChatState.todos = [
      {
        id: 't1',
        subject: 'Implement the active Todo',
        description: '',
        status: 'in_progress',
      },
      {
        id: 't2',
        subject: 'Keep the next Todo pending',
        description: '',
        status: 'pending',
      },
    ]
    mockChatState.expandedCapsule = 'todo'

    const rendered = renderToStaticMarkup(React.createElement(TodoCapsule))

    expect(rendered).toContain('Implement the active Todo')
    expect(rendered).toContain('执行中')
    expect(rendered).toContain('待执行')
  })

  it('renders dependency and approval blockers separately from ready tasks', () => {
    mockChatState.todos = [
      {
        id: 't1',
        subject: 'Complete prerequisite',
        description: '',
        status: 'pending',
      },
      {
        id: 't2',
        subject: 'Run dependent task',
        description: '',
        status: 'pending',
        blockedBy: ['t1'],
        requiresApproval: true,
        approvalStatus: 'pending',
      },
    ]
    mockChatState.expandedCapsule = 'todo'

    const rendered = renderToStaticMarkup(React.createElement(TodoCapsule))

    expect(rendered).toContain('已阻塞')
    expect(rendered).toContain('等待审批 · 等待: Complete prerequisite')
  })
})
