import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  listDefinitions: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}))

vi.mock('../main/agent/SubAgentManager', () => ({
  SubAgentManager: managerMock,
}))

describe('SubAgentRunner result forwarding', () => {
  beforeEach(() => {
    vi.resetModules()
    managerMock.getDefinition.mockReset()
    managerMock.listDefinitions.mockReset()
    managerMock.spawn.mockReset()
    managerMock.getDefinition.mockReturnValue({ type: 'Research' })
    managerMock.listDefinitions.mockReturnValue([{ type: 'Research' }])
  })

  it('forwards a protocol failure to the parent as an error and a failed card state', async () => {
    managerMock.spawn.mockResolvedValue({
      type: 'Research',
      status: 'failed',
      output: 'SubAgent exhausted its run without submitting a valid structured result.',
      toolCallCount: 12,
      filesExamined: ['src/core.ts'],
    })

    const { handleSubAgentRunnerSpawn } = await import('../main/agent/AgentRunner/subAgentRunnerHelper')
    const onToolEnd = vi.fn()
    const onSubAgentEnd = vi.fn()
    const result = await handleSubAgentRunnerSpawn(
      'tool-1',
      JSON.stringify({
        subagent_type: 'Research',
        description: 'Investigate failure',
        prompt: 'Investigate the reported failure.',
      }),
      {
        workspaceRoot: process.cwd(),
        sessionId: 'session-1',
        baseUrl: 'https://example.invalid',
        apiKey: 'test-key',
        apiFormat: 'openai',
        model: 'test-model',
      } as any,
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        onToolEnd,
        onSubAgentEnd,
      }
    )

    const payload = JSON.parse(result.content)
    expect(payload).toMatchObject({
      ok: false,
      data: { status: 'failed', subagent_type: 'Research' },
    })
    expect(payload.error).toContain('without submitting')
    expect(onSubAgentEnd).toHaveBeenCalledWith(
      'subagent_tool-1',
      expect.objectContaining({ status: 'failed', toolCallCount: 12 })
    )
    expect(onToolEnd).toHaveBeenCalledWith('tool-1', result.content)
  })

  it('forwards an interruption with a machine-readable tool error', async () => {
    managerMock.spawn.mockResolvedValue({
      type: 'Research',
      status: 'interrupted',
      output: 'SubAgent execution was interrupted before completion.',
      toolCallCount: 2,
      filesExamined: []
    })

    const { handleSubAgentRunnerSpawn } = await import('../main/agent/AgentRunner/subAgentRunnerHelper')
    const result = await handleSubAgentRunnerSpawn(
      'tool-2',
      JSON.stringify({
        subagent_type: 'Research',
        description: 'Interrupted research',
        prompt: 'Investigate the project.'
      }),
      {
        workspaceRoot: process.cwd(),
        sessionId: 'session-1',
        baseUrl: 'https://example.invalid',
        apiKey: 'test-key',
        apiFormat: 'openai',
        model: 'test-model'
      } as any,
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn()
      }
    )

    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_INTERRUPTED' },
      data: { status: 'interrupted', subagent_type: 'Research' }
    })
  })
})
