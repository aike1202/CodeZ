import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import './PlanPanel.css'

const READ_ONLY_TOOLS = ['Read', 'list_files', 'Glob', 'Grep', 'get_project_snapshot', 'fast_context']

export const PlanPanel: React.FC = () => {
  const planMode = useChatStore((s) => s.planMode)
  const activePlan = useChatStore((s) => s.activePlan)
  const planReview = useChatStore((s) => s.planReview)

  // 1. Plan mode + pending review: approval card
  if (planMode && planReview) {
    return (
      <div className="plan-capsule-container">
        <div className="plan-panel plan-review-panel">
          <div className="plan-panel-header">
            <span className="plan-review-title">📋 Plan — awaiting approval</span>
          </div>
          <div className="plan-review-info">
            <strong>{planReview.plan.slug}</strong>
            <span style={{ marginLeft: 8 }}>{planReview.plan.title}</span>
          </div>
          <div className="plan-review-steps">
            {planReview.plan.steps.map((step: any) => (
              <div key={step.id} className="plan-review-step">
                <div className="plan-review-step-title">{step.id} {step.title}</div>
                <div className="plan-review-step-desc">{step.description}</div>
                {step.files && step.files.length > 0 && (
                  <div className="plan-review-step-files">
                    files: {step.files.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="plan-review-actions">
            <button
              className="plan-review-btn approve"
              onClick={() => {
                const win = window as any
                const ipc = win?.electron?.ipcRenderer
                if (ipc) {
                  // Get streamId from chatStore or active session
                  const streamId = useChatStore.getState().activePlanStreamId
                  if (streamId) {
                    ipc.invoke('plan:approve', streamId, planReview.plan.slug)
                    useChatStore.getState().setPlanReview(null)
                  }
                }
              }}
            >
              ✅ Approve
            </button>
            <button
              className="plan-review-btn reject"
              onClick={() => {
                const feedback = prompt('What changes do you want? (leave blank to auto-revise)')
                const win = window as any
                const ipc = win?.electron?.ipcRenderer
                if (ipc) {
                  const streamId = useChatStore.getState().activePlanStreamId
                  if (streamId) {
                    ipc.invoke('plan:reject', streamId, planReview.plan.slug, feedback || 'Please revise.')
                    useChatStore.getState().setPlanReview(null)
                  }
                }
              }}
            >
              🔄 Request Changes
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 2. Executing plan: progress panel
  if (activePlan) {
    const completed = activePlan.steps.filter((s: any) => s.status === 'completed').length
    const total = activePlan.steps.length
    const hasUnfinished = completed < total

    return (
      <div className="plan-capsule-container">
        <div className="plan-panel plan-exec-panel">
          <div className="plan-panel-header">
            <span className="plan-exec-title">▶ {activePlan.slug}</span>
            <span className="plan-exec-count">{completed}/{total}</span>
          </div>
          <div className="plan-exec-steps">
            {activePlan.steps.map((step: any) => {
              const icon =
                step.status === 'in_progress' ? '🔄' :
                step.status === 'completed' ? '✅' :
                step.status === 'cancelled' ? '❌' : '⬜'
              const cls =
                step.status === 'in_progress' ? 'plan-exec-step active' :
                step.status === 'cancelled' ? 'plan-exec-step cancelled' :
                step.status === 'completed' ? 'plan-exec-step done' :
                'plan-exec-step'
              return (
                <div key={step.id} className={cls}>
                  <span className="plan-exec-step-icon">{icon}</span>
                  <span className="plan-exec-step-title">{step.id} {step.title}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // 3. Plan mode active (exploring, no review yet)
  if (planMode) {
    return (
      <div className="plan-capsule-container">
        <div className="plan-panel plan-explore-panel">
          <div className="plan-panel-header">
            <span>▶ Plan mode — exploring</span>
          </div>
          <div className="plan-panel-tools">
            {READ_ONLY_TOOLS.map((t) => (
              <span key={t} className="plan-tool-badge">{t}</span>
            ))}
          </div>
          <div className="plan-panel-hint">
            Agent is exploring the codebase. A plan will appear here when submitted for review.
          </div>
        </div>
      </div>
    )
  }

  // 4. No plan, no plan mode: hide
  return null
}
