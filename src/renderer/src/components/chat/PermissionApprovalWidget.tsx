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
  const [expandedId, setExpandedId] = useState<string | null>(null)
  
  // 只显示未处理的请求
  const pendingRequests = requests.filter((request) => request.status === 'pending')

  if (pendingRequests.length === 0) return null

  const handleResolve = async (requestId: string, approved: boolean) => {
    if (loadingId) return
    setLoadingId(requestId)
    try {
      await onResolve(msgId, requestId, approved)
    } finally {
      setLoadingId(null)
    }
  }

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }

  return (
    <Card variant="default" className="permission-approval-float-card">
      <Stack gap={2}>
        <Flex align="center" justify="between" className="permission-approval-float-header">
          <Flex align="center" gap={2}>
             <div className="permission-approval-pulse-icon">⚠️</div>
             <span className="permission-approval-title">需要您的授权 ({pendingRequests.length})</span>
          </Flex>
        </Flex>

        <Stack gap={2}>
          {pendingRequests.map((request) => {
            const isLoading = loadingId === request.id
            const isExpanded = expandedId === request.id
            return (
              <div key={request.id} className={`permission-approval-float-item permission-approval-risk-${request.risk}`}>
                <Flex align="center" justify="between" gap={3}>
                  <Flex align="center" gap={2} className="permission-approval-short-info">
                    <span className="permission-approval-risk">{riskLabel(request.risk)}</span>
                    <span className="permission-approval-tool" onClick={() => toggleExpand(request.id)}>{request.toolName}</span>
                    <span className="permission-approval-desc-inline" onClick={() => toggleExpand(request.id)}>{request.description}</span>
                  </Flex>

                  <Flex align="center" gap={2} className="permission-approval-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isLoading}
                      onClick={() => handleResolve(request.id, false)}
                      className="permission-approval-deny"
                    >
                      拒绝
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={isLoading}
                      onClick={() => handleResolve(request.id, true)}
                      className="permission-approval-allow"
                    >
                      允许执行
                    </Button>
                  </Flex>
                </Flex>
                
                {isExpanded && (
                  <div className="permission-approval-float-details">
                    <pre>{JSON.stringify(request.args, null, 2)}</pre>
                  </div>
                )}
              </div>
            )
          })}
        </Stack>
      </Stack>
    </Card>
  )
}
