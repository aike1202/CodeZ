import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LogItemRow } from '../renderer/src/components/chat/ExecutionLog/components/LogItemRow'
import {
  buildSummaryText,
  buildUnifiedTimeline
} from '../renderer/src/components/chat/ExecutionLog/utils'
import { applyCompactionTimelineUpdate } from '../renderer/src/stores/chatStore/slices/messageSlice'
import type { ChatMessage, CompactionTimelineItem } from '../renderer/src/stores/chatStore'

describe('chat compaction execution timeline', () => {
  it('records automatic compaction as an execution-log item without changing reasoning', () => {
    const message: ChatMessage = {
      id: 'agent-1',
      role: 'agent',
      content: '',
      reasoningContent: '已有思考内容'
    }

    const updated = applyCompactionTimelineUpdate(message, {
      status: 'running',
      trigger: 'auto_threshold',
      tokensBefore: 120_000
    }, 100, 'compaction-1')

    expect(updated.reasoningContent).toBe('已有思考内容')
    expect(updated.executionTimeline).toHaveLength(1)
    expect(updated.executionTimeline?.[0]).toMatchObject({
      id: 'compaction-1',
      type: 'compaction',
      status: 'running'
    })
    expect(updated.executionTimeline?.some((item) => item.type === 'reasoning')).toBe(false)

    const unified = buildUnifiedTimeline(updated.executionTimeline || [], [], [], undefined, true)
    expect(unified[0]).toMatchObject({
      type: 'compaction',
      status: 'running',
      target: '正在自动压缩上下文（压缩前 120,000 tokens）'
    })
    expect(buildSummaryText(unified, true)).toBe('正在自动压缩上下文（压缩前 120,000 tokens）')
    expect(buildSummaryText([
      ...unified,
      {
        id: 'reasoning-1',
        type: 'reasoning',
        timestamp: 101,
        status: 'running',
        verb: 'Thought',
        target: '思考中...'
      }
    ], true)).toBe('运行中...')

    const html = renderToStaticMarkup(React.createElement(LogItemRow, {
      item: unified[0],
      isLast: true,
      isItemExpanded: false,
      hasItemDetail: false,
      toggleItemExpand: () => undefined
    }))
    expect(html).toContain('正在自动压缩上下文')
    expect(html).not.toContain('思考')
  })

  it('updates the same item when compaction completes', () => {
    const initial: ChatMessage = { id: 'agent-1', role: 'agent', content: '' }
    const running = applyCompactionTimelineUpdate(initial, {
      status: 'running',
      trigger: 'provider_overflow',
      tokensBefore: 150_000
    }, 100, 'compaction-1')
    const completed = applyCompactionTimelineUpdate(running, {
      status: 'completed',
      trigger: 'provider_overflow',
      tokensBefore: 150_000,
      tokensAfter: 24_000
    }, 200, 'unused-id')

    expect(completed.executionTimeline).toHaveLength(1)
    expect(completed.executionTimeline?.[0]).toMatchObject({
      id: 'compaction-1',
      type: 'compaction',
      status: 'success',
      tokensBefore: 150_000,
      tokensAfter: 24_000,
      completedAt: 200
    })
  })

  it('creates a failed log item when failure occurs before a started event', () => {
    const initial: ChatMessage = { id: 'agent-1', role: 'agent', content: '' }
    const failed = applyCompactionTimelineUpdate(initial, {
      status: 'failed',
      trigger: 'model_downshift',
      error: '摘要超过模型输出限制'
    }, 300, 'compaction-failed')
    const item = failed.executionTimeline?.[0] as CompactionTimelineItem

    expect(item).toMatchObject({
      type: 'compaction',
      status: 'error',
      error: '摘要超过模型输出限制'
    })
    const unified = buildUnifiedTimeline([item], [], [], undefined, true)
    expect(unified[0].target).toContain('自动压缩上下文失败：摘要超过模型输出限制')
  })
})
