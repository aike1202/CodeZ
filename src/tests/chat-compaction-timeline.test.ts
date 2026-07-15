import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExecutionLog from '../renderer/src/components/chat/ExecutionLog'
import { LogItemRow } from '../renderer/src/components/chat/ExecutionLog/components/LogItemRow'
import {
  buildSummaryText,
  buildUnifiedTimeline
} from '../renderer/src/components/chat/ExecutionLog/utils'
import { applyCompactionTimelineUpdate } from '../renderer/src/stores/chatStore/slices/messageSlice'
import type { ChatMessage, CompactionTimelineItem } from '../renderer/src/stores/chatStore'

afterEach(() => {
  vi.useRealTimers()
})

describe('chat compaction execution timeline', () => {
  it('removes a collapsed execution list from layout and accessibility navigation', () => {
    const html = renderToStaticMarkup(React.createElement(ExecutionLog, {
      timeline: [{
        id: 'reasoning-complete',
        type: 'reasoning',
        content: '完成分析',
        status: 'success',
        startedAt: 1_000,
        updatedAt: 2_000,
        completedAt: 2_000,
        sequence: 0
      }]
    }))

    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('class="timeline-list-wrapper" hidden=""')
    expect(html).toContain('展开')
  })

  it('renders the running indicator before the active log and its elapsed time after it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(47_000)

    const html = renderToStaticMarkup(React.createElement(LogItemRow, {
      item: {
        id: 'reasoning-running',
        type: 'reasoning',
        timestamp: 1_000,
        status: 'running',
        verb: 'Thought',
        target: '思考中...'
      },
      isLast: true,
      isItemExpanded: false,
      hasItemDetail: false,
      toggleItemExpand: () => undefined
    }))

    expect(html).toContain('timeline-icon-running')
    expect(html).toContain('思考')
    expect(html).toContain('用时 46s')
    expect(html).not.toContain('思考中...')
    expect(html.indexOf('timeline-icon-running')).toBeLessThan(html.indexOf('思考'))
    expect(html.indexOf('思考')).toBeLessThan(html.indexOf('用时 46s'))
  })

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
