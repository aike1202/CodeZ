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
  const [loadingAll, setLoadingAll] = useState<boolean>(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  
  // 只显示未处理的请求
  const pendingRequests = requests.filter((request) => request.status === 'pending')

  if (pendingRequests.length === 0) return null

  const handleResolveAll = async (approved: boolean) => {
    if (loadingAll) return
    setLoadingAll(true)
    try {
      for (const req of pendingRequests) {
        await onResolve(msgId, req.id, approved)
      }
    } finally {
      setLoadingAll(false)
    }
  }

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }

  return (
    <Card variant="default" className="permission-approval-float-card">
      <Stack gap={1.5}>
        <Flex align="center" justify="between" className="permission-approval-float-header">
          <Flex align="center" gap={2}>
             <div className="permission-approval-pulse-icon">⚠️</div>
             <span className="permission-approval-title">需要您的授权 ({pendingRequests.length})</span>
          </Flex>
          <Flex align="center" gap={2}>
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingAll}
              onClick={() => handleResolveAll(false)}
              className="permission-approval-deny-all"
            >
              拒绝全部
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={loadingAll}
              onClick={() => handleResolveAll(true)}
              className="permission-approval-allow-all"
            >
              允许全部执行
            </Button>
          </Flex>
        </Flex>

        <Stack gap={1}>
          {pendingRequests.map((request) => {
            const isExpanded = expandedId === request.id
            
            // Compute diff numbers if it's an edit tool
            let diffNums = null
            if (['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'apply_patch'].includes(request.toolName)) {
              let argsObj = request.args
              if (typeof argsObj === 'string') {
                try { argsObj = JSON.parse(argsObj) } catch {}
              }
              argsObj = argsObj || {}
              
              let additions = 0
              let deletions = 0
              if (request.toolName === 'write_to_file') {
                const content = argsObj.codeContent || argsObj.code_content || ''
                additions = content ? content.split('\n').length : 0
              } else if (request.toolName === 'replace_file_content') {
                const add = argsObj.replacementContent || ''
                const del = argsObj.targetContent || ''
                additions = add ? add.split('\n').length : 0
                deletions = del ? del.split('\n').length : 0
              } else if (request.toolName === 'apply_patch') {
                if (Array.isArray(argsObj.edits)) {
                  argsObj.edits.forEach((edit: any) => {
                    const add = String(edit.replacementContent || '')
                    const del = String(edit.targetContent || '')
                    additions += add ? add.split('\n').length : 0
                    deletions += del ? del.split('\n').length : 0
                  })
                } else if (typeof argsObj.newContent === 'string') {
                  additions = argsObj.newContent ? argsObj.newContent.split('\n').length : 0
                }
              } else if (request.toolName === 'multi_replace_file_content') {
                const chunks = Array.isArray(argsObj.ReplacementChunks) ? argsObj.ReplacementChunks : (Array.isArray(argsObj.replacementChunks) ? argsObj.replacementChunks : [])
                chunks.forEach((chunk: any) => {
                  const add = chunk.ReplacementContent || chunk.replacementContent || ''
                  const del = chunk.TargetContent || chunk.targetContent || ''
                  additions += add ? String(add).split('\n').length : 0
                  deletions += del ? String(del).split('\n').length : 0
                })
              }
              diffNums = { adds: additions, dels: deletions }
            }

            return (
              <div key={request.id} className={`permission-approval-float-item permission-approval-risk-${request.risk}`}>
                <Flex align="center" justify="between" gap={3}>
                  <Flex align="center" gap={2} className="permission-approval-short-info">
                    <span className="permission-approval-risk">{riskLabel(request.risk)}</span>
                    <span className="permission-approval-tool" onClick={() => toggleExpand(request.id)}>{request.toolName}</span>
                    <span className="permission-approval-desc-inline" onClick={() => toggleExpand(request.id)}>{request.description}</span>
                  </Flex>
                  {diffNums && (
                    <Flex align="center" gap={1.5} style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11.5px', flexShrink: 0 }}>
                      <span style={{ color: '#16a34a' }}>+{diffNums.adds}</span>
                      <span style={{ color: '#dc2626' }}>-{diffNums.dels}</span>
                    </Flex>
                  )}
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
