import { describe, expect, it, vi } from 'vitest'

vi.mock('../main/agent/RulesResolver', () => ({
  RulesResolver: {
    getGlobalRules: vi.fn().mockResolvedValue(''),
    getWorkspaceRules: vi.fn().mockResolvedValue('Workspace Rule Content'),
    getLoadedDirectoryRules: vi.fn().mockReturnValue(''),
  },
}))

vi.mock('../main/services/GitContextService', () => ({
  GitContextService: {
    getSnapshot: vi.fn().mockResolvedValue('Branch: main'),
  },
}))

vi.mock('../main/services/MemoryService', () => ({
  MemoryService: {
    getMemoryDir: vi.fn().mockReturnValue('/tmp/codez-memory'),
  },
}))

vi.mock('../main/services/SkillManager', () => ({
  SkillManager: {
    getInstance: vi.fn().mockReturnValue({
      getActiveSkills: vi.fn().mockResolvedValue([
        { name: 'brainstorming', description: 'Brainstorm ideas' },
      ]),
    }),
  },
}))

vi.mock('../main/services/VerificationStrategyService', () => ({
  VerificationStrategyService: {
    readPackageScripts: vi.fn().mockResolvedValue({ test: 'vitest run' }),
    formatPromptSection: vi.fn().mockReturnValue('  【VERIFICATION STRATEGY】\n  - npm run test'),
  },
}))

vi.mock('../main/tools/ToolManager', () => ({
  ToolManager: vi.fn().mockImplementation(() => ({
    getReadOnlyTools: vi.fn().mockReturnValue([
      { type: 'function', function: { name: 'Read', description: 'Read files', parameters: {} } },
    ]),
    getAllTools: vi.fn().mockReturnValue([
      { name: 'Read', summary: 'Read files' },
      { name: 'Edit', summary: 'Edit files' },
    ]),
    getTool: vi.fn((name: string) => ({
      name,
      description: `${name} tool`,
      parameters_schema: {},
    })),
  })),
}))

describe('Executor subagent prompt', () => {
  it('reuses main prompt policies while excluding main-agent delegation modules', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    const detail = await SubAgentManager.getDetail('Executor')

    expect(detail?.type).toBe('Executor')
    expect(detail?.systemPrompt).toContain('You are CodeZ')
    expect(detail?.systemPrompt).toContain('# Safety')
    expect(detail?.systemPrompt).toContain('Workspace Rule Content')
    expect(detail?.systemPrompt).toContain('# Editing')
    expect(detail?.systemPrompt).toContain('VERIFICATION STRATEGY')
    expect(detail?.systemPrompt).toContain('# Using tools')
    expect(detail?.systemPrompt).toContain('# Executor Constraints')
    expect(detail?.systemPrompt).toContain('submit_result')

    expect(detail?.systemPrompt).not.toContain('# Delegation')
    expect(detail?.systemPrompt).not.toContain('<subagent_guidance>')
    expect(detail?.systemPrompt).not.toContain('<git_status>')
  })

  it('keeps Worker as a compatibility alias for existing callers', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    const detail = await SubAgentManager.getDetail('Worker')

    expect(detail?.type).toBe('Executor')
    expect(detail?.description).toContain('plan step')
  })

  it('injects supplied research context and discourages broad rediscovery', async () => {
    const { WorkerSubAgent } = await import('../main/agent/definitions/WorkerSubAgent')

    const prompt = await WorkerSubAgent.systemPromptBuilder({
      workspaceRoot: '/workspace',
      sessionId: 's1',
      task: 'Implement the renderer projection',
      parentPrompt: 'Implement the renderer projection',
      context: [
        '### Known Facts',
        '- Sidebar status comes from streamCleanups.',
        '### Source References',
        '- useAppWorkspace.ts:151-178 @ abc'
      ].join('\n'),
      apiConfig: {
        baseUrl: 'https://example.invalid',
        apiKey: 'key',
        apiFormat: 'openai',
        model: 'test-model'
      },
      contextCapabilities: { contextWindowTokens: 100_000 }
    })

    expect(prompt).toContain('## Supplied Research and Plan Context')
    expect(prompt).toContain('Sidebar status comes from streamCleanups')
    expect(prompt).toContain('Do not repeat broad repository exploration')
    expect(prompt).toContain('- API format: openai')
    expect(prompt).not.toContain('- Permission mode:')
    expect(prompt).not.toContain('- Extended thinking:')
  })
})
