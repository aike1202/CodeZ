import React, { useState } from 'react'
import type { PermissionApprovalResponse, PermissionRequest } from '../../../../shared/types/permission'
import Button from '../ui/Button'
import Card from '../ui/Card'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import { approvalOptionsForRequest } from './permissionApprovalOptions'
import './PermissionApprovalWidget.css'

interface RequestState extends PermissionRequest {
  status: 'pending' | 'approved' | 'denied'
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
      <Stack gap={1.5}>
        <div className="permission-approval-title">需要您的授权 ({pendingRequests.length} 项)</div>
        {pendingRequests.map((request) => {
          const loading = loadingRequestId === request.id
          return (
            <div key={request.id} className={`permission-approval-float-item ${request.critical ? 'is-critical' : ''}`}>
              <Flex align="center" justify="between" gap={2}>
                <span className="permission-approval-tool">{request.critical ? '极度危险' : `L${request.riskLevel}`}</span>
                <span>{request.toolName}</span>
              </Flex>
              <div className="permission-approval-float-details">
                <strong>{request.reason}</strong>
                <pre>{JSON.stringify(request.args, null, 2)}</pre>
                {request.impacts.map((impact) => <div key={`${impact.kind}:${impact.target}`}>{impact.kind}: {impact.target}</div>)}
                <small>规则：{request.ruleId}</small>
                <Flex justify="end" gap={2} className="permission-approval-actions">
                  <Button variant="danger" size="sm" onClick={() => resolve(request.id, { approved: false, scope: 'once' })} disabled={loading}>拒绝</Button>
                  {approvalOptionsForRequest(request).map((option) => (
                    <Button key={option.scope} variant="primary" size="sm" onClick={() => resolve(request.id, { approved: true, scope: option.scope })} disabled={loading}>{option.label}</Button>
                  ))}
                </Flex>
              </div>
            </div>
          )
        })}
      </Stack>
    </Card>
  )
}
