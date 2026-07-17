import { describe, expect, it } from 'vitest'

import type { AgentRuntimeSnapshot } from '../renderer/src/shared/desktop/generated/contracts'
import type { ChatMessage } from '../renderer/src/stores/chatStore'
import type { SessionRuntimeScopeSnapshot } from '../shared/types/context'
import {
  hydrateSubAgentFromLedger,
  mergeRuntimeSubAgents
} from '../renderer/src/utils/runtimeSubAgents'

function runtimeSnapshot(status: 'queued' | 'completed'): AgentRuntimeSnapshot {
  return {
    version: 1,
    sessionId: 'session-1',
    revision: status === 'queued' ? 1 : 2,
    agents: [{
      agentId: 'agent-1',
      sessionId: 'session-1',
      parentAgentId: '/root',
      parentPath: '/root',
      path: '/root/frontend-analysis',
      role: 'Explore',
      taskName: 'frontend-analysis',
      description: '分析前端',
      status,
      contextScopeId: 'subagent:agent-1',
      attemptId: 'attempt-1',
      createdAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T10:00:01.000Z',
      startedAt: '2026-07-17T10:00:00.100Z',
      completedAt: status === 'completed' ? '2026-07-17T10:00:01.000Z' : undefined,
      runCount: 1,
      launch: {
        depth: 'exhaustive',
        allowedWriteFiles: [],
        allowShell: true
      },
      result: status === 'completed'
        ? {
            status: 'completed',
            report: '前端分析完成',
            conclusion: '需要补充测试'
          }
        : undefined
    }],
    messages: [{
      messageId: 'message-1',
      messageType: 'NEW_TASK',
      attemptId: 'attempt-1',
      author: '/root',
      recipient: '/root/frontend-analysis',
      payload: '检查 src 目录',
      deliveryState: 'read',
      createdAt: '2026-07-17T10:00:00.000Z'
    }]
  }
}

function spawningMessage(): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'agent',
    content: '',
    toolCalls: [{
      id: 'call-spawn',
      name: 'spawn_agent',
      args: JSON.stringify({ taskName: 'frontend-analysis', role: 'Explore' }),
      status: 'running',
      startedAt: Date.parse('2026-07-17T10:00:00.000Z'),
      sequence: 0
    }],
    executionTimeline: []
  }
}

describe('runtime SubAgent projection', () => {
  it('shows a queued Agent card as soon as its spawn call is known', () => {
    const projected = mergeRuntimeSubAgents([spawningMessage()], runtimeSnapshot('queued'))
    const card = projected[0].subAgents?.[0]

    expect(card).toMatchObject({
      id: 'agent-1',
      sessionId: 'session-1',
      contextScopeId: 'subagent:agent-1',
      parentToolCallId: 'call-spawn',
      status: 'running',
      prompt: '检查 src 目录'
    })
  })

  it('hydrates real assistant and tool logs from the Agent ledger scope', () => {
    const [projected] = mergeRuntimeSubAgents(
      [spawningMessage()],
      runtimeSnapshot('completed')
    )
    const card = projected.subAgents?.[0]
    expect(card).toBeDefined()
    const scope = {
      activeMessages: [{
        id: 'assistant-ledger-1',
        turnId: 'attempt-1',
        role: 'assistant',
        content: '先检查入口文件。',
        toolCalls: [{
          id: 'call-read',
          name: 'Read',
          arguments: JSON.stringify({ files: [{ file_path: 'src/main.tsx' }] })
        }],
        status: 'complete',
        createdAt: '2026-07-17T10:00:00.200Z'
      }, {
        id: 'tool-ledger-1',
        turnId: 'attempt-1',
        role: 'tool',
        content: '1: import React from react',
        toolCallId: 'call-read',
        name: 'Read',
        status: 'complete',
        createdAt: '2026-07-17T10:00:00.400Z'
      }]
    } as SessionRuntimeScopeSnapshot

    const hydrated = hydrateSubAgentFromLedger(card!, scope)

    expect(hydrated.toolCalls).toHaveLength(1)
    expect(hydrated.toolCalls[0]).toMatchObject({
      id: 'call-read',
      name: 'Read',
      status: 'success',
      result: '1: import React from react'
    })
    expect(hydrated.executionTimeline.map((item) => item.type)).toEqual(['text', 'tool'])
  })
})
