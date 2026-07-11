import { describe, expect, it, vi } from 'vitest'
import type { PromptContext } from '../main/services/prompts/PromptTypes'

vi.mock('../main/agent/RulesResolver', () => ({
  RulesResolver: {
    getWorkspaceRules: vi.fn().mockResolvedValue('Workspace Rule Content'),
  },
}))

vi.mock('../main/services/GitContextService', () => ({
  GitContextService: {
    getSnapshot: vi.fn().mockReturnValue('Current branch: main'),
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
      getActiveSkills: vi.fn().mockResolvedValue([]),
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
      { type: 'function', function: { name: 'Grep', description: 'Search files', parameters: {} } },
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

const promptContext: PromptContext = {
  workspaceRoot: '/workspace',
  modelId: 'test-model',
  modelDisplayName: 'Test Model',
  contextWindowTokens: 100_000,
  sessionId: 'session-1',
}

describe('shared subagent tool policy', () => {
  it('injects every shared tool-use module into all built-in subagents', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const { SHARED_TOOL_USE_MODULES } = await import('../main/services/prompts/SubAgentPrompts')

    const sharedSections = await Promise.all(
      SHARED_TOOL_USE_MODULES.map(module => module.build(promptContext)),
    )

    for (const type of ['Research', 'ExecutionPlanner', 'Executor']) {
      const detail = await SubAgentManager.getDetail(type)
      expect(detail, `${type} definition`).toBeDefined()
      for (const section of sharedSections) {
        expect(detail?.systemPrompt, `${type} shared policy`).toContain(section.trim())
      }
    }
  })

  it('registers the same shared modules in the main Agent pipeline', async () => {
    const { SHARED_TOOL_USE_MODULES } = await import('../main/services/prompts/SubAgentPrompts')
    const { createDefaultPipeline } = await import('../main/services/prompts/PromptBuilder')

    const enabledIds = createDefaultPipeline().listEnabled(promptContext).map(module => module.id)
    for (const module of SHARED_TOOL_USE_MODULES) {
      expect(enabledIds).toContain(module.id)
    }
  })

  it('keeps read-only subagents read-only after prompt sharing', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    for (const type of ['Research', 'ExecutionPlanner']) {
      const detail = await SubAgentManager.getDetail(type)
      expect(detail?.tools).toContain('Read')
      expect(detail?.tools).not.toContain('Edit')
      expect(detail?.tools).not.toContain('Write')
    }
  })

  it('removes role-local read guidance that competes with the shared policy', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const research = await SubAgentManager.getDetail('Research')
    const planner = await SubAgentManager.getDetail('ExecutionPlanner')

    expect(research?.systemPrompt).toContain('using ONLY read-only tools')
    expect(research?.systemPrompt).not.toContain('Read specific files/ranges')
    expect(research?.systemPrompt).not.toContain('do not dump entire file contents')

    expect(planner?.systemPrompt).toContain('You have ONLY read-only tools')
    expect(planner?.systemPrompt).not.toContain('spot-check')
    expect(planner?.systemPrompt).not.toContain('do not dump whole files')
  })
})
