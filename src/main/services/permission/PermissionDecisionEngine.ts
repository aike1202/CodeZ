import type { PermissionAction, PermissionCapability, PermissionCheck, PermissionMode } from '../../../shared/types/permission'

const AUTO_ALLOW = new Set<PermissionCapability>(['read', 'edit', 'shell'])

export class PermissionDecisionEngine {
  decide(input: {
    mode: PermissionMode
    permission: PermissionCapability
    explicitRule?: 'allow' | 'deny' | null
  }): { action: PermissionAction } {
    if (input.explicitRule === 'deny') return { action: 'deny' }
    if (input.permission === 'hardline') return { action: 'ask' }
    if (input.explicitRule === 'allow') return { action: 'allow' }
    if (input.mode === 'full-access') return { action: 'allow' }
    return { action: AUTO_ALLOW.has(input.permission) ? 'allow' : 'ask' }
  }

  aggregate(checks: PermissionCheck[]): PermissionAction {
    if (checks.some((check) => check.action === 'deny')) return 'deny'
    if (checks.some((check) => check.action === 'ask')) return 'ask'
    return 'allow'
  }
}
