import React, { useState } from 'react'
import Button from '../ui/Button'
import Card from '../ui/Card'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import './PermissionApprovalWidget.css'

interface PermissionRequest {
  id: string
  toolName: string
  risk: string
  description: string
  args: any
  status: 'pending' | 'approved' | 'denied'
}

interface PermissionApprovalWidgetProps {
  msgId: string
  requests: PermissionRequest[]
  onResolve: (msgId: string, requestId: string, approved: boolean) => Promise<void>
}

function riskLabel(risk: string): string {
  switch (risk) {
    case 'safe':
      return '安全'
    case 'write':
      return '写入'
    case 'network':
      return '网络'
    case 'destructive':
      return '高风险'
    default:
      return '未知'
  }
}

export default function PermissionApprovalWidget({ msgId, requests, onResolve }: PermissionApprovalWidgetProps) {
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const pendingRequests = requests.filter((request) => request.status === 'pending')
  const resolvedRequests = requests.filter((request) => request.status !== 'pending')

  if (requests.length === 0) return null

  const handleResolve = async (requestId: string, approved: boolean) => {
    if (loadingId) return
    setLoadingId(requestId)
    try {
      await onResolve(msgId, requestId, approved)
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <Card variant="default" className="permission-approval-card">
      <Stack gap={3}>
        <Flex align="center" justify="between" className="permission-approval-header">
          <span className="permission-approval-title">权限审批</span>
          <span className="permission-approval-count">{pendingRequests.length} 个待处理</span>
        </Flex>

        <Stack gap={2}>
          {requests.map((request) => {
            const isPending = request.status === 'pending'
            const isLoading = loadingId === request.id
            return (
              <div key={request.id} className={`permission-approval-item permission-approval-risk-${request.risk}`}>
                <Flex align="start" justify="between" gap={3}>
                  <Stack gap={1} className="permission-approval-body">
                    <Flex align="center" gap={2}>
                      <span className="permission-approval-risk">{riskLabel(request.risk)}</span>
                      <span className="permission-approval-tool">{request.toolName}</span>
                    </Flex>
                    <div className="permission-approval-desc">{request.description}</div>
                    <details className="permission-approval-details">
                      <summary>查看参数</summary>
                      <pre>{JSON.stringify(request.args, null, 2)}</pre>
                    </details>
                  </Stack>

                  <Flex align="center" gap={1} className="permission-approval-actions">
                    {isPending ? (
                      <>
                        <Button
                          variant="ghost"
                          size="none"
                          disabled={isLoading}
                          onClick={() => handleResolve(request.id, false)}
                          className="permission-approval-deny"
                        >
                          拒绝
                        </Button>
                        <Button
                          variant="primary"
                          size="none"
                          disabled={isLoading}
                          onClick={() => handleResolve(request.id, true)}
                          className="permission-approval-allow"
                        >
                          允许
                        </Button>
                      </>
                    ) : (
                      <span className={`permission-approval-status permission-approval-status-${request.status}`}>
                        {request.status === 'approved' ? '已允许' : '已拒绝'}
                      </span>
                    )}
                  </Flex>
                </Flex>
              </div>
            )
          })}
        </Stack>

        {resolvedRequests.length > 0 && pendingRequests.length === 0 && (
          <div className="permission-approval-note">所有权限请求已处理。</div>
        )}
      </Stack>
    </Card>
  )
}
