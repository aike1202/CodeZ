import React, { useMemo } from 'react'
import { useChatStore } from '../../stores/chatStore'
import './PlanPanel.css'

const READ_ONLY_TOOLS = ['Read', 'list_files', 'Glob', 'Grep', 'get_project_snapshot', 'fast_context']

function detectPlanSteps(content: string): string[] {
  if (!content) return []
  const lines = content.split('\n')
  const steps: string[] = []
  const numberedRe = /^\s*(?:\d+[\.\)]\s+)(.+)/
  const bulletRe = /^\s*(?:[-*•]\s+)(.+)/
  for (const line of lines) {
    const m = line.match(numberedRe) || line.match(bulletRe)
    if (m && m[1]) {
      const text = m[1].trim()
      if (text.length > 2 && text.length < 120) steps.push(text)
    }
  }
  return steps.slice(0, 8)
}

export const PlanPanel: React.FC = () => {
  const planMode = useChatStore((s) => s.planMode)
  const expandedCapsule = useChatStore((s) => s.expandedCapsule)
  const setExpandedCapsule = useChatStore((s) => s.setExpandedCapsule)
  const messages = useChatStore((s) => s.messages)

  const isExpanded = expandedCapsule === 'plan'

  const recentSteps = useMemo(() => {
    if (!isExpanded) return []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'agent' && m.content && !m.streaming) {
        const steps = detectPlanSteps(m.content)
        if (steps.length > 0) return steps
      }
    }
    return []
  }, [messages, isExpanded])

  if (!planMode) return null

  return (
    <div className="plan-capsule-container">
      <button
        className={`plan-capsule ${isExpanded ? 'expanded' : ''}`}
        onClick={() => setExpandedCapsule(isExpanded ? null : 'plan')}
        title="Plan mode active — click to expand"
        aria-expanded={isExpanded}
        aria-label="Plan mode active"
      >
        <span className="plan-capsule-text">📋 Plan</span>
      </button>

      {isExpanded && (
        <div className="plan-panel" role="region" aria-label="Plan mode details">
          <div className="plan-panel-header">
            <span>Plan mode — read-only</span>
            <button
              className="plan-panel-collapse"
              onClick={() => setExpandedCapsule(null)}
            >
              ▲ collapse
            </button>
          </div>

          <div className="plan-panel-section-title">Read-only tools</div>
          <div className="plan-panel-tools">
            {READ_ONLY_TOOLS.map((t) => (
              <span key={t} className="plan-tool-badge">{t}</span>
            ))}
          </div>

          <div className="plan-panel-hint">
            Agent is exploring the codebase and will present a numbered plan below.
            Turn off the [Plan] toggle to start executing.
          </div>

          {recentSteps.length > 0 && (
            <>
              <div className="plan-panel-section-title">Recent plan</div>
              <ol className="plan-steps">
                {recentSteps.map((step, i) => (
                  <li key={i} className="plan-step">{step}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  )
}
