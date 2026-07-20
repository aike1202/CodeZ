import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LogItemRow } from '../renderer/src/components/chat/ExecutionLog/components/LogItemRow'
import { buildUnifiedTimeline } from '../renderer/src/components/chat/ExecutionLog/utils'
import type { ExecutionTimelineItem } from '../renderer/src/stores/chatStore'

function todoTool(
  name: 'TodoCreate' | 'TodoUpdate',
  args: Record<string, unknown>,
  result: Record<string, unknown>
): ExecutionTimelineItem {
  return {
    id: `timeline-${name}`,
    type: 'tool',
    toolCall: {
      id: `tool-${name}`,
      name,
      args: JSON.stringify(args),
      status: 'success',
      result: JSON.stringify(result),
      startedAt: 100,
      completedAt: 200,
      sequence: 0,
    },
    startedAt: 100,
    updatedAt: 200,
    sequence: 0,
  }
}

describe('Todo execution log actions', () => {
  it('uses the Todo group title for creation and supports the current top-level receipt', () => {
    const [item] = buildUnifiedTimeline([todoTool(
      'TodoCreate',
      {
        items: [{
          subject: 'Map repository structure',
          groupTitle: 'Repository onboarding',
        }],
      },
      {
        created: [{
          id: 'todo-1',
          subject: 'Map repository structure',
          status: 'pending',
        }],
      },
    )], [], [], undefined, false)

    expect(item.target).toBe('创建代办：Repository onboarding')
  })

  it('uses the TodoItem title for an in-progress update', () => {
    const [item] = buildUnifiedTimeline([todoTool(
      'TodoUpdate',
      { updates: [{ todoId: 'todo-1', status: 'in_progress' }] },
      {
        updated: [{
          id: 'todo-1',
          subject: 'Map repository structure',
          status: 'in_progress',
        }],
      },
    )], [], [], undefined, false)

    expect(item.target).toBe('开始 Map repository structure')

    const html = renderToStaticMarkup(React.createElement(LogItemRow, {
      item,
      isLast: true,
      isItemExpanded: false,
      hasItemDetail: true,
      toggleItemExpand: () => undefined,
    }))

    expect(html).toContain('开始 Map repository structure')
    expect(html).not.toContain('已执行')
    expect(html).toContain('role="button"')
    expect(html).toContain('展开或收起右上角 Todo 列表')
  })

  it('keeps compatibility with legacy data-wrapped Todo receipts', () => {
    const [item] = buildUnifiedTimeline([todoTool(
      'TodoUpdate',
      { updates: [{ todoId: 'todo-1', status: 'completed' }] },
      {
        data: {
          updated: [{
            id: 'todo-1',
            subject: 'Map repository structure',
            status: 'completed',
          }],
        },
      },
    )], [], [], undefined, false)

    expect(item.target).toBe('完成待办：Map repository structure')
  })
})
