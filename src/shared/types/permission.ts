export type PermissionMode = 'auto' | 'full-access'
export type PermissionRiskLevel = 0 | 1 | 2 | 3 | 4
export type PermissionAction = 'allow' | 'ask' | 'deny'
export type PermissionApprovalScope = 'once' | 'session' | 'workspace'
export type ToolApprovalPreference = 'auto' | 'user'
export type PermissionApprovalSource = 'model-requested' | 'runtime-policy' | 'absolute-redline'
export type PermissionCapability =
  | 'read'
  | 'edit'
  | 'shell'
  | 'shell_unparsed'
  | 'network'
  | 'external_effect'
  | 'external_directory'
  | 'delete'
  | 'rollback'
  | 'unknown'
  | 'hardline'
export type PermissionAnalysisStatus = 'parsed' | 'unparsed'

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto'

export function allowedScopesForDecision(hardline: boolean): PermissionApprovalScope[] {
  return hardline ? ['once'] : ['once', 'session', 'workspace']
}

export function allowedScopesForRisk(riskLevel: PermissionRiskLevel): PermissionApprovalScope[] {
  return allowedScopesForDecision(riskLevel === 4)
}

export interface PermissionImpact {
  kind: 'workspace' | 'external-path' | 'network' | 'git-remote' | 'system' | 'credential' | 'process'
  target: string
}

export interface PermissionSnapshot {
  path: string
  sha256: string
}

export interface PermissionCheck {
  permission: PermissionCapability
  pattern: string
  action: PermissionAction
  reason: string
}

export interface PermissionDecision {
  action: PermissionAction
  permission: PermissionCapability
  checks: PermissionCheck[]
  analysisStatus: PermissionAnalysisStatus
  hardline: boolean
  riskLevel: PermissionRiskLevel
  reason: string
  ruleId: string
  normalizedPattern: string
  impacts: PermissionImpact[]
  snapshots: PermissionSnapshot[]
  critical: boolean
  modelApprovalPreference?: ToolApprovalPreference | null
  approvalSource?: PermissionApprovalSource
  absoluteRedline?: boolean
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
