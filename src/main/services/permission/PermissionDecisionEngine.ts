import type { PermissionAction, PermissionMode, PermissionRiskLevel } from '../../../shared/types/permission'

export class PermissionDecisionEngine {
  decide(input: {
    mode: PermissionMode
    riskLevel: PermissionRiskLevel
    known: boolean
    critical: boolean
    explicitRule?: 'allow' | 'deny' | null
  }): { action: PermissionAction } {
    if (input.explicitRule === 'deny') return { action: 'deny' }
    if (input.critical || input.riskLevel === 4) return { action: 'ask' }
    if (input.explicitRule === 'allow') return { action: 'allow' }
    if (!input.known) return { action: input.mode === 'full-access' ? 'allow' : 'ask' }
    if (input.mode === 'full-access') return { action: 'allow' }
    return { action: input.riskLevel <= 1 ? 'allow' : 'ask' }
  }
}
