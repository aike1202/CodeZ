import React, { useState, useMemo } from 'react'
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

function generateCommandOptions(cmd: string = '') {
   const options = [{ label: `精确匹配: ${cmd}`, rule: cmd }]
   const parts = cmd.trim().split(/s+/)
   if (parts.length > 2) {
      options.push({ label: `子命令: ${parts[0]} ${parts[1]} *`, rule: `${parts[0]} ${parts[1]} *`})
   }
   if (parts.length > 1) {
      options.push({ label: `全部操作: ${parts[0]} *`, rule: `${parts[0]} *` })
   }
   return options
}

function riskLabel(risk: string): string {
  switch (risk) {
    case 'safe': return '安全'
    case 'write': return '写入'
    case 'network': return '网络'
    case 'destructive': return '高风险'
    default: return '未知'
  }
}

export default function PermissionApprovalWidget({ msgId, requests, onResolve }: PermissionApprovalWidgetProps) {
  const [loadingAll, setLoadingAll] = useState<boolean>(false)
  
  // 只显示未处理的请求 (状态为pending的才会弹这里)
  const pendingRequests = requests.filter((request) => request.status === 'pending')

  if (pendingRequests.length === 0) return null

  // 批量拒绝所有兜底
  const handleDenyAll = async () => {
    if (loadingAll) return
    setLoadingAll(true)
    try {
      for (const req of pendingRequests) {
        await onResolve(msgId, req.id, false)
      }
    } finally {
      setLoadingAll(false)
    }
  }

  // 组件：负责单行的 Bash 快捷按键处理
  const BashPermOptions = ({ request }: { request: PermissionRequest }) => {
    const cmd = (request.args?.commandLine || request.args?.CommandLine || request.args?.command || '').trim();
    const opts = useMemo(() => generateCommandOptions(cmd), [cmd]);

    const dispatchApproval = async (rule: string, scope: 'once'|'session'|'global') => {
      if (loadingAll) return;
      setLoadingAll(true);
      try {
        if (scope !== 'once' && (window.api as any)?.permissions?.addRule) {
          // @ts-ignore
          await window.api.permissions.addRule(rule, scope);
        }
        await onResolve(msgId, request.id, true);
      } catch(e) {
         console.error(e)
      } finally {
        setLoadingAll(false);
      }
    };

    return (
      <div style={{ marginTop: '8px' }}>
         <div className="permission-cmd-highlight">
           执行: <code style={{ userSelect: 'all', color: 'var(--text-main)' }}>{cmd}</code>
         </div>
         <Stack gap={1} style={{ marginTop: '8px' }}>
           <button className="permission-option-btn" onClick={() => dispatchApproval(cmd, 'once')} disabled={loadingAll}>
             <span style={{color: '#16a34a', fontWeight: 'bold', width: '20px'}}>✓</span> 仅此次允许执行
           </button>
           {opts[1] && (
             <button className="permission-option-btn" onClick={() => dispatchApproval(opts[1].rule, 'session')} disabled={loadingAll}>
               <span style={{color: '#eab308', fontWeight: 'bold', width: '20px'}}>⚡</span> 允许本会话使用 <code>{opts[1].rule}</code>
             </button>
           )}
           {opts[2] && (
             <button className="permission-option-btn" onClick={() => dispatchApproval(opts[2].rule, 'global')} disabled={loadingAll}>
               <span style={{color: '#3b82f6', fontWeight: 'bold', width: '20px'}}>🌐</span> 全局始终允许 <code>{opts[2].rule}</code>
             </button>
           )}
         </Stack>
      </div>
    )
  }

  return (
    <Card variant="default" className="permission-approval-float-card dropdown-shadow">
      <Stack gap={1.5}>
        <Flex align="center" justify="between" className="permission-approval-float-header">
          <Flex align="center" gap={2}>
             <div className="permission-approval-pulse-icon">⚠️</div>
             <span className="permission-approval-title">需要您的授权 ({pendingRequests.length} 行动)</span>
          </Flex>
          
        </Flex>

        <Stack gap={1}>
          {pendingRequests.map((request) => {
            const isBash = (request.toolName === 'Bash' || request.toolName === 'PowerShell') && (request.args?.commandLine || request.args?.CommandLine || request.args?.command)
            
            return (
              <div key={request.id} className={`permission-approval-float-item permission-approval-risk-${request.risk}`}>
                <Flex align="center" justify="between" gap={3}>
                  <Flex align="center" gap={2} className="permission-approval-short-info">
                    <span className="permission-approval-risk">{riskLabel(request.risk)}</span>
                    <span className="permission-approval-tool">{request.toolName}</span>
                    <span className="permission-approval-desc-inline">{request.description}</span>
                  </Flex>
                </Flex>
                
                <div style={{ marginTop: '8px' }}>
                  {isBash ? (
                     <BashPermOptions request={request} />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <pre style={{ margin: 0, padding: '8px', background: 'var(--bg-surface)', borderRadius: '4px', fontSize: '11px', overflowX: 'auto', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                         {JSON.stringify(request.args, null, 2)}
                      </pre>
                      <Flex justify="end" gap={2}>
                        <Button variant="danger" size="sm" onClick={() => onResolve(msgId, request.id, false)} disabled={loadingAll}>拒绝执行</Button>
                        <Button variant="primary" size="sm" onClick={() => onResolve(msgId, request.id, true)} disabled={loadingAll}>仅允许此次</Button>
                      </Flex>
                    </div>
                  )}
                </div>
                
              </div>
            )
          })}
        </Stack>
      </Stack>
    </Card>
  )
}
