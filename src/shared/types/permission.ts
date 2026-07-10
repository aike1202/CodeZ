export type PermissionMode = 'auto' | 'full-access'
export type PermissionRiskLevel = 0 | 1 | 2 | 3 | 4
export type PermissionAction = 'allow' | 'ask' | 'deny'
export type PermissionApprovalScope = 'once' | 'session' | 'workspace'

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto'

export function allowedScopesForRisk(riskLevel: PermissionRiskLevel): PermissionApprovalScope[] {
  return riskLevel === 4 ? ['once'] : ['once', 'session', 'workspace']
}

export interface PermissionImpact {
  kind: 'workspace' | 'external-path' | 'network' | 'git-remote' | 'system' | 'credential' | 'process'
  target: string
}

export interface PermissionSnapshot {
  path: string
  sha256: string
}

export interface PermissionDecision {
  action: PermissionAction
  riskLevel: PermissionRiskLevel
  reason: string
  ruleId: string
  normalizedPattern: string
  impacts: PermissionImpact[]
  snapshots: PermissionSnapshot[]
  critical: boolean
}

export interface PermissionRequest extends PermissionDecision {
  id: string
  sessionId?: string
  agentId?: string
  toolName: string
  description: string
  args: unknown
  allowedScopes: PermissionApprovalScope[]
}

export interface PermissionApprovalResponse {
  approved: boolean
  scope: PermissionApprovalScope
}
