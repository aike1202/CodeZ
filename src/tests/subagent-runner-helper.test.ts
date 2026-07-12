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
    managerMock.getDefinition.mockReturnValue({ type: 'Explore', allowShell: true })
    managerMock.listDefinitions.mockReturnValue([{ type: 'Explore' }])
  })

  it('forwards a protocol failure to the parent as an error and a failed card state', async () => {
    managerMock.spawn.mockResolvedValue({
      type: 'Explore',
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
        subagent_type: 'Explore',
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
      data: { status: 'failed', subagent_type: 'Explore' },
    })
    expect(payload.error).toContain('without submitting')
    expect(onSubAgentEnd).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent_Explore_[0-9a-f]{16}_tool-1$/),
      expect.objectContaining({ status: 'failed', toolCallCount: 12 })
    )
    expect(onToolEnd).toHaveBeenCalledWith('tool-1', result.content)
  })

  it('forwards an interruption with a machine-readable tool error', async () => {
    managerMock.spawn.mockResolvedValue({
      type: 'Explore',
      status: 'interrupted',
      output: 'SubAgent execution was interrupted before completion.',
      toolCallCount: 2,
      filesExamined: ['src/auth.ts'],
      handoff: {
        reasonCode: 'parent_interrupted',
        reason: 'The user stopped the parent Agent run.',
        originalTask: 'Investigate the project.',
        lastProgress: 'Located the failing authorization branch.',
        filesExamined: ['src/auth.ts'],
        filesModified: ['src/auth.ts'],
        filesPossiblyModified: [],
        recentTools: [{ name: 'Edit', status: 'success', target: 'src/auth.ts' }],
        workspaceMayHaveUntrackedChanges: false,
        canResume: true
      }
    })

    const { handleSubAgentRunnerSpawn } = await import('../main/agent/AgentRunner/subAgentRunnerHelper')
    const result = await handleSubAgentRunnerSpawn(
      'tool-2',
      JSON.stringify({
        subagent_type: 'Explore',
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
      data: {
        status: 'interrupted',
        subagent_type: 'Explore',
        handoff: {
          reasonCode: 'parent_interrupted',
          filesModified: ['src/auth.ts'],
          filesPossiblyModified: [],
          canResume: true
        }
      }
    })
    expect(JSON.parse(result.content).data.resume_subagent_id).toMatch(
      /^subagent_Explore_[0-9a-f]{16}_tool-2$/
    )
  })

  it('resumes an interrupted subagent with the same durable identity', async () => {
    managerMock.spawn.mockResolvedValueOnce({
      type: 'Explore', status: 'interrupted', output: 'stopped', toolCallCount: 1, filesExamined: []
    })

    const { handleSubAgentRunnerSpawn } = await import('../main/agent/AgentRunner/subAgentRunnerHelper')
    const commonArgs = {
      subagent_type: 'Explore',
      description: 'Resume research',
      prompt: 'Investigate the project.',
      context: 'Authentication is already understood.',
      scope: { directories: ['src'], excludeGlobs: ['**/*.test.ts'] },
      expectations: { questions: ['Where is the bug?'] },
      depth: 'normal'
    }
    const config = {
      workspaceRoot: process.cwd(), sessionId: 'session-1', baseUrl: 'https://example.invalid',
      apiKey: 'test-key', apiFormat: 'openai', model: 'test-model', providerId: 'provider-test'
    } as any
    const callbacks = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const interrupted = await handleSubAgentRunnerSpawn(
      'tool-2', JSON.stringify(commonArgs), config, callbacks
    )
    const resumeSubAgentId = JSON.parse(interrupted.content).data.resume_subagent_id

    managerMock.spawn.mockResolvedValueOnce({
      type: 'Explore', status: 'completed', output: 'done', toolCallCount: 1, filesExamined: []
    })
    await handleSubAgentRunnerSpawn(
      'tool-3',
      JSON.stringify({
        ...commonArgs,
        resume_subagent_id: resumeSubAgentId
      }),
      config,
      callbacks
    )

    expect(managerMock.spawn).toHaveBeenCalledWith(
      'Explore',
      expect.objectContaining({
        subAgentId: resumeSubAgentId,
        resumeSubAgentId,
        providerId: 'provider-test',
        context: commonArgs.context,
        scope: commonArgs.scope,
        permissionScope: { allowBash: true, allowedWriteFiles: [] }
      }),
      expect.anything()
    )
  })

  it('rejects a resume id that belongs to a different subagent type', async () => {
    const { handleSubAgentRunnerSpawn } = await import('../main/agent/AgentRunner/subAgentRunnerHelper')
    const result = await handleSubAgentRunnerSpawn(
      'tool-4',
      JSON.stringify({
        subagent_type: 'Explore',
        description: 'Invalid resume',
        prompt: 'Investigate the project.',
        resume_subagent_id: 'subagent_Executor_tool-2'
      }),
      {
        workspaceRoot: process.cwd(), sessionId: 'session-1', baseUrl: 'https://example.invalid',
        apiKey: 'test-key', apiFormat: 'openai', model: 'test-model'
      } as any,
      { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    )

    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      error: expect.stringContaining("invalid for subagent type 'Explore'")
    })
    expect(managerMock.spawn).not.toHaveBeenCalled()
  })

})
