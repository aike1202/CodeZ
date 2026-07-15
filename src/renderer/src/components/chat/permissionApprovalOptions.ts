import type { PermissionApprovalScope, PermissionRequest } from '../../../../shared/types/permission'

export interface ApprovalOption {
  scope: PermissionApprovalScope
  label: string
}

export function approvalOptionsForRequest(
  request: Pick<PermissionRequest, 'hardline' | 'allowedScopes'> & Partial<Pick<PermissionRequest, 'riskLevel' | 'absoluteRedline'>>
): ApprovalOption[] {
  if (request.absoluteRedline ?? request.hardline ?? request.riskLevel === 4) return [{ scope: 'once', label: '仅本次允许' }]
  const labels = {
    once: '仅本次允许',
    session: '本会话允许',
    workspace: '当前工作区始终允许'
  } as const
  return request.allowedScopes.map((scope) => ({ scope, label: labels[scope] }))
}

export function approvalLabelForRequest(
  request: Pick<PermissionRequest, 'hardline' | 'analysisStatus'> & Partial<Pick<PermissionRequest, 'absoluteRedline' | 'approvalSource' | 'critical'>>
): string {
  if (request.absoluteRedline ?? request.hardline ?? request.critical) return '绝对红线：必须确认'
  if (request.approvalSource === 'model-requested') return '模型请求确认'
  if (request.approvalSource === 'runtime-policy') return '权限策略要求确认'
  return request.analysisStatus === 'unparsed' ? '权限策略要求确认' : '需要授权'
}
