import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../shared/types/provider'

const chatMock = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock('../main/services/ChatService', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    streamChat: chatMock.streamChat,
  })),
}))

const outputSpec = {
  description: 'Submit a research handoff.',
  fields: [
    { name: 'report', type: 'string' as const, description: 'Markdown handoff', required: true },
    { name: 'conclusion', type: 'string' as const, description: 'Direct answer', required: true },
    { name: 'confidence', type: 'string' as const, description: 'Confidence', required: true },
  ],
}

const readTool: ToolDefinition = {
  type: 'function',
  function: { name: 'Read', description: 'Read a file', parameters: {} },
}

function makeContext() {
  return {
    workspaceRoot: process.cwd(),
    sessionId: `protocol-${Date.now()}-${Math.random()}`,
    task: 'Investigate the failure.',
    parentPrompt: 'Investigate the failure.',
    apiConfig: {
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      apiFormat: 'openai',
      model: 'test-model',
    },
    contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 },
  }
}

beforeEach(() => {
  chatMock.streamChat.mockReset()
})

describe('structured subagent completion protocol', { timeout: 15_000 }, () => {
  it('reserves the last loop for submit_result and forwards the Markdown report', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    SubAgentManager.register({
      type: 'ProtocolSuccessTest',
      description: 'Protocol success test',
      whenToUse: 'test',
      maxLoops: 2,
      finalizationReserveLoops: 1,
      getTools: () => [readTool],
      systemPromptBuilder: () => 'test subagent',
      outputSpec,
    })

    chatMock.streamChat
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('I will begin investigating.', '')
        callbacks.onDone('I will begin investigating.', 'stop')
      })
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'submit-1',
          type: 'function',
          function: {
            name: 'submit_result',
            arguments: JSON.stringify({
              report: '# Research Handoff\n\n## Direct Answer\nThe failure originates in the parser.',
              conclusion: 'The parser rejects the input.',
              confidence: 'high',
            }),
          },
        }])
        callbacks.onDone('', 'tool_calls')
      })

    const result = await SubAgentManager.spawn('ProtocolSuccessTest', makeContext(), {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    const secondCallTools = chatMock.streamChat.mock.calls[1][0].tools
      .map((tool: ToolDefinition) => tool.function.name)
    expect(secondCallTools).toEqual(['submit_result'])
    expect(result.status).toBe('completed')
    expect(result.output).toContain('# Research Handoff')
  })

  it('fails instead of completing when the structured result is never submitted', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    SubAgentManager.register({
      type: 'ProtocolFailureTest',
      description: 'Protocol failure test',
      whenToUse: 'test',
      maxLoops: 2,
      finalizationReserveLoops: 1,
      getTools: () => [readTool],
      systemPromptBuilder: () => 'test subagent',
      outputSpec,
    })

    chatMock.streamChat
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('I will begin investigating.', '')
        callbacks.onDone('I will begin investigating.', 'stop')
      })
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('Still preparing the answer.', '')
        callbacks.onDone('Still preparing the answer.', 'stop')
      })

    const result = await SubAgentManager.spawn('ProtocolFailureTest', makeContext(), {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    expect(result.status).toBe('failed')
    expect(result.qualitySummary?.coverage).toBe(0)
    expect(result.qualitySummary?.confidence).toBe('low')
    expect(result.handoff).toMatchObject({
      reasonCode: 'protocol_failure',
      reason: expect.stringContaining('without submitting'),
      originalTask: 'Investigate the failure.',
      lastProgress: 'Still preparing the answer.',
      canResume: true
    })
  })

  it('does not accept a plain-text JSON object as a structured result', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    SubAgentManager.register({
      type: 'ProtocolJsonTextTest',
      description: 'Protocol JSON text test',
      whenToUse: 'test',
      maxLoops: 2,
      finalizationReserveLoops: 1,
      getTools: () => [readTool],
      systemPromptBuilder: () => 'test subagent',
      outputSpec,
    })

    chatMock.streamChat
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk(JSON.stringify({
          report: '# Research Handoff',
          conclusion: 'Not submitted through the tool.',
          confidence: 'high',
        }), '')
        callbacks.onDone('', 'stop')
      })
      .mockImplementationOnce(async (_config, callbacks) => {
        callbacks.onChunk('', '', [{
          index: 0,
          id: 'submit-2',
          type: 'function',
          function: {
            name: 'submit_result',
            arguments: JSON.stringify({
              report: '# Research Handoff\n\n## Direct Answer\nConfirmed.\n\n## Key Findings\n- `src/core.ts:10-20` — The parser owns the failure.',
              conclusion: 'The parser owns the failure.',
              confidence: 'high',
            }),
          },
        }])
        callbacks.onDone('', 'tool_calls')
      })

    const result = await SubAgentManager.spawn('ProtocolJsonTextTest', makeContext(), {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    expect(chatMock.streamChat).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('completed')
    expect(result.output).toContain('src/core.ts:10-20')
  })

  it('requires Explore to submit its Markdown report through submit_result', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { ExploreSubAgent } = await import('../main/agent/definitions/ExploreSubAgent')

    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onChunk('', '', [{
        index: 0,
        id: 'explore-submit-1',
        type: 'function',
        function: {
          name: 'submit_result',
          arguments: JSON.stringify({
            report: '## Direct answer\n\nThe parser owns the failing branch at `src/core.ts:10`.',
            conclusion: 'The parser owns the failing branch.',
            confidence: 'high',
            filesExamined: ['src/core.ts'],
            unresolvedCount: 0,
          }),
        },
      }])
      callbacks.onDone('', 'tool_calls')
    })

    const result = await SubAgentManager.spawn('Explore', {
      ...makeContext(),
      maxLoopsOverride: 1,
    }, {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    expect(ExploreSubAgent.outputSpec).toBeDefined()
    expect(result.status).toBe('completed')
    expect(result.output).toContain('src/core.ts:10')
    expect(result.structuredOutput).toMatchObject({ confidence: 'high' })
  })

  it('uses one runtime context for lifecycle hooks and prompt construction', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    let beforeSpawnContext: unknown
    let promptContext: unknown

    SubAgentManager.register({
      type: 'PromptContextIdentityTest',
      description: 'Prompt context identity test',
      whenToUse: 'test',
      maxLoops: 1,
      getTools: () => [readTool],
      onBeforeSpawn: async (ctx) => {
        beforeSpawnContext = ctx
      },
      systemPromptBuilder: (ctx) => {
        promptContext = ctx
        return 'test subagent'
      },
    })

    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      callbacks.onChunk('done', '')
      callbacks.onDone('done', 'stop')
    })

    await SubAgentManager.spawn('PromptContextIdentityTest', makeContext(), {
      onChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    expect(promptContext).toBe(beforeSpawnContext)
    const promptToolNames = (promptContext as { promptTools?: ToolDefinition[] }).promptTools
      ?.map((tool) => tool.function.name)
    expect(promptToolNames).toEqual(['Read', 'send_message', 'list_agents'])
  })
})
