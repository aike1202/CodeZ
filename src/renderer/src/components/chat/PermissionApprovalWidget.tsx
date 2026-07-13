import React, { useState } from 'react'
import type { PermissionApprovalResponse, PermissionRequest } from '../../../../shared/types/permission'
import Button from '../ui/Button'
import Card from '../ui/Card'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import { approvalOptionsForRequest } from './permissionApprovalOptions'
import './PermissionApprovalWidget.css'

interface RequestState extends PermissionRequest {
  status: 'pending' | 'approved' | 'denied' | 'interrupted'
}

interface PermissionApprovalWidgetProps {
  msgId: string
  requests: RequestState[]
  onResolve: (msgId: string, requestId: string, response: PermissionApprovalResponse) => Promise<void>
}

export default function PermissionApprovalWidget({ msgId, requests, onResolve }: PermissionApprovalWidgetProps) {
  const [loadingRequestId, setLoadingRequestId] = useState<string | null>(null)
  const pendingRequests = requests.filter((request) => request.status === 'pending')
  if (pendingRequests.length === 0) return null

  const resolve = async (requestId: string, response: PermissionApprovalResponse) => {
    if (loadingRequestId) return
    setLoadingRequestId(requestId)
    try {
      await onResolve(msgId, requestId, response)
    } finally {
      setLoadingRequestId(null)
    }
  }

  return (
    <Card variant="default" className="permission-approval-float-card dropdown-shadow">
      <Stack gap={1.5} className="permission-approval-stack">
        <div className="permission-approval-title">需要您的授权 ({pendingRequests.length} 项)</div>
        <div className="permission-approval-list">
          {pendingRequests.map((request) => {
            const loading = loadingRequestId === request.id
            const hardline = request.hardline ?? request.critical
            const unparsed = !hardline && request.analysisStatus === 'unparsed'
            const label = hardline ? '极度危险' : unparsed ? '无法完整分析' : '需要授权'
            const visibleChecks = (request.checks ?? []).filter((check) => check.action !== 'allow')
            return (
              <div key={request.id} className={`permission-approval-float-item ${hardline ? 'is-critical' : unparsed ? 'is-unparsed' : ''}`}>
                <Flex align="center" justify="between" gap={2}>
                  <span className="permission-approval-tool">{label}</span>
                  <span>{request.toolName}</span>
                </Flex>
                <div className="permission-approval-float-details">
                  <div className="permission-approval-detail-scroll">
                    <strong>{request.reason}</strong>
                    <pre>{JSON.stringify(request.args, null, 2)}</pre>
                    {visibleChecks.map((check) => (
                      <div key={`${check.permission}:${check.pattern}`}>{check.permission}: {check.pattern}</div>
                    ))}
                    {request.impacts.map((impact) => <div key={`${impact.kind}:${impact.target}`}>{impact.kind}: {impact.target}</div>)}
                    <small>规则：{request.ruleId}</small>
                  </div>
                  <Flex justify="end" gap={2} wrap="wrap" className="permission-approval-actions">
                    <Button variant="danger" size="sm" onClick={() => resolve(request.id, { approved: false, scope: 'once' })} disabled={loading}>拒绝</Button>
                    {approvalOptionsForRequest(request).map((option) => (
                      <Button key={option.scope} variant="primary" size="sm" onClick={() => resolve(request.id, { approved: true, scope: option.scope })} disabled={loading}>{option.label}</Button>
                    ))}
                  </Flex>
                </div>
              </div>
            )
          })}
        </div>
      </Stack>
    </Card>
  )
}
