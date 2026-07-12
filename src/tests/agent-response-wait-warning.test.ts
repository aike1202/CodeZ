import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../renderer/src/stores/chatStore'

vi.mock('../renderer/src/components/chat/ChatArea', () => ({
  extractMessageEdits: () => ({ edits: [], tools: [] }),
  handleApprovalDiffClick: vi.fn()
}))

import { AgentMessageContent } from '../renderer/src/components/chat/AgentMessageContent'

describe('agent response wait warning', () => {
  it('distinguishes backend startup from model thinking', () => {
    const message: ChatMessage = {
      id: 'agent-starting',
      role: 'agent',
      content: '',
      streaming: true,
      streamPhase: 'starting'
    }

    const html = renderToStaticMarkup(React.createElement(AgentMessageContent, {
      msg: message,
      lastStreamingMsgId: message.id,
      handleFileClick: async () => undefined,
      handleDiffClick: () => undefined
    }))

    expect(html).toContain('正在启动…')
    expect(html).not.toContain('正在思考…')
  })

  it('renders after the execution timeline', () => {
    const message: ChatMessage = {
      id: 'agent-1',
      role: 'agent',
      content: '',
      streaming: true,
      responseWaitWarning: true,
      executionTimeline: [{
        id: 'reasoning-1',
        type: 'reasoning',
        content: 'Checking the workspace',
        status: 'running',
        startedAt: 1,
        updatedAt: 1,
        sequence: 0
      }]
    }

    const html = renderToStaticMarkup(React.createElement(AgentMessageContent, {
      msg: message,
      lastStreamingMsgId: message.id,
      handleFileClick: async () => undefined,
      handleDiffClick: () => undefined
    }))

    expect(html.indexOf('timeline-container')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('agent-response-wait-warning')).toBeGreaterThan(html.indexOf('timeline-container'))
    expect(html).toContain('长时间未收到响应')
  })

  it('stores the warning separately from assistant content', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const messages = [{ id: 'agent-1', role: 'agent', content: 'existing reply' }] as ChatMessage[]
    useChatStore.setState({
      sessions: [{ id: 's1', projectId: 'p1', summary: 'test', relativeTime: 'now', messages }],
      activeSessionId: 's1',
      messages
    })

    useChatStore.getState().setResponseWaitWarning('agent-1', true)
    expect(useChatStore.getState().messages[0]).toMatchObject({
      content: 'existing reply',
      responseWaitWarning: true
    })

    useChatStore.getState().setResponseWaitWarning('agent-1', false)
    expect(useChatStore.getState().messages[0].responseWaitWarning).toBeUndefined()
  })
})
