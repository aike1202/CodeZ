import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

const chatMock = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock('../main/services/ChatService', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    streamChat: chatMock.streamChat,
  })),
}))

let workspaceRoot = ''

beforeEach(async () => {
  chatMock.streamChat.mockReset()
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codez-reviewer-runtime-'))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('Reviewer runtime shell policy', { timeout: 15_000 }, () => {
  it('denies a project write in the real SubAgent tool pipeline', async () => {
    const target = path.join(workspaceRoot, 'should-not-exist.txt')
    chatMock.streamChat
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'review-write-1',
          type: 'function',
          function: {
            name: 'PowerShell',
            arguments: JSON.stringify({
              command: `Set-Content -LiteralPath '${target}' -Value 'changed'`,
            }),
          },
        }])
        callbacks.onDone('', 'tool_calls')
      })
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'review-submit-1',
          type: 'function',
          function: {
            name: 'submit_result',
            arguments: JSON.stringify({
              verdict: 'FAIL',
              report: 'The attempted mutation was correctly blocked by the review runtime.',
              conclusion: 'Reviewer remained non-editing.',
              confidence: 'high',
              findings: ['P2: Reviewer attempted a forbidden project mutation.'],
              checksRun: ['BLOCKED: Set-Content was denied by Reviewer shell policy.'],
              filesExamined: ['should-not-exist.txt'],
              unresolvedCount: 0,
            }),
          },
        }])
        callbacks.onDone('', 'tool_calls')
      })

    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const onSubAgentToolEnd = vi.fn()
    const result = await SubAgentManager.spawn('Reviewer', {
      workspaceRoot,
      sessionId: `review-runtime-${Date.now()}`,
      task: 'Review a completed change.',
      parentPrompt: 'Review a completed change.',
      maxLoopsOverride: 2,
      permissionScope: {
        allowBash: true,
        allowedWriteFiles: [],
        shellPolicy: 'verification',
      },
      apiConfig: {
        baseUrl: 'https://example.invalid',
        apiKey: 'test-key',
        apiFormat: 'openai',
        model: 'test-model',
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
    }, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onSubAgentToolEnd,
    })

    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(onSubAgentToolEnd).toHaveBeenCalledWith(
      expect.any(String),
      'review-write-1',
      expect.stringContaining('Reviewer shell command denied')
    )
    expect(result.structuredOutput).toMatchObject({ verdict: 'FAIL' })
  })
})
