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

  it('renders concurrent Executor runtime states for individual TaskItems', () => {
    const runtimeBase = {
      executionId: 'exec-1',
      executionCreatedAt: 1,
      waveIndex: 0,
      isolation: 'shared' as const,
      attemptCount: 1,
      updatedAt: 2,
    }
    mockChatState.tasks = [
      {
        id: 't1',
        subject: 'Run first Executor',
        description: '',
        status: 'in_progress',
        executorRuntime: {
          ...runtimeBase,
          executorId: 'executor-1',
          status: 'running',
        },
      },
      {
        id: 't2',
        subject: 'Await worktree acceptance',
        description: '',
        status: 'in_progress',
        executorRuntime: {
          ...runtimeBase,
          executorId: 'executor-2',
          status: 'succeeded',
          artifactStatus: 'ready',
        },
      },
      {
        id: 't3',
        subject: 'Show failed Executor',
        description: '',
        status: 'pending',
        executorRuntime: {
          ...runtimeBase,
          executorId: 'executor-3',
          status: 'failed',
          error: 'Provider request failed',
        },
      },
      {
        id: 't4',
        subject: 'Merge accepted artifact',
        description: '',
        status: 'in_progress',
        executorRuntime: {
          ...runtimeBase,
          executorId: 'executor-4',
          isolation: 'worktree',
          status: 'succeeded',
          artifactStatus: 'merging',
        },
      },
    ]
    mockChatState.expandedCapsule = 'task'

    const rendered = renderToStaticMarkup(React.createElement(TaskCapsule))

    expect(rendered).toContain('3 项任务执行中')
    expect(rendered).toContain('执行中')
    expect(rendered).toContain('待接纳')
    expect(rendered).toContain('正在整合')
    expect(rendered).toContain('失败')
    expect(rendered).toContain('Provider request failed')
  })
})
