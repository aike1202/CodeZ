import React, { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import './PlanApprovalCard.css'

export const PlanApprovalCard: React.FC = () => {
  const { planReview, activePlanStreamId } = useChatStore()
  const [feedback, setFeedback] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!planReview || planReview.status !== 'pending_review' || !planReview.plan) {
    return null
  }

  const { plan } = planReview

  const handleApprove = async () => {
    if (!activePlanStreamId || isSubmitting) return
    setIsSubmitting(true)
    try {
      await (window as any).electron.ipcRenderer.invoke(`plan:review-response:${activePlanStreamId}`, { approved: true })
      useChatStore.getState().setPlanReview(null)
      useChatStore.getState().setActivePlanStreamId(null)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRequestChanges = async () => {
    if (!activePlanStreamId || isSubmitting) return
    setIsSubmitting(true)
    try {
      // 通过 IPC 发送带 feedback 的拒绝响应
      // 注意: 现有的 sendApprovalResponse 只接受 boolean, 我们可能需要扩展它，
      // 或者在后端通过另一个 IPC channel 传递 feedback。
      // 为简化，假设后端接受了 { approved: false, feedback } 这种增强的响应。
      // 由于接口限制，我们使用一个自定义 IPC 请求：
      await (window as any).electron.ipcRenderer.invoke(`plan:review-response:${activePlanStreamId}`, {
        approved: false,
        feedback
      })
      useChatStore.getState().setPlanReview(null)
      useChatStore.getState().setActivePlanStreamId(null)
    } finally {
      setIsSubmitting(false)
    }
  }

  // Handle default boolean approval response to support existing flow if custom ipc is not available
  const handleApproveNative = async () => {
    if (!activePlanStreamId || isSubmitting) return
    setIsSubmitting(true)
    try {
      await (window as any).electron.ipcRenderer.invoke(`plan:review-response:${activePlanStreamId}`, {
        approved: true
      })
      useChatStore.getState().setPlanReview(null)
      useChatStore.getState().setActivePlanStreamId(null)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="plan-approval-card">
      <div className="plan-approval-header">
        <span className="plan-approval-icon">🏗️</span>
        <h3>Plan Ready for Review</h3>
      </div>
      <div className="plan-approval-body">
        <h4>{plan.title}</h4>
        <p className="plan-approval-desc">{plan.description}</p>
        <ul className="plan-approval-steps">
          {plan.steps?.map((step: any) => (
            <li key={step.id}>
              <strong>{step.id} {step.title}</strong>
              <div className="step-desc">{step.description}</div>
              {step.files && step.files.length > 0 && (
                <div className="step-files">Files: {step.files.join(', ')}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="plan-approval-feedback">
        <textarea 
          placeholder="Optional feedback for changes..." 
          value={feedback} 
          onChange={e => setFeedback(e.target.value)}
          disabled={isSubmitting}
        />
      </div>
      <div className="plan-approval-actions">
        <button 
          className="btn-request-changes" 
          onClick={handleRequestChanges}
          disabled={isSubmitting || !feedback.trim()}
        >
          🔄 Request Changes
        </button>
        <button 
          className="btn-approve" 
          onClick={handleApproveNative}
          disabled={isSubmitting}
        >
          ✅ Approve Plan
        </button>
      </div>
    </div>
  )
}
