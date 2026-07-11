import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ExecutionLogDetail from '../renderer/src/components/chat/ExecutionLogDetail'
import type { UnifiedTimelineItem } from '../renderer/src/components/chat/ExecutionLog/utils'

describe('TaskUpdate structured detail rendering', () => {
  it('renders the complete terminal task snapshot in the expandable detail', () => {
    const item: UnifiedTimelineItem = {
      id: 'task-t1',
      type: 'tool',
      timestamp: 100,
      status: 'success',
      verb: 'Executed',
      target: '完成任务：Lifecycle task',
      args: JSON.stringify({ taskId: 't1', status: 'completed' }),
      detail: JSON.stringify({
        ok: true,
        data: {
          task: {
            id: 't1',
            subject: 'Lifecycle task',
            description: 'Retain terminal detail',
            status: 'completed',
            files: ['src/task.ts'],
            acceptanceCriteria: ['Capsule hides terminal tasks'],
            verificationCommand: 'npm test'
          },
          summary: '1/1 completed'
        }
      }),
      toolName: 'TaskUpdate'
    }

    const html = renderToStaticMarkup(React.createElement(ExecutionLogDetail, { item }))

    expect(html).toContain('最终状态')
    expect(html).toContain('已完成')
    expect(html).toContain('Retain terminal detail')
    expect(html).toContain('src/task.ts')
    expect(html).toContain('Capsule hides terminal tasks')
    expect(html).toContain('npm test')
  })
})
