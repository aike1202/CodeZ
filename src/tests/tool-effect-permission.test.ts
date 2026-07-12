import { describe, expect, it } from 'vitest'
import { PermissionManager } from '../main/services/PermissionManager'

describe('PermissionManager effect plans', () => {
  it('derives the primary capability from declared effects', async () => {
    const manager = new PermissionManager()
    const decision = await manager.evaluateEffectPlan(
      'ExternalWriter',
      {},
      {
        analysisStatus: 'parsed',
        effects: [{ kind: 'write-file', path: 'C:\\workspace\\src\\a.ts', mode: 'modify' }]
      },
      {
        workspaceRoot: 'C:\\workspace',
        cwd: 'C:\\workspace',
        platform: 'win32',
        mode: 'auto'
      }
    )
    expect(decision.permission).toBe('edit')
    expect(decision.ruleId).toBe('tool.effect-plan')
    expect(decision.analysisStatus).toBe('parsed')
  })
})
