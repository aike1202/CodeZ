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

  it('renders Todo status without deriving it from Executor state', () => {
    mockChatState.tasks = [
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
    mockChatState.expandedCapsule = 'task'

    const rendered = renderToStaticMarkup(React.createElement(TaskCapsule))

    expect(rendered).toContain('Implement the active Todo')
    expect(rendered).toContain('执行中')
    expect(rendered).toContain('待执行')
  })

  it('renders dependency and approval blockers separately from ready tasks', () => {
    mockChatState.tasks = [
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
    mockChatState.expandedCapsule = 'task'

    const rendered = renderToStaticMarkup(React.createElement(TaskCapsule))

    expect(rendered).toContain('已阻塞')
    expect(rendered).toContain('等待审批 · 等待: Complete prerequisite')
  })
})
