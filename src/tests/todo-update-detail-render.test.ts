import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ExecutionLogDetail from '../renderer/src/components/chat/ExecutionLogDetail'
import type { UnifiedTimelineItem } from '../renderer/src/components/chat/ExecutionLog/utils'

describe('TodoUpdate structured detail rendering', () => {
  it('renders the complete terminal Todo snapshot in the expandable detail', () => {
    const item: UnifiedTimelineItem = {
      id: 'todo-t1',
      type: 'tool',
      timestamp: 100,
      status: 'success',
      verb: 'Executed',
      target: '完成待办：Lifecycle Todo',
      args: JSON.stringify({ todoId: 't1', status: 'completed' }),
      detail: JSON.stringify({
        ok: true,
        data: {
          updated: [{
            id: 't1',
            subject: 'Lifecycle Todo',
            description: 'Retain terminal detail',
            status: 'completed',
            files: ['src/todo.ts'],
            acceptanceCriteria: ['Capsule hides terminal Todos'],
            verificationCommand: 'npm test'
          }],
          summary: '1/1 completed'
        }
      }),
      toolName: 'TodoUpdate'
    }

    const html = renderToStaticMarkup(React.createElement(ExecutionLogDetail, { item }))

    expect(html).toContain('最终状态')
    expect(html).toContain('已完成')
    expect(html).toContain('Retain terminal detail')
    expect(html).toContain('src/todo.ts')
    expect(html).toContain('Capsule hides terminal Todos')
    expect(html).toContain('npm test')
  })
})
