import React, { useEffect, useState, useCallback } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useChatStore } from '../../stores/chatStore'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import IconClose from '../icons/IconClose'
import './PlanListModal.css'

/** Minimal plan shape matching the data returned by PlanStore.list */
interface PlanItem {
  id: string
  slug: string
  title: string
  status: string
  steps: Array<{ id: string; title: string; status: string }>
}

const STATUS_ICONS: Record<string, string> = {
  executing: '▶',       // ▶
  suspended: '⏸',       // ⏸
  completed: '✅',       // ✅
  pending_review: '📋', // 📋
  drafting: '📝',  // 📝
  revising: '🔄',  // 🔄
  abandoned: '❌',       // ❌
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

const STEP_ICONS: Record<string, string> = {
  completed: '✅',     // ✅
  in_progress: '🔄', // 🔄
  pending: '⬜',       // ⬜
  cancelled: '❌',     // ❌
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
  const [plans, setPlans] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(false)
  const workspace = useWorkspaceStore((s) => s.workspace)

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
      await (window as any).api.plan.load(workspace.rootPath, plan.slug)
      // Show the plan panel by setting expanded capsule
      useChatStore.getState().setExpandedCapsule('plan')
      onClose()
    } catch (err) {
      console.error('[PlanListModal] Failed to load plan:', err)
    }
  }

  const handleNewPlan = () => {
    useChatStore.getState().togglePlanMode()
    onClose()
  }

  if (!isOpen) return null

  return (
    <Flex className="plan-list-modal-overlay" onClick={onClose}>
      <Card variant="default" className="plan-list-modal-card" onClick={(e) => e.stopPropagation()}>
        <Stack className="h-full">
          <Flex align="center" justify="between" className="plan-list-modal-header">
            <h2 className="plan-list-modal-title">Plans</h2>
            <Button variant="ghost" size="none" onClick={onClose} className="plan-list-close-btn">
              <IconClose />
            </Button>
          </Flex>

          <Stack className="plan-list-modal-content">
            {loading ? (
              <div className="plan-list-empty">加载中...</div>
            ) : plans.length === 0 ? (
              <div className="plan-list-empty">
                <p>暂无 Plan</p>
                <p className="plan-list-empty-hint">输入 /plan new 描述 来创建一个新计划</p>
              </div>
            ) : (
              <Stack gap={2}>
                {plans.map((plan) => {
                  const statusIcon = STATUS_ICONS[plan.status] || '❓'
                  const statusLabel = STATUS_LABELS[plan.status] || plan.status
                  const statusClass = STATUS_CLASS[plan.status] || ''

                  return (
                    <Card
                      key={plan.id}
                      variant="default"
                      className="plan-card-item"
                      onClick={() => handlePlanClick(plan)}
                    >
                      <Flex align="center" gap={3} className="plan-item-header">
                        <span className={`plan-status-icon ${statusClass}`}>
                          {statusIcon}
                        </span>
                        <Stack className="min-w-0 plan-item-info">
                          <Flex align="center" gap={3}>
                            <span className="plan-slug">{plan.slug}</span>
                            <span className={`plan-badge ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </Flex>
                          <span className="plan-title">{plan.title}</span>
                        </Stack>
                      </Flex>

                      {plan.steps.length > 0 && (
                        <Flex align="center" gap={2} className="plan-steps-preview">
                          {plan.steps.map((step) => (
                            <span key={step.id} className="plan-step-icon" title={`${step.id} ${step.title}: ${step.status}`}>
                              {STEP_ICONS[step.status] || '⬜'} {step.id.toUpperCase()}
                            </span>
                          ))}
                        </Flex>
                      )}
                    </Card>
                  )
                })}
              </Stack>
            )}
          </Stack>

          <Flex gap={3} className="plan-list-modal-footer">
            <Button variant="primary" size="sm" onClick={handleNewPlan}>
              新建 Plan
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              关闭
            </Button>
          </Flex>
        </Stack>
      </Card>
    </Flex>
  )
}
