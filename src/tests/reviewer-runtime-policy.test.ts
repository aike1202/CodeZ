import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
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

describe('Reviewer runtime tool exposure', { timeout: 15_000 }, () => {
  it('does not tell the model about shell tools even when a caller supplies a shell scope', async () => {
    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onChunk('', '', [{
        index: 0,
        id: 'review-submit-1',
        type: 'function',
        function: {
          name: 'submit_result',
          arguments: JSON.stringify({
            verdict: 'PASS',
            reviewCycleId: 'runtime-tools',
            reviewMode: 'initial',
            report: 'The supplied implementation and tests cover the requested behavior.',
            conclusion: 'No actionable findings were identified from read-only inspection.',
            confidence: 'high',
            blockingFindings: [],
            risks: [],
            resolvedFindingIds: [],
            checksRun: ['Read-only inspection of the supplied implementation and tests.'],
            filesExamined: ['src/main.ts'],
            unresolvedCount: 0,
          }),
        },
      }])
      callbacks.onDone('', 'tool_calls')
    })

    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const result = await SubAgentManager.spawn('Reviewer', {
      workspaceRoot,
      sessionId: `review-runtime-${Date.now()}`,
      task: 'Review a completed change.',
      parentPrompt: 'Review a completed change.',
      reviewMode: 'initial',
      reviewCycleId: 'runtime-tools',
      expectations: { questions: ['The implementation satisfies the requested behavior.'] },
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
    })

    const request = chatMock.streamChat.mock.calls[0]?.[0]
    const exposedNames = request.tools.map((tool: { function: { name: string } }) => tool.function.name)
    expect(exposedNames).toEqual(expect.arrayContaining(['Read', 'list_files', 'Glob', 'Grep', 'submit_result']))
    expect(exposedNames).not.toEqual(expect.arrayContaining(['Bash', 'PowerShell']))
    expect(JSON.stringify(request.messages)).not.toMatch(/\b(?:Bash|PowerShell)\b/)
    expect(result.structuredOutput).toMatchObject({ verdict: 'PASS' })
  })

  it('continues the same completed Reviewer once for closure and rejects a third review', async () => {
    const finding = {
      id: 'F-001',
      criterionId: 'AC-1',
      severity: 'P1',
      location: 'src/main.ts:10',
      expected: 'The request is persisted.',
      actual: 'The request exists only in memory.',
      reproduction: 'Create a request, restart, then read it.',
      evidence: 'src/main.ts:10 writes only to a module-level Map.',
      confidence: 'high',
    }
    chatMock.streamChat
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'review-initial-submit',
          type: 'function',
          function: {
            name: 'submit_result',
            arguments: JSON.stringify({
              verdict: 'BLOCKED',
              reviewCycleId: 'same-reviewer',
              reviewMode: 'initial',
              report: 'Persistence criterion is violated.',
              conclusion: 'Fix F-001 before closure.',
              confidence: 'high',
              blockingFindings: [finding],
              risks: [],
              resolvedFindingIds: [],
              checksRun: ['Read src/main.ts.'],
              filesExamined: ['src/main.ts'],
              unresolvedCount: 0,
            }),
          },
        }])
        callbacks.onDone('', 'tool_calls')
      })
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'review-closure-submit',
          type: 'function',
          function: {
            name: 'submit_result',
            arguments: JSON.stringify({
              verdict: 'PASS',
              reviewCycleId: 'same-reviewer',
              reviewMode: 'closure',
              report: 'F-001 is closed by durable storage.',
              conclusion: 'The frozen criterion is now satisfied.',
              confidence: 'high',
              blockingFindings: [],
              risks: [],
              resolvedFindingIds: ['F-001'],
              checksRun: ['Read the persistence implementation.'],
              filesExamined: ['src/main.ts'],
              unresolvedCount: 0,
            }),
          },
        }])
        callbacks.onDone('', 'tool_calls')
      })

    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const sessionId = `review-closure-${Date.now()}`
    const subAgentId = `reviewer-same-context-${Date.now()}`
    const common = {
      workspaceRoot,
      sessionId,
      task: 'Review persistence against the frozen criterion.',
      parentPrompt: 'Review persistence against the frozen criterion.',
      subAgentId,
      reviewCycleId: 'same-reviewer',
      expectations: { questions: ['The request persists across restart.'] },
      maxLoopsOverride: 2,
      apiConfig: {
        baseUrl: 'https://example.invalid',
        apiKey: 'test-key',
        apiFormat: 'openai',
        model: 'test-model',
      },
      contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
    }
    const callbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }

    const initial = await SubAgentManager.spawn('Reviewer', {
      ...common,
      reviewMode: 'initial',
    }, callbacks)
    expect(initial.structuredOutput).toMatchObject({ verdict: 'BLOCKED' })

    const closure = await SubAgentManager.spawn('Reviewer', {
      ...common,
      task: 'Verify the fix for F-001 without broadening scope.',
      parentPrompt: 'Verify the fix for F-001 without broadening scope.',
      resumeSubAgentId: subAgentId,
      reviewMode: 'closure',
      previousFindingIds: ['F-001'],
    }, callbacks)
    expect(closure.structuredOutput).toMatchObject({
      verdict: 'PASS',
      resolvedFindingIds: ['F-001'],
    })

    await expect(SubAgentManager.spawn('Reviewer', {
      ...common,
      task: 'Attempt an impermissible third review.',
      parentPrompt: 'Attempt an impermissible third review.',
      resumeSubAgentId: subAgentId,
      reviewMode: 'closure',
      previousFindingIds: ['F-001'],
    }, callbacks)).rejects.toThrow('already used its one closure review')
    expect(chatMock.streamChat).toHaveBeenCalledTimes(2)
  })
})
