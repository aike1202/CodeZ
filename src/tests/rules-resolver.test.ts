import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { RulesResolver } from '../main/agent/RulesResolver'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: vi.fn()
  }
})

describe('RulesResolver', () => {
  const mockWorkspace = path.join(__dirname, 'mock_workspace')
  const mockHomeDir = path.join(__dirname, 'mock_home')

  beforeEach(async () => {
    RulesResolver.clearLoadedDirectoryRules()
    ;(os.homedir as any).mockReturnValue(mockHomeDir)
    await fs.mkdir(mockWorkspace, { recursive: true })
    await fs.mkdir(mockHomeDir, { recursive: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(mockWorkspace, { recursive: true, force: true })
    await fs.rm(mockHomeDir, { recursive: true, force: true })
  })

  describe('getGlobalRules', () => {
    it('should return empty string when no global rules exist', async () => {
      const rules = await RulesResolver.getGlobalRules()
      expect(rules).toBe('')
    })

    it('should load global rules from ~/.codez/AGENTS.md', async () => {
      const codezDir = path.join(mockHomeDir, '.codez')
      await fs.mkdir(codezDir, { recursive: true })
      await fs.writeFile(path.join(codezDir, 'AGENTS.md'), 'Global Agent Rule')

      const rules = await RulesResolver.getGlobalRules()
      expect(rules).toContain('Global Agent Rule')
    })

    it('should load global rules from ~/.codez/rules/*.md', async () => {
      const rulesDir = path.join(mockHomeDir, '.codez', 'rules')
      await fs.mkdir(rulesDir, { recursive: true })
      await fs.writeFile(path.join(rulesDir, 'style.md'), 'Global Style Rule')

      const rules = await RulesResolver.getGlobalRules()
      expect(rules).toContain('Global Style Rule')
    })
  })

  describe('getWorkspaceRules', () => {
    it('should return empty string when no workspace rules exist', async () => {
      const rules = await RulesResolver.getWorkspaceRules(mockWorkspace)
      expect(rules).toBe('')
    })

    it('should load workspace AGENTS.md', async () => {
      await fs.writeFile(path.join(mockWorkspace, 'AGENTS.md'), 'Workspace Agent Rule')

      const rules = await RulesResolver.getWorkspaceRules(mockWorkspace)
      expect(rules).toContain('Workspace Agent Rule')
    })

    it('should load .clinerules', async () => {
      await fs.writeFile(path.join(mockWorkspace, '.clinerules'), 'Cline Rule')

      const rules = await RulesResolver.getWorkspaceRules(mockWorkspace)
      expect(rules).toContain('Cline Rule')
    })

    it('should load .cursorrules', async () => {
      await fs.writeFile(path.join(mockWorkspace, '.cursorrules'), 'Cursor Rule')

      const rules = await RulesResolver.getWorkspaceRules(mockWorkspace)
      expect(rules).toContain('Cursor Rule')
    })

    it('should load workspace .codez/rules/*.md', async () => {
      const rulesDir = path.join(mockWorkspace, '.codez', 'rules')
      await fs.mkdir(rulesDir, { recursive: true })
      await fs.writeFile(path.join(rulesDir, 'project.md'), 'Project Rule')

      const rules = await RulesResolver.getWorkspaceRules(mockWorkspace)
      expect(rules).toContain('Project Rule')
    })
  })

  describe('directory-scoped rules', () => {
    it('loads nested AGENTS.md only when a file in that directory is read', async () => {
      const featureDir = path.join(mockWorkspace, 'src', 'feature')
      await fs.mkdir(featureDir, { recursive: true })
      await fs.writeFile(path.join(mockWorkspace, 'AGENTS.md'), 'Root Rule')
      await fs.writeFile(path.join(featureDir, 'AGENTS.md'), 'Feature Rule')
      const target = path.join(featureDir, 'index.ts')
      await fs.writeFile(target, 'export {}')

      const instruction = await RulesResolver.loadDirectoryRulesForFiles(
        mockWorkspace,
        [target],
        'session-1'
      )
      expect(instruction).toContain('<directory_instructions>')
      expect(instruction).toContain('Feature Rule')
      expect(instruction).not.toContain('Root Rule')
      expect(RulesResolver.getLoadedDirectoryRules('session-1')).toContain('Feature Rule')

      const duplicate = await RulesResolver.loadDirectoryRulesForFiles(
        mockWorkspace,
        [target],
        'session-1'
      )
      expect(duplicate).toBe('')
    })

    it('ignores paths outside the workspace', async () => {
      const outside = path.join(mockHomeDir, 'outside.ts')
      await fs.writeFile(outside, 'outside')
      await expect(RulesResolver.loadDirectoryRulesForFiles(
        mockWorkspace,
        [outside],
        'session-2'
      )).resolves.toBe('')
    })

    it('removes cached directory rules when the source file is deleted', async () => {
      const featureDir = path.join(mockWorkspace, 'src', 'feature')
      const rulePath = path.join(featureDir, 'AGENTS.md')
      const target = path.join(featureDir, 'index.ts')
      await fs.mkdir(featureDir, { recursive: true })
      await fs.writeFile(rulePath, 'Temporary Feature Rule')
      await fs.writeFile(target, 'export {}')

      await RulesResolver.loadDirectoryRulesForFiles(mockWorkspace, [target], 'session-3')
      expect(RulesResolver.getLoadedDirectoryRules('session-3')).toContain('Temporary Feature Rule')

      await fs.rm(rulePath)
      await RulesResolver.loadDirectoryRulesForFiles(mockWorkspace, [target], 'session-3')
      expect(RulesResolver.getLoadedDirectoryRules('session-3')).toBe('')
    })
  })
})
