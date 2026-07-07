import React, { useState, useMemo } from 'react'
import Button from '../ui/Button'
import Card from '../ui/Card'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import {
  generateCommandRuleOptions,
  PERMISSION_SCOPE_OPTIONS,
  type CommandRuleOption,
  type PermissionRuleScope
} from './permissionApprovalOptions'
import { actionLabel, riskLabel } from './permissionApprovalLabels'
import './PermissionApprovalWidget.css'

interface PermissionRequest {
  id: string
  toolName: string
  risk: string
  action?: string
  reason?: string
  impacts?: string[]
  description: string
  args: any
  ruleOptions?: CommandRuleOption[]
  status: 'pending' | 'approved' | 'denied'
}

interface PermissionApprovalWidgetProps {
  msgId: string
  requests: PermissionRequest[]
  onResolve: (msgId: string, requestId: string, approved: boolean) => Promise<void>
}

interface BashPermissionOptionsProps {
  msgId: string
  request: PermissionRequest
  loading: boolean
  setLoading: (loading: boolean) => void
  onResolve: PermissionApprovalWidgetProps['onResolve']
}

function BashPermissionOptions({
  msgId,
  request,
  loading,
  setLoading,
  onResolve
}: BashPermissionOptionsProps) {
  const cmd = (request.args?.commandLine || request.args?.CommandLine || request.args?.command || '').trim()
  const ruleOptions = useMemo(
    () => request.ruleOptions && request.ruleOptions.length > 0
      ? request.ruleOptions
      : generateCommandRuleOptions(cmd),
    [cmd, request.ruleOptions]
  )
  const [selectedRule, setSelectedRule] = useState<CommandRuleOption>(ruleOptions[0])

  const dispatchApproval = async (scope: PermissionRuleScope) => {
    if (loading) return
    setLoading(true)
    try {
      if (scope !== 'once' && window.api.permissions?.addRule) {
        await window.api.permissions.addRule(selectedRule.rule, scope)
      }
      await onResolve(msgId, request.id, true)
    } catch(e) {
       console.error(e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="permission-review">
       <div className="permission-command-block">
         <div className="permission-section-label">完整命令</div>
         <code>{cmd}</code>
       </div>
       <div className="permission-review-grid">
         <div className="permission-review-main">
           <div className="permission-facts">
             <span>{actionLabel(request.action)}</span>
             {(request.impacts || []).map((impact) => <span key={impact}>{impact}</span>)}
           </div>
           <div className="permission-review-reason">
             {request.reason || '未提供风险原因，按当前风险等级处理。'}
           </div>
           <div className="permission-section-label">允许规则</div>
           <div className="permission-rule-list">
             {ruleOptions.map((option) => (
               <button
                 key={option.id}
                 className={`permission-rule-btn ${selectedRule.id === option.id ? 'selected' : ''}`}
                 onClick={() => setSelectedRule(option)}
                 disabled={loading}
               >
                 <span>{option.label}</span>
                 <code>{option.rule}</code>
                 <small>{option.description}</small>
               </button>
             ))}
           </div>
           {ruleOptions.length === 1 && request.risk === 'destructive' && (
             <div className="permission-rule-note">高风险命令不提供通配保存，只能选择精确命令。</div>
           )}
         </div>
         <div className="permission-scope-list">
           <div className="permission-section-label">授权方式</div>
           {PERMISSION_SCOPE_OPTIONS.map((option) => (
             <button
               key={option.id}
               className="permission-option-btn"
               onClick={() => dispatchApproval(option.id)}
               disabled={loading}
             >
               {option.label}
             </button>
           ))}
           <button
             className="permission-option-btn permission-deny-btn"
             onClick={() => onResolve(msgId, request.id, false)}
             disabled={loading}
           >
             拒绝执行
           </button>
         </div>
       </div>
    </div>
  )
}

export default function PermissionApprovalWidget({ msgId, requests, onResolve }: PermissionApprovalWidgetProps) {
  const [loadingAll, setLoadingAll] = useState<boolean>(false)
  
  // 只显示未处理的请求 (状态为pending的才会弹这里)
  const pendingRequests = requests.filter((request) => request.status === 'pending')

  if (pendingRequests.length === 0) return null

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
                <div>
                  {isBash ? (
                     <BashPermissionOptions
                       msgId={msgId}
                       request={request}
                       loading={loadingAll}
                       setLoading={setLoadingAll}
                       onResolve={onResolve}
                     />
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
