import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { RulesResolver } from '../main/agent/RulesResolver'

describe('RulesResolver', () => {
  const mockWorkspace = path.join(__dirname, 'mock_workspace')
  const mockHomeDir = path.join(__dirname, 'mock_home')

  beforeEach(async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHomeDir)
    await fs.mkdir(mockWorkspace, { recursive: true })
    await fs.mkdir(mockHomeDir, { recursive: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(mockWorkspace, { recursive: true, force: true })
    await fs.rm(mockHomeDir, { recursive: true, force: true })
  })

  it('should load global and workspace rules and concatenate them', async () => {
    // Setup workspace rules
    await fs.writeFile(path.join(mockWorkspace, 'AGENTS.md'), 'Workspace Agent Rule')
    const codezRulesDir = path.join(mockWorkspace, '.codez', 'rules')
    await fs.mkdir(codezRulesDir, { recursive: true })
    await fs.writeFile(path.join(codezRulesDir, 'test-rule.md'), 'Workspace Custom Rule')

    // Setup global rules
    const globalCodezRulesDir = path.join(mockHomeDir, '.codez', 'rules')
    await fs.mkdir(globalCodezRulesDir, { recursive: true })
    await fs.writeFile(path.join(globalCodezRulesDir, 'global-test-rule.md'), 'Global Custom Rule')

    const rules = await RulesResolver.getRules(mockWorkspace)
    
    expect(rules).toContain('Workspace Agent Rule')
    expect(rules).toContain('Workspace Custom Rule')
    expect(rules).toContain('Global Custom Rule')
  })
})
