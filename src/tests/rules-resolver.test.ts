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
    (os.homedir as any).mockReturnValue(mockHomeDir)
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
})
