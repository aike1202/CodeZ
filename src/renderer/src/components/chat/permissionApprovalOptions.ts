import type { PermissionApprovalScope, PermissionRequest } from '../../../../shared/types/permission'

export interface ApprovalOption {
  scope: PermissionApprovalScope
  label: string
}

export function approvalOptionsForRequest(
  request: Pick<PermissionRequest, 'hardline' | 'allowedScopes'> & Partial<Pick<PermissionRequest, 'riskLevel'>>
): ApprovalOption[] {
  if (request.hardline ?? request.riskLevel === 4) return [{ scope: 'once', label: '仅本次允许' }]
  const labels = {
    once: '仅本次允许',
    session: '本会话允许',
    workspace: '当前工作区始终允许'
  } as const
  return request.allowedScopes.map((scope) => ({ scope, label: labels[scope] }))
}
