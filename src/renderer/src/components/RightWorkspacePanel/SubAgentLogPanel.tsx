import React, { useEffect, useState } from 'react'
import type { SubAgentRecord } from '../../stores/chatStore'
import SubAgentCard from '../chat/SubAgentCard'
import { desktopApi } from '../../shared/desktop'
import { hydrateSubAgentFromLedger } from '../../utils/runtimeSubAgents'

interface SubAgentLogPanelProps {
  subAgent: SubAgentRecord
  visible: boolean
  onFileClick: (filePath: string, virtualContent?: string) => void
  onDiffClick: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
}

export function SubAgentLogPanel({
  subAgent,
  visible,
  onFileClick,
  onDiffClick
}: SubAgentLogPanelProps): React.ReactElement {
  const [displayedSubAgent, setDisplayedSubAgent] = useState(subAgent)

  useEffect(() => {
    setDisplayedSubAgent((current) => current.id === subAgent.id
      ? {
          ...current,
          ...subAgent,
          toolCalls: current.toolCalls.length ? current.toolCalls : subAgent.toolCalls,
          executionTimeline: current.executionTimeline.length
            ? current.executionTimeline
            : subAgent.executionTimeline
        }
      : subAgent)
  }, [subAgent])

  useEffect(() => {
    if (!visible || !subAgent.sessionId || !subAgent.contextScopeId) return
    let active = true
    const sessionId = subAgent.sessionId
    const contextScopeId = subAgent.contextScopeId
    const refresh = async (): Promise<void> => {
      try {
        const snapshot = await desktopApi.context.ledgerGetSnapshot(sessionId)
        if (!active) return
        setDisplayedSubAgent((current) =>
          hydrateSubAgentFromLedger(current, snapshot?.scopes[contextScopeId])
        )
      } catch (error) {
        if (active) console.warn('[SubAgentLogPanel] Failed to refresh Agent ledger:', error)
      }
    }

    void refresh()
    if (subAgent.status !== 'running') {
      return () => { active = false }
    }
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [subAgent.contextScopeId, subAgent.sessionId, subAgent.status, visible])

  return (
    <div className="right-agent-log">
      <SubAgentCard
        subAgent={displayedSubAgent}
        defaultExpanded
        onFileClick={onFileClick}
        onDiffClick={onDiffClick}
      />
    </div>
  )
}
