import { describe, expect, it, vi } from 'vitest'
import { SystemPromptService } from '../main/services/SystemPromptService'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  splitSystemPromptSections
} from '../main/services/prompts/PromptCache'
import type { PromptContext } from '../main/services/prompts/PromptTypes'

vi.mock('../main/services/GitContextService', () => ({
  GitContextService: {
    getSnapshot: vi.fn().mockResolvedValue('Branch: main\nWorking tree: clean')
  }
}))

vi.mock('../main/services/MemoryService', () => ({
  MemoryService: {
    getMemoryDir: vi.fn().mockReturnValue('/home/user/.codez/projects/abc/memory')
  }
}))

vi.mock('../main/agent/RulesResolver', () => ({
  RulesResolver: {
    getGlobalRules: vi.fn().mockResolvedValue('Global Rule Content'),
    getWorkspaceRules: vi.fn().mockResolvedValue('Workspace Rule Content'),
    getLoadedDirectoryRules: vi.fn().mockReturnValue('')
  }
}))

vi.mock('../main/services/VerificationStrategyService', () => ({
  VerificationStrategyService: {
    readPackageScripts: vi.fn().mockResolvedValue({ test: 'vitest run', typecheck: 'tsc --noEmit' }),
    formatPromptSection: vi.fn().mockReturnValue('【VERIFICATION STRATEGY】\n- npm run test')
  }
}))

vi.mock('../main/services/SkillManager', () => ({
  SkillManager: {
    getInstance: vi.fn().mockReturnValue({
      getActiveSkills: vi.fn().mockResolvedValue([
        { name: 'brainstorming', description: 'Brainstorm ideas' }
      ])
    })
  }
}))

vi.mock('../main/agent/SubAgentManager', () => ({
  SubAgentManager: {
    listEnabledDefinitions: vi.fn().mockReturnValue([
      {
        type: 'Explore',
        description: 'Fast read-only codebase exploration agent.',
        whenToUse: 'A directed search is insufficient.',
        whenNotToUse: 'The answer is a directed lookup.'
      },
      {
        type: 'Reviewer',
        description: 'Independent read-only implementation reviewer.',
        whenToUse: 'After implementation and before reporting completion.',
        whenNotToUse: 'General exploration.'
      }
    ])
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    type: vi.fn().mockReturnValue('Windows_NT'),
    release: vi.fn().mockReturnValue('10.0.26200')
  }
})

const mockCtx: PromptContext = {
  workspaceRoot: 'C:\\test\\workspace',
  modelId: 'claude-opus-test',
  modelDisplayName: 'Opus Test',
  contextWindowTokens: 200_000,
  sessionId: 'test-session',
  apiFormat: 'anthropic',
  permissionMode: 'auto',
  thinkingEnabled: true,
  now: new Date(2026, 6, 13),
  availableTools: [
    { name: 'Read', summary: 'Read files' },
    { name: 'Edit', summary: 'Edit files' },
    { name: 'Bash', summary: 'Run shell commands' },
    { name: 'Skill', summary: 'Load skills' },
    { name: 'TaskCreate', summary: 'Track tasks' },
    { name: 'SubAgentRunner', summary: 'Run specialists' },
    { name: 'update_resume_state', summary: 'Persist handoff state' }
  ],
  deferredTools: [{ name: 'WebSearch', summary: 'Search the web' }]
}

describe('SystemPromptService', () => {
  it('builds a direct, non-rigid software engineering prompt', async () => {
    const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
    expect(prompt).toContain('You are CodeZ')
    expect(prompt).toContain('Ask the user only when missing information would materially change the result')
    expect(prompt).toContain('File count alone is never a reason to delegate')
    expect(prompt).not.toContain('# Reasoning Policy')
    expect(prompt).not.toContain('# Decision Policy')
    expect(prompt).not.toContain('identify at least two approaches')
    expect(prompt).not.toContain('Does this break into 3+ distinct steps?')
  })

  it('keeps one stable behavior prefix before dynamic runtime context', async () => {
    const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
    expect(prompt).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    const sections = splitSystemPromptSections(prompt)
    expect(sections.staticContent).toContain('# Doing tasks')
    expect(sections.staticContent).toContain('# Verification')
    expect(sections.staticContent).not.toContain('Workspace Rule Content')
    expect(sections.dynamicContent).toContain('Workspace Rule Content')
    expect(sections.dynamicContent).toContain('# Environment')
    expect(sections.staticContent.length).toBeLessThan(8_000)
  })

  it('adapts tool, task, skill, and subagent guidance to exposed capabilities', async () => {
    const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
    expect(prompt).toContain('# Using tools')
    expect(prompt).toContain('# Task tracking')
    expect(prompt).toContain('# Subagents')
    expect(prompt).toContain('brainstorming')
    expect(prompt).toContain('WebSearch: Search the web')

    const readOnlyPrompt = await SystemPromptService.buildSystemPrompt({
      ...mockCtx,
      availableTools: [{ name: 'Read', summary: 'Read files' }],
      deferredTools: [],
      activeSkills: []
    })
    expect(readOnlyPrompt).not.toContain('# Task tracking')
    expect(readOnlyPrompt).not.toContain('# Subagents')
    expect(readOnlyPrompt).not.toContain('<subagent_guidance>')
    expect(readOnlyPrompt).not.toContain('<skills_instructions>')
  })

  it('injects rules once with explicit precedence', async () => {
    const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
    expect(prompt).toContain('global < workspace < closest directory < the current explicit user request')
    expect(prompt).toContain('<global_rules>\nGlobal Rule Content')
    expect(prompt).toContain('<workspace_rules>\nWorkspace Rule Content')
  })

  it('uses truthful model and environment data without a hard-coded cutoff', async () => {
    const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
    expect(prompt).toContain('- Date: 2026-07-13')
    expect(prompt).toContain('- API format: anthropic')
    expect(prompt).toContain('- Permission mode: auto')
    expect(prompt).toContain('- Extended thinking: enabled')
    expect(prompt).toContain('Branch: main')
    expect(prompt).not.toContain('Knowledge cutoff:')
    expect(prompt).not.toContain('Is a git repository: true')
  })

  it('includes proportional verification and the workspace verification strategy', async () => {
    const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
    expect(prompt).toContain('Scale verification to risk')
    expect(prompt).toContain('【VERIFICATION STRATEGY】')
  })

  it('requires an independent Reviewer after project changes with a complete handoff', async () => {
    const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)

    expect(prompt).toContain('## Independent review gate')
    expect(prompt).toContain('you MUST invoke Reviewer')
    expect(prompt).toContain('Do not use Explore')
    expect(prompt).toContain('Original user goal and acceptance criteria')
    expect(prompt).toContain('Actual changes and implementation approach')
    expect(prompt).toContain('Complete changed-file list')
    expect(prompt).toContain('Verification commands already run and their actual results')
    expect(prompt).toContain('On FAIL, fix the findings and launch Reviewer again')
  })

  it('keeps the Reviewer gate in the default exposure where SubAgentRunner is deferred', async () => {
    const { availableTools: _availableTools, deferredTools: _deferredTools, ...defaultCtx } = mockCtx
    const prompt = await SystemPromptService.buildSystemPrompt(defaultCtx)

    expect(prompt).toContain('<deferred_tools>')
    expect(prompt).toContain('- SubAgentRunner:')
    expect(prompt).toContain('<subagent_guidance>')
    expect(prompt).toContain('## Independent review gate')
    expect(prompt).toContain('you MUST invoke Reviewer')
  })

  it('does not emit the legacy duplicate system reminder', async () => {
    await expect(SystemPromptService.buildSystemReminder(mockCtx.workspaceRoot)).resolves.toBe('')
  })
})
