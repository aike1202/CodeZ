import { describe, expect, it, vi } from 'vitest'
import type { PromptContext } from '../main/services/prompts/PromptTypes'

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
    const { resolvePromptContext } = await import('../main/services/prompts/PromptContextResolver')
    const resolvedContext = await resolvePromptContext(promptContext)

    const stableSharedModules = SHARED_TOOL_USE_MODULES.filter(module => module.layer !== 'dynamic')
    const sharedSections = (await Promise.all(
      stableSharedModules.map(module => module.build(resolvedContext)),
    )).filter((section): section is string => Boolean(section))

    for (const type of ['Explore', 'Reviewer', 'ExecutionPlanner', 'Executor']) {
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

    const enabledIds = (await createDefaultPipeline().listEnabled(promptContext)).map(module => module.id)
    for (const module of SHARED_TOOL_USE_MODULES) {
      expect(enabledIds).toContain(module.id)
    }
  })

  it('keeps read-only subagents read-only after prompt sharing', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    for (const type of ['Explore', 'Reviewer', 'ExecutionPlanner']) {
      const detail = await SubAgentManager.getDetail(type)
      expect(detail?.tools).toContain('Read')
      expect(detail?.tools).not.toContain('Edit')
      expect(detail?.tools).not.toContain('Write')
    }
  })

  it('removes role-local read guidance that competes with the shared policy', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')
    const explore = await SubAgentManager.getDetail('Explore')
    const planner = await SubAgentManager.getDetail('ExecutionPlanner')

    expect(explore?.systemPrompt).toContain('Critical: Read-only mode')
    expect(explore?.systemPrompt).not.toContain('Read specific files/ranges')
    expect(explore?.systemPrompt).not.toContain('do not dump entire file contents')

    expect(planner?.systemPrompt).toContain('You have ONLY read-only tools')
    expect(planner?.systemPrompt).not.toContain('spot-check')
    expect(planner?.systemPrompt).not.toContain('do not dump whole files')
  })
})
