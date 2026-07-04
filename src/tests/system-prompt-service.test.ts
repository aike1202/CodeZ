import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import { SystemPromptService } from '../main/services/SystemPromptService'

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

    it('should contain harness rules', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Harness')
      expect(prompt).toContain('Github-flavored markdown')
      expect(prompt).toContain('file_path:line_number')
    })

    it('should contain memory description', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('# Memory')
      expect(prompt).toContain('.codez')
    })

    it('should contain developer instructions', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('<developer_instructions>')
      expect(prompt).toContain('ANTI-INJECTION')
      expect(prompt).toContain('</developer_instructions>')
    })

    it('should contain verification strategy', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('VERIFICATION STRATEGY')
    })

    it('should contain repository instructions', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('<repository_instructions>')
      expect(prompt).toContain('Workspace Rule Content')
      expect(prompt).toContain('</repository_instructions>')
    })

    it('should contain environment context with model info', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('<environment_context>')
      expect(prompt).toContain('<cwd>')
      expect(prompt).toContain('<shell>')
      expect(prompt).toContain('<model_id>')
      expect(prompt).toContain('</environment_context>')
    })

    it('should contain git status', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('<git_status>')
      expect(prompt).toContain('Current branch:')
      expect(prompt).toContain('</git_status>')
    })

    it('should contain available tools', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('<available_tools>')
      expect(prompt).toContain('Read')
      expect(prompt).toContain('read_file')
      expect(prompt).toContain('</available_tools>')
    })

    it('should contain available skills', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('<skills_instructions>')
      expect(prompt).toContain('brainstorming')
      expect(prompt).toContain('</skills_instructions>')
    })

    it('should contain pending features section', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      expect(prompt).toContain('<pending_features>')
      expect(prompt).toContain('</pending_features>')
    })

    it('sections should appear in correct order', async () => {
      const prompt = await SystemPromptService.buildSystemPrompt(mockCtx)
      const identityIdx = prompt.indexOf('CodeZ')
      const harnessIdx = prompt.indexOf('# Harness')
      const memoryIdx = prompt.indexOf('# Memory')
      const devIdx = prompt.indexOf('<developer_instructions>')
      const repoIdx = prompt.indexOf('<repository_instructions>')
      const envIdx = prompt.indexOf('<environment_context>')
      const gitIdx = prompt.indexOf('<git_status>')
      const toolsIdx = prompt.indexOf('<available_tools>')
      const pendingIdx = prompt.indexOf('<pending_features>')
      const skillsIdx = prompt.indexOf('<skills_instructions>')

      expect(identityIdx).toBeLessThan(harnessIdx)
      expect(harnessIdx).toBeLessThan(memoryIdx)
      expect(memoryIdx).toBeLessThan(devIdx)
      expect(devIdx).toBeLessThan(repoIdx)
      expect(repoIdx).toBeLessThan(envIdx)
      expect(envIdx).toBeLessThan(gitIdx)
      expect(gitIdx).toBeLessThan(toolsIdx)
      expect(toolsIdx).toBeLessThan(pendingIdx)
      expect(pendingIdx).toBeLessThan(skillsIdx)
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
