import React, { useEffect, useState, useCallback } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useChatStore } from '../../stores/chatStore'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import { Loader2, CheckCircle2, CircleDashed, Play, Archive, FileText, RefreshCw, XCircle, Search } from 'lucide-react'
import './PlanListModal.css'
import { useSendMessage } from './hooks/useSendMessage'

/** Minimal plan shape matching the data returned by PlanStore.list */
interface PlanItem {
  id: string
  slug: string
  title: string
  status: string
  steps: Array<{ id: string; title: string; status: string }>
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  executing: <Play size={16} />,
  suspended: <CircleDashed size={16} />,
  completed: <CheckCircle2 size={16} />,
  pending_review: <FileText size={16} />,
  drafting: <FileText size={16} />,
  revising: <RefreshCw size={16} />,
  abandoned: <Archive size={16} />,
}

const STATUS_CLASS: Record<string, string> = {
  executing: 'plan-status-executing',
  suspended: 'plan-status-suspended',
  completed: 'plan-status-completed',
  pending_review: 'plan-status-review',
  drafting: 'plan-status-drafting',
  revising: 'plan-status-revising',
  abandoned: 'plan-status-abandoned',
}

const STEP_ICONS: Record<string, React.ReactNode> = {
  completed: <CheckCircle2 size={12} />,
  in_progress: <Loader2 size={12} className="spin" />,
  pending: <CircleDashed size={12} />,
  cancelled: <XCircle size={12} />,
}

const STATUS_LABELS: Record<string, string> = {
  executing: '执行中',
  suspended: '已暂挂',
  completed: '已完成',
  pending_review: '待审批',
  drafting: '草稿',
  revising: '修改中',
  abandoned: '已放弃',
}

interface PlanListModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function PlanListModal({ isOpen, onClose }: PlanListModalProps) {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const [plans, setPlans] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(false)
  const { handleSendMessage } = useSendMessage()

  const loadPlans = useCallback(async () => {
    if (!workspace) return
    setLoading(true)
    try {
      const data = (window as any).api.plan.list(workspace.rootPath)
      setPlans(await data || [])
    } catch (err) {
      console.error('[PlanListModal] Failed to load plans:', err)
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    if (isOpen) {
      loadPlans()
    }
  }, [isOpen, loadPlans])

  const handlePlanClick = async (plan: PlanItem) => {
    if (!workspace) return
    try {
      const activeSessionId = useChatStore.getState().activeSessionId
      const msg = `⚡ 计划已就绪：[${plan.title}]\n请分析当前状态并指导下一步工作。`
      if (activeSessionId) {
        await useChatStore.getState().linkPlanToSession(activeSessionId, plan.slug)
      } else {
        const loadedPlan = await (window as any).api.plan.load(workspace.rootPath, plan.slug)
        useChatStore.getState().setActivePlan(loadedPlan)
      }
      useChatStore.getState().setExpandedCapsule('plan')
      onClose()
      
      handleSendMessage(msg, '', true)
    } catch (err) {
      console.error('[PlanListModal] Failed to load plan:', err)
    }
  }

  const handleNewPlan = () => {
    // 可以通过向 agent 发送消息或通过其他方式启动新 Plan
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="plan-list-modal-overlay" onClick={onClose}>
      <div className="plan-list-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="plan-list-modal-header">
          <Search size={16} className="plan-list-search-icon" />
          <input 
            type="text" 
            placeholder="Search plans..." 
            className="plan-list-search-input"
            readOnly // 为了演示保持极简，暂不实现搜索过滤逻辑
          />
          <div className="plan-list-esc-hint" onClick={onClose}>ESC</div>
        </div>

          <div className="plan-list-modal-content">
            {loading ? (
              <div className="plan-list-empty">
                <Loader2 size={24} className="spin" style={{ margin: '0 auto', color: 'var(--text-muted)' }} />
              </div>
            ) : plans.length === 0 ? (
              <div className="plan-list-empty">
                <p>暂无开发计划</p>
                <p className="plan-list-empty-hint">输入 /plan new &lt;目标&gt; 来创建一个新计划</p>
              </div>
            ) : (
              <div className="plan-list-grid">
                {plans.map((plan) => {
                  const statusIcon = STATUS_ICONS[plan.status] || <CircleDashed size={16} />
                  const statusLabel = STATUS_LABELS[plan.status] || plan.status
                  const statusClass = STATUS_CLASS[plan.status] || ''

                  return (
                    <div
                      key={plan.id}
                      className="plan-card-item"
                      onClick={() => handlePlanClick(plan)}
                    >
                      <div className="plan-item-main">
                        <div className={`plan-status-icon ${statusClass}`}>
                          {statusIcon}
                        </div>
                        <div className="plan-item-info">
                          <div className="plan-item-title-row">
                            <span className="plan-title">{plan.title}</span>
                            <span className={`plan-badge ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </div>
                          <span className="plan-slug">{plan.slug}</span>
                        </div>
                      </div>

                      {plan.steps.length > 0 && (
                        <div className="plan-steps-preview">
                          {plan.steps.map((step) => (
                            <span key={step.id} className={`plan-step-icon step-${step.status}`} title={`${step.id} ${step.title}: ${step.status}`}>
                              {STEP_ICONS[step.status] || <CircleDashed size={12} />}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
  )
}
