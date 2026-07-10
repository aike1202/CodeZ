import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../shared/types/provider'

const chatMock = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock('../main/services/ChatService', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    streamChat: chatMock.streamChat,
  })),
}))

describe('SubAgentManager recoverable provider errors', () => {
  const workerOutputSpec = {
    description: 'Report worker outcome',
    fields: [
      { name: 'status', type: 'string' as const, description: 'completed or failed', required: true },
      { name: 'summary', type: 'string' as const, description: 'summary', required: true },
      { name: 'filesModified', type: 'string[]' as const, description: 'modified files', required: true },
      { name: 'blockers', type: 'string[]' as const, description: 'blockers', required: false },
    ],
  }

  it('asks the user to maintain provider/network and then retries the same subagent loop', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    SubAgentManager.register({
      type: 'RecoveryTest',
      description: 'Recovery test agent',
      whenToUse: 'test',
      maxLoops: 4,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test subagent',
    })

    chatMock.streamChat
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onError('网络错误: fetch failed')
      })
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('done', '', undefined)
        callbacks.onDone('done')
      })

    const askUser = vi.fn().mockResolvedValue([
      { question: 'Worker 遇到 API/网络问题。', answer: '已修复，继续重试' },
    ])

    const result = await SubAgentManager.spawn(
      'RecoveryTest',
      {
        workspaceRoot: process.cwd(),
        sessionId: 's1',
        task: 'recover',
        parentPrompt: 'recover',
        apiConfig: {
          baseUrl: 'https://example.invalid',
          apiKey: 'key',
          apiFormat: 'openai',
          model: 'test-model',
        },
        contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      },
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        onAskUserRequest: askUser,
      }
    )

    expect(askUser).toHaveBeenCalledTimes(1)
    expect(chatMock.streamChat).toHaveBeenCalledTimes(2)
    expect(result.output).toBe('done')
  })

  it('returns structured failed output when the user stops after a recoverable provider error', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    SubAgentManager.register({
      type: 'RecoveryStopTest',
      description: 'Recovery stop test agent',
      whenToUse: 'test',
      maxLoops: 4,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test subagent',
      outputSpec: workerOutputSpec,
    })

    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onError('网络错误: fetch failed')
    })

    const askUser = vi.fn().mockResolvedValue([
      { question: 'Worker 遇到 API/网络问题。', answer: '停止这个 Worker' },
    ])

    const result = await SubAgentManager.spawn(
      'RecoveryStopTest',
      {
        workspaceRoot: process.cwd(),
        sessionId: 's1',
        task: 'recover',
        parentPrompt: 'recover',
        apiConfig: {
          baseUrl: 'https://example.invalid',
          apiKey: 'key',
          apiFormat: 'openai',
          model: 'test-model',
        },
        contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
      },
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        onAskUserRequest: askUser,
      }
    )

    expect(result.structuredOutput).toMatchObject({
      status: 'failed',
      filesModified: [],
      blockers: ['网络错误: fetch failed'],
    })
  })
})
