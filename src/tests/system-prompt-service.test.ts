import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import { SystemPromptService } from '../main/services/SystemPromptService'
import { ToolPolicyModule } from '../main/services/prompts/execution/ToolPolicy'
import { InvestigationModule } from '../main/services/prompts/execution/Investigation'

// Mock all dependencies
vi.mock('../main/services/GitContextService', () => ({
  GitContextService: {
    getSnapshot: vi.fn().mockReturnValue('Current branch: main\n\nGit user: test\n\nStatus:\n\nRecent commits:\nabc123 test commit')
  }
}))

vi.mock('../main/services/MemoryService', () => ({
  MemoryService: {
    getMemoryDir: vi.fn().mockReturnValue('/home/user/.codez/projects/abc/memory')
  }
}))

vi.mock('../main/agent/RulesResolver', () => ({
  RulesResolver: {
    getGlobalRules: vi.fn().mockResolvedValue('=== Global Rules ===\nGlobal Rule Content'),
    getWorkspaceRules: vi.fn().mockResolvedValue('=== Workspace Rules ===\nWorkspace Rule Content')
  }
}))

vi.mock('../main/services/VerificationStrategyService', () => ({
  VerificationStrategyService: {
    readPackageScripts: vi.fn().mockResolvedValue({ test: 'vitest run', typecheck: 'tsc --noEmit' }),
    formatPromptSection: vi.fn().mockReturnValue('  【VERIFICATION STRATEGY】\n  - npm run test')
  }
}))

vi.mock('../main/services/SkillManager', () => ({
  SkillManager: {
    getInstance: vi.fn().mockReturnValue({
      getActiveSkills: vi.fn().mockResolvedValue([
        { name: 'brainstorming', description: 'Brainstorm ideas', path: '/skills/brainstorming/SKILL.md' }
      ])
    })
  }
}))

vi.mock('../main/agent/SubAgentManager', () => ({
  SubAgentManager: {
    listDefinitions: vi.fn().mockReturnValue([
      {
        type: 'Explore',
        description: 'Fast read-only codebase exploration agent.',
        whenToUse: 'A directed search is insufficient.\nThe task needs several dependent queries.',
        whenNotToUse: 'The answer is a single file lookup.',
        costHint: 'Up to 12 tool calls.'
      },
      {
        type: 'Plan',
        description: 'Software architect agent.',
        whenToUse: 'You need a structured implementation plan.',
        costHint: 'Up to 15 tool calls.'
      }
    ]),
    listEnabledDefinitions: vi.fn().mockReturnValue([
      {
        type: 'Explore',
        description: 'Fast read-only codebase exploration agent.',
        whenToUse: 'A directed search is insufficient.\nThe task needs several dependent queries.',
        whenNotToUse: 'The answer is a single file lookup.',
        costHint: 'Up to 12 tool calls.'
      },
      {
        type: 'Plan',
        description: 'Software architect agent.',
        whenToUse: 'You need a structured implementation plan.',
        costHint: 'Up to 15 tool calls.'
      }
    ])
  }
}))

vi.mock('../main/tools/ToolManager', () => ({
  ToolManager: vi.fn().mockImplementation(() => ({
    getAllTools: vi.fn().mockReturnValue([
      { name: 'read_file', description: 'Read a file from the workspace' },
      { name: 'edit', description: 'Edit a file with exact string replacement' }
    ])
  }))
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    type: vi.fn().mockReturnValue('Windows_NT'),
    release: vi.fn().mockReturnValue('10.0.26200'),
    homedir: vi.fn().mockReturnValue('C:\\Users\\test')
  }
})

const mockCtx = {
  workspaceRoot: 'C:\\test\\workspace',
  modelId: 'claude-opus-4-8',
  modelDisplayName: 'Opus 4.8 (1M context)',
  contextWindowTokens: 200000,
  sessionId: 'test-session'
}

describe('SystemPromptService', () => {
  describe('buildSystemPrompt', () => {
    it('should return a string with identity', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('CodeZ')
    })

    it('should contain operating environment rules', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Operating Environment')
      expect(prompt).toContain('markdown')
      expect(prompt).toContain('file_path:line_number')
    })

    it('should require batching known reads before data-dependent reads', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('Batch known reads before calling tools')
      expect(prompt).toContain('fewest Read.files calls the schema permits')
      expect(prompt).toContain('dispatch overflow batches in the same response')
      expect(prompt).toContain('Read one or more known files or ranges')
      expect(prompt).toContain('merge adjacent or overlapping ranges')
      expect(prompt).toContain('only when the next target depends on the current result')
      expect(prompt).toContain('Never re-read a file merely to verify your own successful Edit or Write')
      expect(prompt).toContain('failed Edit or Write indicates current source content is needed')
      expect(prompt).toContain('after an external change')
      expect(prompt).toContain('later task requires content not preserved in the current context')
      expect(prompt).toContain('structured Edit or Write result and its diff when present')
      expect(prompt).toContain('returned hash with the smallest appropriate check')
      expect(prompt).not.toContain('After a file changes, re-read it')
      expect(prompt).not.toContain('Re-read the diff')
      expect(prompt).toContain('Plan reads, batch known targets, then act within your role')
      expect(prompt).not.toContain('Read twice, edit once')
    })

    it('should omit arbitrary ranges on initial reads', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('For an initial read without an evidence-based relevant range, omit offset and limit')
      expect(prompt).toContain('A known relevant range is permitted even on the first read')
      expect(prompt).toContain('Do not probe arbitrary first 50 or 100 lines')
      expect(prompt).toContain('marked truncated or reached its documented content-budget boundary')
      expect(prompt).toContain('context trimming removed the earlier content')

      const moduleTexts = await Promise.all([
        ToolPolicyModule.build(mockCtx),
        InvestigationModule.build(mockCtx),
      ])
      for (const text of moduleTexts) {
        expect(text).toContain('For an initial read without an evidence-based relevant range')
        expect(text).toContain('A known relevant range is permitted even on the first read')
        expect(text).toContain('marked truncated or reached its documented content-budget boundary')
      }
    })

    it('should contain memory description', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Memory')
      expect(prompt).toContain('.codez')
    })

    it('should contain security rules', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Security')
      expect(prompt).toContain('UNTRUSTED DATA')
    })

    it('should contain verification strategy', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('VERIFICATION STRATEGY')
    })

    it('should contain reasoning policy with pipeline', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Reasoning Policy')
      expect(prompt).toContain('Understand first, act second')
    })

    it('should contain failure recovery', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Failure Recovery')
      expect(prompt).toContain('Fail once, learn, change strategy')
    })

    it('should contain output policy', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Output Policy')
      expect(prompt).toContain('Report truth, not comfort')
    })

    it('should contain decision policy', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Decision Policy')
      expect(prompt).toContain('Every action should have a reason')
    })

    it('should contain repository rules', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('Workspace Rule Content')
    })

    it('should contain environment context', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('Primary working directory')
      expect(prompt).toContain(mockCtx.modelId)
    })

    it('should contain git status', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('Current branch:')
    })

    it('should contain available tools', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('Read')
      expect(prompt).toContain('read_file')
    })

    it('should contain available skills', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('brainstorming')
    })

    it('should contain delegation guidance', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('subagent_guidance')
      expect(prompt).toContain('Explore is a fast, read-only codebase search specialist:')
      expect(prompt).toContain('Prefer direct Glob, Grep, and Read calls for simple or directed lookups.')
      expect(prompt).toContain('after a simple directed search is insufficient')
      expect(prompt).toContain('more than a few dependent queries')
      expect(prompt).toContain('Explore returns a concise plain-text report.')
      expect(prompt).not.toContain('Research is a context-isolation mechanism.')
      expect(prompt).toContain('Interrupted SubAgent handoff')
      expect(prompt).toContain('filesModified')
      expect(prompt).toContain('resume_subagent_id')
    })

    it('sections should appear in correct order', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      const identityIdx = prompt.indexOf('You are CodeZ')
      const securityIdx = prompt.indexOf('# Security')
      const harnessIdx = prompt.indexOf('# Operating Environment')
      const engineeringIdx = prompt.indexOf('# Engineering Philosophy')
      const reasoningIdx = prompt.indexOf('# Reasoning Policy')
      const decisionIdx = prompt.indexOf('# Decision Policy')
      const memoryIdx = prompt.indexOf('# Memory')
      const investigationIdx = prompt.indexOf('# Investigation')
      const editingIdx = prompt.indexOf('# Editing')
      const verificationIdx = prompt.indexOf('VERIFICATION STRATEGY')
      const failureIdx = prompt.indexOf('# Failure Recovery')
      const completionIdx = prompt.indexOf('# Completion')
      const outputIdx = prompt.indexOf('# Output Policy')

      // Layer 1: Core — Identity & Thinking
      expect(identityIdx).toBeLessThan(securityIdx)
      expect(securityIdx).toBeLessThan(harnessIdx)
      expect(harnessIdx).toBeLessThan(engineeringIdx)
      expect(engineeringIdx).toBeLessThan(reasoningIdx)
      expect(reasoningIdx).toBeLessThan(decisionIdx)
      // Layer 2: Context — Knowledge appears after core, before execution
      expect(decisionIdx).toBeLessThan(memoryIdx)
      expect(memoryIdx).toBeLessThan(investigationIdx)
      // Layer 3: Execution modules appear in order
      expect(investigationIdx).toBeLessThan(editingIdx)
      expect(editingIdx).toBeLessThan(verificationIdx)
      expect(verificationIdx).toBeLessThan(failureIdx)
      expect(failureIdx).toBeLessThan(completionIdx)
      expect(completionIdx).toBeLessThan(outputIdx)
    })
  })

  describe('buildSystemReminder', () => {
    it('should return empty string when no global rules', async () => {
      const { RulesResolver } = await import('../main/agent/RulesResolver')
      ;(RulesResolver.getGlobalRules as any).mockResolvedValue('')
      const reminder = await SystemPromptService.buildSystemReminder('C:\\test')
      expect(reminder).toBe('')
    })

    it('should wrap global rules in system-reminder tags', async () => {
      const { RulesResolver } = await import('../main/agent/RulesResolver')
      ;(RulesResolver.getGlobalRules as any).mockResolvedValue('=== Global Rules ===\nTest Rule')
      const reminder = await SystemPromptService.buildSystemReminder('C:\\test')
      expect(reminder).toContain('<system-reminder>')
      expect(reminder).toContain('Test Rule')
      expect(reminder).toContain('# currentDate')
      expect(reminder).toContain('</system-reminder>')
    })
  })
})
