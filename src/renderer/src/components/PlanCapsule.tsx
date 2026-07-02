import React, { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../stores/chatStore'
import { Loader2, CheckCircle2, CircleDashed, Sparkles, ChevronDown, ChevronUp, Unlink } from 'lucide-react'
import './PlanCapsule.css'

export const PlanCapsule: React.FC = () => {
  const { activePlan, subAgentStatus } = useChatStore()
  const [expanded, setExpanded] = useState(false)
  const capsuleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (capsuleRef.current && !capsuleRef.current.contains(event.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  // 如果 Agent 在探索中但尚未产生 activePlan，则显示 SubAgent Progress
  if (subAgentStatus === 'running' && !activePlan) {
    return (
      <div className="plan-capsule-wrapper" ref={capsuleRef}>
        <div className="plan-capsule executing">
          <Loader2 className="plan-capsule-icon spin" size={14} />
          <span className="plan-capsule-text">Exploring...</span>
        </div>
      </div>
    )
  }

  if (!activePlan) {
    return null
  }

  const steps = activePlan.steps || []
  const total = steps.length
  const completed = steps.filter((s: any) => s.status === 'completed').length
  const currentStep = steps.find((s: any) => s.status === 'in_progress') || steps.find((s: any) => s.status === 'pending') || steps[steps.length - 1]

  const toggleExpand = () => setExpanded(!expanded)

  const handleUnlink = () => {
    const { activeSessionId, linkPlanToSession } = useChatStore.getState()
    if (activeSessionId) {
      linkPlanToSession(activeSessionId, null)
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="step-icon completed" size={14} />
      case 'in_progress': return <Loader2 className="step-icon in-progress spin" size={14} />
      default: return <CircleDashed className="step-icon pending" size={14} />
    }
  }

  return (
    <div className={`plan-capsule-wrapper ${expanded ? 'expanded' : ''}`} ref={capsuleRef}>
      <div className={`plan-capsule ${activePlan.status}`} onClick={toggleExpand}>
        {completed === total ? (
          <Sparkles className="plan-capsule-icon success" size={14} />
        ) : activePlan.status === 'executing' ? (
          <Loader2 className="plan-capsule-icon spin" size={14} />
        ) : (
          <CircleDashed className="plan-capsule-icon pending" size={14} />
        )}
        
        <span className="plan-capsule-text">
          {currentStep ? `${currentStep.id}: ${currentStep.title}` : `Plan ${activePlan.status}`}
        </span>
        
        {expanded ? <ChevronUp size={14} className="chevron" /> : <ChevronDown size={14} className="chevron" />}
      </div>

      {expanded && (
        <div className="plan-capsule-popover">
          <div className="plan-capsule-header">
            <h4>{activePlan.title}</h4>
            <span className="plan-progress">{Math.round((completed / total) * 100)}%</span>
          </div>
          <div className="plan-capsule-body">
            <ul className="plan-steps-list">
              {steps.map((step: any) => (
                <li key={step.id} className={`step-item status-${step.status}`}>
                  {getStatusIcon(step.status)}
                  <div className="step-info">
                    <span className="step-title">{step.id} {step.title}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="plan-capsule-footer" onClick={handleUnlink} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px', borderTop: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem', gap: '6px' }}>
            <Unlink size={12} />
            从当前会话解绑
          </div>
        </div>
      )}
    </div>
  )
}
